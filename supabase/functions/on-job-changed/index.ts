// ============================================================
//  on-job-changed — Supabase Edge Function
//
//  Triggered asynchronously by a Supabase Database Webhook on
//  jobs INSERT / UPDATE. Responsibilities:
//    1. Notify Azure for general job processing.
//
//  SCRAPE-ONLY PIPELINE: resume generation is DISABLED — no AI
//  fit analysis runs, so no ready_to_build → generate-resume call.
//
//  Auth: shared secret header (AZURE_FUNCTION_WEBHOOK_SECRET)
//        stored in Edge Function secrets — NEVER a user token.
// ============================================================

// @ts-ignore — Deno types are injected by the Supabase runtime
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

interface JobChangeRecord {
  id: string;
  title?: string;
  company?: string;
  url?: string;
  status?: string;
  resume_status?: string;
  pipeline_run_id?: string | null;
  user_id?: string | null;
  raw_description?: string | null;
  fit_score?: number | null;
  fit_reasons?: string[] | null;
}

interface WebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: JobChangeRecord;
  old_record: JobChangeRecord | null;
}

const AZURE_FN_BASE = Deno.env.get("AZURE_FN_BASE_URL") ?? ""; // e.g. https://jobsautomation.azurewebsites.net
const SHARED_SECRET = Deno.env.get("AZURE_FUNCTION_WEBHOOK_SECRET") ?? "";
// The Express/socket backend — where /webhook/state + /webhook/invalidate
// live. Falls back to the Azure base when not set (keeps existing deploys
// working); set SOCKET_API_BASE to the Render backend URL in production.
const SOCKET_API_BASE =
  Deno.env.get("SOCKET_API_BASE") ?? Deno.env.get("AZURE_FN_BASE_URL") ?? "";

const RETRY_DELAYS_MS = [1000, 4000, 10000]; // 1s, 4s, 10s
const MAX_RETRIES = RETRY_DELAYS_MS.length;

/** POST to the socket backend's webhook with the shared secret. */
async function postWebhook(path: string, body: unknown): Promise<void> {
  if (!SOCKET_API_BASE) return; // not configured — skip
  try {
    await fetch(`${SOCKET_API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": SHARED_SECRET,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn(`[on-job-changed] socket webhook ${path} failed: ${err}`);
  }
}

/**
 * Notify the socket layer that a job changed.
 *
 * 1. `/webhook/invalidate` — clear the Redis caches (eval-state, latest-run,
 *    run-board-detail) so the NEXT push recomputes fresh data. Without this,
 *    the socket would keep serving the cached (up to 20s stale) evaluation
 *    state even though a job just changed.
 * 2. `/webhook/state` — push the live `stats` (or `job:state`) event to the
 *    user's socket room so the browser updates WITHOUT polling.
 *
 * Both are event-driven: they fire only when a job actually changes (via the
 * DB webhook), never on a timer or per-push Supabase query.
 */
async function notifySocket(payload: WebhookPayload): Promise<void> {
  const userId = payload.record.user_id ?? null;
  const runId = payload.record.pipeline_run_id ?? null;
  if (!userId) return;

  // Invalidate the backend's cached reads for this user (+ this run).
  await postWebhook("/webhook/invalidate", { userId, runId });

  // Push the live update. For job-row changes use `job:state` so the exact
  // job's status/score streams; also nudge the account-wide `stats` so the
  // evaluation fit/not-fit counters refresh.
  await postWebhook("/webhook/state", {
    userId,
    runId,
    scope: "job",
    jobId: payload.record.id,
  });
  await postWebhook("/webhook/state", { userId, runId });
}

async function callAzure(url: string, body: unknown): Promise<Response> {
  if (!AZURE_FN_BASE || !SHARED_SECRET) {
    console.error(
      "[on-job-changed] Missing AZURE_FN_BASE_URL or AZURE_FUNCTION_WEBHOOK_SECRET",
    );
    return new Response(
      JSON.stringify({ ok: false, error: "missing config" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-webhook-secret": SHARED_SECRET,
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        console.log(
          `[on-job-changed] ✅ Azure notified (${url}) (${res.status})`,
        );
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // 4xx that isn't a transient — do not retry
      if (
        res.status >= 400 &&
        res.status < 500 &&
        res.status !== 408 &&
        res.status !== 429
      ) {
        console.error(
          `[on-job-changed] ❌ Azure rejected (${url}): HTTP ${res.status}`,
        );
        return new Response(JSON.stringify({ ok: false, status: res.status }), {
          status: res.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      lastErr = new Error(`HTTP ${res.status}`);
      console.warn(
        `[on-job-changed] Retry ${attempt + 1}/${MAX_RETRIES} (HTTP ${res.status})`,
      );
    } catch (err) {
      lastErr = err;
      console.warn(
        `[on-job-changed] Retry ${attempt + 1}/${MAX_RETRIES}: ${err}`,
      );
    }

    if (attempt < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }

  console.error(
    `[on-job-changed] ❌ Giving up after ${MAX_RETRIES} attempts: ${lastErr}`,
  );
  return new Response(
    JSON.stringify({ ok: false, error: "exhausted retries" }),
    { status: 502, headers: { "Content-Type": "application/json" } },
  );
}

async function notifyAzure(payload: WebhookPayload): Promise<Response> {
  const url = `${AZURE_FN_BASE}/api/jobs/${payload.record.id}/process`;
  const body = {
    event: payload.type, // INSERT | UPDATE
    jobId: payload.record.id,
    title: payload.record.title,
    company: payload.record.company,
    url: payload.record.url,
    status: payload.record.status,
    resumeStatus: payload.record.resume_status,
    pipelineRunId: payload.record.pipeline_run_id ?? null,
    userId: payload.record.user_id ?? null,
    timestamp: new Date().toISOString(),
  };
  return callAzure(url, body);
}

serve(async (req: Request) => {
  // ── Method guard ──────────────────────────────────────────
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "method not allowed" }),
      {
        status: 405,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // ── Auth: verify shared secret ────────────────────────────
  const secret = req.headers.get("x-webhook-secret") ?? "";
  if (!SHARED_SECRET || secret !== SHARED_SECRET) {
    console.warn("[on-job-changed] ⛔ Unauthorized webhook call");
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── Parse payload ─────────────────────────────────────────
  let payload: WebhookPayload;
  try {
    payload = (await req.json()) as WebhookPayload;
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "bad json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!payload?.record?.id) {
    return new Response(
      JSON.stringify({ ok: false, error: "missing record.id" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // ── Fire the Azure + socket calls (async) ──────────────────
  // Scrape-only pipeline: jobs are scraped & stored without AI fit
  // analysis, so resume generation is DISABLED — only the general
  // job-processing notification is sent (which is a no-op for
  // completed jobs).
  //
  // We await so the Edge Function lifetime covers the requests.
  const results: Promise<unknown>[] = [
    notifyAzure(payload),
    // Event-driven socket update: invalidate caches + push live state.
    notifySocket(payload),
  ];

  // Respond with the first non-OK status if any, else 200.
  const settled = await Promise.allSettled(results);
  for (const r of settled) {
    if (r.status === "fulfilled" && (r.value as Response)?.status >= 400) {
      return r.value as Response;
    }
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

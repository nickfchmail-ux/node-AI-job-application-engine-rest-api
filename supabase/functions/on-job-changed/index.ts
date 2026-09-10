// ============================================================
//  on-job-changed — Supabase Edge Function
//
//  Triggered asynchronously by a Supabase Database Webhook on
//  jobs INSERT. Responsibilities:
//    1. Notify Azure for general job processing.
//    2. Nudge the socket backend so the browser updates live.
//
//  BATCHED PAYLOAD (migration 0017)
//  --------------------------------
//  The `jobs` trigger is now `FOR EACH STATEMENT` with a transition
//  table, so ONE invocation carries a whole upsert batch:
//
//      { type, table, schema, records: [ ...job rows... ], count }
//
//  Previously it was `FOR EACH ROW`, so a 50-row batch produced 50
//  invocations. Both shapes are accepted here — `record` (single,
//  legacy) and `records` (array, current) — so this function can be
//  deployed BEFORE or AFTER the migration without dropping events.
//
//  SCRAPE-ONLY PIPELINE: resume generation is DISABLED — no AI
//  fit analysis runs, so no ready_to_build → generate-resume call.
//
//  Auth: shared secret header (AZURE_FUNCTION_WEBHOOK_SECRET)
//        stored in Edge Function secrets — NEVER a user token.
// ============================================================

// @ts-ignore — Deno types are injected by the Supabase runtime
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// Provided by the Supabase Edge Runtime. Lets us return a response
// immediately while the outbound work continues in the background.
// @ts-ignore — not present in the ambient Deno lib types.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

interface JobChangeRecord {
  id: string;
  title?: string;
  company?: string;
  url?: string;
  status?: string;
  resume_status?: string;
  pipeline_run_id?: string | null;
  user_id?: string | null;
  // Only sent by the legacy (0010, per-row) payload shape.
  raw_description?: string | null;
  fit_score?: number | null;
  fit_reasons?: string[] | null;
}

interface WebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  /** Batched shape (migration 0017): one entry per inserted row. */
  records?: JobChangeRecord[] | null;
  /** Row count of the batch, supplied by the trigger. */
  count?: number | null;
  /** Legacy single-row shape (migration 0010). */
  record?: JobChangeRecord | null;
  old_record?: JobChangeRecord | null;
}

/**
 * Normalise both payload shapes into a single array.
 * Deduplicates by id so a retried/duplicated delivery cannot enqueue
 * the same job twice.
 */
function extractRecords(payload: WebhookPayload): JobChangeRecord[] {
  const raw = Array.isArray(payload?.records)
    ? payload.records
    : payload?.record
      ? [payload.record]
      : [];

  const seen = new Set<string>();
  const out: JobChangeRecord[] = [];
  for (const r of raw) {
    if (!r?.id || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

const AZURE_FN_BASE = Deno.env.get("AZURE_FN_BASE_URL") ?? ""; // e.g. https://jobsautomation.azurewebsites.net
/**
 * Secret Azure Function validates on /api/jobs/{id}/process — and the
 * secret the DB trigger sends (from the `app.azure_webhook_secret` GUC).
 *
 * Accepts EITHER env var name: the two backends are configured
 * independently, and in practice only one of the names tends to be set
 * (`.env.local` defines STATE_WEBHOOK_SECRET but not
 * AZURE_FUNCTION_WEBHOOK_SECRET). Insisting on the exact "azure" spelling
 * would make the inbound check reject every call with a 401.
 */
const AZURE_SECRET =
  Deno.env.get("AZURE_FUNCTION_WEBHOOK_SECRET") ??
  Deno.env.get("STATE_WEBHOOK_SECRET") ??
  "";
// The Express/socket backend — where /webhook/state + /webhook/invalidate
// live. Falls back to the Azure base when not set (keeps existing deploys
// working); set SOCKET_API_BASE to the Render backend URL in production.
const SOCKET_API_BASE =
  Deno.env.get("SOCKET_API_BASE") ?? Deno.env.get("AZURE_FN_BASE_URL") ?? "";
/**
 * Secret the socket backend validates (`STATE_WEBHOOK_SECRET` in
 * `server.ts`) and sends as the `x-webhook-secret` header.
 *
 * Deliberately does NOT fall back to `AZURE_FUNCTION_WEBHOOK_SECRET`: the
 * two are different secrets for different consumers, and falling back meant
 * a deploy that was missing the socket secret would silently send the Azure
 * secret to Render — which answers 401 while looking perfectly "configured".
 * Missing config must fail loudly, not authenticate against the wrong peer.
 */
const SOCKET_SECRET =
  Deno.env.get("STATE_WEBHOOK_SECRET") ??
  Deno.env.get("SOCKET_WEBHOOK_SECRET") ??
  "";

if (!AZURE_SECRET) {
  console.warn(
    "[on-job-changed] No webhook secret configured " +
      "(AZURE_FUNCTION_WEBHOOK_SECRET / STATE_WEBHOOK_SECRET). Inbound " +
      "trigger calls will 401 and Azure cannot be notified.",
  );
}
if (SOCKET_API_BASE && !SOCKET_SECRET) {
  console.warn(
    "[on-job-changed] SOCKET_API_BASE is set but no socket webhook secret " +
      "was found (STATE_WEBHOOK_SECRET / SOCKET_WEBHOOK_SECRET). " +
      "Every /webhook/* call will be rejected with 401.",
  );
}
if (SOCKET_API_BASE && SOCKET_SECRET && SOCKET_SECRET === AZURE_SECRET) {
  console.log(
    "[on-job-changed] socket + Azure share the same webhook secret " +
      "(fine, but they are configurable independently).",
  );
}
// Booleans only — never log the secret values themselves. Makes a
// half-configured deploy obvious in the function logs.
console.log(
  "[on-job-changed] resolved config: " +
    JSON.stringify({
      azureBase: Boolean(AZURE_FN_BASE),
      azureSecret: Boolean(AZURE_SECRET),
      socketBase: Boolean(SOCKET_API_BASE),
      socketSecret: Boolean(SOCKET_SECRET),
      socketBaseIsAzureFallback:
        !Deno.env.get("SOCKET_API_BASE") && Boolean(AZURE_FN_BASE),
    }),
);

const RETRY_DELAYS_MS = [1000, 4000, 10000]; // 1s, 4s, 10s
const MAX_RETRIES = RETRY_DELAYS_MS.length;

/** POST to the socket backend's webhook with the shared secret. */
async function postWebhook(path: string, body: unknown): Promise<void> {
  if (!SOCKET_API_BASE) return; // not configured — skip
  try {
    const res = await fetch(`${SOCKET_API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": SOCKET_SECRET,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    // NOTE: this used to only catch *network* errors, so a 401 from a
    // secret mismatch looked exactly like "the socket backend is quiet".
    // Every realtime push could 401 forever with nothing in the logs.
    // Any non-2xx is now logged loudly.
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(
        `[on-job-changed] ❌ socket webhook ${path} rejected: ` +
          `HTTP ${res.status} ${res.statusText} ${detail.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.warn(`[on-job-changed] socket webhook ${path} failed: ${err}`);
  }
}

/**
 * Notify the socket layer that jobs changed.
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
 *
 * BATCHING: work is grouped per `user_id`, so a 50-job batch for one user
 * costs 1 invalidation + 1 account-wide push (+ N per-job pushes) rather
 * than 3 calls per job. Jobs with no `user_id` are "system" jobs
 * (legacy/CLI runs) — the socket routes require a `userId`, so there is
 * nobody to push to and they are skipped here.
 */
async function notifySockets(records: JobChangeRecord[]): Promise<void> {
  interface Group {
    userId: string;
    runId: string | null;
    jobIds: string[];
  }

  const groups = new Map<string, Group>();
  for (const r of records) {
    const userId = r.user_id ?? null;
    if (!userId) continue;

    let g = groups.get(userId);
    if (!g) {
      g = { userId, runId: r.pipeline_run_id ?? null, jobIds: [] };
      groups.set(userId, g);
    }
    // Prefer a concrete run id if any row in the group has one.
    if (!g.runId && r.pipeline_run_id) g.runId = r.pipeline_run_id;
    if (!g.jobIds.includes(r.id)) g.jobIds.push(r.id);
  }

  await Promise.all(
    [...groups.values()].map(async (g) => {
      // Invalidate the backend's cached reads for this user (+ this run).
      await postWebhook("/webhook/invalidate", {
        userId: g.userId,
        runId: g.runId,
      });

      // For job-row changes use `job:state` so the exact job's
      // status/score streams.
      for (const jobId of g.jobIds) {
        await postWebhook("/webhook/state", {
          userId: g.userId,
          runId: g.runId,
          scope: "job",
          jobId,
        });
      }

      // Nudge the account-wide `stats` last so the evaluation
      // fit/not-fit counters refresh once per batch.
      await postWebhook("/webhook/state", {
        userId: g.userId,
        runId: g.runId,
      });
    }),
  );
}

type AzureResult = { ok: boolean; status: number };

/**
 * Terminal job statuses that must NOT be sent to Azure:
 *  - `completed` — the Azure handler is an explicit no-op.
 *  - `duplicate` — the Azure handler falls through to its default branch
 *    and would RE-ENQUEUE the job for processing.
 * Skipping both avoids a pointless round trip (and a latent bug).
 */
const TERMINAL_STATUSES = new Set(["completed", "duplicate"]);

/**
 * POST one job to Azure, with the retry ladder.
 * Never throws — returns a status object so one bad job cannot abort
 * the rest of the batch.
 */
async function callAzure(url: string, body: unknown): Promise<AzureResult> {
  if (!AZURE_FN_BASE || !AZURE_SECRET) {
    console.error(
      "[on-job-changed] Missing AZURE_FN_BASE_URL or AZURE_FUNCTION_WEBHOOK_SECRET",
    );
    return { ok: false, status: 500 };
  }

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-webhook-secret": AZURE_SECRET,
        },
        body: JSON.stringify(body),
        // Without this a hung Azure host would pin the isolate forever.
        signal: AbortSignal.timeout(15_000),
      });

      if (res.ok) {
        console.log(
          `[on-job-changed] ✅ Azure notified (${url}) (${res.status})`,
        );
        return { ok: true, status: res.status };
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
        return { ok: false, status: res.status };
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
  return { ok: false, status: 502 };
}

/** Notify Azure that a single job needs processing. */
async function notifyAzure(
  record: JobChangeRecord,
  event: string,
): Promise<AzureResult> {
  if (record.status && TERMINAL_STATUSES.has(record.status)) {
    console.log(
      `[on-job-changed] ⏭️ skipping Azure for job ${record.id} (status=${record.status})`,
    );
    return { ok: true, status: 204 };
  }

  const url = `${AZURE_FN_BASE}/api/jobs/${record.id}/process`;
  const body = {
    event, // INSERT | UPDATE
    jobId: record.id,
    title: record.title,
    company: record.company,
    url: record.url,
    status: record.status,
    resumeStatus: record.resume_status,
    pipelineRunId: record.pipeline_run_id ?? null,
    userId: record.user_id ?? null,
    timestamp: new Date().toISOString(),
  };
  return callAzure(url, body);
}

/**
 * Fan the batch out to Azure with bounded concurrency.
 * A 50-job batch must not open 50 simultaneous outbound sockets, and each
 * job carries its own retry ladder.
 */
const AZURE_CONCURRENCY = 8;

async function notifyAzureBatch(
  records: JobChangeRecord[],
  event: string,
): Promise<AzureResult[]> {
  const queue = [...records];
  const results: AzureResult[] = [];

  const worker = async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      results.push(await notifyAzure(next, event));
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(AZURE_CONCURRENCY, queue.length) }, worker),
  );
  return results;
}

/** Do all outbound work for one webhook delivery. */
async function processBatch(
  payload: WebhookPayload,
  records: JobChangeRecord[],
): Promise<void> {
  const [azure, socket] = await Promise.allSettled([
    notifyAzureBatch(records, payload.type),
    notifySockets(records),
  ]);

  if (socket.status === "rejected") {
    console.warn(`[on-job-changed] socket fan-out failed: ${socket.reason}`);
  }
  if (azure.status === "fulfilled") {
    const failed = azure.value.filter((r) => !r.ok).length;
    console.log(
      `[on-job-changed] batch complete: ${records.length} job(s), ${failed} Azure failure(s)`,
    );
  } else {
    console.warn(`[on-job-changed] Azure fan-out failed: ${azure.reason}`);
  }
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
  // This is the secret the DB trigger sends, taken from the
  // `app.azure_webhook_secret` GUC — hence the AZURE_FUNCTION_WEBHOOK_SECRET
  // name. It guards INBOUND calls; the outbound socket secret is separate.
  const secret = req.headers.get("x-webhook-secret") ?? "";
  if (!AZURE_SECRET || secret !== AZURE_SECRET) {
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

  // ── Normalise both payload shapes ──────────────────────────
  const records = extractRecords(payload);
  if (records.length === 0) {
    return new Response(
      JSON.stringify({ ok: false, error: "missing record.id" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // ── Fan out to Azure + the socket backend ──────────────────
  // Scrape-only pipeline: jobs are scraped & stored without AI fit
  // analysis, so resume generation is DISABLED — only the general
  // job-processing notification is sent.
  //
  // The work runs in the BACKGROUND. pg_net only records the response
  // and nothing consumes it, so holding the HTTP response open for the
  // full retry ladder (up to ~15s per job) was pure cost — and a common
  // source of pg_net `timed_out` rows. EdgeRuntime.waitUntil keeps the
  // isolate alive without blocking the response.
  const work = processBatch(payload, records);

  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(work);
  } else {
    // Local `supabase functions serve` has no EdgeRuntime — await so the
    // process does not exit before the outbound work completes.
    await work;
  }

  return new Response(JSON.stringify({ ok: true, accepted: records.length }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

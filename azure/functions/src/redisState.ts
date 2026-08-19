// ============================================================
//  redisState.ts — Upstash Redis pipeline-state counters for the
//  Azure Functions layer, KEYED BY USER ID (lightweight).
//
//  Every state change in the pipeline writes to Redis so the
//  frontend can show a LIVE, logically-related funnel per user:
//
//    scraped → duplicate (deduped) → unique
//      → processing (detail scrape, live counter)
//
//  Terminal / per-job states (queued → processing → completed /
//  failed) live in Supabase `jobs.status` and stream via Realtime —
//  they are NOT duplicated into Redis counters.
//
//  Key layout (all scoped under the user — each user only reads
//  their own keys):
//
//    user:{userId}:runs                  SET     — this user's runIds
//    user:{userId}:run:{runId}:counts   HASH    — per-run counters
//    user:{userId}:run:{runId}:boards   HASH    — per-run per-board counters
//    user:{userId}:run:{runId}:meta     STRING  — run metadata JSON
//    user:{userId}:summary              HASH    — lightweight AGGREGATED
//                                                 counters across all user runs
//
//  Uses the Upstash REST API (KV_REST_API_URL + KV_REST_API_TOKEN)
//  which works from Azure Functions without extra Redis drivers.
// ============================================================

const REST_URL = process.env.KV_REST_API_URL ?? "";
const REST_TOKEN = process.env.KV_REST_API_TOKEN ?? "";
// Optional: Express server webhook for realtime WebSocket push
const STATE_WEBHOOK_URL = process.env.STATE_WEBHOOK_URL ?? "";
const STATE_WEBHOOK_SECRET = process.env.STATE_WEBHOOK_SECRET ?? "";

let _client: UpstashClient | null = null;

interface UpstashClient {
  request<T = unknown>(cmd: string[]): Promise<T>;
  pipeline(commands: (string | number)[][]): Promise<unknown[]>;
}

function getClient(): UpstashClient {
  if (_client) return _client;
  if (!REST_URL || !REST_TOKEN) {
    throw new Error(
      "Upstash Redis not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN.",
    );
  }
  _client = {
    async request<T = unknown>(cmd: string[]): Promise<T> {
      const res = await fetch(REST_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(cmd),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        throw new Error(
          `Upstash HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
        );
      }
      const json = (await res.json()) as { result: T };
      // Upstash REST wraps the actual result in { result: ... }
      return json.result;
    },
    async pipeline(commands: (string | number)[][]): Promise<unknown[]> {
      const res = await fetch(`${REST_URL}/pipeline`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(commands),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        throw new Error(`Upstash pipeline HTTP ${res.status}`);
      }
      const json = (await res.json()) as { results: unknown[] };
      return json.results ?? [];
    },
  };
  return _client;
}

/** Key helpers — everything is scoped under the user. */
const runsSetKey = (userId: string) => `user:${userId}:runs`;
const countsKey = (userId: string, runId: string) =>
  `user:${userId}:run:${runId}:counts`;
const boardsKey = (userId: string, runId: string) =>
  `user:${userId}:run:${runId}:boards`;
const metaKey = (userId: string, runId: string) =>
  `user:${userId}:run:${runId}:meta`;
const summaryKey = (userId: string) => `user:${userId}:summary`;

/** The set of counters we track (kept in sync with callers). */
export const COUNTER_NAMES = [
  "scraped", // total job listings discovered by scrapers
  "duplicate", // already-known (deduped) — not inserted
  "processing", // currently being detail-scraped / enriched (live counter)
] as const;

/**
 * Atomically increment counters for a user's run. Also bumps the
 * lightweight per-user summary hash. Best-effort — never throws
 * (the pipeline must continue even if Redis is temporarily down).
 */
export async function incrementCounters(
  userId: string,
  runId: string,
  counters: Record<string, number>,
  board?: string,
): Promise<void> {
  if (!userId || !runId) return;
  try {
    const client = getClient();
    const commands: (string | number)[][] = [];
    const cKey = countsKey(userId, runId);
    const sKey = summaryKey(userId);
    for (const [name, delta] of Object.entries(counters)) {
      if (delta === 0) continue;
      commands.push(["HINCRBY", cKey, name, String(delta)]);
      // Lightweight aggregate across all the user's runs
      commands.push(["HINCRBY", sKey, name, String(delta)]);
    }
    if (board) {
      const bKey = boardsKey(userId, runId);
      for (const [name, delta] of Object.entries(counters)) {
        if (delta === 0) continue;
        commands.push(["HINCRBY", bKey, `${board}:${name}`, String(delta)]);
      }
    }
    if (commands.length) {
      await client.pipeline(commands);
      // Fire-and-forget: tell the Express server to push live updates
      // to this user's WebSocket room (no polling on the frontend).
      notifyWebhook(userId, runId).catch(() => {});
    }
  } catch (err) {
    console.warn(
      `[redisState] incrementCounters(${userId}/${runId}) failed: ${err}`,
    );
  }
}

/** Best-effort: POST to the Express webhook to trigger a WS push. */
async function notifyWebhook(userId: string, runId: string): Promise<void> {
  if (!STATE_WEBHOOK_URL) return;
  try {
    await fetch(STATE_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(STATE_WEBHOOK_SECRET
          ? { "x-webhook-secret": STATE_WEBHOOK_SECRET }
          : {}),
      },
      body: JSON.stringify({ userId, runId }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    // non-fatal — WS push is best-effort
    console.warn(`[redisState] notifyWebhook failed: ${err}`);
  }
}

/** Register a run under the user + set its metadata. */
export async function setRunMeta(
  userId: string,
  runId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  if (!userId || !runId) return;
  try {
    const client = getClient();
    await client.pipeline([
      ["SET", metaKey(userId, runId), JSON.stringify(meta)],
      ["EXPIRE", metaKey(userId, runId), 86400 * 2], // 48h
      ["SADD", runsSetKey(userId), runId],
      ["EXPIRE", countsKey(userId, runId), 86400 * 2],
      ["EXPIRE", boardsKey(userId, runId), 86400 * 2],
      ["EXPIRE", summaryKey(userId), 86400 * 7], // keep user summary 7d
    ]);
  } catch (err) {
    console.warn(`[redisState] setRunMeta(${userId}/${runId}) failed: ${err}`);
  }
}

/** Read the per-run counts hash. */
export async function getRunCounts(
  userId: string,
  runId: string,
): Promise<Record<string, number>> {
  try {
    const client = getClient();
    const raw =
      (await client.request<string[]>(["HGETALL", countsKey(userId, runId)])) ??
      [];
    const out: Record<string, number> = {};
    for (let i = 0; i < raw.length; i += 2) {
      out[raw[i]] = Number(raw[i + 1]) || 0;
    }
    return out;
  } catch (err) {
    console.warn(
      `[redisState] getRunCounts(${userId}/${runId}) failed: ${err}`,
    );
    return {};
  }
}

/** Read the per-run per-board counts hash. */
export async function getRunBoardCounts(
  userId: string,
  runId: string,
): Promise<Record<string, number>> {
  try {
    const client = getClient();
    const raw =
      (await client.request<string[]>(["HGETALL", boardsKey(userId, runId)])) ??
      [];
    const out: Record<string, number> = {};
    for (let i = 0; i < raw.length; i += 2) {
      out[raw[i]] = Number(raw[i + 1]) || 0;
    }
    return out;
  } catch (err) {
    console.warn(
      `[redisState] getRunBoardCounts(${userId}/${runId}) failed: ${err}`,
    );
    return {};
  }
}

/** Read the run metadata JSON. */
export async function getRunMeta(
  userId: string,
  runId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const client = getClient();
    const raw = await client.request<string | null>([
      "GET",
      metaKey(userId, runId),
    ]);
    if (!raw) return null;
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** List a user's runIds (active + recent). */
export async function listUserRuns(userId: string): Promise<string[]> {
  try {
    const client = getClient();
    return (
      (await client.request<string[]>(["SMEMBERS", runsSetKey(userId)])) ?? []
    );
  } catch {
    return [];
  }
}

/** Read the lightweight per-user summary hash (all counters aggregated). */
export async function getUserSummary(
  userId: string,
): Promise<Record<string, number>> {
  try {
    const client = getClient();
    const raw =
      (await client.request<string[]>(["HGETALL", summaryKey(userId)])) ?? [];
    const out: Record<string, number> = {};
    for (let i = 0; i < raw.length; i += 2) {
      out[raw[i]] = Number(raw[i + 1]) || 0;
    }
    return out;
  } catch (err) {
    console.warn(`[redisState] getUserSummary(${userId}) failed: ${err}`);
    return {};
  }
}

/** Remove a run from the user's active set once terminal. */
export async function markRunTerminal(
  userId: string,
  runId: string,
): Promise<void> {
  try {
    const client = getClient();
    await client.pipeline([
      ["SREM", runsSetKey(userId), runId],
      ["EXPIRE", countsKey(userId, runId), 86400 * 7], // keep counts 7d after done
      ["EXPIRE", boardsKey(userId, runId), 86400 * 7],
    ]);
  } catch {
    /* ignore */
  }
}

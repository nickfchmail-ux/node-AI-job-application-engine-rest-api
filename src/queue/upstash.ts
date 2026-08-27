// ============================================================
//  upstash.ts — Upstash Redis REST client for the Express
//  server (user-keyed pipeline state). Reads counters that the
//  Azure Functions write. Uses the Upstash REST API so no Redis
//  driver is needed (works serverless / on Render / locally).
//
//  Key layout (scoped per user — mirrors azure/functions/src/redisState.ts):
//    user:{userId}:runs                  SET
//    user:{userId}:run:{runId}:counts   HASH
//    user:{userId}:run:{runId}:boards   HASH
//    user:{userId}:run:{runId}:meta     STRING
//    user:{userId}:summary              HASH
// ============================================================

let _client: UpstashClient | null = null;

interface UpstashClient {
  request<T = unknown>(cmd: string[]): Promise<T>;
}

function getClient(): UpstashClient {
  if (_client) return _client;
  // Read env lazily — loadEnvLocal() may not have run yet at import time.
  const restUrl = process.env.KV_REST_API_URL ?? "";
  const restToken = process.env.KV_REST_API_TOKEN ?? "";
  if (!restUrl || !restToken) {
    throw new Error(
      "Upstash Redis not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN.",
    );
  }
  _client = {
    async request<T = unknown>(cmd: string[]): Promise<T> {
      const res = await fetch(restUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${restToken}`,
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
  };
  return _client;
}

const runsSetKey = (userId: string) => `user:${userId}:runs`;
const countsKey = (userId: string, runId: string) =>
  `user:${userId}:run:${runId}:counts`;
const boardsKey = (userId: string, runId: string) =>
  `user:${userId}:run:${runId}:boards`;
const metaKey = (userId: string, runId: string) =>
  `user:${userId}:run:${runId}:meta`;
const summaryKey = (userId: string) => `user:${userId}:summary`;

async function hgetall(key: string): Promise<Record<string, number>> {
  try {
    const client = getClient();
    const raw = (await client.request<string[]>(["HGETALL", key])) ?? [];
    const out: Record<string, number> = {};
    for (let i = 0; i < raw.length; i += 2) {
      out[raw[i]] = Number(raw[i + 1]) || 0;
    }
    return out;
  } catch (err) {
    console.warn(`[upstash] HGETALL ${key} failed: ${err}`);
    return {};
  }
}

async function get(key: string): Promise<string | null> {
  try {
    const client = getClient();
    return await client.request<string | null>(["GET", key]);
  } catch (err) {
    console.warn(`[upstash] GET ${key} failed: ${err}`);
    return null;
  }
}

/** Aggregated counters across all the user's runs. */
export async function getUserSummary(
  userId: string,
): Promise<Record<string, number>> {
  return hgetall(summaryKey(userId));
}

/** The user's run IDs. */
export async function listUserRuns(userId: string): Promise<string[]> {
  try {
    const client = getClient();
    return (
      (await client.request<string[]>(["SMEMBERS", runsSetKey(userId)])) ?? []
    );
  } catch (err) {
    console.warn(`[upstash] SMEMBERS failed: ${err}`);
    return [];
  }
}

/** One run's funnel counters. */
export async function getRunCounts(
  userId: string,
  runId: string,
): Promise<Record<string, number>> {
  return hgetall(countsKey(userId, runId));
}

/** One run's per-board counters (keys like "jobsdb:fit"). */
export async function getRunBoardCounts(
  userId: string,
  runId: string,
): Promise<Record<string, number>> {
  return hgetall(boardsKey(userId, runId));
}

/** One run's metadata JSON. */
export async function getRunMeta(
  userId: string,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const raw = await get(metaKey(userId, runId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Short-TTL cache for per-push Supabase reads.                      */
/*                                                                     */
/*  WHY: the socket `stats` push previously re-queried Supabase on     */
/*  EVERY `/webhook/state` (latest run id, run_boards detail, and —    */
/*  worst — a FULL select over the user's jobs for evaluation counts). */
/*  On a busy run that's several Supabase round-trips per progress     */
/*  update → the exhaustion the user hit. These helpers cache those    */
/*  reads in Redis with a short TTL so Supabase is hit occasionally,   */
/*  not on every push. The values are bounded in staleness (TTL) and   */
/*  invalidated explicitly when the underlying data changes.           */
/* ------------------------------------------------------------------ */

const cacheKey = (name: string, id: string) => `cache:${name}:${id}`;

/** GET a cached JSON value (string|object) — null when absent/expired. */
async function cacheGet(name: string, id: string): Promise<string | null> {
  return get(cacheKey(name, id));
}

/** SET a cached JSON value with a TTL (seconds). */
async function cacheSet(
  name: string,
  id: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  try {
    const client = getClient();
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    await client.request([
      "SETEX",
      cacheKey(name, id),
      String(ttlSeconds),
      raw,
    ]);
  } catch (err) {
    console.warn(`[upstash] cacheSet ${name}:${id} failed: ${err}`);
  }
}

/** DELETE a cached value (call after the underlying data changes). */
export async function cacheDelete(name: string, id: string): Promise<void> {
  try {
    const client = getClient();
    await client.request(["DEL", cacheKey(name, id)]);
  } catch (err) {
    console.warn(`[upstash] cacheDelete ${name}:${id} failed: ${err}`);
  }
}

/** JSON-safe get+set with TTL in one call. Returns parsed value or null. */
export async function cacheGetOrSet<T>(
  name: string,
  id: string,
  ttlSeconds: number,
  compute: () => Promise<T | null>,
): Promise<T | null> {
  const hit = await cacheGet(name, id);
  if (hit !== null) {
    try {
      return JSON.parse(hit) as T;
    } catch {
      /* fall through to recompute */
    }
  }
  const value = await compute();
  if (value !== null) await cacheSet(name, id, value, ttlSeconds);
  return value;
}

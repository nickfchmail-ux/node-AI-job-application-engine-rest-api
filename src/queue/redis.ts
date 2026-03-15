import type { ConnectionOptions } from "bullmq";
import * as fs from "fs";
import * as path from "path";

/**
 * Parse a Redis URL into BullMQ ConnectionOptions (plain object).
 * BullMQ v5 bundles its own ioredis — passing a plain options object avoids
 * version-mismatch type errors from a separately installed ioredis package.
 */
function parseRedisUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  const opts: ConnectionOptions & Record<string, unknown> = {
    host: u.hostname,
    port: Number(u.port) || 6379,
    // Retry forever with backoff — worker stays alive while Redis is starting
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => Math.min(times * 500, 10_000),
    enableOfflineQueue: true,
  };
  if (u.password) opts.password = decodeURIComponent(u.password);
  if (u.username) opts.username = u.username;
  if (u.pathname && u.pathname !== "/") opts.db = Number(u.pathname.slice(1));
  if (u.protocol === "rediss:") opts.tls = {};
  return opts as ConnectionOptions;
}

// Try process.env first; if not present (import order before loadEnvLocal),
// fall back to reading .env.local directly so local deployments pick up REDIS_URL.
let rawRedisUrl = process.env.REDIS_URL;
console.log(`[cwd] ${process.cwd()}`);
if (!rawRedisUrl) {
  try {
    const envPath = path.join(process.cwd(), ".env.local");
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq === -1) continue;
        const key = t.slice(0, eq).trim();
        const val = t.slice(eq + 1).trim();
        if (key === "REDIS_URL") {
          rawRedisUrl = val;
          break;
        }
      }
    }
  } catch {
    /* ignore */
  }
}

export const redisConnection: ConnectionOptions = rawRedisUrl
  ? parseRedisUrl(rawRedisUrl)
  : ({
      host: "localhost",
      port: 6379,
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => Math.min(times * 500, 10_000),
    } as ConnectionOptions);

// Debug: show which Redis host/port/protocol the worker will attempt to use.
// Do NOT log the password.
try {
  if (rawRedisUrl) {
    const u = new URL(rawRedisUrl);
    const masked = `${u.protocol}//${u.username ? u.username + ":" : ""}***@${u.hostname}:${u.port}${u.pathname}`;
    console.log(
      `[redis] REDIS_URL (masked): ${masked}  protocol=${u.protocol} user=${u.username ? "<present>" : "<none>"}`,
    );
  } else {
    console.log(
      "[redis] No REDIS_URL configured — falling back to localhost:6379",
    );
  }
} catch (e) {
  /* ignore malformed URL */
}

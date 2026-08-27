// ============================================================
//  scraperApi.ts — ScraperAPI as the FINAL fallback for the
//  Indeed board ONLY (JobsDB/CTgoodjobs/OfferToday/LinkedIn never
//  touch ScraperAPI — see cloudflareProxy.ts).
//
//  KEY ROTATION (multi-key):
//  Keys live in Supabase `scraper_api_keys`. One key is `is_active`.
//  When a key returns "You have exhausted the API Credits", we:
//    1. mark that key `exhausted_on = today`,
//    2. rotate `is_active` to the next non-exhausted key,
//    3. retry with the new key.
//  If ALL keys are exhausted today, we stop (caller sees no key
//  available) — the frontend then hides the Indeed button for the day.
//
//  Fallback order (in cloudflareProxy.ts):
//    1. Cloudflare proxy worker (jobboard-proxy)
//    2. DataImpulse residential proxy (directProxy.ts)
//    3. ScraperAPI (THIS) — only for Indeed
// ============================================================

import { getSupabaseClient } from "./supabase";

export interface ScraperApiResult {
  ok: boolean;
  html?: string;
  error?: string;
  status?: number;
  detail?: string;
}

const SCRAPERAPI_BASE = "http://api.scraperapi.com";

/** The exact "credits exhausted" response body from ScraperAPI. */
const EXHAUSTED_MARKER = "You have exhausted the API Credits";
/** How long to cache the key table (ms). */
const KEYS_CACHE_TTL_MS = 30_000;

interface ScraperApiKeyRow {
  id: string;
  key_value: string;
  label: string;
  is_active: boolean;
  exhausted_on: string | null;
}

let keysCache: { at: number; rows: ScraperApiKeyRow[] } | null = null;

/**
 * Load the ScraperAPI key table from Supabase (cached 30s).
 * Falls back to the env var SCRAPERAPI_KEY if the table is empty/unreachable
 * so existing deployments keep working during rollout.
 */
async function loadKeys(): Promise<ScraperApiKeyRow[]> {
  if (keysCache && Date.now() - keysCache.at < KEYS_CACHE_TTL_MS) {
    return keysCache.rows;
  }
  try {
    const sb = getSupabaseClient();
    const { data, error } = await sb
      .from("scraper_api_keys")
      .select("id, key_value, label, is_active, exhausted_on")
      .order("label", { ascending: true });
    if (error) throw error;
    const rows = (data ?? []) as ScraperApiKeyRow[];
    // Bootstrap: if the table is empty but env has a key, treat env as the
    // single active key.
    if (rows.length === 0 && process.env.SCRAPERAPI_KEY) {
      rows.push({
        id: "env",
        key_value: process.env.SCRAPERAPI_KEY,
        label: "env",
        is_active: true,
        exhausted_on: null,
      });
    }
    keysCache = { at: Date.now(), rows };
    return rows;
  } catch (err) {
    // On DB failure, fall back to env if set.
    if (process.env.SCRAPERAPI_KEY) {
      const rows = [
        {
          id: "env",
          key_value: process.env.SCRAPERAPI_KEY,
          label: "env",
          is_active: true,
          exhausted_on: null,
        },
      ] as ScraperApiKeyRow[];
      keysCache = { at: Date.now(), rows };
      return rows;
    }
    return [];
  }
}

/** Invalidate the cache (after a rotation write). */
function invalidateKeysCache() {
  keysCache = null;
}

/** The active (or first non-exhausted-today) key, or null if all exhausted. */
export async function getActiveScraperApiKey(): Promise<string | null> {
  const rows = await loadKeys();
  if (rows.length === 0) return null;
  const today = todayStr();
  // Prefer is_active (if it's not exhausted today); otherwise the first
  // key that isn't exhausted today.
  const active = rows.find(
    (r) => r.is_active && r.exhausted_on !== today,
  );
  if (active) return active.key_value;
  const anyHealthy = rows.find((r) => r.exhausted_on !== today);
  return anyHealthy?.key_value ?? null;
}

/** True if ANY key is available today (not all exhausted). */
export async function scraperApiAvailableToday(): Promise<boolean> {
  const rows = await loadKeys();
  if (rows.length === 0) return false;
  const today = todayStr();
  return rows.some((r) => r.exhausted_on !== today);
}

/**
 * Mark a key exhausted today AND rotate to the next non-exhausted key.
 * Used when a key genuinely runs out of monthly credits.
 */
async function rotateAfterExhaustion(
  exhaustedId: string,
  log: (msg: string) => void,
): Promise<void> {
  const sb = getSupabaseClient();
  const today = todayStr();
  try {
    await sb
      .from("scraper_api_keys")
      .update({ exhausted_on: today, updated_at: new Date().toISOString() })
      .eq("id", exhaustedId);
    await rotateToNextKey(exhaustedId, log);
  } catch (err) {
    log(`[scraperapi] rotation write failed (non-fatal): ${err}`);
  }
}

/**
 * Rotate `is_active` to the next key that isn't exhausted today, WITHOUT
 * marking the current one exhausted. Used for captcha/challenge rotation
 * (a healthy key that just got a captcha should stay healthy — we just want
 * a different residential IP for the next attempt).
 */
async function rotateToNextKey(
  currentId: string,
  log: (msg: string) => void,
): Promise<void> {
  const sb = getSupabaseClient();
  const today = todayStr();
  try {
    const { data } = await sb
      .from("scraper_api_keys")
      .select("id, key_value, exhausted_on")
      .order("label", { ascending: true });
    const next = (data ?? []).find(
      (r) => r.id !== currentId && r.exhausted_on !== today,
    );
    if (next) {
      // Clear active on all, then set the chosen one.
      await sb
        .from("scraper_api_keys")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .neq("id", "00000000-0000-0000-0000-000000000000");
      await sb
        .from("scraper_api_keys")
        .update({ is_active: true, updated_at: new Date().toISOString() })
        .eq("id", next.id);
      log(
        `[scraperapi] rotated active → key ${(next.key_value ?? "").slice(0, 6)}`,
      );
    } else {
      log(`[scraperapi] no other healthy key to rotate to.`);
    }
    invalidateKeysCache();
  } catch (err) {
    log(`[scraperapi] rotation write failed (non-fatal): ${err}`);
  }
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Fetch a URL through ScraperAPI with automatic key rotation. Returns
 * { ok, html } on success or a structured failure. Never throws — always
 * returns a result object.
 */
export async function fetchViaScraperApi(opts: {
  url: string;
  render?: boolean;
  countryCode?: string;
  log?: (msg: string) => void;
}): Promise<ScraperApiResult> {
  const { url, render = false, countryCode, log = console.log } = opts;

  // Track which keys we've tried in this call so we don't infinite-loop.
  const tried = new Set<string>();
  const maxTries = 5;
  // Track consecutive timeouts per key — after 2, rotate away from it so a
  // flaky key doesn't wedge Indeed (ScraperAPI can hang on some keys while
  // others work).
  const timeoutCount = new Map<string, number>();
  const TIMEOUT_ROTATE_THRESHOLD = 2;

  for (let attempt = 0; attempt < maxTries; attempt++) {
    const apiKey = await getActiveScraperApiKey();
    if (!apiKey) {
      log(`[scraperapi] No key available (all exhausted today) — skipping`);
      return { ok: false, error: "no_api_key" };
    }
    if (tried.has(apiKey)) {
      log(`[scraperapi] all ${tried.size} key(s) exhausted — giving up`);
      return { ok: false, error: "no_api_key" };
    }
    tried.add(apiKey);

    const apiUrl = new URL(SCRAPERAPI_BASE);
    apiUrl.searchParams.set("api_key", apiKey);
    apiUrl.searchParams.set("url", url);
    apiUrl.searchParams.set("render", render ? "true" : "false");
    if (countryCode) apiUrl.searchParams.set("country_code", countryCode);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);
      let res: Response;
      try {
        res = await fetch(apiUrl.toString(), { signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        // Credits exhausted → rotate + retry with next key.
        if (
          res.status === 403 &&
          bodyText.includes(EXHAUSTED_MARKER)
        ) {
          log(`[scraperapi] key exhausted (403 credits) — rotating...`);
          const rows = await loadKeys();
          const row = rows.find((r) => r.key_value === apiKey);
          if (row) {
            await rotateAfterExhaustion(row.id, log);
          }
          continue; // retry with the (newly active) key
        }
        log(`[scraperapi] ${url} → HTTP ${res.status} ${bodyText.slice(0, 80)}`);
        return { ok: false, error: "upstream", status: res.status };
      }

      const html = await res.text();
      if (!html || html.length < 50) {
        log(`[scraperapi] ${url} → empty body`);
        return { ok: false, error: "empty" };
      }
      // Detect a challenge page even through ScraperAPI
      const lower = html.slice(0, 4000).toLowerCase();
      const isChallenge =
        lower.includes("cf-chl") ||
        lower.includes("challenge-platform") ||
        lower.includes("just a moment") ||
        lower.includes("captcha");
      if (isChallenge) {
        log(`[scraperapi] ${url} → challenge page returned`);
        // A challenge/captcha is often IP-based — rotate to a DIFFERENT key
        // (fresh residential IP) and retry before giving up. The current key
        // stays healthy (not marked exhausted); we just pick a different one.
        const rows = await loadKeys();
        const row = rows.find((r) => r.key_value === apiKey);
        if (row) {
          await rotateToNextKey(row.id, log);
          log(`[scraperapi] challenge — rotated away from key ${apiKey.slice(0, 6)}`);
          continue; // retry with the (newly active) key
        }
        return { ok: false, error: "challenge" };
      }
      return { ok: true, html };
    } catch (err) {
      const isAbort = (err as Error)?.name === "AbortError";
      const n = (timeoutCount.get(apiKey) ?? 0) + 1;
      timeoutCount.set(apiKey, n);
      log(
        `[scraperapi] ${url} error: ${err} (key ${apiKey.slice(0, 6)} timeout #${n})`,
      );

      // Rotate away from a key that keeps timing out (likely flaky/hung).
      if (isAbort && n >= TIMEOUT_ROTATE_THRESHOLD) {
        log(`[scraperapi] key ${apiKey.slice(0, 6)} timed out ${n}x — rotating...`);
        const rows = await loadKeys();
        const row = rows.find((r) => r.key_value === apiKey);
        if (row) {
          await rotateAfterExhaustion(row.id, log);
        }
        continue; // retry with the (newly active) key
      }
      // Don't consume all tries on the first timeout — but a single timeout
      // with no fallback just returns it (the board will report timeout).
      return { ok: false, error: "timeout", detail: String(err) };
    }
  }

  log(`[scraperapi] exhausted all attempts`);
  return { ok: false, error: "no_api_key" };
}

/** Whether ScraperAPI has ANY key available today (async now). */
export async function isScraperApiConfigured(): Promise<boolean> {
  return scraperApiAvailableToday();
}


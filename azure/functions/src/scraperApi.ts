// ============================================================
//  scraperApi.ts — ScraperAPI as the FINAL fallback for ALL job
//  boards when every other method fails.
//
//  Fallback order (in cloudflareProxy.ts):
//    1. Cloudflare proxy worker (jobboard-proxy)
//    2. DataImpulse residential proxy (directProxy.ts)
//    3. ScraperAPI (THIS) — last resort for anti-bot-hard boards
//
//  ScraperAPI fetches a URL through its own proxy infra with
//  realistic rendering. We use render=false for listing HTML
//  (the mosaic/RSC/next-data JSON is in the SSR HTML) and
//  render=true as an option for JS-heavy detail pages.
// ============================================================

export interface ScraperApiResult {
  ok: boolean;
  html?: string;
  error?: string;
  status?: number;
  detail?: string;
}

const SCRAPERAPI_BASE = "http://api.scraperapi.com";

function getApiKey(): string | undefined {
  return process.env.SCRAPERAPI_KEY;
}

/**
 * Fetch a URL through ScraperAPI. Returns { ok, html } on success or a
 * structured failure. Never throws — always returns a result object.
 */
export async function fetchViaScraperApi(opts: {
  url: string;
  render?: boolean;
  countryCode?: string;
  log?: (msg: string) => void;
}): Promise<ScraperApiResult> {
  const { url, render = false, countryCode, log = console.log } = opts;
  const apiKey = getApiKey();
  if (!apiKey) {
    log(`[scraperapi] SCRAPERAPI_KEY not set — skipping ScraperAPI fallback`);
    return { ok: false, error: "no_api_key" };
  }

  const apiUrl = new URL(SCRAPERAPI_BASE);
  apiUrl.searchParams.set("api_key", apiKey);
  apiUrl.searchParams.set("url", url);
  apiUrl.searchParams.set("render", render ? "true" : "false");
  if (countryCode) apiUrl.searchParams.set("country_code", countryCode);

  try {
    const controller = new AbortController();
    // ScraperAPI can be slow, but we must FAIL FAST so a single slow board
    // doesn't hold up the whole parallel run (which would hit the function
    // timeout before finalizing). 25s is enough for a normal fetch.
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    try {
      const res = await fetch(apiUrl.toString(), {
        signal: controller.signal,
      });
      if (!res.ok) {
        log(`[scraperapi] ${url} → HTTP ${res.status}`);
        return { ok: false, error: "upstream", status: res.status };
      }
      const html = await res.text();
      if (!html || html.length < 50) {
        log(`[scraperapi] ${url} → empty body`);
        return { ok: false, error: "empty" };
      }
      // Detect a challenge page even through ScraperAPI
      const lower = html.slice(0, 4000).toLowerCase();
      if (
        lower.includes("cf-chl") ||
        lower.includes("challenge-platform") ||
        lower.includes("just a moment") ||
        lower.includes("captcha")
      ) {
        log(`[scraperapi] ${url} → challenge page returned`);
        return { ok: false, error: "challenge" };
      }
      return { ok: true, html };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    log(`[scraperapi] ${url} error: ${err}`);
    return { ok: false, error: "timeout", detail: String(err) };
  }
}

/** Whether ScraperAPI is configured (so callers can skip the attempt). */
export function isScraperApiConfigured(): boolean {
  return Boolean(process.env.SCRAPERAPI_KEY);
}

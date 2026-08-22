// ============================================================
//  proxyFetch.ts — legacy-path helper to route ALL job-board
//  fetches through the Cloudflare jobboard-proxy Worker.
//
//  This is the SAME proxy the Azure Functions use. No ScraperAPI,
//  no direct datacenter fetches. The proxy returns raw HTML/JSON
//  with realistic headers + UA rotation + KV cache + politeness.
//
//  Contract (from cloudflare/jobboard-proxy):
//    GET {CLOUDFLARE_PROXY_URL}/{board}?keyword=&page=&countryCode=
//      → { ok:true, html } | { ok:false, error, retryAfter? }
//    GET {CLOUDFLARE_PROXY_URL}/{board}/detail?url=...
//      → { ok:true, html } | { ok:false, error, retryAfter? }
// ============================================================

export interface ProxyResult {
  ok: boolean;
  html?: string;
  error?: string;
  retryAfter?: number;
  detail?: string;
}

const PROXY_URL = () => process.env.CLOUDFLARE_PROXY_URL ?? "";
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1500;

async function proxyGet(
  url: string,
  log: (msg: string) => void,
): Promise<ProxyResult> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const body = (await res.json()) as ProxyResult;
      if (body.ok) return body;

      const retryable = ["timeout", "upstream", "rate_limited"].includes(
        body.error ?? "",
      );
      if (!retryable) return body;
      const waitMs =
        (body.retryAfter ?? 0) * 1000 || BASE_BACKOFF_MS * 2 ** attempt;
      log(
        `[proxy] attempt ${attempt + 1} got ${body.error}, waiting ${waitMs}ms`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    } catch (err) {
      log(`[proxy] attempt ${attempt + 1}/${MAX_ATTEMPTS} error: ${err}`);
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, BASE_BACKOFF_MS * 2 ** attempt));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return { ok: false, error: "upstream" };
}

/**
 * Fetch a board SEARCH page through the Cloudflare proxy.
 * @returns the raw HTML, or throws on non-recoverable failure.
 */
export async function fetchBoardPageViaProxy(opts: {
  board: string;
  keyword: string;
  page?: number;
  countryCode?: string;
  log?: (msg: string) => void;
}): Promise<string> {
  const { board, keyword, page = 1, countryCode, log = console.log } = opts;
  const base = PROXY_URL();
  if (!base) {
    throw new Error("CLOUDFLARE_PROXY_URL not set — cannot scrape via proxy");
  }
  const url = new URL(`/${board}`, base);
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("page", String(page));
  if (countryCode) url.searchParams.set("countryCode", countryCode);

  const result = await proxyGet(url.toString(), log);
  if (!result.ok || result.html == null) {
    throw new Error(
      `proxy ${board} failed: ${result.error ?? "unknown"}${result.retryAfter ? ` (retryAfter ${result.retryAfter})` : ""}`,
    );
  }
  return result.html;
}

/**
 * Fetch an arbitrary URL on a board's domain through the proxy's
 * detail mode (used for job detail pages AND the Indeed RPC batch).
 */
export async function fetchUrlViaProxy(opts: {
  board: string;
  url: string;
  log?: (msg: string) => void;
}): Promise<string> {
  const { board, url, log = console.log } = opts;
  const base = PROXY_URL();
  if (!base) {
    throw new Error("CLOUDFLARE_PROXY_URL not set — cannot scrape via proxy");
  }
  const proxyUrl = new URL(`/${board}/detail`, base);
  proxyUrl.searchParams.set("url", url);

  const result = await proxyGet(proxyUrl.toString(), log);
  if (!result.ok || result.html == null) {
    throw new Error(
      `proxy ${board} detail failed: ${result.error ?? "unknown"}${result.retryAfter ? ` (retryAfter ${result.retryAfter})` : ""}`,
    );
  }
  return result.html;
}

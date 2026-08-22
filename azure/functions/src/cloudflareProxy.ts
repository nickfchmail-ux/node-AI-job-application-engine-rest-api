// ============================================================
//  Cloudflare proxy client — the ONLY way Azure Functions reach
//  job boards. Wraps the jobboard-proxy Worker with retries and
//  retryAfter handling.
//
//  Fallback: when the Cloudflare worker is blocked (datacenter
//  IP), the functions fall back to the DataImpulse residential
//  proxy (see directProxy.ts).
// ============================================================

import { fetchBoardDirect, fetchDetailDirect } from "./directProxy";
import { fetchViaScraperApi, isScraperApiConfigured } from "./scraperApi";
import { getBoardPattern } from "./boardRegistry";

export interface ProxySuccess {
  ok: true;
  html: string;
  cached?: boolean;
}

export interface ProxyFailure {
  ok: false;
  error:
    | "blocked"
    | "rate_limited"
    | "challenge"
    | "timeout"
    | "not_found"
    | "upstream"
    | "missing_keyword"
    | "method_not_allowed"
    | "forbidden_origin"
    | "bad_proxy_config";
  retryAfter?: number;
  status?: number;
  detail?: string;
}

export type ProxyResult = ProxySuccess | ProxyFailure;

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1500;

/**
 * Fetch a job board search page through the Cloudflare proxy.
 * Retries on 5xx/blocked/challenge/timeout with exponential backoff,
 * honouring retryAfter seconds from the worker.
 */
export async function fetchBoardPage(opts: {
  board: string;
  keyword: string;
  page: number;
  countryCode?: string;
  log?: (msg: string) => void;
}): Promise<ProxyResult> {
  const { board, keyword, page, countryCode, log = console.log } = opts;

  // ── Boards that block datacenter IPs (jobsdb returns 403 to Cloudflare) ──
  // Try the DataImpulse residential proxy FIRST — residential IPs pass
  // anti-bot, whereas the Cloudflare worker's datacenter egress gets 403'd.
  const pattern = getBoardPattern(board);
  const dcBlocked = pattern?.antiBot.datacenterBlocked === true;
  if (dcBlocked) {
    const direct = await fetchBoardDirect({
      board,
      keyword,
      page,
      countryCode,
      log,
    });
    if (direct.ok && direct.html) {
      log(`[proxy] ${board} p${page} OK via residential (datacenter-blocked board)`);
      return { ok: true, html: direct.html };
    }
    log(
      `[proxy] ${board} residential-first failed (${direct.error}${direct.detail ? ` ${direct.detail}` : ""}) — falling back to Cloudflare worker`,
    );
  }

  const base = process.env.CLOUDFLARE_PROXY_URL;
  if (!base) {
    const msg = "CLOUDFLARE_PROXY_URL is not set";
    log(`[proxy] ${msg}`);
    return { ok: false, error: "upstream" };
  }

  const url = new URL(`/${board}`, base);
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("page", String(page));
  if (countryCode) url.searchParams.set("countryCode", countryCode);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      const body = (await res.json()) as ProxyResult;

      if (body.ok) return body;

      // Hard anti-bot blocks — don't waste retries; break out to the
      // residential + ScraperAPI fallbacks below (so ScraperAPI is ALWAYS
      // tried as the final resort, even on a hard block).
      if (body.error === "blocked" || body.error === "challenge") {
        log(
          `[proxy] ${board} got ${body.error} — trying residential + ScraperAPI fallbacks`,
        );
        break;
      }

      // Retryable errors: timeout, upstream, rate_limited
      const retryable = ["timeout", "upstream", "rate_limited"].includes(
        body.error,
      );
      if (!retryable) {
        log(`[proxy] ${board} non-retryable error: ${body.error}`);
        return body;
      }

      const waitMs =
        (body.retryAfter ?? 0) * 1000 || BASE_BACKOFF_MS * 2 ** attempt;
      log(
        `[proxy] ${board} attempt ${attempt + 1}/${MAX_ATTEMPTS} got ${body.error}, waiting ${waitMs}ms`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    } catch (err) {
      log(
        `[proxy] ${board} attempt ${attempt + 1}/${MAX_ATTEMPTS} fetch error: ${err}`,
      );
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, BASE_BACKOFF_MS * 2 ** attempt));
      }
    }
  }

  log(`[proxy] ${board} gave up after ${MAX_ATTEMPTS} attempts`);

  // ── Fallback 1: try the DataImpulse residential proxy directly ──
  const direct = await fetchBoardDirect({
    board,
    keyword,
    page,
    countryCode,
    log,
  });
  if (direct.ok && direct.html) {
    return { ok: true, html: direct.html };
  }
  log(
    `[proxy] ${board} direct fallback also failed: ${direct.error} detail=${direct.detail ?? ""}`,
  );

  // ── Fallback 2 (FINAL): ScraperAPI — last resort for anti-bot-hard boards ──
  const target = getBoardSearchUrl(board, keyword, page, countryCode);
  if (target && isScraperApiConfigured()) {
    log(`[scraperapi] ${board} — trying ScraperAPI as final fallback...`);
    const sa = await fetchViaScraperApi({
      url: target,
      countryCode,
      log,
    });
    if (sa.ok && sa.html) return { ok: true, html: sa.html };
    log(
      `[scraperapi] ${board} ScraperAPI also failed: ${sa.error}${sa.detail ? ` (${sa.detail})` : ""}`,
    );
    return {
      ok: false,
      error: (sa.error ?? "upstream") as ProxyFailure["error"],
      detail: sa.detail,
    };
  }

  return {
    ok: false,
    error: direct.error ?? "upstream",
    detail: direct.detail,
  };
}

/**
 * Fetch a single job DETAIL page verbatim through the Cloudflare
 * proxy (GET /<board>/detail?url=<job-url>). Used by the job
 * processor to scrape the full job content for each post.
 */
export async function fetchJobDetail(opts: {
  board: string;
  url: string;
  log?: (msg: string) => void;
}): Promise<ProxyResult> {
  const { board, url, log = console.log } = opts;
  const base = process.env.CLOUDFLARE_PROXY_URL;
  if (!base) {
    const msg = "CLOUDFLARE_PROXY_URL is not set";
    log(`[proxy] ${msg}`);
    return { ok: false, error: "upstream" };
  }

  const proxyUrl = new URL(`/${board}/detail`, base);
  proxyUrl.searchParams.set("url", url);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(proxyUrl.toString(), {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      const body = (await res.json()) as ProxyResult;

      if (body.ok) return body;

      // Hard anti-bot blocks — break out to the residential + ScraperAPI
      // fallbacks so ScraperAPI is ALWAYS tried as the final resort.
      if (body.error === "blocked" || body.error === "challenge") {
        log(
          `[proxy] ${board} detail got ${body.error} — trying residential + ScraperAPI fallbacks`,
        );
        break;
      }

      const retryable = ["timeout", "upstream", "rate_limited"].includes(
        body.error,
      );
      if (!retryable) {
        log(`[proxy] ${board} detail non-retryable error: ${body.error}`);
        return body;
      }

      const waitMs =
        (body.retryAfter ?? 0) * 1000 || BASE_BACKOFF_MS * 2 ** attempt;
      log(
        `[proxy] ${board} detail attempt ${attempt + 1}/${MAX_ATTEMPTS} got ${body.error}, waiting ${waitMs}ms`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    } catch (err) {
      log(
        `[proxy] ${board} detail attempt ${attempt + 1}/${MAX_ATTEMPTS} fetch error: ${err}`,
      );
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, BASE_BACKOFF_MS * 2 ** attempt));
      }
    }
  }

  log(`[proxy] ${board} detail gave up after ${MAX_ATTEMPTS} attempts`);

  // ── Fallback 1: try the DataImpulse residential proxy directly ──
  const direct = await fetchDetailDirect({ board, url, log });
  if (direct.ok && direct.html) {
    return { ok: true, html: direct.html };
  }
  log(
    `[proxy] ${board} detail fallback also failed: ${direct.error} detail=${direct.detail ?? ""}`,
  );

  // ── Fallback 2 (FINAL): ScraperAPI for JS-heavy / hard-blocked detail pages ──
  if (isScraperApiConfigured()) {
    log(`[scraperapi] ${board} detail — trying ScraperAPI render=true...`);
    const sa = await fetchViaScraperApi({ url, render: true, log });
    if (sa.ok && sa.html) return { ok: true, html: sa.html };
    log(
      `[scraperapi] ${board} detail ScraperAPI failed: ${sa.error}${sa.detail ? ` (${sa.detail})` : ""}`,
    );
    return {
      ok: false,
      error: (sa.error ?? "upstream") as ProxyFailure["error"],
      detail: sa.detail,
    };
  }

  return {
    ok: false,
    error: direct.error ?? "upstream",
    detail: direct.detail,
  };
}

/**
 * Fetch an ARBITRARY URL on a board's domain through the Cloudflare proxy
 * (the worker's /<board>/detail mode fetches any URL whose host matches the
 * board's base domain). This is the single path for ALL scraping — no
 * ScraperAPI, no direct datacenter fetches. Used for things like Indeed's
 * RPC batch description endpoint (hk.indeed.com/rpc/jobdescs?jks=...).
 *
 * Retries with backoff; falls back to the DataImpulse residential proxy on
 * hard anti-bot blocks, matching fetchJobDetail.
 */
export async function fetchViaProxy(opts: {
  board: string;
  url: string;
  log?: (msg: string) => void;
}): Promise<ProxyResult> {
  const { board, url, log = console.log } = opts;
  const base = process.env.CLOUDFLARE_PROXY_URL;
  if (!base) {
    log(`[proxy] CLOUDFLARE_PROXY_URL is not set`);
    return { ok: false, error: "upstream" };
  }

  const proxyUrl = new URL(`/${board}/detail`, base);
  proxyUrl.searchParams.set("url", url);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(proxyUrl.toString(), {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const body = (await res.json()) as ProxyResult;

      if (body.ok) return body;

      if (body.error === "blocked" || body.error === "challenge") {
        log(
          `[proxy] ${board} ${url} got ${body.error} — trying residential + ScraperAPI fallbacks`,
        );
        break;
      }

      const retryable = ["timeout", "upstream", "rate_limited"].includes(
        body.error,
      );
      if (!retryable) {
        log(`[proxy] ${board} ${url} non-retryable error: ${body.error}`);
        return body;
      }

      const waitMs =
        (body.retryAfter ?? 0) * 1000 || BASE_BACKOFF_MS * 2 ** attempt;
      log(
        `[proxy] ${board} ${url} attempt ${attempt + 1}/${MAX_ATTEMPTS} got ${body.error}, waiting ${waitMs}ms`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    } catch (err) {
      log(
        `[proxy] ${board} ${url} attempt ${attempt + 1}/${MAX_ATTEMPTS} fetch error: ${err}`,
      );
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, BASE_BACKOFF_MS * 2 ** attempt));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  log(`[proxy] ${board} ${url} gave up after ${MAX_ATTEMPTS} attempts`);

  // ── Fallback 1: DataImpulse residential ──
  const direct = await fetchDetailDirect({ board, url, log });
  if (direct.ok && direct.html) return { ok: true, html: direct.html };

  // ── Fallback 2 (FINAL): ScraperAPI ──
  if (isScraperApiConfigured()) {
    log(`[scraperapi] ${board} ${url} — trying ScraperAPI render=true...`);
    const sa = await fetchViaScraperApi({ url, render: true, log });
    if (sa.ok && sa.html) return { ok: true, html: sa.html };
    log(
      `[scraperapi] ${board} ${url} ScraperAPI failed: ${sa.error}${sa.detail ? ` (${sa.detail})` : ""}`,
    );
    return {
      ok: false,
      error: (sa.error ?? "upstream") as ProxyFailure["error"],
      detail: sa.detail,
    };
  }

  return { ok: false, error: "upstream" };
}

/**
 * Build the board search URL (same searchPath logic as the jobboard-proxy
 * worker). Used by the ScraperAPI fallback so we can pass a concrete URL.
 */
function getBoardSearchUrl(
  board: string,
  keyword: string,
  page: number,
  countryCode?: string,
): string | null {
  const clean = keyword.trim().toLowerCase();
  const encoded = encodeURIComponent(keyword.trim());
  switch (board) {
    case "jobsdb": {
      const slug = clean.replace(/[^a-z0-9\s-]+/g, "").replace(/\s+/g, "-");
      return slug
        ? `https://hk.jobsdb.com/${slug}-jobs/in-hong-kong?page=${page}`
        : `https://hk.jobsdb.com/${encoded}-jobs/in-hong-kong?page=${page}`;
    }
    case "ctgoodjobs":
      return `https://jobs.ctgoodjobs.hk/jobs?q=${encoded}&page=${page}`;
    case "indeed": {
      const base =
        countryCode === "hk"
          ? "https://hk.indeed.com"
          : "https://www.indeed.com";
      return `${base}/jobs?q=${encoded}&start=${(page - 1) * 10}`;
    }
    case "offertoday":
      return `https://www.offertoday.com/search?q=${encoded}&page=${page}`;
    case "linkedin":
      return `https://www.linkedin.com/jobs/search?keywords=${encoded}&location=Hong+Kong&start=${(page - 1) * 10}`;
    default:
      return null;
  }
}

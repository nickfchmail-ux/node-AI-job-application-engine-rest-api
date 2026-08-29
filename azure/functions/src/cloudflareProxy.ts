// ============================================================
//  Cloudflare proxy client — the ONLY way Azure Functions reach
//  job boards. Wraps the jobboard-proxy Worker with retries and
//  retryAfter handling.
//
//  Fallback: when the Cloudflare worker is blocked (datacenter
//  IP), the functions fall back to the DataImpulse residential
//  proxy (see directProxy.ts).
// ============================================================

import { getBoardPattern } from "./boardRegistry";
import { fetchBoardDirect, fetchDetailDirect } from "./directProxy";
import { fetchViaScraperApi, isScraperApiConfigured } from "./scraperApi";

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
 * ── Circuit breaker / path memory ─────────────────────────────────────────
 * Remembers which fetch path actually worked for each board so a board that
 * is consistently blocked on one path (e.g. DataImpulse residential timing
 * out from Azure) skips straight to the known-good path on the NEXT page or
 * NEXT run — no wasted 45s timeouts per attempt.
 *
 * `pathScores[board][path]` counts successes; we pick the path with the
 * highest success count first. A path that has NEVER succeeded is tried last
 * (it might work for a different page/network), but a path with a bad streak
 * of failures is deprioritised.
 *
 * This is in-process state (per function instance) — good enough for the
 * steady-state within a single run and across a warm instance.
 */
type FetchPath = "residential" | "cloudflare" | "scraperapi" | "public";
const pathScores: Record<string, Partial<Record<FetchPath, number>>> = {};
const pathFailures: Record<string, Partial<Record<FetchPath, number>>> = {};

function bumpPath(board: string, path: FetchPath, ok: boolean): void {
  if (!pathScores[board]) pathScores[board] = {};
  if (!pathFailures[board]) pathFailures[board] = {};
  if (ok) {
    pathScores[board]![path] = (pathScores[board]![path] ?? 0) + 1;
    // A success clears the failure streak so a flaky path gets retried later.
    pathFailures[board]![path] = 0;
  } else {
    pathFailures[board]![path] = (pathFailures[board]![path] ?? 0) + 1;
  }
}

/** Order paths best-first using success counts, honouring a hard skip list. */
function orderPaths(
  board: string,
  candidates: FetchPath[],
  skip: FetchPath[] = [],
): FetchPath[] {
  const score = (p: FetchPath) => pathScores[board]?.[p] ?? 0;
  const failStreak = (p: FetchPath) => pathFailures[board]?.[p] ?? 0;
  return [...candidates]
    .filter((p) => !skip.includes(p))
    .sort((a, b) => {
      // A path with a long failure streak is demoted hard (tried last).
      const aBlocked = failStreak(a) >= 2 && score(a) === 0;
      const bBlocked = failStreak(b) >= 2 && score(b) === 0;
      if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
      return score(b) - score(a);
    });
}

/** Short helper: try a DataImpulse residential fetch with a hard per-attempt cap. */
const RESIDENTIAL_ATTEMPT_TIMEOUT_MS = 20_000; // was 45s in directProxy — cap harder
const RESIDENTIAL_MAX_ATTEMPTS = 2;

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
  // DataImpulse rate-limits (429) after a few rapid requests, so retry with
  // backoff; if residential is exhausted, go STRAIGHT to ScraperAPI (paid
  // rotating IPs) — skipping the doomed Cloudflare worker (403).
  const pattern = getBoardPattern(board);
  const dcBlocked = pattern?.antiBot.datacenterBlocked === true;
  if (dcBlocked) {
    // ── Circuit-breaker-aware path ordering ────────────────────────────────
    // Try paths in order of prior success, skipping known-dead ones. For
    // datacenter-blocked boards the candidates are:
    //   residential (DataImpulse) → scraperapi (paid, rotating IPs) → cloudflare
    // The circuit breaker demotes a path with a failure streak so we don't
    // burn 45s+ on residential when it has failed 2+ times already.
    const candidates: FetchPath[] = ["residential", "scraperapi", "cloudflare"];
    const ordered = orderPaths(board, candidates);
    let lastErr: { error?: string; detail?: string } | null = null;

    for (const path of ordered) {
      if (path === "residential") {
        const retryable = ["rate_limited", "timeout", "upstream"];
        let residentialOk = false;
        for (let attempt = 0; attempt < RESIDENTIAL_MAX_ATTEMPTS; attempt++) {
          const direct = await fetchBoardDirect({
            board,
            keyword,
            page,
            countryCode,
            log,
          });
          if (direct.ok && direct.html) {
            residentialOk = true;
            bumpPath(board, "residential", true);
            log(
              `[proxy] ${board} p${page} OK via residential (datacenter-blocked board)`,
            );
            return { ok: true, html: direct.html };
          }
          lastErr = direct;
          const retry = direct.error && retryable.includes(direct.error);
          log(
            `[proxy] ${board} residential attempt ${attempt + 1}/${RESIDENTIAL_MAX_ATTEMPTS} got ${direct.error}${direct.detail ? ` ${direct.detail}` : ""}${retry ? " — retrying" : ""}`,
          );
          if (!retry) break;
          if (attempt < RESIDENTIAL_MAX_ATTEMPTS - 1) {
            await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
          }
        }
        if (!residentialOk) bumpPath(board, "residential", false);
      }

      if (path === "scraperapi") {
        // ScraperAPI (rotating residential IPs) is the reliable paid answer
        // for datacenter-blocked boards. IMPORTANT COST CONSTRAINT: only use
        // it for Indeed — NEVER JobsDB/CTgoodjobs (the user's most-searched
        // boards) because every ScraperAPI call costs money. Those boards must
        // rely on residential (DataImpulse) + Cloudflare only.
        const scraperBoards = new Set(["indeed"]);
        const target = getBoardSearchUrl(board, keyword, page, countryCode);
        if (
          scraperBoards.has(board) &&
          target &&
          (await isScraperApiConfigured())
        ) {
          log(
            `[scraperapi] ${board} p${page} — trying ScraperAPI (rotating IPs)...`,
          );
          const sa = await fetchViaScraperApi({
            url: target,
            countryCode,
            log,
          });
          if (sa.ok && sa.html) {
            bumpPath(board, "scraperapi", true);
            return { ok: true, html: sa.html };
          }
          bumpPath(board, "scraperapi", false);
          lastErr = {
            error: sa.error ?? "upstream",
            detail: sa.detail,
          };
          log(
            `[scraperapi] ${board} ScraperAPI failed: ${sa.error}${sa.detail ? ` (${sa.detail})` : ""}`,
          );
        }
      }

      if (path === "cloudflare") {
        // Last resort for dcBlocked boards — the Cloudflare worker's datacenter
        // egress usually 403s, but try it once (it may work for some networks).
        const base = process.env.CLOUDFLARE_PROXY_URL;
        if (base) {
          const url = new URL(`/${board}`, base);
          url.searchParams.set("keyword", keyword);
          url.searchParams.set("page", String(page));
          if (countryCode) url.searchParams.set("countryCode", countryCode);
          try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 15000);
            const res = await fetch(url.toString(), {
              headers: { Accept: "application/json" },
              signal: controller.signal,
            });
            clearTimeout(t);
            const body = (await res.json()) as ProxyResult;
            if (body.ok) {
              bumpPath(board, "cloudflare", true);
              return body;
            }
            bumpPath(board, "cloudflare", false);
            lastErr = { error: body.error, detail: body.detail };
            log(`[proxy] ${board} Cloudflare worker: ${body.error}`);
          } catch (err) {
            bumpPath(board, "cloudflare", false);
            log(`[proxy] ${board} Cloudflare worker fetch error: ${err}`);
          }
        }
      }
    }

    // All paths failed on this page. Return the most useful error.
    log(`[proxy] ${board} p${page} all paths failed`);
    return {
      ok: false,
      error: (lastErr?.error ?? "upstream") as ProxyFailure["error"],
      detail: lastErr?.detail,
    };
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

  let cloudflareFailed = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      const body = (await res.json()) as ProxyResult;

      if (body.ok) {
        bumpPath(board, "cloudflare", true);
        return body;
      }

      // Hard anti-bot blocks — don't waste retries; break out to the
      // residential + ScraperAPI fallbacks below (so ScraperAPI is ALWAYS
      // tried as the final resort, even on a hard block).
      if (body.error === "blocked" || body.error === "challenge") {
        cloudflareFailed = true;
        bumpPath(board, "cloudflare", false);
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
        bumpPath(board, "cloudflare", false);
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
      cloudflareFailed = true;
      log(
        `[proxy] ${board} attempt ${attempt + 1}/${MAX_ATTEMPTS} fetch error: ${err}`,
      );
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, BASE_BACKOFF_MS * 2 ** attempt));
      }
    }
  }

  log(`[proxy] ${board} gave up after ${MAX_ATTEMPTS} attempts`);
  if (cloudflareFailed) bumpPath(board, "cloudflare", false);

  // ── Fallback 1: try the DataImpulse residential proxy directly ──
  const direct = await fetchBoardDirect({
    board,
    keyword,
    page,
    countryCode,
    log,
  });
  if (direct.ok && direct.html) {
    bumpPath(board, "residential", true);
    return { ok: true, html: direct.html };
  }
  bumpPath(board, "residential", false);
  log(
    `[proxy] ${board} direct fallback also failed: ${direct.error} detail=${direct.detail ?? ""}`,
  );

  // ── Fallback 2 (FINAL): ScraperAPI — last resort for anti-bot-hard boards ──
  // ScraperAPI rotating IPs are the reliable last answer for Indeed.
  // IMPORTANT COST CONSTRAINT: NEVER use ScraperAPI for JobsDB/CTgoodjobs
  // (the user's most-searched boards) — every call costs money. They must
  // rely on residential (DataImpulse) + Cloudflare only.
  const scraperBoards = new Set(["indeed"]);
  const target = getBoardSearchUrl(board, keyword, page, countryCode);
  if (scraperBoards.has(board) && target && (await isScraperApiConfigured())) {
    log(`[scraperapi] ${board} — trying ScraperAPI as final fallback...`);
    const sa = await fetchViaScraperApi({
      url: target,
      countryCode,
      log,
    });
    if (sa.ok && sa.html) {
      bumpPath(board, "scraperapi", true);
      return { ok: true, html: sa.html };
    }
    bumpPath(board, "scraperapi", false);
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
  // Only Indeed uses ScraperAPI — other boards must not spend ScraperAPI
  // credits on detail fetches. render=false: Indeed's HTML (including the
  // RPC description payload) is server-rendered; render=true hangs on
  // Indeed's anti-bot and times out.
  if (board === "indeed" && (await isScraperApiConfigured())) {
    log(`[scraperapi] ${board} detail — trying ScraperAPI (render=false)...`);
    const sa = await fetchViaScraperApi({ url, render: false, log });
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
  // Only Indeed uses ScraperAPI; other boards never spend credits.
  // render=false (render=true hangs on Indeed's anti-bot).
  if (board === "indeed" && (await isScraperApiConfigured())) {
    log(`[scraperapi] ${board} ${url} — trying ScraperAPI (render=false)...`);
    const sa = await fetchViaScraperApi({ url, render: false, log });
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

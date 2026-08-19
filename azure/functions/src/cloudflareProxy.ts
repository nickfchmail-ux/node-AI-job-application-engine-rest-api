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
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      const body = (await res.json()) as ProxyResult;

      if (body.ok) return body;

      // Hard anti-bot blocks — don't waste retries, fall back to the
      // DataImpulse residential proxy immediately.
      if (body.error === "blocked" || body.error === "challenge") {
        log(
          `[proxy] ${board} got ${body.error} — falling back to residential proxy`,
        );
        const direct = await fetchBoardDirect({
          board,
          keyword,
          page,
          countryCode,
          log,
        });
        if (direct.ok && direct.html) return { ok: true, html: direct.html };
        log(
          `[proxy] ${board} direct fallback error: ${direct.error} status=${direct.status ?? "?"} detail=${direct.detail ?? ""}`,
        );
        return {
          ok: false,
          error: direct.error ?? "upstream",
          status: direct.status,
          detail: direct.detail,
        };
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

  // ── Fallback: try the DataImpulse residential proxy directly ──
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
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(proxyUrl.toString(), {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      const body = (await res.json()) as ProxyResult;

      if (body.ok) return body;

      // Hard anti-bot blocks — fall back to residential proxy immediately
      if (body.error === "blocked" || body.error === "challenge") {
        log(
          `[proxy] ${board} detail got ${body.error} — falling back to residential proxy`,
        );
        const direct = await fetchDetailDirect({ board, url, log });
        if (direct.ok && direct.html) return { ok: true, html: direct.html };
        return {
          ok: false,
          error: direct.error ?? "upstream",
          status: direct.status,
          detail: direct.detail,
        };
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

  // ── Fallback: try the DataImpulse residential proxy directly ──
  const direct = await fetchDetailDirect({ board, url, log });
  if (direct.ok && direct.html) {
    return { ok: true, html: direct.html };
  }
  log(
    `[proxy] ${board} detail fallback also failed: ${direct.error} detail=${direct.detail ?? ""}`,
  );
  return {
    ok: false,
    error: direct.error ?? "upstream",
    detail: direct.detail,
  };
}

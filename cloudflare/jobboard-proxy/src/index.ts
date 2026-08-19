// ============================================================
//  jobboard-proxy — Cloudflare Worker
//
//  The ONLY path through which Azure Functions scrape job
//  boards. Routes /<board>?keyword=&page=&countryCode= to the
//  underlying board, returns structured JSON:
//    { ok: true, html }            — success
//    { ok: false, error: "blocked"|"rate_limited"|"challenge"|"timeout"|"not_found"|"upstream", retryAfter? }
//
//  Features:
//    - per-board rate limiting (politeness)
//    - KV cache of successful responses (TTL) to relieve
//      upstream load + speed up repeated keyword/page fetches
//    - realistic browser headers + UA rotation
//    - structured errors on bot challenges (never fake data)
// ============================================================

export interface Env {
  // Optional — when not bound (KV-less deploy), caching is skipped gracefully
  JOBBOARD_KV?: KVNamespace;
  // Secrets (set via `wrangler secret put`)
  ALLOWED_ORIGINS?: string;
}

interface BoardConfig {
  name: string;
  baseUrl: string;
  searchPath: (keyword: string, page: number, countryCode?: string) => string;
}

// Boards supported by the platform. Keep in sync with src/scrapers/*.
const BOARDS: Record<string, BoardConfig> = {
  jobsdb: {
    name: "JobsDB HK",
    baseUrl: "https://hk.jobsdb.com",
    searchPath: (keyword, page) => {
      const clean = keyword.trim().toLowerCase();
      const slug = clean.replace(/[^a-z0-9\s-]+/g, "").replace(/\s+/g, "-");
      return slug
        ? `/${slug}-jobs/in-hong-kong?page=${page}`
        : `/${encodeURIComponent(keyword.trim())}-jobs/in-hong-kong?page=${page}`;
    },
  },
  ctgoodjobs: {
    name: "CTgoodjobs HK",
    baseUrl: "https://jobs.ctgoodjobs.hk",
    searchPath: (keyword, page) =>
      `/jobs?q=${encodeURIComponent(keyword.trim())}&page=${page}`,
  },
  indeed: {
    name: "Indeed",
    baseUrl: "https://hk.indeed.com",
    searchPath: (keyword, page, countryCode) => {
      const locale = countryCode === "hk" ? "hk" : "www";
      const base =
        locale === "hk" ? "https://hk.indeed.com" : "https://www.indeed.com";
      return `/jobs?q=${encodeURIComponent(keyword.trim())}&start=${(page - 1) * 10}`.replace(
        "https://www.indeed.com",
        base,
      );
    },
  },
  offertoday: {
    name: "OfferToday",
    baseUrl: "https://www.offertoday.com",
    searchPath: (keyword, page) =>
      `/search?q=${encodeURIComponent(keyword.trim())}&page=${page}`,
  },
};

// ── User-Agent rotation (avoid naive blocking) ──────────────────────────────
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
];

// ── Per-board politeness: min interval (ms) between requests ────────────────
const BOARD_MIN_INTERVAL_MS: Record<string, number> = {
  jobsdb: 1500,
  ctgoodjobs: 2000,
  indeed: 3000,
  offertoday: 2000,
};

// In-memory throttle state (per isolated worker instance)
const lastRequestAt: Record<string, number> = {};

function pickUA(): string {
  // crypto.getRandomValues is safe for non-security selection (UA rotation)
  const idx =
    crypto.getRandomValues(new Uint32Array(1))[0] % USER_AGENTS.length;
  return USER_AGENTS[idx];
}

function boardKey(board: string): BoardConfig | undefined {
  return BOARDS[board];
}

/** KV cache key: board|keyword|page|countryCode */
function cacheKey(
  board: string,
  keyword: string,
  page: number,
  countryCode?: string,
): string {
  return `${board}|${keyword.trim().toLowerCase()}|${page}|${countryCode ?? ""}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** KV cache helpers — no-op gracefully when KV is not bound (KV-less deploy). */
async function kvGet(env: Env, key: string): Promise<string | null> {
  if (!env.JOBBOARD_KV) return null;
  try {
    return await env.JOBBOARD_KV.get(key);
  } catch {
    return null;
  }
}
function kvPut(
  env: Env,
  ctx: ExecutionContext,
  key: string,
  value: string,
  ttl: number,
): void {
  if (!env.JOBBOARD_KV) return;
  ctx.waitUntil(env.JOBBOARD_KV.put(key, value, { expirationTtl: ttl }));
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname; // e.g. /jobsdb or /jobsdb/detail

    // ── Origin guard ─────────────────────────────────────────
    const origin = request.headers.get("origin");
    if (origin) {
      const allowed = (env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (allowed.length > 0 && !allowed.includes(origin)) {
        return json({ ok: false, error: "forbidden_origin" }, 403);
      }
    }

    // ── Only GET ─────────────────────────────────────────────
    if (request.method !== "GET") {
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }

    const segments = path.replace(/^\//, "").split("/").filter(Boolean);
    const board = (segments[0] ?? "").toLowerCase();
    const isDetail = segments[1] === "detail";
    const cfg = boardKey(board);

    if (!cfg) {
      return json(
        { ok: false, error: "not_found", boards: Object.keys(BOARDS) },
        404,
      );
    }

    // ── DETAIL mode: fetch a specific job page verbatim ──────
    if (isDetail) {
      const detailUrl = url.searchParams.get("url");
      if (!detailUrl) {
        return json({ ok: false, error: "missing_url" }, 400);
      }

      // Security: only allow URLs on this board's domain
      let target: URL;
      try {
        target = new URL(detailUrl);
      } catch {
        return json({ ok: false, error: "bad_url" }, 400);
      }
      const allowedHost = new URL(cfg.baseUrl).host;
      if (
        target.host !== allowedHost &&
        !target.host.endsWith(`.${allowedHost}`)
      ) {
        return json({ ok: false, error: "forbidden_url" }, 403);
      }

      // ── KV cache (fast path) ─────────────────────────────
      const dKey = `detail|${board}|${target.href}`;
      const cached = await kvGet(env, dKey);
      if (cached) {
        kvPut(env, ctx, dKey, cached, 600);
        return json({ ok: true, html: cached, cached: true });
      }

      // ── Politeness throttle ──────────────────────────────
      const since = Date.now() - (lastRequestAt[board] ?? 0);
      const minInterval = BOARD_MIN_INTERVAL_MS[board] ?? 2000;
      if (since < minInterval) {
        await new Promise((r) => setTimeout(r, minInterval - since));
      }
      lastRequestAt[board] = Date.now();

      const headers = new Headers({
        "User-Agent": pickUA(),
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        Referer: cfg.baseUrl + "/",
        Cookie: board === "ctgoodjobs" ? "culture=en-US" : "",
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);

      try {
        const resp = await fetch(target.href, {
          method: "GET",
          redirect: "follow",
          headers,
          signal: controller.signal,
        });

        if (resp.status === 403 || resp.status === 401) {
          return json(
            {
              ok: false,
              error: "blocked",
              retryAfter: 60,
              status: resp.status,
            },
            503,
          );
        }
        if (resp.status === 429) {
          const retryAfter =
            Number(resp.headers.get("retry-after") ?? 30) || 30;
          return json({ ok: false, error: "rate_limited", retryAfter }, 429);
        }
        if (resp.status === 404) {
          return json({ ok: false, error: "not_found", status: 404 }, 404);
        }
        if (!resp.ok) {
          return json(
            { ok: false, error: "upstream", status: resp.status },
            502,
          );
        }

        const html = await resp.text();

        // ── Challenge detection ────────────────────────────
        const lower = html.slice(0, 4000).toLowerCase();
        if (
          lower.includes("cf-chl") ||
          lower.includes("challenge-platform") ||
          lower.includes("__cf_chl_") ||
          lower.includes("px-captcha") ||
          lower.includes("captcha") ||
          lower.includes("just a moment")
        ) {
          return json({ ok: false, error: "challenge", retryAfter: 60 }, 503);
        }

        // ── Cache (10 min TTL) ─────────────────────────────
        kvPut(env, ctx, dKey, html, 600);

        return json({ ok: true, html });
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return json({ ok: false, error: "timeout", retryAfter: 30 }, 504);
        }
        console.error(`[jobboard-proxy] ${board} detail fetch error:`, err);
        return json({ ok: false, error: "upstream", retryAfter: 15 }, 502);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    const keyword = url.searchParams.get("keyword") ?? "";
    const pageRaw = url.searchParams.get("page") ?? "1";
    const countryCode = url.searchParams.get("countryCode") ?? undefined;
    const page = Math.max(1, parseInt(pageRaw, 10) || 1);

    if (!keyword.trim()) {
      return json({ ok: false, error: "missing_keyword" }, 400);
    }

    // ── KV cache (fast path) ─────────────────────────────────
    const ckey = cacheKey(board, keyword, page, countryCode);
    const cachedSearch = await kvGet(env, ckey);
    if (cachedSearch) {
      // Rewind cached entries so frequently-requested pages stay warm
      kvPut(env, ctx, ckey, cachedSearch, 300);
      return json({ ok: true, html: cachedSearch, cached: true });
    }

    // ── Politeness throttle ──────────────────────────────────
    const since = Date.now() - (lastRequestAt[board] ?? 0);
    const minInterval = BOARD_MIN_INTERVAL_MS[board] ?? 1500;
    if (since < minInterval) {
      await new Promise((r) => setTimeout(r, minInterval - since));
    }
    lastRequestAt[board] = Date.now();

    // ── Build upstream URL + headers ─────────────────────────
    const target = cfg.baseUrl + cfg.searchPath(keyword, page, countryCode);
    const headers = new Headers({
      "User-Agent": pickUA(),
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
      Referer: cfg.baseUrl + "/",
      Cookie: board === "ctgoodjobs" ? "culture=en-US" : "",
    });

    // ── Fetch with timeout ───────────────────────────────────
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    try {
      const resp = await fetch(target, {
        method: "GET",
        redirect: "follow",
        headers,
        signal: controller.signal,
      });

      if (resp.status === 403 || resp.status === 401) {
        return json(
          { ok: false, error: "blocked", retryAfter: 60, status: resp.status },
          503,
        );
      }
      if (resp.status === 429) {
        const retryAfter = Number(resp.headers.get("retry-after") ?? 30) || 30;
        return json({ ok: false, error: "rate_limited", retryAfter }, 429);
      }
      if (resp.status === 404) {
        return json({ ok: false, error: "not_found", status: 404 }, 404);
      }
      if (!resp.ok) {
        return json({ ok: false, error: "upstream", status: resp.status }, 502);
      }

      const html = await resp.text();

      // ── Challenge detection (Cloudflare/Imperva/DataDome markers) ──
      const lower = html.slice(0, 4000).toLowerCase();
      if (
        lower.includes("cf-chl") ||
        lower.includes("challenge-platform") ||
        lower.includes("__cf_chl_") ||
        lower.includes("px-captcha") ||
        lower.includes("captcha") ||
        lower.includes("just a moment")
      ) {
        return json({ ok: false, error: "challenge", retryAfter: 60 }, 503);
      }

      // ── Cache successful responses (5 min TTL) ─────────────
      kvPut(env, ctx, ckey, html, 300);

      return json({ ok: true, html });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return json({ ok: false, error: "timeout", retryAfter: 30 }, 504);
      }
      console.error(`[jobboard-proxy] ${board} fetch error:`, err);
      return json({ ok: false, error: "upstream", retryAfter: 15 }, 502);
    } finally {
      clearTimeout(timeoutId);
    }
  },
} satisfies ExportedHandler<Env>;

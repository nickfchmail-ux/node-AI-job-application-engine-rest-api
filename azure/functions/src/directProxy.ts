// ============================================================
//  DataImpulse residential proxy client — DIRECT fallback path.
//
//  When the Cloudflare worker gets blocked (datacenter IP),
//  the functions fall back to scraping the board DIRECTLY through
//  the DataImpulse HK residential proxy (rotating residential IPs
//  that pass anti-bot checks).
//
//  Proxy credentials are supplied via the DATA_IMPULSE_PROXY_URL
//  app setting, e.g.:
//    http://<user>__cr.hk:<pass>@gw.dataimpulse.com:823
// ============================================================

import { ProxyAgent, request } from "undici";

let _agent: ProxyAgent | null = null;
let _agentUrl = "";

/** Build (and cache) the undici ProxyAgent for the DataImpulse proxy. */
function getAgent(proxyUrl: string): ProxyAgent {
  if (_agent && _agentUrl === proxyUrl) return _agent;
  _agent = new ProxyAgent({
    uri: proxyUrl,
    requestTls: { rejectUnauthorized: false },
  });
  _agentUrl = proxyUrl;
  return _agent;
}

/**
 * Fetch through the proxy using undici's OWN `request` API (NOT global fetch —
 * the Functions runtime's fetch does not accept a `dispatcher`).
 * Follows 301/302 redirects manually.
 */
async function requestViaProxy(
  url: string,
  agent: ProxyAgent,
  controller: AbortController,
  headers: Record<string, string>,
): Promise<{ statusCode: number; bodyText: string }> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const {
      statusCode,
      body,
      headers: resHeaders,
    } = await request(current, {
      dispatcher: agent,
      signal: controller.signal,
      headers,
    });
    if (statusCode >= 300 && statusCode < 400 && resHeaders.location) {
      const loc = resHeaders.location as string;
      current = new URL(loc, current).toString();
      continue;
    }
    const text = await body.text();
    return { statusCode, bodyText: text };
  }
  return { statusCode: 302, bodyText: "" };
}

export interface DirectProxyResult {
  ok: boolean;
  html?: string;
  error?:
    | "blocked"
    | "challenge"
    | "timeout"
    | "rate_limited"
    | "upstream"
    | "not_found"
    | "bad_proxy_config";
  status?: number;
  /** Actual underlying error message (for diagnostics) */
  detail?: string;
}

// Board URL builders (same as the Cloudflare worker's searchPath logic)
const BOARDS: Record<
  string,
  {
    baseUrl: string;
    searchPath: (keyword: string, page: number, cc?: string) => string;
  }
> = {
  jobsdb: {
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
    baseUrl: "https://jobs.ctgoodjobs.hk",
    searchPath: (keyword, page) =>
      `/jobs?q=${encodeURIComponent(keyword.trim())}&page=${page}`,
  },
  indeed: {
    baseUrl: "https://hk.indeed.com",
    searchPath: (keyword, page, cc) => {
      const start = (page - 1) * 10;
      return `/jobs?q=${encodeURIComponent(keyword.trim())}&start=${start}`;
    },
  },
  offertoday: {
    baseUrl: "https://www.offertoday.com",
    searchPath: (keyword, page) =>
      `/search?q=${encodeURIComponent(keyword.trim())}&page=${page}`,
  },
  linkedin: {
    baseUrl: "https://www.linkedin.com",
    searchPath: (keyword, page) =>
      `/jobs/search?keywords=${encodeURIComponent(keyword)}&location=Hong+Kong&start=${(page - 1) * 10}`,
  },
};

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

function pickUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/** Fetch a board search page DIRECTLY through the DataImpulse residential proxy. */
export async function fetchBoardDirect(opts: {
  board: string;
  keyword: string;
  page: number;
  countryCode?: string;
  log?: (msg: string) => void;
}): Promise<DirectProxyResult> {
  const { board, keyword, page, countryCode, log = console.log } = opts;
  const proxyUrl = process.env.DATA_IMPULSE_PROXY_URL;
  if (!proxyUrl) {
    return { ok: false, error: "bad_proxy_config" };
  }
  const cfg = BOARDS[board];
  if (!cfg) {
    return { ok: false, error: "not_found" };
  }

  const target = cfg.baseUrl + cfg.searchPath(keyword, page, countryCode);
  const agent = getAgent(proxyUrl);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000);

  try {
    const { statusCode, bodyText } = await requestViaProxy(
      target,
      agent,
      controller,
      {
        "User-Agent": pickUA(),
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: cfg.baseUrl + "/",
        Cookie: board === "ctgoodjobs" ? "culture=en-US" : "",
      },
    );

    log(`[direct] ${board} p${page} → HTTP ${statusCode}`);

    if (statusCode === 403 || statusCode === 401) {
      return { ok: false, error: "blocked", status: statusCode };
    }
    if (statusCode === 429) {
      // DataImpulse rate-limits per IP after a few rapid requests.
      // Treat as RETRYABLE so the caller backs off and retries.
      return { ok: false, error: "rate_limited", status: statusCode };
    }
    if (statusCode === 404) {
      return { ok: false, error: "not_found", status: 404 };
    }
    if (statusCode >= 400) {
      return { ok: false, error: "upstream", status: statusCode };
    }

    const html = bodyText;

    // Challenge detection
    const lower = html.slice(0, 4000).toLowerCase();
    if (
      lower.includes("cf-chl") ||
      lower.includes("challenge-platform") ||
      lower.includes("captcha") ||
      lower.includes("just a moment") ||
      lower.includes("attention required")
    ) {
      return { ok: false, error: "challenge", status: statusCode };
    }

    return { ok: true, html };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { ok: false, error: "timeout" };
    }
    log(`[direct] ${board} fetch error: ${err}`);
    return { ok: false, error: "upstream", detail: String(err) };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Fetch a job DETAIL page directly through the DataImpulse residential proxy. */
export async function fetchDetailDirect(opts: {
  board: string;
  url: string;
  log?: (msg: string) => void;
}): Promise<DirectProxyResult> {
  const { board, url, log = console.log } = opts;
  const proxyUrl = process.env.DATA_IMPULSE_PROXY_URL;
  if (!proxyUrl) {
    return { ok: false, error: "bad_proxy_config" };
  }
  const cfg = BOARDS[board];
  if (!cfg) return { ok: false, error: "not_found" };

  const agent = getAgent(proxyUrl);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000);

  try {
    const { statusCode, bodyText } = await requestViaProxy(
      url,
      agent,
      controller,
      {
        "User-Agent": pickUA(),
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: cfg.baseUrl + "/",
        Cookie: board === "ctgoodjobs" ? "culture=en-US" : "",
      },
    );

    log(`[direct] detail ${board} → HTTP ${statusCode}`);

    if (statusCode === 403 || statusCode === 401 || statusCode === 429) {
      return { ok: false, error: "blocked", status: statusCode };
    }
    if (statusCode >= 400) {
      return { ok: false, error: "upstream", status: statusCode };
    }

    const html = bodyText;
    const lower = html.slice(0, 4000).toLowerCase();
    if (
      lower.includes("cf-chl") ||
      lower.includes("captcha") ||
      lower.includes("just a moment")
    ) {
      return { ok: false, error: "challenge", status: statusCode };
    }
    return { ok: true, html };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { ok: false, error: "timeout" };
    }
    log(`[direct] detail ${board} fetch error: ${err}`);
    return { ok: false, error: "upstream", detail: String(err) };
  } finally {
    clearTimeout(timeoutId);
  }
}

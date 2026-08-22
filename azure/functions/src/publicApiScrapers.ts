// ============================================================
//  publicApiScrapers.ts — scrape job boards via their PUBLIC
//  JSON APIs, bypassing anti-bot HTML blocks.
//
//  These endpoints need no proxy, no login, and no anti-bot
//  evasion — they are the same endpoints the boards' own
//  frontends use. Ported from the legacy src/scrapers/*.
//
//  Supported:
//    offertoday → POST /wapi/geek/recommend/search/list
//    linkedin   → GET  /jobs-guest/jobs/api/seeMoreJobPostings/search
//    indeed     → GET  /jobs (HTML) — via RPC detail endpoint
//
//  Returns ScrapedJob[] compatible with the existing pipeline.
// ============================================================

import type { ScrapedJob } from "./types";

const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── OfferToday public JSON API ──────────────────────────────────────────────
// POST /wapi/geek/recommend/search/list with a JSON body. Returns clean JSON.
// No proxy needed.

interface OfferTodayResult {
  code?: number;
  data?: {
    resultList?: OfferTodayItem[];
    hasMore?: boolean;
  };
}

interface OfferTodayItem {
  jobId?: string;
  jobName?: string;
  companyName?: string;
  brandName?: string;
  locationDesc?: string;
  salaryDesc?: string;
  jobPostTime?: string;
  jobTypeDesc?: string;
  experience?: string;
  educationDesc?: string;
  skills?: string[];
}

function parsePostTime(raw?: string): string | undefined {
  if (!raw) return undefined;
  const m = raw.match(/(\d+)\s*(day|month|week|hour|minute)/i);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const now = new Date();
  const ms: Record<string, number> = {
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 30 * 86_400_000,
  };
  const d = new Date(now.getTime() - n * (ms[unit] ?? 0));
  return d.toISOString().slice(0, 10);
}

export async function scrapeOfferTodayApi(
  keyword: string,
  page: number,
  log: (msg: string) => void = console.log,
): Promise<ScrapedJob[]> {
  const url = "https://www.offertoday.com/wapi/geek/recommend/search/list";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": UA_CHROME,
        Accept: "application/json",
        "Content-Type": "application/json",
        Referer: "https://www.offertoday.com/",
      },
      body: JSON.stringify({
        keyword: keyword.trim(),
        page,
        pageSize: 30,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      log(`[offertoday-api] page ${page} → HTTP ${res.status}`);
      return [];
    }
    const json = (await res.json()) as OfferTodayResult;
    if (json.code !== 0 || !json.data?.resultList?.length) {
      log(`[offertoday-api] page ${page} → code=${json.code}, empty`);
      return [];
    }
    const jobs: ScrapedJob[] = json.data.resultList
      .filter((item) => item.jobName && item.companyName)
      .map((item) => ({
        board: "offertoday",
        title: item.jobName as string,
        company: item.brandName || item.companyName || "",
        location: item.locationDesc || "Hong Kong",
        salary: item.salaryDesc || undefined,
        postedDate: parsePostTime(item.jobPostTime),
        url: `https://www.offertoday.com/hk/job/${item.jobId}`,
        description: [
          item.jobTypeDesc,
          item.experience,
          item.educationDesc,
          ...(item.skills || []),
        ]
          .filter(Boolean)
          .join(" · "),
      }));
    log(`[offertoday-api] page ${page} → ${jobs.length} jobs`);
    return jobs;
  } catch (err) {
    log(`[offertoday-api] page ${page} error: ${err}`);
    return [];
  }
}

// ── OfferToday job DETAIL public API ────────────────────────────────────────
// GET /wapi/geek/recommend/jobDetail?encryptJobId=...&lid=x

export async function fetchOfferTodayDescriptionApi(
  encryptJobId: string,
  log: (msg: string) => void = console.log,
): Promise<string | null> {
  const url =
    `https://www.offertoday.com/wapi/geek/recommend/jobDetail` +
    `?encryptJobId=${encodeURIComponent(encryptJobId)}&lid=x`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA_CHROME,
        Accept: "application/json",
        Referer: "https://www.offertoday.com/",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      log(`[offertoday-api] detail ${encryptJobId} → HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as {
      code?: number;
      data?: {
        jobDesc?: string;
        jobDetail?: string;
        description?: string;
        jobRequirement?: string;
      };
    };
    if (json.code !== 0) {
      log(`[offertoday-api] detail ${encryptJobId} → code=${json.code}`);
      return null;
    }
    const desc =
      json.data?.jobDesc ||
      json.data?.jobDetail ||
      json.data?.description ||
      "";
    if (!desc) {
      log(`[offertoday-api] detail ${encryptJobId} → empty description`);
      return null;
    }
    const req = json.data?.jobRequirement;
    const html = `${desc}${req ? `\nRequirements:\n${req}` : ""}`;
    return html;
  } catch (err) {
    log(`[offertoday-api] detail ${encryptJobId} error: ${err}`);
    return null;
  }
}

// ── LinkedIn guest API ──────────────────────────────────────────────────────
// GET /jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=...&start=N
// Returns an HTML fragment with job cards (no login, no proxy).

export async function scrapeLinkedInApi(
  keyword: string,
  page: number,
  log: (msg: string) => void = console.log,
): Promise<ScrapedJob[]> {
  const start = (page - 1) * 10;
  const url =
    `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search` +
    `?keywords=${encodeURIComponent(keyword.trim())}` +
    `&location=${encodeURIComponent("Hong Kong")}` +
    `&start=${start}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA_CHROME,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      log(`[linkedin-api] page ${page} → HTTP ${res.status}`);
      return [];
    }
    const html = await res.text();
    const jobs = parseLinkedInListingHtml(html);
    log(`[linkedin-api] page ${page} → ${jobs.length} jobs`);
    return jobs;
  } catch (err) {
    log(`[linkedin-api] page ${page} error: ${err}`);
    return [];
  }
}

function parseLinkedInListingHtml(html: string): ScrapedJob[] {
  const jobs: ScrapedJob[] = [];
  const cardRegex =
    /<div[^>]*class="[^"]*job-search-card"[^>]*data-entity-urn="urn:li:jobPosting:(\d+)"[\s\S]*?<\/li>/g;
  let cardMatch: RegExpExecArray | null;
  while ((cardMatch = cardRegex.exec(html)) !== null) {
    const card = cardMatch[0];
    const jobId = cardMatch[1];
    const title = extractText(
      card,
      /base-search-card__title[^>]*>\s*([\s\S]*?)\s*<\/h3>/,
    );
    const company = extractText(
      card,
      /hidden-nested-link[^>]*>\s*([\s\S]*?)\s*<\/a>/,
    );
    const location = extractText(
      card,
      /job-search-card__location[^>]*>\s*([\s\S]*?)\s*<\/span>/,
    );
    const dateMatch = card.match(/datetime="(\d{4}-\d{2}-\d{2})"/);
    if (!title || !company) continue;
    jobs.push({
      board: "linkedin",
      title,
      company,
      location: location || "Hong Kong",
      url: `https://www.linkedin.com/jobs/view/${jobId}`,
      postedDate: dateMatch?.[1],
    });
  }
  return jobs;
}

function extractText(html: string, pattern: RegExp): string | undefined {
  const m = pattern.exec(html);
  return (
    m?.[1]
      ?.replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim() || undefined
  );
}

// ── LinkedIn guest DETAIL API ───────────────────────────────────────────────
// GET /jobs-guest/jobs/api/jobPosting/{jobId} → HTML with description.

export async function fetchLinkedInDescriptionApi(
  jobId: string,
  log: (msg: string) => void = console.log,
): Promise<string | null> {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA_CHROME,
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      log(`[linkedin-api] detail ${jobId} → HTTP ${res.status}`);
      return null;
    }
    const html = await res.text();
    const m = html.match(
      /<div class="show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/,
    );
    if (m?.[1]) return m[1];
    const m2 = html.match(
      /<section class="description[^>]*>([\s\S]*?)<\/section>/,
    );
    return m2?.[1] ?? null;
  } catch (err) {
    log(`[linkedin-api] detail ${jobId} error: ${err}`);
    return null;
  }
}

// ── Indeed RPC batch detail endpoint ────────────────────────────────────────
// GET /rpc/jobdescs?jks=jobkey1,jobkey2 → JSON map jobkey → HTML description.
// Single call for a whole batch instead of N detail fetches.
// Routed through the Cloudflare proxy (the /indeed/detail mode) — the SAME
// path every other board uses. No direct datacenter fetch, no ScraperAPI.

import { fetchViaProxy } from "./cloudflareProxy";
import { fetchViaScraperApi } from "./scraperApi";

export async function fetchIndeedBatchDescriptionsApi(
  jobkeys: string[],
  log: (msg: string) => void = console.log,
): Promise<Record<string, string>> {
  if (jobkeys.length === 0) return {};
  const BATCH_SIZE = 25;
  const result: Record<string, string> = {};
  const proxyBase = process.env.CLOUDFLARE_PROXY_URL;

  for (let i = 0; i < jobkeys.length; i += BATCH_SIZE) {
    const batch = jobkeys.slice(i, i + BATCH_SIZE);
    const targetUrl = `https://hk.indeed.com/rpc/jobdescs?jks=${batch.join(",")}`;
    const chunkNum = i / BATCH_SIZE + 1;

    // If the proxy isn't configured, fall back to a plain fetch (best effort).
    if (!proxyBase) {
      log(`[indeed-rpc] CLOUDFLARE_PROXY_URL not set — trying direct fetch`);
      try {
        const res = await fetch(targetUrl, {
          headers: { "User-Agent": UA_CHROME, Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          log(`[indeed-rpc] chunk ${chunkNum} direct fetch ${res.status}`);
          continue;
        }
        const data = (await res.json()) as Record<string, string>;
        Object.assign(result, data);
        log(
          `[indeed-rpc] chunk ${chunkNum} → ${Object.keys(data).length} descriptions`,
        );
      } catch (err) {
        log(`[indeed-rpc] chunk ${chunkNum} direct error: ${err}`);
      }
      continue;
    }

    try {
      const proxyResult = await fetchViaProxy({
        board: "indeed",
        url: targetUrl,
        log,
      });
      if (!proxyResult.ok) {
        // ── Final fallback: ScraperAPI for the RPC batch ──
        log(
          `[indeed-rpc] chunk ${chunkNum} proxy error: ${proxyResult.error} — trying ScraperAPI...`,
        );
        const sa = await fetchViaScraperApi({ url: targetUrl, log });
        if (sa.ok && sa.html) {
          try {
            const data = JSON.parse(sa.html) as Record<string, string>;
            Object.assign(result, data);
            log(
              `[indeed-rpc] chunk ${chunkNum} ScraperAPI → ${Object.keys(data).length} descriptions`,
            );
          } catch (parseErr) {
            log(
              `[indeed-rpc] chunk ${chunkNum} ScraperAPI JSON parse error: ${parseErr}`,
            );
          }
        } else {
          log(`[indeed-rpc] chunk ${chunkNum} ScraperAPI error: ${sa.error}`);
        }
        continue;
      }
      // The proxy returns raw HTML (JSON here since the RPC endpoint is JSON).
      try {
        const data = JSON.parse(proxyResult.html) as Record<string, string>;
        Object.assign(result, data);
        log(
          `[indeed-rpc] chunk ${chunkNum} → ${Object.keys(data).length} descriptions`,
        );
      } catch (parseErr) {
        log(`[indeed-rpc] chunk ${chunkNum} JSON parse error: ${parseErr}`);
      }
    } catch (err) {
      log(`[indeed-rpc] chunk ${chunkNum} error: ${err}`);
    }
  }
  return result;
}

// ── Indeed listing via HTML page through proxy (fallback when API blocked) ──

/** Extract Indeed jobkeys from the mosaic.providerData JSON inside the page. */
export function extractIndeedJobKeys(html: string): string[] {
  const keys: string[] = [];
  const re = /"jobkey":"([a-f0-9]{16})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    keys.push(m[1]);
  }
  return [...new Set(keys)];
}

export function extractIndeedJobkeyFromUrl(url: string): string | null {
  const m = url.match(/jk=([a-f0-9]{16})/);
  return m?.[1] ?? null;
}

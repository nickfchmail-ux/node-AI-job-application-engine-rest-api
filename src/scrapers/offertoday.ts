import { type Page } from "playwright";
import { BaseJobScraper } from "./base";
import { Job } from "./types";

/**
 * Offer Today (offertoday.com) scraper using public API endpoints.
 * No proxy or authentication required — 0 ScraperAPI credits.
 *
 * Search: POST /wapi/geek/recommend/search/list  (JSON body)
 * Detail: GET  /wapi/geek/recommend/jobDetail?encryptJobId=...&lid=x
 */
export class OfferTodayScraper extends BaseJobScraper {
  readonly name = "Offer Today";
  readonly baseUrl = "https://www.offertoday.com";

  private static readonly FETCH_HEADERS = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json",
    "Content-Type": "application/json",
    Referer: "https://www.offertoday.com/",
  };

  private static readonly PAGE_SIZE = 30;

  async scrape(keyword: string, pages = 0): Promise<Job[]> {
    const maxPages = Math.min(pages || this.MAX_PAGES, this.MAX_PAGES);
    this.log("[Offer Today] Using public API (0 credits)");
    const allJobs: Job[] = [];

    for (let p = 1; p <= maxPages; p++) {
      this.log(`[Offer Today] page ${p}/${maxPages}`);

      try {
        const res = await fetch(
          `${this.baseUrl}/wapi/geek/recommend/search/list`,
          {
            method: "POST",
            headers: OfferTodayScraper.FETCH_HEADERS,
            body: JSON.stringify({
              query: keyword.trim(),
              page: p,
              pageSize: OfferTodayScraper.PAGE_SIZE,
            }),
            signal: AbortSignal.timeout(20_000),
          },
        );

        if (!res.ok) {
          this.log(`[Offer Today] page ${p} → ${res.status}`);
          break;
        }

        const json = await res.json();
        if (json.code !== 0 || !json.data?.resultList?.length) {
          this.log(`[Offer Today] page ${p} → code=${json.code}, empty`);
          break;
        }

        const jobs = this.parseResults(json.data.resultList);
        this.log(`[Offer Today] Page ${p}: ${jobs.length} jobs`);

        if (jobs.length === 0) break;
        allJobs.push(...jobs);

        if (!json.data.hasMore) break;
      } catch (err) {
        this.log(`[Offer Today] Page ${p} error: ${err}`);
        break;
      }
    }

    return allJobs;
  }

  private parseResults(items: OfferTodayJob[]): Job[] {
    return items
      .filter((item) => item.jobName && item.companyName)
      .map((item) => ({
        source: this.name,
        title: item.jobName,
        company: item.brandName || item.companyName,
        location: item.locationDesc || "Hong Kong",
        salary: item.salaryDesc || undefined,
        postedDate: this.parsePostTime(item.jobPostTime),
        url: `${this.baseUrl}/hk/job/${item.jobId}`,
        description: [
          item.jobTypeDesc,
          item.experience,
          item.educationDesc,
          ...(item.skills || []),
        ]
          .filter(Boolean)
          .join(" · "),
        // Store encrypted job ID for batch detail fetching
        _encryptJobId: item.jobId,
      }));
  }

  private parsePostTime(raw?: string): string | undefined {
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

  // --- Unused Playwright methods (required by BaseJobScraper) ---
  protected buildUrl(keyword: string, _page: number): string {
    return `${this.baseUrl}/hk/search/${encodeURIComponent(keyword)}-jobs`;
  }
  protected getWaitSelector(): string {
    return "body";
  }
  protected async extractJobs(_page: Page): Promise<Omit<Job, "source">[]> {
    return [];
  }
}

// ── Detail fetching (0 credits) ──────────────────────────────────────────

/**
 * Fetch a single Offer Today job description via the public detail API.
 * Returns the job description HTML (prefers English translation), or null.
 */
export async function fetchOfferTodayDescription(
  encryptJobId: string,
  log: (msg: string) => void = console.log,
): Promise<string | null> {
  const url =
    `https://www.offertoday.com/wapi/geek/recommend/jobDetail` +
    `?encryptJobId=${encodeURIComponent(encryptJobId)}&lid=x`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
        Referer: "https://www.offertoday.com/",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== 0 || !json.data) return null;
    // Prefer translated (English) description, fall back to original
    return json.data.translateJobDesc || json.data.jobDesc || null;
  } catch (err) {
    log(`[OfferToday detail] ${encryptJobId} error: ${err}`);
    return null;
  }
}

/**
 * Batch-fetch Offer Today job descriptions.
 * Fetches in parallel with concurrency control. 0 credits.
 * Returns a map of encryptJobId → description HTML.
 */
export async function fetchOfferTodayBatchDescriptions(
  encryptJobIds: string[],
  log: (msg: string) => void = console.log,
): Promise<Record<string, string>> {
  if (encryptJobIds.length === 0) return {};

  const CONCURRENCY = 5;
  const result: Record<string, string> = {};
  const queue = [...encryptJobIds];

  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift()!;
      const desc = await fetchOfferTodayDescription(id, log);
      if (desc) result[id] = desc;
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return result;
}

// ── Types ────────────────────────────────────────────────────────────────

interface OfferTodayJob {
  jobId: string;
  jobName: string;
  companyName: string;
  brandName?: string;
  locationDesc?: string;
  salaryDesc?: string;
  jobPostTime?: string;
  skills?: string[];
  jobType?: number;
  jobTypeDesc?: string;
  experience?: string;
  educationDesc?: string;
}

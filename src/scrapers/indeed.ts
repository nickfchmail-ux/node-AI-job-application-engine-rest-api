import { type Page } from "playwright";
import { browserPool } from "../pipeline/browserPool";
import { BaseJobScraper } from "./base";
import { Job } from "./types";

/**
 * Batch-fetch full job descriptions from Indeed's internal RPC endpoint.
 * Returns a map of jobkey → HTML description string.
 * Tries direct fetch first; if blocked (403), falls back to ScraperAPI proxy
 * (still just 1 API call for all jobs instead of N individual calls).
 */
export async function fetchIndeedBatchDescriptions(
  jobkeys: string[],
  log: (msg: string) => void = console.log,
): Promise<Record<string, string>> {
  if (jobkeys.length === 0) return {};
  const BATCH_SIZE = 25;
  const result: Record<string, string> = {};
  const apiKey = process.env.SCRAPERAPI_KEY;

  for (let i = 0; i < jobkeys.length; i += BATCH_SIZE) {
    const batch = jobkeys.slice(i, i + BATCH_SIZE);
    const targetUrl = `https://hk.indeed.com/rpc/jobdescs?jks=${batch.join(",")}`;
    const chunkNum = i / BATCH_SIZE + 1;
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "application/json",
    };

    try {
      // Attempt 1: direct fetch (free, 0 credits)
      let res = await fetch(targetUrl, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });

      // Attempt 2: if direct blocked, proxy through ScraperAPI (1 credit for whole batch)
      if (!res.ok && apiKey) {
        log(`[Indeed batch] chunk ${chunkNum} direct fetch ${res.status}, retrying via ScraperAPI...`);
        const proxyUrl = `http://api.scraperapi.com?api_key=${encodeURIComponent(apiKey)}&url=${encodeURIComponent(targetUrl)}`;
        res = await fetch(proxyUrl, {
          headers,
          signal: AbortSignal.timeout(60_000),
        });
      }

      if (!res.ok) {
        log(`[Indeed batch] chunk ${chunkNum} failed: ${res.status}`);
        continue;
      }
      const data = await res.json() as Record<string, string>;
      Object.assign(result, data);
      log(`[Indeed batch] chunk ${chunkNum}: got ${Object.keys(data).length} descriptions`);
    } catch (err) {
      log(`[Indeed batch] chunk ${chunkNum} error: ${err}`);
    }
  }
  return result;
}

// When SCRAPERAPI_KEY is set, uses ScraperAPI HTTP API with render=true to
// fetch JS-rendered HTML, bypassing Cloudflare without needing Playwright.
// Without the key, falls back to the shared browserPool (residential IPs only).
export class IndeedScraper extends BaseJobScraper {
  readonly name = "Indeed HK";
  readonly baseUrl = "https://hk.indeed.com";
  /** Optional ScraperAPI geotargeting country code (e.g. "us", "hk"). Costs 10x credits when set. */
  countryCode?: string;

  async scrape(keyword: string, pages = 0): Promise<Job[]> {
    const maxPages = Math.min(pages || this.MAX_PAGES, this.MAX_PAGES);
    const apiKey = process.env.SCRAPERAPI_KEY;

    if (apiKey) {
      return this.scrapeViaApi(keyword, maxPages, apiKey);
    }
    this.log(
      "[Indeed HK] WARNING: No SCRAPERAPI_KEY configured — Indeed blocks datacenter IPs with Cloudflare. " +
      "Direct browser access will likely fail. Set SCRAPERAPI_KEY in Render env vars to enable Indeed scraping.",
    );
    return this.scrapeViaBrowser(keyword, maxPages);
  }

  /** Use ScraperAPI HTTP API with render=true to get JS-rendered HTML */
  private async scrapeViaApi(
    keyword: string,
    maxPages: number,
    apiKey: string,
  ): Promise<Job[]> {
    this.log("[Indeed HK] Using ScraperAPI render mode");
    const allJobs: Job[] = [];

    for (let p = 1; p <= maxPages; p++) {
      const targetUrl = this.buildUrl(keyword, p);
      const cc = this.countryCode ? `&country_code=${encodeURIComponent(this.countryCode)}` : '';
      const apiUrl = `http://api.scraperapi.com?api_key=${encodeURIComponent(apiKey)}&url=${encodeURIComponent(targetUrl)}${cc}`;
      this.log(`[Indeed HK] page ${p}/${maxPages}`);

      try {
        const res = await fetch(apiUrl, { signal: AbortSignal.timeout(60000) });
        this.log(`[Indeed HK] ${targetUrl} → ${res.status} ${res.statusText}`);
        if (!res.ok) break;

        const html = await res.text();
        const jobs = this.parseMosaicJson(html);
        this.log(`[Indeed HK] Page ${p}: ${jobs.length} jobs`);

        if (jobs.length === 0) {
          const snippet = html
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200);
          this.log(`[Indeed HK] ⚠ 0 jobs — body snippet: "${snippet}"`);
          break;
        }

        allJobs.push(...jobs.map((j) => ({ ...j, source: this.name })));
      } catch (err) {
        this.log(`[Indeed HK] Page ${p} fetch error: ${err}`);
        break;
      }
    }

    return allJobs;
  }

  /** Original Playwright path — works from residential IPs only */
  private async scrapeViaBrowser(
    keyword: string,
    maxPages: number,
  ): Promise<Job[]> {
    const context = await browserPool.acquire();
    const allJobs: Job[] = [];

    try {
      for (let p = 1; p <= maxPages; p++) {
        const url = this.buildUrl(keyword, p);
        this.log(`[Indeed HK] page ${p}/${maxPages} (direct browser)`);
        const tab = await context.newPage();

        try {
          await tab.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          });
          await tab.waitForTimeout(5000);

          const html = await tab.content();

          // Detect Cloudflare / security block early — don't waste time on remaining pages
          const title = await tab.title();
          if (
            title.includes("Security Check") ||
            title.includes("Attention Required") ||
            html.includes("Human Verification") ||
            html.includes("cf-browser-verify") ||
            html.includes("Just a moment")
          ) {
            this.log(
              `[Indeed HK] ⛔ Cloudflare security block detected (title: "${title}"). ` +
              `Indeed blocks datacenter IPs. Set SCRAPERAPI_KEY in Render env vars to bypass. ` +
              `Skipping remaining pages.`,
            );
            break;
          }

          const jobs = this.parseMosaicJson(html);
          this.log(`[Indeed HK] Page ${p}: ${jobs.length} jobs`);

          if (jobs.length === 0) {
            const bodySnippet = await tab.evaluate(
              () =>
                document.body?.innerText?.slice(0, 200).replace(/\s+/g, " ") ??
                "",
            );
            this.log(
              `[Indeed HK] ⚠ 0 jobs — title="${title}" body="${bodySnippet}"`,
            );
            break;
          }

          allJobs.push(...jobs.map((j) => ({ ...j, source: this.name })));
        } finally {
          await tab.close();
        }
      }
    } finally {
      await browserPool.release(context);
    }

    return allJobs;
  }

  private parseMosaicJson(html: string): Omit<Job, "source">[] {
    const marker = 'window.mosaic.providerData["mosaic-provider-jobcards"]';
    const idx = html.indexOf(marker);
    if (idx === -1) return [];
    const eqIdx = html.indexOf("=", idx);
    if (eqIdx === -1) return [];

    let depth = 0,
      start = -1;
    for (let i = eqIdx + 1; i < html.length; i++) {
      if (html[i] === "{") {
        if (start === -1) start = i;
        depth++;
      } else if (html[i] === "}") {
        if (--depth === 0) {
          try {
            const parsed = JSON.parse(html.slice(start, i + 1));
            const results: any[] =
              parsed?.metaData?.mosaicProviderJobCardsModel?.results ?? [];
            return results
              .filter((r: any) => r.jobkey && r.displayTitle)
              .map((r: any) => {
                const salaryMin = r.extractedSalary?.min;
                const salaryMax = r.extractedSalary?.max;
                const salaryType = r.extractedSalary?.type ?? "";
                return {
                  title: (r.displayTitle ?? r.normTitle ?? "N/A").trim(),
                  company: (r.company ?? "N/A").trim(),
                  location: (
                    r.formattedLocation ??
                    r.jobLocationCity ??
                    "N/A"
                  ).trim(),
                  postedDate: r.formattedRelativeTime ?? undefined,
                  url: `${this.baseUrl}/viewjob?jk=${r.jobkey}`,
                  description: r.snippet
                    ? r.snippet
                        .replace(/<[^>]+>/g, " ")
                        .replace(/\s+/g, " ")
                        .trim()
                    : undefined,
                  salary:
                    salaryMin != null || salaryMax != null
                      ? [salaryMin, salaryMax].filter(Boolean).join("–") +
                        (salaryType ? ` ${salaryType}` : "")
                      : undefined,
                };
              });
          } catch {
            return [];
          }
        }
      }
    }
    return [];
  }

  protected buildUrl(keyword: string, page: number): string {
    const start = (page - 1) * 10;
    return `${this.baseUrl}/jobs?q=${encodeURIComponent(keyword.trim())}&start=${start}`;
  }
  protected getWaitSelector(): string {
    return "body";
  }
  protected async extractJobs(_page: Page): Promise<Omit<Job, "source">[]> {
    return [];
  }
}

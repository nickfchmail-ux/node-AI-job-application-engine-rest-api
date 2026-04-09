import { Job } from "./types";

const BASE_URL = "https://jobs.ctgoodjobs.hk";
const MAX_PAGES = 5;
/** Jobs returned per page by CTgoodjobs RSC (observed: 18) */
const PAGE_SIZE = 18;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

interface RscSalary {
  salaryValue?: string;
  salaryFrom?: string | null;
  salaryTo?: string | null;
}
interface RscPublishTime { date?: string; }
interface RscJobEntry {
  jobId: string;
  jobTitle: string;
  url: string;
  companyName: string;
  publishTime: string | RscPublishTime;
  salary: string | RscSalary;
  locations: string | string[];
}

/**
 * CTgoodjobs scraper using plain HTTP fetch + Next.js RSC payload parsing.
 *
 * CTgoodjobs migrated to Next.js App Router in early 2026. The listing page
 * is now a React Server Components app: the full job data is embedded in the
 * server-rendered HTML inside  self.__next_f.push([1, "..."])  script blocks
 * using the RSC flight protocol. Plain HTTP fetch retrieves this data without
 * a browser. This scraper replaces the old cheerio approach.
 *
 * Implements the same interface that MultiboardScraper expects:
 *   name, log, scrape(keyword, pages)
 */
export class CTgoodjobsScraper {
  readonly name = "CTgoodjobs HK";
  log: (msg: string) => void = console.log;

  private buildUrl(keyword: string, page: number): string {
    return `${BASE_URL}/jobs?q=${encodeURIComponent(keyword.trim())}&page=${page}`;
  }

  private randomUA(): string {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  }

  private async fetchPage(url: string): Promise<string> {
    const apiKey = process.env.SCRAPERAPI_KEY;
    const targetUrl = apiKey
      ? `http://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(url)}&render=false`
      : url;

    const headers: Record<string, string> = apiKey
      ? {} // ScraperAPI sets its own headers
      : {
          "User-Agent": this.randomUA(),
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          Connection: "keep-alive",
          "Upgrade-Insecure-Requests": "1",
          "Cache-Control": "max-age=0",
          Cookie: "culture=en-US",
        };

    const resp = await fetch(targetUrl, {
      method: "GET",
      redirect: "follow",
      headers,
    });
    this.log(`[${this.name}] ${url} → ${resp.status} ${resp.statusText}`);
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      this.log(
        `[${this.name}] Response body (first 500): ${body.slice(0, 500)}`,
      );
      throw new Error(`HTTP ${resp.status} for ${url}`);
    }
    return resp.text();
  }

  /**
   * Parse job listings from the Next.js RSC (React Server Components) payload
   * embedded in the page HTML as self.__next_f.push([1, "..."]) script blocks.
   *
   * The RSC flight protocol uses a flat map of hexKey → JSON value with
   * $hexKey references for nested objects (salary, publishTime, locations).
   */
  private parseRscJobs(html: string): Omit<Job, "source">[] {
    // 1. Collect and unescape all RSC push chunks
    const chunks: string[] = [];
    const rscRegex = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
    let m: RegExpExecArray | null;
    while ((m = rscRegex.exec(html)) !== null) {
      try { chunks.push(JSON.parse('"' + m[1] + '"')); } catch { /* skip malformed */ }
    }
    if (chunks.length === 0) return [];
    const fullRsc = chunks.join("\n");

    // 2. Parse RSC entries: hexKey:jsonValue (one per line)
    const rscMap = new Map<string, unknown>();
    const entryRegex = /^([0-9a-f]+):(.+)$/mg;
    let em: RegExpExecArray | null;
    while ((em = entryRegex.exec(fullRsc)) !== null) {
      try { rscMap.set(em[1], JSON.parse(em[2])); } catch { /* skip */ }
    }

    // 3. Find job objects and resolve $ref pointers
    const results: Omit<Job, "source">[] = [];
    for (const [, entry] of rscMap) {
      if (
        typeof entry !== "object" || entry === null ||
        !("jobId" in entry) || !("jobTitle" in entry) ||
        !("url" in entry) || !("companyName" in entry)
      ) continue;

      const job = entry as RscJobEntry;

      // Resolve salary ($ref → { salaryValue, ... })
      let salary: string | undefined;
      const salaryRef =
        typeof job.salary === "string" && job.salary.startsWith("$")
          ? job.salary.slice(1)
          : null;
      if (salaryRef) {
        const s = rscMap.get(salaryRef) as RscSalary | undefined;
        if (s?.salaryValue && s.salaryValue !== "N/A") salary = s.salaryValue;
      }

      // Resolve publishTime ($ref → { date, ... })
      let postedDate: string | undefined;
      const ptRef =
        typeof job.publishTime === "string" && job.publishTime.startsWith("$")
          ? job.publishTime.slice(1)
          : null;
      if (ptRef) {
        const pt = rscMap.get(ptRef) as RscPublishTime | undefined;
        if (pt?.date) postedDate = pt.date;
      }

      // Resolve locations ($ref → string[])
      let location = "Hong Kong";
      const locRef =
        typeof job.locations === "string" && job.locations.startsWith("$")
          ? job.locations.slice(1)
          : null;
      if (locRef) {
        const locArr = rscMap.get(locRef);
        if (Array.isArray(locArr) && locArr.length > 0 && typeof locArr[0] === "string") {
          location = locArr[0];
        }
      }

      results.push({
        title: (job.jobTitle as string).replace(/<[^>]+>/g, "").trim(),
        company: job.companyName as string,
        location,
        salary,
        postedDate,
        url: job.url as string,
      });
    }

    return results;
  }

  /**
   * Extract total job count from the Schema.org ItemList embedded in the RSC.
   * Returns 1 (single page) when not found.
   */
  private getTotalPagesFromRsc(html: string, pageSize = PAGE_SIZE): number {
    const m = html.match(/"numberOfItems":(\d+)/);
    if (!m) return 1;
    const total = parseInt(m[1], 10);
    return Math.min(Math.ceil(total / pageSize), MAX_PAGES);
  }

  async scrape(keyword: string, pages = 0): Promise<Job[]> {
    const autoMode = pages === 0;

    // Fetch page 1
    const url1 = this.buildUrl(keyword, 1);
    this.log(`[${this.name}] Fetching ${url1}`);
    const html1 = await this.fetchPage(url1);

    // Detect CAPTCHA / verification page
    if (html1.includes("Human Verification") || html1.includes("captcha")) {
      this.log(`[${this.name}] Got CAPTCHA page — cannot scrape from this IP`);
      return [];
    }

    const firstJobs = this.parseRscJobs(html1);
    if (firstJobs.length === 0) {
      this.log(`[${this.name}] 0 jobs on page 1 — RSC parsing found nothing (possible site change)`);
      return [];
    }

    const totalPages = autoMode
      ? this.getTotalPagesFromRsc(html1)
      : Math.min(pages, MAX_PAGES);

    this.log(
      `[${this.name}] Page 1: ${firstJobs.length} jobs. Total pages: ${totalPages}`,
    );

    // Fetch remaining pages in parallel
    const allJobs: Job[] = firstJobs.map((j) => ({ ...j, source: this.name }));

    if (totalPages > 1) {
      const pageNums = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
      const settled = await Promise.allSettled(
        pageNums.map(async (p) => {
          const html = await this.fetchPage(this.buildUrl(keyword, p));
          return this.parseRscJobs(html);
        }),
      );

      for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        if (result.status === "fulfilled" && result.value.length > 0) {
          allJobs.push(
            ...result.value.map((j) => ({ ...j, source: this.name })),
          );
        } else if (result.status === "rejected") {
          this.log(
            `[${this.name}] Page ${pageNums[i]} failed: ${result.reason}`,
          );
        }
      }
    }

    this.log(
      `[${this.name}] Total: ${allJobs.length} jobs across ${totalPages} page(s)`,
    );
    return allJobs;
  }
}

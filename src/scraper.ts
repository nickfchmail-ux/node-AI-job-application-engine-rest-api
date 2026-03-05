import * as fs from "fs";
import * as path from "path";
import { chromium, type Page } from "playwright";

// ── Shared types ──────────────────────────────────────────────────────────────

export interface Job {
  source: string; // which job board this came from
  title: string;
  company: string;
  location: string;
  salary?: string;
  postedDate?: string;
  url: string;
  description?: string;
}

/**
 * CSS selector configuration used by the shared DOM extractor.
 * Each field is an ordered array of selectors tried one by one until a non-empty
 * text value is found.  `card` is the root element that groups one job listing.
 */
export interface DomSelectors {
  /** One or more selectors for the card root; the first that returns results wins */
  card: string[];
  title: string[];
  company: string[];
  location: string[];
  salary?: string[];
  postedDate?: string[];
  description?: string[];
  /** Selector for the <a> tag inside a card */
  link?: string[];
}

// ── Abstract base class ───────────────────────────────────────────────────────

export abstract class BaseJobScraper {
  /** Human-readable name shown in output and saved as `source` */
  abstract readonly name: string;

  /** Logging function — set by MultiboardScraper so output appears in job status */
  protected log: (msg: string) => void = console.log;
  /** Root URL of the job board, used to resolve relative links */
  abstract readonly baseUrl: string;

  /** Build a paginated search URL for the given keyword and page number */
  protected abstract buildUrl(keyword: string, page: number): string;

  /**
   * CSS selector(s) to wait for before extracting — confirms the page loaded.
   * Multiple selectors separated by commas act as an "any of" condition.
   */
  protected abstract getWaitSelector(): string;

  /**
   * Extract raw job data from the Playwright page.
   * Must NOT include `source`; the base class stamps it automatically.
   */
  protected abstract extractJobs(page: Page): Promise<Omit<Job, "source">[]>;

  /**
   * Return the total number of result pages available for this search.
   * Called once after page 1 is loaded. Default returns Infinity — the loop
   * stops naturally when a page returns 0 results. Override to read the real
   * total from the page so all pages are fetched without an extra empty request.
   */
  protected async getTotalPages(_page: Page): Promise<number> {
    return Infinity;
  }

  /** Hard cap — never fetch more than this many pages in one run */
  protected readonly MAX_PAGES = 5;

  // ── Shared browser setup ──────────────────────────────────────────────────

  protected async createContext() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      locale: "en-US",
      viewport: { width: 1280, height: 800 },
    });
    return { browser, context };
  }

  // ── Shared scrape loop ────────────────────────────────────────────────────

  /**
   * @param keyword  Search term
   * @param pages    Number of pages to fetch. Pass 0 (default) to auto-fetch
   *                 ALL available pages (capped at MAX_PAGES).
   */
  async scrape(keyword: string, pages = 0): Promise<Job[]> {
    const { browser, context } = await this.createContext();
    const autoMode = pages === 0;

    try {
      // ── Step 1: fetch page 1 to warm up and detect total pages ─────────────
      const firstPage = await context.newPage();
      await firstPage.goto(this.buildUrl(keyword, 1), {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await firstPage
        .waitForSelector(this.getWaitSelector(), { timeout: 20000 })
        .catch(() =>
          console.warn(`[${this.name}] Selector timeout — continuing anyway`),
        );
      await firstPage.waitForTimeout(2000);

      const totalPages = autoMode
        ? Math.min(await this.getTotalPages(firstPage), this.MAX_PAGES)
        : Math.min(pages, this.MAX_PAGES);

      console.log(
        `[${this.name}] Total pages to fetch: ${totalPages === this.MAX_PAGES && autoMode ? `${this.MAX_PAGES} (capped)` : totalPages}`,
      );

      const firstRaw = await this.extractJobs(firstPage);
      await firstPage.close();

      if (firstRaw.length === 0) {
        console.warn(`[${this.name}] No jobs found on page 1. Stopping.`);
        return [];
      }

      // ── Step 2: fetch all remaining pages in parallel ──────────────────────
      const remainingPageNums = Array.from(
        { length: totalPages - 1 },
        (_, i) => i + 2,
      );

      const fetchPage = async (p: number): Promise<Omit<Job, "source">[]> => {
        const tab = await context.newPage();
        try {
          console.log(`[${this.name}] Fetching page ${p}/${totalPages}`);
          await tab.goto(this.buildUrl(keyword, p), {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          await tab
            .waitForSelector(this.getWaitSelector(), { timeout: 20000 })
            .catch(() => {});
          await tab.waitForTimeout(2000);
          return await this.extractJobs(tab);
        } finally {
          await tab.close();
        }
      };

      const settled = await Promise.allSettled(
        remainingPageNums.map((p) => fetchPage(p)),
      );

      // ── Step 3: collect results in page order ──────────────────────────────
      const allJobs: Job[] = firstRaw.map((j) => ({ ...j, source: this.name }));

      for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        if (result.status === "fulfilled") {
          if (result.value.length === 0) {
            console.warn(
              `[${this.name}] Page ${remainingPageNums[i]} returned 0 jobs — skipping.`,
            );
          } else {
            allJobs.push(
              ...result.value.map((j) => ({ ...j, source: this.name })),
            );
          }
        } else {
          console.error(
            `[${this.name}] Page ${remainingPageNums[i]} failed:`,
            result.reason,
          );
        }
      }

      return allJobs;
    } finally {
      await browser.close();
    }
  }

  // ── Shared DOM helper available to all subclasses ─────────────────────────

  /**
   * Generic DOM extractor driven by a `DomSelectors` config object.
   * Serializes the config into `page.evaluate()` so it runs in the browser.
   */
  protected async extractFromDom(
    page: Page,
    selectors: DomSelectors,
  ): Promise<Omit<Job, "source">[]> {
    return page.evaluate(
      ({
        sel,
        baseUrl,
      }: {
        sel: DomSelectors;
        baseUrl: string;
      }): Omit<Job, "source">[] => {
        /** Try each selector in order; return first non-empty innerText */
        const pickText = (
          root: Element,
          candidates: string[] = [],
        ): string | undefined => {
          for (const s of candidates) {
            const el = root.querySelector(s) as HTMLElement | null;
            const t = el?.innerText?.trim();
            if (t) return t;
          }
          return undefined;
        };

        const results: Omit<Job, "source">[] = [];

        // Find the first card selector that yields results
        let cards: NodeListOf<Element> | null = null;
        for (const cardSel of sel.card) {
          const found = document.querySelectorAll(cardSel);
          if (found.length > 0) {
            cards = found;
            break;
          }
        }
        if (!cards || cards.length === 0) return results;

        cards.forEach((card) => {
          const title = pickText(card, sel.title) ?? "N/A";
          if (title === "N/A") return; // skip empty cards

          const company = pickText(card, sel.company) ?? "N/A";
          const location = pickText(card, sel.location) ?? "N/A";
          const salary = pickText(card, sel.salary);
          const postedDate = pickText(card, sel.postedDate);
          const description = pickText(card, sel.description);

          // Resolve URL
          let url = baseUrl;
          const linkSels = sel.link ?? ["a[href*='/job']", "a"];
          for (const ls of linkSels) {
            const anchor = card.querySelector(ls) as HTMLAnchorElement | null;
            if (anchor?.href) {
              url = anchor.href;
              break;
            }
          }

          results.push({
            title,
            company,
            location,
            salary,
            postedDate,
            description,
            url,
          });
        });

        return results;
      },
      { sel: selectors, baseUrl: this.baseUrl },
    );
  }
}

// ── JobsDB HK ─────────────────────────────────────────────────────────────────

export class JobsDBScraper extends BaseJobScraper {
  readonly name = "JobsDB HK";
  readonly baseUrl = "https://hk.jobsdb.com";

  protected buildUrl(keyword: string, page: number): string {
    return `${this.baseUrl}/jobs/in-hong-kong?keywords=${encodeURIComponent(keyword.trim())}&page=${page}`;
  }

  protected getWaitSelector(): string {
    return "#__NEXT_DATA__, [data-automation='jobListing'], article[data-job-id], [data-testid='job-card']";
  }

  protected async getTotalPages(page: Page): Promise<number> {
    return page.evaluate(() => {
      const el = document.getElementById("__NEXT_DATA__");
      if (!el?.textContent) return Infinity;
      try {
        const data = JSON.parse(el.textContent);
        const sr =
          data?.props?.pageProps?.searchResults ??
          data?.props?.pageProps?.results;
        const total: number = sr?.totalCount ?? sr?.total ?? 0;
        const size: number = sr?.pageSize ?? sr?.perPage ?? 30;
        if (total > 0 && size > 0) return Math.ceil(total / size);
      } catch {
        /* fall through */
      }
      return Infinity;
    });
  }

  protected async extractJobs(page: Page): Promise<Omit<Job, "source">[]> {
    // Primary: parse embedded Next.js JSON (fast & reliable)
    const fromNextData = await page.evaluate((baseUrl: string) => {
      const results: Omit<import("./scraper").Job, "source">[] = [];
      const el = document.getElementById("__NEXT_DATA__");
      if (!el?.textContent) return results;
      try {
        const data = JSON.parse(el.textContent);
        const candidates = [
          data?.props?.pageProps?.searchResults?.jobs,
          data?.props?.pageProps?.jobs,
          data?.props?.pageProps?.results?.jobs,
          data?.props?.pageProps?.initialData?.jobs,
          data?.props?.pageProps?.searchResults?.data?.jobs,
        ];
        const list: any[] =
          candidates.find((c) => Array.isArray(c) && c.length > 0) ?? [];

        for (const job of list) {
          const relPath: string =
            job.jobUrl || (job.id ? `/job/${job.id}` : "");
          const url = relPath.startsWith("http")
            ? relPath
            : `${baseUrl}${relPath}`;
          results.push({
            title: job.title || job.jobTitle || "N/A",
            company:
              job.advertiser?.description ||
              job.company?.name ||
              job.companyName ||
              "N/A",
            location:
              job.suburb ||
              job.location?.label ||
              job.locationLabel ||
              "Hong Kong",
            salary: job.salary || job.salaryLabel || undefined,
            postedDate: job.listingDate || job.postedAt || undefined,
            description: job.teaser || job.abstract || undefined,
            url,
          });
        }
      } catch {
        // fall through
      }
      return results;
    }, this.baseUrl);

    if (fromNextData.length > 0) return fromNextData;

    // Fallback: DOM extraction
    return this.extractFromDom(page, {
      card: [
        "article[data-job-id]",
        "[data-automation='jobListing']",
        "[data-testid='job-card']",
        ".jobListing",
        ".job-item",
      ],
      title: ["[data-automation='jobTitle']", "h1", "h2", "h3"],
      company: ["[data-automation='jobCompany']", ".company-name"],
      location: ["[data-automation='jobLocation']", ".location"],
      salary: ["[data-automation='jobSalary']", ".salary"],
      postedDate: ["[data-automation='jobListingDate']", "time"],
      description: [
        "[data-automation='jobShortDescription']",
        "[class*='teaser']",
        "[class*='description']",
      ],
      link: ["a[href*='/job/']", "a"],
    });
  }
}

// ── Indeed HK ─────────────────────────────────────────────────────────────────

export class IndeedScraper extends BaseJobScraper {
  readonly name = "Indeed HK";
  readonly baseUrl = "https://hk.indeed.com";

  // Works from residential IPs (Cloudflare passes them).
  // Railway/GCP IPs are blocked by Cloudflare IP reputation — not fixable
  // with browser fingerprinting. Excluded from DEFAULT_BOARDS for Railway.

  async scrape(keyword: string, pages = 0): Promise<Job[]> {
    const maxPages = Math.min(pages || this.MAX_PAGES, this.MAX_PAGES);
    const { browser, context } = await this.createContext();
    const allJobs: Job[] = [];

    try {
      for (let p = 1; p <= maxPages; p++) {
        const url = this.buildUrl(keyword, p);
        this.log(`[Indeed HK] page ${p}/${maxPages}`);
        const tab = await context.newPage();

        try {
          await tab.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          await tab.waitForTimeout(3000);

          const html = await tab.content();
          const jobs = this.parseMosaicJson(html);
          this.log(`[Indeed HK] Page ${p}: ${jobs.length} jobs`);

          if (jobs.length === 0) {
            // Surface what page Indeed actually returned
            const title = await tab.title();
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
      await browser.close();
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

// ── CTgoodjobs HK ─────────────────────────────────────────────────────────────

export class CTgoodjobsScraper extends BaseJobScraper {
  readonly name = "CTgoodjobs HK";
  // Jobs are hosted on the jobs subdomain, not hk.ctgoodjobs.hk
  readonly baseUrl = "https://jobs.ctgoodjobs.hk";

  protected buildUrl(keyword: string, page: number): string {
    return `${this.baseUrl}/jobs?q=${encodeURIComponent(keyword.trim())}&page=${page}`;
  }

  protected getWaitSelector(): string {
    return "div.job-card, a.jc-position, a.jc-company";
  }

  protected async getTotalPages(page: Page): Promise<number> {
    return page.evaluate(() => {
      // CTgoodjobs renders "Go to last page (N)" anchor
      const anchors = Array.from(document.querySelectorAll("a"));
      for (const a of anchors) {
        const match =
          a.innerText.match(/last page.*?(\d+)/i) ??
          a.getAttribute("aria-label")?.match(/last.*?(\d+)/i);
        if (match) return parseInt(match[1], 10);
      }
      // Fallback: highest page= param in pagination links
      const pageNums = anchors
        .map((a) => {
          const m = a.href.match(/[?&]page=(\d+)/);
          return m ? parseInt(m[1], 10) : 0;
        })
        .filter(Boolean);
      return pageNums.length > 0 ? Math.max(...pageNums) : Infinity;
    });
  }

  protected async extractJobs(page: Page): Promise<Omit<Job, "source">[]> {
    return page.evaluate((baseUrl: string) => {
      const results: Omit<import("./scraper").Job, "source">[] = [];

      const cards = document.querySelectorAll("div.job-card");
      cards.forEach((card) => {
        // Title: a.jc-position contains an h2 with bold tags
        const titleEl = card.querySelector(
          "a.jc-position h2",
        ) as HTMLElement | null;
        const title = titleEl?.innerText?.trim() ?? "N/A";
        if (title === "N/A") return;

        // Company: a.jc-company
        const company =
          (
            card.querySelector("a.jc-company") as HTMLElement
          )?.innerText?.trim() ?? "N/A";

        // Location: first .jc-info .col-12 contains a pin SVG then the location text node
        // innerText skips SVG content, so we just get the location string directly
        const locationEl = card.querySelector(
          ".jc-info .col-12",
        ) as HTMLElement | null;
        const location = locationEl?.innerText?.trim() || "N/A";

        // Date: .jc-other contains a clock SVG + "2d ago" etc.
        const dateEl = card.querySelector(".jc-other") as HTMLElement | null;
        const postedDate = dateEl?.innerText?.trim() || undefined;

        // Job URL: from a.jc-position href
        const linkEl = card.querySelector(
          "a.jc-position",
        ) as HTMLAnchorElement | null;
        const url = linkEl?.href || baseUrl;

        results.push({ title, company, location, postedDate, url });
      });

      return results;
    }, this.baseUrl);
  }
}

// ── Multi-board aggregator ────────────────────────────────────────────────────

/** Map of available board keys to their scraper constructors */
const BOARD_MAP: Record<string, () => BaseJobScraper> = {
  jobsdb: () => new JobsDBScraper(),
  indeed: () => new IndeedScraper(),
  ctgoodjobs: () => new CTgoodjobsScraper(),
};

export class MultiboardScraper {
  private scrapers: BaseJobScraper[];

  constructor(scrapers: BaseJobScraper[]) {
    this.scrapers = scrapers;
  }

  /**
   * Scrape all boards in parallel and combine results.
   * Failed boards are skipped with a warning — they won't crash the run.
   */
  async scrape(
    keyword: string,
    pages = 0,
    log: (msg: string) => void = console.log,
  ): Promise<Job[]> {
    // Inject log into every scraper so diagnostics surface in job-status polls
    for (const s of this.scrapers) {
      (s as any).log = log;
    }

    const settled = await Promise.allSettled(
      this.scrapers.map((s) => s.scrape(keyword, pages)),
    );

    const jobs: Job[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") {
        jobs.push(...result.value);
      } else {
        log(`[MultiboardScraper] A board failed: ${result.reason}`);
      }
    }
    return jobs;
  }
}

// ── Output utilities ──────────────────────────────────────────────────────────

export function printJobs(jobs: Job[], keyword: string): void {
  if (jobs.length === 0) {
    console.log("\nNo jobs found. The page structure may have changed.");
    return;
  }

  // Group by source for cleaner output
  const bySource = jobs.reduce<Record<string, Job[]>>((acc, job) => {
    (acc[job.source] ??= []).push(job);
    return acc;
  }, {});

  const sep = "=".repeat(64);
  console.log(`\n${sep}`);
  console.log(
    `  "${keyword}"  —  ${jobs.length} job${jobs.length !== 1 ? "s" : ""} across ${Object.keys(bySource).length} board${Object.keys(bySource).length !== 1 ? "s" : ""}`,
  );
  console.log(`${sep}`);

  for (const [source, group] of Object.entries(bySource)) {
    console.log(`\n── ${source} (${group.length}) ──`);
    group.forEach((job, i) => {
      console.log(`\n  [${i + 1}] ${job.title}`);
      console.log(`      Company  : ${job.company}`);
      console.log(`      Location : ${job.location}`);
      if (job.salary) console.log(`      Salary   : ${job.salary}`);
      if (job.postedDate) console.log(`      Posted   : ${job.postedDate}`);
      if (job.description)
        console.log(
          `      Summary  : ${job.description.slice(0, 130)}${job.description.length > 130 ? "…" : ""}`,
        );
      console.log(`      URL      : ${job.url}`);
    });
  }
  console.log();
}

/**
 * Save results to disk.
 * - One combined JSON file: `results/YYYY-MM-DD/{keyword}.json`
 * - One file per board:     `results/YYYY-MM-DD/{keyword}_{board}.json`
 */
export function saveResults(jobs: Job[], keyword: string): void {
  const dateStr = new Date().toISOString().slice(0, 10);
  const safeKeyword = keyword.trim().toLowerCase().replace(/\s+/g, "_");
  const dir = path.join(process.cwd(), "results", dateStr);
  fs.mkdirSync(dir, { recursive: true });

  // Per-board files only
  const bySource = jobs.reduce<Record<string, Job[]>>((acc, job) => {
    (acc[job.source] ??= []).push(job);
    return acc;
  }, {});

  for (const [source, group] of Object.entries(bySource)) {
    const safeSource = source.toLowerCase().replace(/\s+/g, "_");
    const boardPath = path.join(dir, `${safeKeyword}_${safeSource}.json`);
    fs.writeFileSync(boardPath, JSON.stringify(group, null, 2), "utf-8");
    console.log(
      `  └─ ${source}: results/${dateStr}/${safeKeyword}_${safeSource}.json  (${group.length} jobs)`,
    );
  }
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const keyword = process.argv[2] ?? "web developer";
  // 0 = auto (all pages), any positive number = exact page count
  const pages = parseInt(process.argv[3] ?? "0", 10);
  // e.g. "jobsdb,indeed,ctgoodjobs"  — defaults to all boards
  const boardArg = process.argv[4] ?? "jobsdb,indeed,ctgoodjobs";
  const boardKeys = boardArg.split(",").map((b) => b.trim().toLowerCase());

  const scrapers: BaseJobScraper[] = [];
  for (const key of boardKeys) {
    if (BOARD_MAP[key]) {
      scrapers.push(BOARD_MAP[key]());
    } else {
      console.warn(
        `Unknown board key "${key}". Available: ${Object.keys(BOARD_MAP).join(", ")}`,
      );
    }
  }

  if (scrapers.length === 0) {
    console.error("No valid boards specified. Exiting.");
    process.exit(1);
  }

  console.log(
    `Searching for: "${keyword}"  |  pages: ${pages === 0 ? "all (auto)" : pages}  |  boards: ${scrapers.map((s) => s.name).join(", ")}`,
  );

  const multi = new MultiboardScraper(scrapers);
  const jobs = await multi.scrape(keyword, pages);
  printJobs(jobs, keyword);
  saveResults(jobs, keyword);
}

if (require.main === module) {
  main().catch(console.error);
}

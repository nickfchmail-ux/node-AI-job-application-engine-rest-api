import { type Page } from "playwright";
import { browserPool } from "../pipeline/browserPool";
import { DomSelectors, Job } from "./types";

// Configurable timeouts / retries (ms or counts) via env vars for cloud tuning
const NAV_TIMEOUT = Number(process.env.SCRAPER_NAV_TIMEOUT_MS ?? 30000);
const SELECTOR_TIMEOUT = Number(
  process.env.SCRAPER_SELECTOR_TIMEOUT_MS ?? 20000,
);
const SCRAPER_RETRIES = Number(process.env.SCRAPER_RETRIES ?? 1); // extra attempts after first
const FAILURE_SNIPPET_SIZE = Number(
  process.env.SCRAPER_FAILURE_SNIPPET_SIZE ?? 2000,
);

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
   * stops naturally when a page returns 0 results.
   */
  protected async getTotalPages(_page: Page): Promise<number> {
    return Infinity;
  }

  /** Hard cap — never fetch more than this many pages in one run */
  protected readonly MAX_PAGES = 5;

  // ── Shared scrape loop ────────────────────────────────────────────────────

  /**
   * @param keyword  Search term
   * @param pages    Number of pages to fetch. Pass 0 (default) to auto-fetch
   *                 ALL available pages (capped at MAX_PAGES).
   */
  async scrape(keyword: string, pages = 0): Promise<Job[]> {
    const context = await browserPool.acquire();
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

          let lastErr: any = null;
          // Attempt initial + SCRAPER_RETRIES retries
          for (let attempt = 1; attempt <= SCRAPER_RETRIES + 1; attempt++) {
            try {
              const resp = await tab.goto(this.buildUrl(keyword, p), {
                waitUntil: "domcontentloaded",
                timeout: NAV_TIMEOUT,
              });
              await tab
                .waitForSelector(this.getWaitSelector(), {
                  timeout: SELECTOR_TIMEOUT,
                })
                .catch(() => {});
              await tab.waitForTimeout(2000);
              // Small success log with response status when available
              if (resp && typeof (resp as any).status === "function") {
                console.log(
                  `[${this.name}] Page ${p} response: ${(resp as any).status()}`,
                );
              }
              return await this.extractJobs(tab);
            } catch (err) {
              lastErr = err;
              console.warn(
                `[${this.name}] Page ${p} attempt ${attempt} failed: ${err}`,
              );
              if (attempt <= SCRAPER_RETRIES) {
                // Backoff before retrying
                const backoff = 1000 * attempt;
                await tab.waitForTimeout(backoff);
                continue;
              }
              // Final failure — capture a small HTML snippet for diagnostics
              try {
                const html = await tab.content();
                const snippet = html.slice(0, FAILURE_SNIPPET_SIZE);
                console.error(
                  `[${this.name}] Final failure on page ${p}: ${String(
                    lastErr,
                  )}. HTML snippet:\n${snippet}`,
                );
              } catch (e) {
                console.error(
                  `[${this.name}] Failed to capture page content: ${e}`,
                );
              }
              throw lastErr;
            }
          }
          // unreachable, but satisfy TS
          throw lastErr;
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
      await browserPool.release(context);
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
          if (title === "N/A") return;

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

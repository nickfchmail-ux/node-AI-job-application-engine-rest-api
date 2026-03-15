import { BaseJobScraper } from "./base";
import { CTgoodjobsScraper } from "./ctgoodjobs";
import { IndeedScraper } from "./indeed";
import { JobsDBScraper } from "./jobsdb";
import { Job } from "./types";

/** Map of available board keys to their scraper constructors */
export const BOARD_MAP: Record<string, () => BaseJobScraper> = {
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
   * Scrape all boards sequentially and combine results.
   * Sequential (not parallel) to keep peak memory low in constrained containers —
   * each board acquires a browser context, scrapes, then releases before the next starts.
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

    const jobs: Job[] = [];
    for (const scraper of this.scrapers) {
      try {
        const results = await scraper.scrape(keyword, pages);
        jobs.push(...results);
      } catch (err) {
        log(`[MultiboardScraper] A board failed: ${err}`);
      }
    }
    return jobs;
  }
}

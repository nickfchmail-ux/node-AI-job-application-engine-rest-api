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

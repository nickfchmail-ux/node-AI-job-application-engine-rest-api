import { CTgoodjobsScraper } from "./ctgoodjobs";
import { IndeedScraper } from "./indeed";
import { JobsDBScraper } from "./jobsdb";
import { LinkedInScraper } from "./linkedin";
import { OfferTodayScraper } from "./offertoday";
import { Job, JobScraper } from "./types";

/** Map of available board keys to their scraper constructors */
export const BOARD_MAP: Record<string, () => JobScraper> = {
  jobsdb: () => new JobsDBScraper(),
  indeed: () => new IndeedScraper(),
  ctgoodjobs: () => new CTgoodjobsScraper(),
  linkedin: () => new LinkedInScraper(),
  offertoday: () => new OfferTodayScraper(),
};

export class MultiboardScraper {
  private scrapers: JobScraper[];

  constructor(scrapers: JobScraper[]) {
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
      s.log = log;
    }

    const jobs: Job[] = [];
    for (const scraper of this.scrapers) {
      try {
        const results = await scraper.scrape(keyword, pages);
        log(`[${scraper.name}] returned ${results.length} job(s)`);
        jobs.push(...results);
      } catch (err) {
        log(`[MultiboardScraper] ${scraper.name} failed: ${err}`);
      }
    }
    return jobs;
  }
}

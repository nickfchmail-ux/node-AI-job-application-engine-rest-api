import { type Page } from "playwright";
import { BaseJobScraper } from "./base";
import { Job } from "./types";

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
      const results: {
        title: string;
        company: string;
        location: string;
        salary?: string;
        postedDate?: string;
        description?: string;
        url: string;
      }[] = [];
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

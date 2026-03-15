import { type Page } from "playwright";
import { browserPool } from "../pipeline/browserPool";
import { BaseJobScraper } from "./base";
import { Job } from "./types";

// Works from residential IPs (Cloudflare passes them).
// Railway/GCP IPs are blocked by Cloudflare IP reputation — not fixable
// with browser fingerprinting. Excluded from DEFAULT_BOARDS for Railway.
export class IndeedScraper extends BaseJobScraper {
  readonly name = "Indeed HK";
  readonly baseUrl = "https://hk.indeed.com";

  async scrape(keyword: string, pages = 0): Promise<Job[]> {
    const maxPages = Math.min(pages || this.MAX_PAGES, this.MAX_PAGES);
    const context = await browserPool.acquire();
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

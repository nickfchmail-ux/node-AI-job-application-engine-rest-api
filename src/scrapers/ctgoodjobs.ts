import { type Page } from "playwright";
import { BaseJobScraper } from "./base";
import { Job } from "./types";

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
      const results: {
        title: string;
        company: string;
        location: string;
        postedDate?: string;
        url: string;
      }[] = [];

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

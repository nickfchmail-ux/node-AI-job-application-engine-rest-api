import * as cheerio from "cheerio";
import { Job } from "./types";

const BASE_URL = "https://jobs.ctgoodjobs.hk";
const MAX_PAGES = 5;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

/**
 * CTgoodjobs scraper using plain HTTP fetch + cheerio.
 *
 * CTgoodjobs serves a "Human Verification" CAPTCHA to headless browsers
 * (Playwright) from datacenter IPs, but plain HTTP requests get the real
 * server-rendered HTML. This scraper avoids Playwright entirely.
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

  private parseJobs(html: string): Omit<Job, "source">[] {
    const $ = cheerio.load(html);
    const results: Omit<Job, "source">[] = [];

    $("div.job-card").each((_, card) => {
      const titleEl = $(card).find("a.jc-position h2");
      const title = titleEl.text().trim();
      if (!title) return;

      const company = $(card).find("a.jc-company").text().trim() || "N/A";
      const location =
        $(card).find(".jc-info .col-12").first().text().trim() || "N/A";
      const postedDate = $(card).find(".jc-other").text().trim() || undefined;

      const linkEl = $(card).find("a.jc-position");
      const href = linkEl.attr("href") || "";
      const url = href.startsWith("http") ? href : `${BASE_URL}${href}`;

      results.push({ title, company, location, postedDate, url });
    });

    return results;
  }

  private getTotalPages(html: string): number {
    const $ = cheerio.load(html);
    // Look for highest page= param in pagination links
    let maxPage = 1;
    $("a[href*='page=']").each((_, el) => {
      const href = $(el).attr("href") || "";
      const m = href.match(/[?&]page=(\d+)/);
      if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
    });
    // Also check aria-label for "last page (N)"
    $("a").each((_, el) => {
      const label = $(el).attr("aria-label") || $(el).text();
      const m = label.match(/last.*?(\d+)/i);
      if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
    });
    return Math.min(maxPage, MAX_PAGES);
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

    const firstJobs = this.parseJobs(html1);
    if (firstJobs.length === 0) {
      this.log(`[${this.name}] 0 jobs on page 1 — possible layout change`);
      return [];
    }

    const totalPages = autoMode
      ? this.getTotalPages(html1)
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
          return this.parseJobs(html);
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

/**
 * Quick script to inspect a CTgoodjobs job detail page and dump what selectors work.
 * Usage: npx tsx src/inspect_job.ts <url>
 */
import { chromium } from "playwright";

async function main() {
  const url = process.argv[2];
  if (!url) {
    // First, scrape a listing page to get a real job URL
    console.log("No URL provided — scraping a listing page to find one...");
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("https://jobs.ctgoodjobs.hk/jobs?q=developer&page=1", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(3000);
    const firstUrl = await page.evaluate(() => {
      const link = document.querySelector("a.jc-position") as HTMLAnchorElement;
      return link?.href ?? null;
    });
    await browser.close();
    if (!firstUrl) {
      console.error("Could not find a job link on the listing page");
      process.exit(1);
    }
    console.log("Found job URL:", firstUrl);
    await inspect(firstUrl);
    return;
  }
  await inspect(url);
}

async function inspect(url: string) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  console.log(`\nNavigating to: ${url}\n`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(5000);

  // Dump candidates
  const info = await page.evaluate(() => {
    const results: Record<string, string> = {};

    // Check various selectors
    const selectors = [
      "#jd__desc",
      "[class*='jd']",
      "[class*='job-desc']",
      "[class*='job-detail']",
      "[class*='jobDesc']",
      "[class*='jobDetail']",
      "[class*='description']",
      "[class*='content']",
      "article",
      "section.content",
      "[data-automation='jobAdDetails']",
      ".job-description",
      ".job-detail",
      ".job-content",
      ".detail-content",
      ".jd-content",
      ".jd-description",
      ".jd-detail",
      "#job-description",
      "#job-detail",
      "#jobDescription",
      "#jobDetail",
    ];

    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          results[sel] = `${els.length} match(es) — first innerText length: ${(els[0] as HTMLElement).innerText?.length ?? 0}, preview: ${(els[0] as HTMLElement).innerText?.slice(0, 200) ?? ""}`;
        }
      } catch {}
    }

    // Also dump all IDs on the page
    const allIds = Array.from(document.querySelectorAll("[id]")).map(
      (el) => `#${el.id} (tag: ${el.tagName}, text len: ${(el as HTMLElement).innerText?.length ?? 0})`,
    );

    // Dump classes that contain "jd" or "job" or "desc" or "detail"
    const relevantClasses = Array.from(document.querySelectorAll("*"))
      .filter((el) => {
        const cls = el.className;
        if (typeof cls !== "string") return false;
        return /jd|job|desc|detail|content/i.test(cls);
      })
      .slice(0, 50)
      .map(
        (el) =>
          `${el.tagName}.${el.className.split(/\s+/).join(".")} (text len: ${(el as HTMLElement).innerText?.length ?? 0})`,
      );

    return { selectorResults: results, allIds, relevantClasses };
  });

  console.log("=== Selector matches ===");
  for (const [sel, val] of Object.entries(info.selectorResults)) {
    console.log(`  ${sel}: ${val}`);
  }

  console.log("\n=== All IDs on page ===");
  for (const id of info.allIds) {
    console.log(`  ${id}`);
  }

  console.log("\n=== Relevant classes (jd|job|desc|detail|content) ===");
  for (const cls of info.relevantClasses) {
    console.log(`  ${cls}`);
  }

  // Also dump full page HTML length and a larger snippet
  const htmlLen = await page.evaluate(() => document.documentElement.outerHTML.length);
  console.log(`\nTotal HTML length: ${htmlLen}`);

  // Dump first 2000 chars of body text
  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) ?? "");
  console.log("\n=== Body text (first 2000 chars) ===");
  console.log(bodyText);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

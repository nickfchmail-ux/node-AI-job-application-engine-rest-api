import { chromium } from "playwright";

(async () => {
  console.log("Launching Playwright...");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const url =
    "https://hk.jobsdb.com/jobs/in-hong-kong?keywords=__integration_test_keyword&page=1";
  console.log("Navigating to", url);
  try {
    const resp = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    console.log("Response status:", resp?.status());
    const title = await page.title();
    console.log("Title:", title);
    const hasNext = (await page.$("#__NEXT_DATA__")) !== null;
    console.log("__NEXT_DATA__ present:", hasNext);
    const bodySnippet = await page.evaluate(
      () => document.body?.innerText?.slice(0, 200) ?? "",
    );
    console.log("Body snippet:", bodySnippet.replace(/\n/g, " "));
  } catch (e) {
    console.error("Navigation error:", (e as Error).message);
  } finally {
    await browser.close();
  }
})();

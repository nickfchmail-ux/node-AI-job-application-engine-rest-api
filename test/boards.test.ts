// ============================================================
//  test/boards.test.ts — end-to-end board test
//
//  Tests the full row-creation path per board WITHOUT needing
//  Azure/Supabase:
//    1. fetch search page via local Cloudflare proxy (wrangler dev)
//    2. run extractListings() (the same parser the scraper uses)
//    3. for the first listing, fetch its DETAIL page via proxy
//    4. run enrichOneJob() to confirm content extraction works
//
//  Usage: start `wrangler dev --port 8787`, then:
//    npx ts-node test/boards.test.ts
// ============================================================

import { extractListings } from "../azure/functions/src/boardParsers";
import { enrichOneJob } from "../azure/functions/src/enrich";

const PROXY = process.env.PROXY_URL ?? "http://localhost:8787";
const KEYWORD = process.env.KEYWORD ?? "web developer";

async function proxyGet(path: string): Promise<any> {
  const res = await fetch(`${PROXY}${path}`, {
    headers: { Accept: "application/json" },
  });
  return res.json();
}

async function testBoard(board: string): Promise<void> {
  console.log(`\n═══ ${board.toUpperCase()} ═══`);
  try {
    // 1. Search page via proxy
    const search = await proxyGet(
      `/${board}?keyword=${encodeURIComponent(KEYWORD)}&page=1&countryCode=hk`,
    );
    if (!search.ok) {
      console.log(
        `✗ search failed: ${search.error}${search.retryAfter ? ` (retryAfter ${search.retryAfter}s)` : ""}`,
      );
      return;
    }
    console.log(
      `✓ search OK (html ${search.html.length} bytes${search.cached ? ", cached" : ""})`,
    );

    // 2. Parse listings (same parser the scraper worker uses)
    const jobs = extractListings(board, search.html);
    console.log(`✓ parsed ${jobs.length} job(s)`);
    if (jobs.length === 0) {
      console.log(`  ⚠ no listings extracted — board may have changed layout`);
      return;
    }
    const first = jobs[0];
    console.log(`  sample: "${first.title}" @ ${first.company} — ${first.url}`);

    // 3. Detail page via proxy (the per-job content step)
    const detail = await proxyGet(
      `/${board}/detail?url=${encodeURIComponent(first.url)}`,
    );
    if (!detail.ok) {
      console.log(`✗ detail fetch failed: ${detail.error}`);
      return;
    }
    console.log(`✓ detail OK (html ${detail.html.length} bytes)`);

    // 4. Enrich — parse the full content into structured fields
    const enriched = enrichOneJob({ ...first, rawDetailHtml: detail.html });
    const jd = enriched.jobDetail;
    console.log(
      `✓ enrich → resp=${jd.responsibilities.length} req=${jd.requirements.length} skills=${jd.skills.length} ben=${jd.benefits.length}`,
    );
    console.log(`  rawDescription chars: ${jd.rawDescription.length}`);
    if (jd.rawDescription.length < 50) {
      console.log(
        `  ⚠ raw description is short — content may not be extracted well`,
      );
    } else {
      console.log(
        `  content preview: "${jd.rawDescription.slice(0, 120).replace(/\n/g, " ")}..."`,
      );
    }
  } catch (err) {
    console.log(`✗ board test error: ${err}`);
  }
}

async function main(): Promise<void> {
  const boards = (
    process.env.BOARDS ?? "jobsdb,ctgoodjobs,indeed,offertoday"
  ).split(",");
  console.log(`Testing boards: ${boards.join(", ")} (keyword: "${KEYWORD}")`);
  for (const b of boards) await testBoard(b.trim());
  console.log("\n═══ done ═══");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

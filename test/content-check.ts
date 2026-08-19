// Quick content-quality check for a single board's detail extraction
import { extractListings } from "../azure/functions/src/boardParsers";
import { enrichOneJob } from "../azure/functions/src/enrich";

const PROXY = process.env.PROXY_URL ?? "http://localhost:8787";
const BOARD = process.env.BOARD ?? "ctgoodjobs";
const KEYWORD = process.env.KEYWORD ?? "web developer";

async function main() {
  const search = await (
    await fetch(
      `${PROXY}/${BOARD}?keyword=${encodeURIComponent(KEYWORD)}&page=1&countryCode=hk`,
    )
  ).json();
  if (!search.ok) {
    console.log(`search failed: ${search.error}`);
    return;
  }
  const jobs = extractListings(BOARD, search.html);
  console.log(`${BOARD} jobs:`, jobs.length);
  if (jobs.length === 0) return;
  const first = jobs[0];
  const detail = await (
    await fetch(`${PROXY}/${BOARD}/detail?url=${encodeURIComponent(first.url)}`)
  ).json();
  console.log(
    `detail ok: ${detail.ok}, html ${detail.html?.length ?? 0} bytes`,
  );
  const enriched = enrichOneJob({ ...first, rawDetailHtml: detail.html });
  const jd = enriched.jobDetail;
  console.log(`=== ${BOARD} first job ===`);
  console.log("title:", enriched.title);
  console.log("company:", enriched.company);
  console.log("location:", enriched.location);
  console.log("resp[0]:", jd.responsibilities[0]);
  console.log("req[0]:", jd.requirements[0]);
  console.log("skills[0..3]:", JSON.stringify(jd.skills.slice(0, 4)));
  console.log("aboutCompany:", jd.aboutCompany?.slice(0, 120));
}

main();

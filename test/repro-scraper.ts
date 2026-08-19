// Reproduce scraper worker logic locally against live Cloudflare worker
import { extractListings } from "../azure/functions/src/boardParsers";
import { fetchBoardPage } from "../azure/functions/src/cloudflareProxy";

async function main() {
  process.env.CLOUDFLARE_PROXY_URL =
    "https://jobboard-proxy.nickfchmail.workers.dev";
  const r = await fetchBoardPage({
    board: "jobsdb",
    keyword: "web developer",
    page: 1,
    countryCode: "hk",
    log: console.log,
  });
  console.log("proxy result ok:", r.ok);
  if (r.ok) {
    const jobs = extractListings("jobsdb", r.html);
    console.log("jobs parsed:", jobs.length);
    if (jobs[0]) console.log("sample:", jobs[0].title, "|", jobs[0].url);
  } else {
    console.log("error:", r.error);
  }
}
main();

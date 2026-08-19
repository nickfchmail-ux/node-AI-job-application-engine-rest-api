// Test the full fetchBoardPage with DataImpulse fallback locally
import { extractListings } from "../azure/functions/src/boardParsers";
import { fetchBoardPage } from "../azure/functions/src/cloudflareProxy";

async function main() {
  process.env.CLOUDFLARE_PROXY_URL =
    "https://jobboard-proxy.nickfchmail.workers.dev";
  process.env.DATA_IMPULSE_PROXY_URL =
    "http://1dadd5807dd571717a52__cr.hk:1dd6773e6f2686b6@gw.dataimpulse.com:823";

  console.log("Testing JobsDB via Cloudflare → DataImpulse fallback...");
  const r = await fetchBoardPage({
    board: "jobsdb",
    keyword: "web developer",
    page: 1,
    countryCode: "hk",
    log: console.log,
  });
  console.log("result ok:", r.ok);
  if (r.ok) {
    const jobs = extractListings("jobsdb", r.html);
    console.log("jobs parsed:", jobs.length);
    if (jobs[0]) console.log("sample:", jobs[0].title, "|", jobs[0].url);
  } else {
    console.log("error:", r.error);
  }
}
main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});

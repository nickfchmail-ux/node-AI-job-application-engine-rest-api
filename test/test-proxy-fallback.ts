// Test the full fetchBoardPage with DataImpulse fallback locally
import { extractListings } from "../azure/functions/src/boardParsers";
import { fetchBoardPage } from "../azure/functions/src/cloudflareProxy";

// ⚠️ The proxy credential is read from the ENVIRONMENT and must never be
// hardcoded here. A previous revision carried it in plaintext, so that
// credential is considered compromised — rotate it in the DataImpulse
// dashboard before relying on it.
async function main() {
  process.env.CLOUDFLARE_PROXY_URL =
    "https://jobboard-proxy.nickfchmail.workers.dev";
  if (!process.env.DATA_IMPULSE_PROXY_URL) {
    console.error("DATA_IMPULSE_PROXY_URL is not set — aborting.");
    process.exit(1);
  }

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

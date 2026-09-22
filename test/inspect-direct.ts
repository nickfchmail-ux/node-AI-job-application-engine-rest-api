// Inspect the HTML from the DataImpulse proxy for JobsDB
import * as fs from "fs";
import { fetchBoardDirect } from "../azure/functions/src/directProxy";

// ⚠️ The proxy credential is read from the ENVIRONMENT and must never be
// hardcoded here. A previous revision carried it in plaintext, so that
// credential is considered compromised — rotate it in the DataImpulse
// dashboard before relying on it.
// Note: the DataImpulse residential proxy was returning 429 + a challenge page
// and is treated as dead; the live path is ScraperAPI + the Cloudflare worker.
async function main() {
  if (!process.env.DATA_IMPULSE_PROXY_URL) {
    console.error("DATA_IMPULSE_PROXY_URL is not set — aborting.");
    process.exit(1);
  }
  const r = await fetchBoardDirect({
    board: "jobsdb",
    keyword: "web developer",
    page: 1,
    countryCode: "hk",
    log: console.log,
  });
  console.log("ok:", r.ok, "| error:", r.error);
  if (r.ok && r.html) {
    fs.writeFileSync("jobsdb_direct.html", r.html);
    console.log("saved, len:", r.html.length);
    console.log("has data-job-id:", r.html.includes("data-job-id"));
    console.log(
      "has normalJob:",
      r.html.includes('data-automation="normalJob"'),
    );
    console.log("has captcha:", /captcha|cf-chl/i.test(r.html.slice(0, 4000)));
    console.log("first 300 chars:", r.html.slice(0, 300).replace(/\s+/g, " "));
  }
}
main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});

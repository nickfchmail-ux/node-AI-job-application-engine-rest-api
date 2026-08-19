// Inspect the HTML from the DataImpulse proxy for JobsDB
import * as fs from "fs";
import { fetchBoardDirect } from "../azure/functions/src/directProxy";

async function main() {
  process.env.DATA_IMPULSE_PROXY_URL =
    "http://1dadd5807dd571717a52__cr.hk:1dd6773e6f2686b6@gw.dataimpulse.com:823";
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

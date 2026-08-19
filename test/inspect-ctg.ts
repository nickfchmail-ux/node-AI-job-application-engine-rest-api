// Inspect a CTgoodjobs detail page to find where the real job description lives
import * as fs from "fs";
import { extractListings } from "../azure/functions/src/boardParsers";

const PROXY = "http://localhost:8787";

async function main() {
  const search = await (
    await fetch(
      `${PROXY}/ctgoodjobs?keyword=web%20developer&page=1&countryCode=hk`,
    )
  ).json();
  const jobs = extractListings("ctgoodjobs", search.html);
  const first = jobs[0];
  const detail = await (
    await fetch(
      `${PROXY}/ctgoodjobs/detail?url=${encodeURIComponent(first.url)}`,
    )
  ).json();
  const html: string = detail.html;
  fs.writeFileSync("ctg_detail.html", html);
  console.log("saved ctg_detail.html", html.length);

  const markers = [
    "Higher Diploma",
    "applyjob@clts.com",
    "responsibilit",
    "jobDescription",
    "job-description",
    "Job Responsibilities",
    "What You",
    "Description",
    "jobDetail",
  ];
  for (const m of markers) {
    const i = html.indexOf(m);
    console.log(m, "->", i);
  }

  // Show 300 chars around 'Higher Diploma' to see the container
  const i = html.indexOf("Higher Diploma");
  if (i > 0) {
    console.log("\n--- context around Higher Diploma ---");
    console.log(JSON.stringify(html.slice(i - 300, i + 200)));
  }
}

main();

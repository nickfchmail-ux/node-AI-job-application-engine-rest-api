// Check if JobsDB detail page has a JSON-LD JobPosting block
import * as fs from "fs";
import { extractListings } from "../azure/functions/src/boardParsers";
import { extractRawDescription } from "../azure/functions/src/enrich";

async function main() {
  const search = await (
    await fetch(
      "http://localhost:8787/jobsdb?keyword=web%20developer&page=1&countryCode=hk",
    )
  ).json();
  const jobs = extractListings("jobsdb", search.html);
  const first = jobs[0];
  const detail = await (
    await fetch(
      `http://localhost:8787/jobsdb/detail?url=${encodeURIComponent(first.url)}`,
    )
  ).json();
  const html: string = detail.html;
  fs.writeFileSync("jobsdb_detail.html", html);
  console.log("jobsdb detail saved:", html.length);

  // Check for JSON-LD
  const ld = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>/gi,
  );
  console.log("JSON-LD blocks:", ld?.length ?? 0);

  const raw = extractRawDescription({ ...first, rawDetailHtml: html });
  console.log("raw len:", raw.length);
  console.log("--- first 300 chars ---");
  console.log(raw.slice(0, 300));
}

main();

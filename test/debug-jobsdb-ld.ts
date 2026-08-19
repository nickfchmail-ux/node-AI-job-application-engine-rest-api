// Inspect the JobsDB JSON-LD block content
import * as fs from "fs";

const html = fs.readFileSync("jobsdb_detail.html", "utf-8");
const blocks =
  html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  ) ?? [];
console.log("JSON-LD blocks:", blocks.length);
for (const b of blocks) {
  const m = b.match(/>([\s\S]*?)<\/script>/i);
  if (!m?.[1]) continue;
  try {
    const parsed = JSON.parse(m[1].trim());
    console.log("type:", parsed?.["@type"]);
    if (parsed?.["@type"] === "JobPosting") {
      console.log("title:", parsed.title);
      console.log("description len:", parsed.description?.length);
      console.log("description head:", parsed.description?.slice(0, 200));
    }
  } catch (e) {
    console.log("parse error:", (e as Error).message.slice(0, 80));
  }
}

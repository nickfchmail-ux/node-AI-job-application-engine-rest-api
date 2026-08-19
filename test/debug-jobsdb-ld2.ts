// Inspect the actual structure of the JobsDB JSON-LD block
import * as fs from "fs";

const html = fs.readFileSync("jobsdb_detail.html", "utf-8");
const blocks =
  html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  ) ?? [];
for (const b of blocks) {
  const m = b.match(/>([\s\S]*?)<\/script>/i);
  if (!m?.[1]) continue;
  const raw = m[1].trim();
  console.log("raw len:", raw.length);
  console.log("head:", raw.slice(0, 300));
  try {
    const parsed = JSON.parse(raw);
    console.log("keys:", Object.keys(parsed));
    console.log("is array:", Array.isArray(parsed));
    if (Array.isArray(parsed)) {
      parsed.forEach((item, i) => {
        console.log(
          `  [${i}] @type:`,
          item?.["@type"],
          "has description:",
          typeof item?.description,
        );
      });
    }
  } catch (e) {
    console.log("parse error:", (e as Error).message.slice(0, 120));
  }
}

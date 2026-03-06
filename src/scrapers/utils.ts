import * as fs from "fs";
import * as path from "path";
import { BaseJobScraper } from "./base";
import { BOARD_MAP, MultiboardScraper } from "./multiboard";
import { Job } from "./types";

export function printJobs(jobs: Job[], keyword: string): void {
  if (jobs.length === 0) {
    console.log("\nNo jobs found. The page structure may have changed.");
    return;
  }

  // Group by source for cleaner output
  const bySource = jobs.reduce<Record<string, Job[]>>((acc, job) => {
    (acc[job.source] ??= []).push(job);
    return acc;
  }, {});

  const sep = "=".repeat(64);
  console.log(`\n${sep}`);
  console.log(
    `  "${keyword}"  —  ${jobs.length} job${jobs.length !== 1 ? "s" : ""} across ${Object.keys(bySource).length} board${Object.keys(bySource).length !== 1 ? "s" : ""}`,
  );
  console.log(`${sep}`);

  for (const [source, group] of Object.entries(bySource)) {
    console.log(`\n── ${source} (${group.length}) ──`);
    group.forEach((job, i) => {
      console.log(`\n  [${i + 1}] ${job.title}`);
      console.log(`      Company  : ${job.company}`);
      console.log(`      Location : ${job.location}`);
      if (job.salary) console.log(`      Salary   : ${job.salary}`);
      if (job.postedDate) console.log(`      Posted   : ${job.postedDate}`);
      if (job.description)
        console.log(
          `      Summary  : ${job.description.slice(0, 130)}${job.description.length > 130 ? "…" : ""}`,
        );
      console.log(`      URL      : ${job.url}`);
    });
  }
  console.log();
}

/**
 * Save results to disk.
 * - One file per board: `results/YYYY-MM-DD/{keyword}_{board}.json`
 */
export function saveResults(jobs: Job[], keyword: string): void {
  const dateStr = new Date().toISOString().slice(0, 10);
  const safeKeyword = keyword.trim().toLowerCase().replace(/\s+/g, "_");
  const dir = path.join(process.cwd(), "results", dateStr);
  fs.mkdirSync(dir, { recursive: true });

  const bySource = jobs.reduce<Record<string, Job[]>>((acc, job) => {
    (acc[job.source] ??= []).push(job);
    return acc;
  }, {});

  for (const [source, group] of Object.entries(bySource)) {
    const safeSource = source.toLowerCase().replace(/\s+/g, "_");
    const boardPath = path.join(dir, `${safeKeyword}_${safeSource}.json`);
    fs.writeFileSync(boardPath, JSON.stringify(group, null, 2), "utf-8");
    console.log(
      `  └─ ${source}: results/${dateStr}/${safeKeyword}_${safeSource}.json  (${group.length} jobs)`,
    );
  }
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const keyword = process.argv[2] ?? "web developer";
  // 0 = auto (all pages), any positive number = exact page count
  const pages = parseInt(process.argv[3] ?? "0", 10);
  // e.g. "jobsdb,indeed,ctgoodjobs"  — defaults to all boards
  const boardArg = process.argv[4] ?? "jobsdb,indeed,ctgoodjobs";
  const boardKeys = boardArg.split(",").map((b) => b.trim().toLowerCase());

  const scrapers: BaseJobScraper[] = [];
  for (const key of boardKeys) {
    if (BOARD_MAP[key]) {
      scrapers.push(BOARD_MAP[key]());
    } else {
      console.warn(
        `Unknown board key "${key}". Available: ${Object.keys(BOARD_MAP).join(", ")}`,
      );
    }
  }

  if (scrapers.length === 0) {
    console.error("No valid boards specified. Exiting.");
    process.exit(1);
  }

  console.log(
    `Searching for: "${keyword}"  |  pages: ${pages === 0 ? "all (auto)" : pages}  |  boards: ${scrapers.map((s) => s.name).join(", ")}`,
  );

  const multi = new MultiboardScraper(scrapers);
  const jobs = await multi.scrape(keyword, pages);
  printJobs(jobs, keyword);
  saveResults(jobs, keyword);
}

if (require.main === module) {
  main().catch(console.error);
}

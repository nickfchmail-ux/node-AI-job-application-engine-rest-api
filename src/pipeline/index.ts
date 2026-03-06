import { getSupabaseClient } from "../db";
import { analyzeJobs } from "./analyze";
import { enrichJobs } from "./enrich";
import { upsertToSupabase } from "./persist";
import { loadResumeText } from "./resume";
import { DEFAULT_BOARDS, scrapeJobs } from "./scrape";
import { AnalysedJob, PipelineOptions, PipelineResult } from "./types";

export * from "./analyze";
export * from "./enrich";
export * from "./persist";
export * from "./resume";
export * from "./scrape";
export * from "./types";

export async function runPipeline(
  opts: PipelineOptions,
): Promise<PipelineResult> {
  const {
    keyword,
    pages = 1,
    force = false,
    log = console.log,
    userId,
    boards,
  } = opts;
  const cleanKeyword = keyword
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "")
    .trim();
  const safeKeyword = cleanKeyword.toLowerCase().replace(/\s+/g, "_");
  const scrapedDate = new Date().toISOString().slice(0, 10);

  // 1. Load resume
  const resumeText = await loadResumeText(userId, log);

  // 2. Scrape
  const boardList = boards?.length ? boards : [...DEFAULT_BOARDS];
  log(
    `\n── Phase 1: Scraping "${cleanKeyword}" (${pages} page(s)) on [${boardList.join(", ")}] ──`,
  );
  const rawJobs = await scrapeJobs(cleanKeyword, pages, log, boardList);

  // Deduplicate by URL (same job can appear across boards or pages)
  const seenUrls = new Set<string>();
  const uniqueJobs = rawJobs.filter((j) => {
    if (seenUrls.has(j.url)) return false;
    seenUrls.add(j.url);
    return true;
  });
  log(
    `Scraped ${uniqueJobs.length} jobs (${rawJobs.length - uniqueJobs.length} duplicates removed).`,
  );
  if (uniqueJobs.length === 0)
    throw new Error("No jobs found for this keyword.");

  // Filter out jobs already processed for this user — skip enrich, DeepSeek, and upsert
  let newJobs = uniqueJobs;
  if (userId && !force) {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from("jobs")
      .select("title, company")
      .eq("user_id", userId);
    const existing = new Set(
      (data ?? []).map(
        (r: { title: string; company: string }) => `${r.title}|${r.company}`,
      ),
    );
    const skipped = uniqueJobs.filter((j) =>
      existing.has(`${j.title}|${j.company}`),
    );
    newJobs = uniqueJobs.filter(
      (j) => !existing.has(`${j.title}|${j.company}`),
    );
    if (skipped.length > 0)
      log(`⏭  ${skipped.length} job(s) already in Supabase — skipping.`);
  }

  let analysed: AnalysedJob[];
  if (newJobs.length === 0) {
    log(`\nAll scraped jobs are already processed. Nothing new to do.`);
    analysed = [];
  } else {
    // 3. Enrich only new jobs
    log(`\n── Phase 2: Enriching ${newJobs.length} new job(s) ──`);
    const enriched = await enrichJobs(newJobs, log);

    // 4. Analyse only new jobs with DeepSeek
    log(`\n── Phase 3: Analysing fit with DeepSeek ──`);
    const freshAnalysed = await analyzeJobs(enriched, resumeText, force, log);

    // 5. Upsert only new jobs to Supabase
    log(`\n── Phase 4: Uploading to Supabase ──`);
    await upsertToSupabase(
      freshAnalysed,
      safeKeyword,
      scrapedDate,
      log,
      userId,
    );

    analysed = freshAnalysed;
  }

  const fit = analysed.filter((j) => j.fitAnalysis?.fit).length;
  return {
    keyword: safeKeyword,
    scrapedDate,
    total: analysed.length,
    fit,
    jobs: analysed,
  };
}

import { Job, Queue, Worker } from "bullmq";
import express from "express";
import { getSupabaseClient, loadEnvLocal } from "./db";
import { analyzeOne } from "./pipeline/analyze";
import { browserPool } from "./pipeline/browserPool";
import { enrichOneJob } from "./pipeline/enrich";
import { upsertToSupabase } from "./pipeline/persist";
import { loadResumeText } from "./pipeline/resume";
import { DEFAULT_BOARDS, scrapeJobs } from "./pipeline/scrape";
import type { Job as ScrapedJob } from "./pipeline/types";
import {
  PipelineJobData,
  ProcessJobData,
  QUEUE_NAME,
  ScrapeJobData,
  ScrapeResult,
} from "./queue";
import { redisConnection } from "./queue/redis";
import { fetchIndeedBatchDescriptions } from "./scrapers/indeed";
import { fetchLinkedInBatchDescriptions } from "./scrapers/linkedin";
import { fetchOfferTodayBatchDescriptions } from "./scrapers/offertoday";

loadEnvLocal();

// ----------------------------------------------------------------------
// Health check server (required for Cloud Run)
// ----------------------------------------------------------------------
const app = express();
const port = process.env.PORT || 8080;

app.get("/health", (_req, res) => {
  res.status(200).send("OK");
});

const server = app.listen(Number(port), "0.0.0.0", () => {
  console.log(`[health] Health check server listening on port ${port}`);
});
server.on("error", (err) => {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "EADDRINUSE") {
    console.warn(
      `[health] Port ${port} already in use — skipping health server (continuing without it)`,
    );
    return;
  }
  console.error("[health] Server failed to start:", err);
  process.exit(1);
});

// ----------------------------------------------------------------------
// Queue instance (for adding child jobs from within the worker)
// ----------------------------------------------------------------------
const workerQueue = new Queue<PipelineJobData, unknown, string>(QUEUE_NAME, {
  connection: redisConnection,
});

// ----------------------------------------------------------------------
// BullMQ worker with extended lock duration
// ----------------------------------------------------------------------
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 1);
const JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per job
const LOCK_DURATION_MS = 10 * 60 * 1000;
const STALLED_INTERVAL_MS = 5 * 60 * 1000;

// ── Phase 1 handler: scrape → fan-out child jobs ──────────────────────────
async function processScrapeJob(
  job: Job<ScrapeJobData>,
): Promise<ScrapeResult> {
  const { keyword, pages, force, boards, userId, countryCode } = job.data;
  const log = (msg: string) => {
    console.log(`[job ${job.id}]`, msg);
    job.log(msg).catch(() => {});
  };

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
    `── Scraping "${cleanKeyword}" (${pages} page(s)) on [${boardList.join(", ")}] ──`,
  );
  const rawJobs = await scrapeJobs(
    cleanKeyword,
    pages,
    log,
    boardList,
    countryCode,
  );

  // Deduplicate by URL
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

  // Filter out already-processed jobs
  let newJobs: ScrapedJob[] = uniqueJobs;
  if (!force) {
    const supabase = getSupabaseClient();
    let query = supabase.from("jobs").select("url");
    if (userId) {
      query = query.eq("user_id", userId);
    } else {
      query = query.is("user_id", null);
    }
    const { data } = await query;
    const existing = new Set((data ?? []).map((r: { url: string }) => r.url));
    const skipped = uniqueJobs.filter((j) => existing.has(j.url));
    newJobs = uniqueJobs.filter((j) => !existing.has(j.url));
    if (skipped.length > 0)
      log(`⏭  ${skipped.length} job(s) already in Supabase — skipping.`);
  }

  if (newJobs.length === 0) {
    log(`All scraped jobs are already processed. Nothing new to do.`);
    return { childJobIds: [], totalJobs: 0, keyword: safeKeyword, scrapedDate };
  }

  // 3. Batch-fetch Indeed descriptions (saves ~5 ScraperAPI credits per job)
  const indeedJobs = newJobs.filter((j) =>
    j.url.includes("indeed.com/viewjob"),
  );
  if (indeedJobs.length > 0) {
    log(
      `⚡ Batch-fetching ${indeedJobs.length} Indeed description(s) via RPC endpoint...`,
    );
    const jobkeyMap = new Map<string, ScrapedJob>();
    for (const j of indeedJobs) {
      const match = j.url.match(/[?&]jk=([a-f0-9]+)/i);
      if (match) jobkeyMap.set(match[1], j);
    }
    try {
      const descriptions = await fetchIndeedBatchDescriptions(
        [...jobkeyMap.keys()],
        log,
      );
      let attached = 0;
      for (const [key, html] of Object.entries(descriptions)) {
        const job = jobkeyMap.get(key);
        if (job && html) {
          job.rawDetailHtml = html;
          attached++;
        }
      }
      log(
        `✅ Pre-fetched ${attached}/${indeedJobs.length} Indeed description(s) — saving ~${attached * 5} ScraperAPI credits.`,
      );
    } catch (err) {
      log(`⚠ Indeed batch fetch failed (will fallback to ScraperAPI): ${err}`);
    }
  }

  // 3b. Batch-fetch LinkedIn descriptions (0 ScraperAPI credits)
  const linkedinJobs = newJobs.filter((j) =>
    j.url.includes("linkedin.com/jobs/view/"),
  );
  if (linkedinJobs.length > 0) {
    log(
      `⚡ Batch-fetching ${linkedinJobs.length} LinkedIn description(s) via guest API...`,
    );
    const jobIdMap = new Map<string, ScrapedJob>();
    for (const j of linkedinJobs) {
      const match = j.url.match(/\/jobs\/view\/(\d+)/);
      if (match) jobIdMap.set(match[1], j);
    }
    try {
      const descriptions = await fetchLinkedInBatchDescriptions(
        [...jobIdMap.keys()],
        log,
      );
      let attached = 0;
      for (const [id, html] of Object.entries(descriptions)) {
        const job = jobIdMap.get(id);
        if (job && html) {
          job.rawDetailHtml = html;
          attached++;
        }
      }
      log(
        `✅ Pre-fetched ${attached}/${linkedinJobs.length} LinkedIn description(s) — 0 credits used.`,
      );
    } catch (err) {
      log(`⚠ LinkedIn batch fetch failed: ${err}`);
    }
  }

  // 3c. Batch-fetch Offer Today descriptions (0 ScraperAPI credits)
  const offerTodayJobs = newJobs.filter((j) =>
    j.url.includes("offertoday.com/hk/job/"),
  );
  if (offerTodayJobs.length > 0) {
    log(
      `⚡ Batch-fetching ${offerTodayJobs.length} Offer Today description(s) via public API...`,
    );
    const jobIdMap = new Map<string, ScrapedJob>();
    for (const j of offerTodayJobs) {
      const match = j.url.match(/\/hk\/job\/([^/?#]+)/);
      if (match) jobIdMap.set(match[1], j);
    }
    try {
      const descriptions = await fetchOfferTodayBatchDescriptions(
        [...jobIdMap.keys()],
        log,
      );
      let attached = 0;
      for (const [id, html] of Object.entries(descriptions)) {
        const job = jobIdMap.get(id);
        if (job && html) {
          job.rawDetailHtml = html;
          attached++;
        }
      }
      log(
        `✅ Pre-fetched ${attached}/${offerTodayJobs.length} Offer Today description(s) — 0 credits used.`,
      );
    } catch (err) {
      log(`⚠ Offer Today batch fetch failed: ${err}`);
    }
  }

  // 4. Fan-out: create one "process-job" per listing
  log(`Dispatching ${newJobs.length} individual processing jobs...`);
  const childJobIds: string[] = [];
  for (const scrapedJob of newJobs) {
    const child = await workerQueue.add("process-job", {
      type: "process-job" as const,
      scrapedJob,
      resumeText,
      safeKeyword,
      scrapedDate,
      userId,
      force,
      parentJobId: job.id!,
    });
    childJobIds.push(child.id!);
  }

  log(
    `✓ Dispatched ${childJobIds.length} processing jobs — workers will pick them up in parallel.`,
  );
  return {
    childJobIds,
    totalJobs: newJobs.length,
    keyword: safeKeyword,
    scrapedDate,
  };
}

// ── Phase 2 handler: enrich + analyse + persist ONE job ───────────────────
async function processOneJob(job: Job<ProcessJobData>) {
  const { scrapedJob, resumeText, safeKeyword, scrapedDate, userId, force } =
    job.data;
  const log = (msg: string) => {
    console.log(`[job ${job.id}]`, msg);
    job.log(msg).catch(() => {});
  };

  // 1. Enrich
  log(`Enriching: ${scrapedJob.title} @ ${scrapedJob.company}`);
  const enriched = await enrichOneJob(scrapedJob, log);

  // 2. Analyse
  log(`Analysing fit with DeepSeek...`);
  const analysis = await analyzeOne(resumeText, enriched);
  const analysed = { ...enriched, fitAnalysis: analysis };
  const tag = analysis.fit
    ? `✅ FIT (${analysis.score})`
    : `❌ NO FIT (${analysis.score})`;
  log(`${scrapedJob.title} @ ${scrapedJob.company} — ${tag}`);

  // 3. Persist
  await upsertToSupabase([analysed], safeKeyword, scrapedDate, log, userId);
  log(`✓ Persisted to Supabase.`);

  // 4. Remove newer duplicates (same user_id + title + company), keep oldest (has user's application status)
  if (userId && analysed.title && analysed.company) {
    try {
      const supabase = getSupabaseClient();
      // Find all rows matching this user+title+company, ordered by created_at asc (oldest first)
      const { data: dupes, error: fetchErr } = await supabase
        .from("jobs")
        .select("id, created_at")
        .eq("user_id", userId)
        .eq("title", analysed.title)
        .eq("company", analysed.company)
        .order("created_at", { ascending: true });

      if (!fetchErr && dupes && dupes.length > 1) {
        // Keep the first (oldest — has application status), delete the rest
        const idsToDelete = dupes.slice(1).map((d) => d.id);
        const { error: delErr } = await supabase
          .from("jobs")
          .delete()
          .in("id", idsToDelete);
        if (delErr) {
          log(`⚠ Dedup delete error: ${delErr.message}`);
        } else {
          log(`🗑  Removed ${idsToDelete.length} newer duplicate(s) for "${analysed.title} @ ${analysed.company}".`);
        }
      }
    } catch (err) {
      log(`⚠ Dedup cleanup failed: ${err}`);
    }
  }

  return {
    title: analysed.title,
    company: analysed.company,
    fit: analysis.fit,
    score: analysis.score,
  };
}

// ── Route jobs to the correct handler ─────────────────────────────────────
async function processJob(job: Job<PipelineJobData>) {
  const data = job.data;
  if (data.type === "scrape") {
    return await processScrapeJob(job as Job<ScrapeJobData>);
  }
  if (data.type === "process-job") {
    return await processOneJob(job as Job<ProcessJobData>);
  }
  throw new Error(`Unknown job type: ${(data as Record<string, unknown>).type}`);
}

let worker: Worker | undefined;

try {
  worker = new Worker<PipelineJobData, unknown>(
    QUEUE_NAME,
    async (job: Job<PipelineJobData>) => {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Job timed out")), JOB_TIMEOUT_MS),
      );
      try {
        return await Promise.race([processJob(job), timeoutPromise]);
      } catch (error) {
        console.error(`[job ${job.id}] Unhandled error:`, error);
        throw error;
      }
    },
    {
      connection: redisConnection,
      concurrency: CONCURRENCY,
      lockDuration: LOCK_DURATION_MS,
      stalledInterval: STALLED_INTERVAL_MS,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  );

  worker.on("completed", (job) => {
    console.log(`[worker] job ${job.id} (${job.data.type}) completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[worker] job ${job?.id} (${job?.data.type}) failed:`, err.message);
  });

  worker.on("error", (err) => {
    console.error("[worker] Worker error:", err);
  });

  console.log(
    `[worker] Started — queue: "${QUEUE_NAME}", concurrency: ${CONCURRENCY}, timeout: ${JOB_TIMEOUT_MS}ms, lockDuration: ${LOCK_DURATION_MS}ms`,
  );
} catch (err) {
  console.error("[worker] Failed to initialize worker:", err);
}

// ----------------------------------------------------------------------
// Graceful shutdown
// ----------------------------------------------------------------------
async function shutdown() {
  console.log("Shutting down gracefully...");
  if (worker) await worker.close();
  await workerQueue.close();
  await browserPool.close();
  server.close(() => {
    console.log("Health check server closed.");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("Force exit after timeout");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

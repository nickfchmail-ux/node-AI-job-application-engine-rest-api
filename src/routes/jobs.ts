import { Job } from "bullmq";
import { Request, Response, Router } from "express";
import { requireAuth } from "../middleware/auth";
import { PipelineJobData, ScrapeResult, pipelineQueue } from "../queue";

const router = Router();

// ── In-memory cache for completed/failed job responses ──────────────────
// Once a job reaches a terminal state its result never changes, so we cache
// it to avoid hitting Redis on every subsequent poll.
const jobResultCache = new Map<
  string,
  { ts: number; body: unknown; status: number }
>();
const CACHE_MAX = 2000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h (matches BullMQ removeOnComplete age)

function cacheResult(jobId: string, status: number, body: unknown) {
  // Evict oldest entries when at capacity
  if (jobResultCache.size >= CACHE_MAX) {
    const oldest = jobResultCache.keys().next().value;
    if (oldest) jobResultCache.delete(oldest);
  }
  jobResultCache.set(jobId, { ts: Date.now(), body, status });
}

function getCached(
  jobId: string,
): { status: number; body: unknown } | undefined {
  const entry = jobResultCache.get(jobId);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    jobResultCache.delete(jobId);
    return undefined;
  }
  return { status: entry.status, body: entry.body };
}

/**
 * POST /scrape
 * Body: { keyword: string, pages?: number, force?: boolean, boards?: string[] }
 * Returns immediately: { jobId } — poll GET /jobs/:jobId for result.
 * The job is queued in Redis; a separate worker process executes it.
 */
router.post("/scrape", requireAuth, async (req: Request, res: Response) => {
  const {
    keyword,
    pages = 1,
    force = false,
    boards,
  } = req.body as {
    keyword?: string;
    pages?: number;
    force?: boolean;
    boards?: string[];
  };

  if (!keyword || typeof keyword !== "string" || !keyword.trim()) {
    res.status(400).json({ error: "keyword is required (non-empty string)" });
    return;
  }

  const job = await pipelineQueue.add("scrape", {
    type: "scrape" as const,
    keyword: keyword.trim(),
    pages: Number(pages) || 1,
    force: Boolean(force),
    boards: Array.isArray(boards) ? boards : undefined,
    userId: req.userId!,
  });

  res.status(202).json({ jobId: job.id, pollUrl: `/jobs/${job.id}` });
});

/**
 * GET /jobs/:jobId
 * Returns job status + logs + result when done.
 * For "scrape" parent jobs, aggregates status from all child processing jobs.
 */
router.get("/jobs/:jobId", requireAuth, async (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);

  // ── Return cached terminal result (zero Redis calls) ────────────────────
  const cached = getCached(jobId);
  if (cached) {
    res.status(cached.status).json(cached.body);
    return;
  }

  const job = await Job.fromId<PipelineJobData>(pipelineQueue, jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  // Ownership check
  if (job.data.userId !== req.userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const state = await job.getState();
  const { logs } = await pipelineQueue.getJobLogs(job.id!, 0, -1);

  // ── Scrape (parent) job — aggregate child statuses ──────────────────────
  if (job.data.type === "scrape") {
    if (state === "failed") {
      const body = { status: "error", error: job.failedReason, logs };
      cacheResult(jobId, 500, body);
      res.status(500).json(body);
      return;
    }

    // Parent still running (scraping phase)
    if (state !== "completed") {
      res.json({ status: "scraping", logs });
      return;
    }

    // Parent completed — children are being processed by workers
    const result = job.returnvalue as ScrapeResult | null;
    if (!result?.childJobIds?.length) {
      const body = {
        status: "done",
        result: {
          total: 0,
          fit: 0,
          jobs: [],
          keyword: result?.keyword,
          scrapedDate: result?.scrapedDate,
        },
        logs,
      };
      cacheResult(jobId, 200, body);
      res.json(body);
      return;
    }

    // Load child job states
    const childJobs = await Promise.all(
      result.childJobIds.map((id) =>
        Job.fromId<PipelineJobData>(pipelineQueue, id),
      ),
    );

    let completed = 0;
    let failed = 0;
    const results: unknown[] = [];
    const childErrors: string[] = [];

    for (const child of childJobs) {
      if (!child) continue;
      const childState = await child.getState();
      if (childState === "completed") {
        completed++;
        results.push(child.returnvalue);
      } else if (childState === "failed") {
        failed++;
        childErrors.push(`${child.failedReason}`);
      }
    }

    const total = result.childJobIds.length;
    const allDone = completed + failed >= total;

    if (allDone) {
      const fitCount = results.filter(
        (r) => r && typeof r === "object" && (r as Record<string, unknown>).fit,
      ).length;
      const body = {
        status: "done",
        result: {
          total,
          completed,
          failed,
          fit: fitCount,
          keyword: result.keyword,
          scrapedDate: result.scrapedDate,
          jobs: results,
        },
        logs: [...logs, ...childErrors],
      };
      cacheResult(jobId, 200, body);
      res.json(body);
    } else {
      res.json({
        status: "running",
        progress: {
          total,
          completed,
          failed,
          pending: total - completed - failed,
        },
        logs,
      });
    }
    return;
  }

  // ── Individual process-job (child) — direct status ──────────────────────
  if (state === "completed") {
    const body = { status: "done", result: job.returnvalue, logs };
    cacheResult(jobId, 200, body);
    res.json(body);
    return;
  }
  if (state === "failed") {
    const body = { status: "error", error: job.failedReason, logs };
    cacheResult(jobId, 500, body);
    res.status(500).json(body);
    return;
  }

  const statusMap: Record<string, string> = {
    active: "running",
    waiting: "pending",
    delayed: "pending",
  };
  res.json({ status: statusMap[state] ?? state, logs });
});

export default router;

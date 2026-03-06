import { Router, Request, Response } from "express";
import { runPipeline } from "../pipeline";
import { requireAuth } from "../middleware/auth";

type JobStatus = "pending" | "running" | "done" | "error";

interface JobEntry {
  id: string;
  userId: string;
  status: JobStatus;
  logs: string[];
  result?: unknown;
  error?: string;
  createdAt: number;
}

const jobs = new Map<string, JobEntry>();

function makeJobId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const router = Router();

/**
 * POST /scrape
 * Body: { keyword: string, pages?: number, force?: boolean }
 * Returns immediately: { jobId }  — poll GET /jobs/:jobId for result
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

  const jobId = makeJobId();
  const entry: JobEntry = {
    id: jobId,
    userId: req.userId!,
    status: "pending",
    logs: [],
    createdAt: Date.now(),
  };
  jobs.set(jobId, entry);

  res.status(202).json({ jobId, pollUrl: `/jobs/${jobId}` });

  entry.status = "running";
  runPipeline({
    keyword: keyword.trim(),
    pages: Number(pages) || 1,
    force: Boolean(force),
    boards: Array.isArray(boards) ? boards : undefined,
    log: (msg) => {
      console.log(msg);
      entry.logs.push(msg);
    },
    userId: req.userId,
  })
    .then((result) => {
      entry.status = "done";
      entry.result = result;
    })
    .catch((err) => {
      entry.status = "error";
      const msg =
        err instanceof Error
          ? err.message || err.stack || err.toString()
          : String(err);
      entry.error = msg;
      console.error("[job]", jobId, msg);
    });
});

/**
 * GET /jobs/:jobId
 * Returns job status + result when done
 */
router.get("/jobs/:jobId", requireAuth, (req: Request, res: Response) => {
  const entry = jobs.get(req.params.jobId as string);
  if (!entry) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (entry.userId !== req.userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (entry.status === "done") {
    res.json({ status: "done", result: entry.result, logs: entry.logs });
    return;
  }
  if (entry.status === "error") {
    res
      .status(500)
      .json({ status: "error", error: entry.error, logs: entry.logs });
    return;
  }
  res.json({ status: entry.status, logs: entry.logs });
});

export default router;

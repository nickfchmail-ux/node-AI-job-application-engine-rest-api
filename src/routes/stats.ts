// ============================================================
//  stats.ts — Express routes exposing the LIVE pipeline state
//  that the Azure Functions write to Upstash Redis (user-keyed).
//
//  Auth: Bearer token (requireAuth) — every read is scoped to
//  the authenticated user's own Redis keys.
//
//  Endpoints:
//    GET /stats/summary           → aggregated counters for this user
//    GET /stats/runs              → this user's runIds (+ counts)
//    GET /stats/runs/:runId       → one run's funnel + per-board + meta
// ============================================================

import { Request, Response, Router } from "express";
import { requireAuth } from "../middleware/auth";
import {
  getRunBoardCounts,
  getRunCounts,
  getRunMeta,
  getUserSummary,
  listUserRuns,
} from "../queue/upstash";

const router = Router();
router.use(requireAuth);

/** Normalize a counters hash into a full funnel object (0 defaults). */
function funnelFrom(counts: Record<string, number>) {
  const scraped = counts.scraped ?? 0;
  const duplicate = counts.duplicate ?? 0;
  const unique = Math.max(0, scraped - duplicate);
  const analysed = counts.analysed ?? 0;
  const failed = counts.failed ?? 0;
  const completed = counts.completed ?? 0;
  const processing = Math.max(0, unique - analysed - failed);
  return {
    scraped,
    duplicate,
    unique,
    processing,
    analysed,
    fit: counts.fit ?? 0,
    unfit: counts.unfit ?? 0,
    cover_letter: counts.cover_letter ?? 0,
    resume_building: counts.resume_building ?? 0,
    resume_done: counts.resume_done ?? 0,
    resume_failed: counts.resume_failed ?? 0,
    completed,
    failed,
  };
}

/**
 * GET /stats/summary
 * Lightweight aggregated counters across ALL of the user's runs.
 */
router.get("/summary", async (req: Request, res: Response) => {
  try {
    const counts = await getUserSummary(req.userId!);
    res.json({ ok: true, userId: req.userId, counts: funnelFrom(counts) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /stats/runs
 * List the user's runs with each run's funnel counters.
 */
router.get("/runs", async (req: Request, res: Response) => {
  try {
    const runIds = await listUserRuns(req.userId!);
    const runs = [];
    for (const runId of runIds) {
      const [counts, meta] = await Promise.all([
        getRunCounts(req.userId!, runId),
        getRunMeta(req.userId!, runId),
      ]);
      runs.push({
        runId,
        keyword: (meta?.keyword as string) ?? "",
        boards: (meta?.boards as string[]) ?? [],
        createdAt: (meta?.createdAt as string) ?? null,
        counts: funnelFrom(counts),
      });
    }
    // Most recent first
    runs.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    res.json({ ok: true, runs });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /stats/runs/:runId
 * Full detail for one run: funnel counts + per-board breakdown + meta.
 */
router.get("/runs/:runId", async (req: Request, res: Response) => {
  const runId = String(req.params.runId);
  try {
    const [counts, boardCounts, meta] = await Promise.all([
      getRunCounts(req.userId!, runId),
      getRunBoardCounts(req.userId!, runId),
      getRunMeta(req.userId!, runId),
    ]);

    // Rebuild a per-board object: { jobsdb: { fit: 2, scraped: 30 }, ... }
    const boards: Record<string, Record<string, number>> = {};
    for (const [key, val] of Object.entries(boardCounts)) {
      const sep = key.indexOf(":");
      if (sep === -1) continue;
      const board = key.slice(0, sep);
      const name = key.slice(sep + 1);
      if (!boards[board]) boards[board] = {};
      boards[board][name] = val;
    }

    res.json({
      ok: true,
      runId,
      meta: meta ?? null,
      counts: funnelFrom(counts),
      boards,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;

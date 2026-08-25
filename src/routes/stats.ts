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
import { getSupabaseClient } from "../db";
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

/** Cache of runId → pipeline_runs.status, fetched once per request. */
let _statusCache: Record<string, string> = {};
async function getRunStatuses(userId: string): Promise<Record<string, string>> {
  if (Object.keys(_statusCache).length > 0) return _statusCache;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("pipeline_runs")
      .select("id, status")
      .eq("user_id", userId);
    if (error) {
      console.warn(`[stats] pipeline_runs status failed: ${error.message}`);
      _statusCache = {};
    } else {
      _statusCache = Object.fromEntries(
        (data ?? []).map((r) => [r.id, r.status]),
      );
    }
  } catch (err) {
    console.warn(`[stats] getRunStatuses failed: ${err}`);
    _statusCache = {};
  }
  return _statusCache;
}

/** Normalize a counters hash into a full funnel object (0 defaults). */
function funnelFrom(counts: Record<string, number>) {
  const scraped = counts.scraped ?? 0;
  const duplicate = counts.duplicate ?? 0;
  const unique = Math.max(0, scraped - duplicate);
  const processing = counts.processing ?? 0;
  return {
    scraped,
    duplicate,
    unique,
    processing,
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
    const statuses = await getRunStatuses(req.userId!);
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
        status: statuses[runId] ?? null,
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

    // Rebuild a per-board object: { jobsdb: { scraped: 30, processing: 2 }, ... }
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

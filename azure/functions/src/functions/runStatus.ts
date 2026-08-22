// ============================================================
//  GET /api/runs/{runId} — HTTP trigger (read-only status)
//
//  Returns the pipeline_run (subscription) status for a given
//  run. The frontend can either poll this endpoint or (better)
//  subscribe to Supabase Realtime on pipeline_runs — this
//  endpoint is a convenient REST fallback / initial fetch.
// ============================================================

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { boardDisplayName } from "../boardRegistry";
import { getRunBoards } from "../runBoardState";
import { getSupabaseClient } from "../supabase";

app.http("run-status", {
  methods: ["GET"],
  authLevel: "function", // function key — client authenticates via x-functions-key
  route: "runs/{runId}",
  handler: async (
    req: HttpRequest,
    context: InvocationContext,
  ): Promise<HttpResponseInit> => {
    const runId = req.params.runId;
    if (!runId) {
      return { status: 400, jsonBody: { error: "missing run id" } };
    }

    try {
      const supabase = getSupabaseClient();
      const { data: run, error } = await supabase
        .from("pipeline_runs")
        .select("*")
        .eq("id", runId)
        .maybeSingle();

      if (error) {
        console.error(`[run-status] query failed: ${error.message}`);
        return { status: 500, jsonBody: { error: "query failed" } };
      }
      if (!run) {
        return { status: 404, jsonBody: { error: "run not found" } };
      }

      // ── Also fetch job counts for this run ──
      const { count } = await supabase
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .eq("pipeline_run_id", runId);

      // ── Per-board progress (run_boards) ──
      const boardRows = await getRunBoards(runId);
      // Normalize to a frontend-friendly map: { jobsdb: { stage, jobsFound, ... } }
      const boards: Record<string, Record<string, unknown>> = {};
      for (const row of boardRows) {
        const key = String(row.board_key);
        boards[key] = {
          stage: row.stage,
          pagesFetched: row.pages_fetched ?? 0,
          pagesTotal: row.pages_total ?? 0,
          jobsFound: row.jobs_found ?? 0,
          jobsProcessed: row.jobs_processed ?? 0,
          jobsFailed: row.jobs_failed ?? 0,
          duplicate: row.duplicate ?? 0,
          lastError: row.last_error ?? null,
          displayName: boardDisplayName(key),
        };
      }
      // Ensure every requested board has an entry (default pending)
      const requested = (run.boards as string[]) ?? [];
      for (const b of requested) {
        if (!boards[b]) {
          boards[b] = {
            stage: "pending",
            pagesFetched: 0,
            pagesTotal: 0,
            jobsFound: 0,
            jobsProcessed: 0,
            jobsFailed: 0,
            duplicate: 0,
            lastError: null,
            displayName: boardDisplayName(b),
          };
        }
      }

      return {
        status: 200,
        jsonBody: {
          run,
          jobsCount: count ?? 0,
          boards,
          // UX-friendly status text mapping (used by the frontend)
          statusLabel: mapStatusLabel(run.status),
        },
      };
    } catch (err) {
      console.error(`[run-status] error: ${err}`);
      // TEMP: expose the actual error to diagnose (remove after fix)
      return {
        status: 500,
        jsonBody: { error: "internal error", detail: String(err) },
      };
    }
  },
});

/** Map machine status → warm human copy (per UX Designer agent guidance). */
export function mapStatusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "In line…";
    case "scraping":
      return "Searching the job boards…";
    case "processing":
      return "Matching jobs against your resume…";
    case "completed":
      return "Done ✓";
    case "failed":
      return "Something went wrong — retry";
    case "retrying":
      return "Hitting a snag, retrying…";
    default:
      return status;
  }
}

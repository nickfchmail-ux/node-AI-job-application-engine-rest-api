// ============================================================
//  wsPush.ts — WebSocket push layer for the Jobs Automation
//  platform (Socket.io). The browser connects ONCE and receives
//  LIVE job-state updates — no polling.
//
//  Flow:
//    Azure Functions write counters to Redis, then POST to
//    /webhook/state  →  this module looks up the counters and
//    emits a SINGLE "stats" event to the user's Socket.io room.
//
//  Rooms are user-scoped:  user:{userId}
//  The client authenticates via the Supabase JWT on connect.
//
//  ── SIMPLIFIED CONTRACT ──────────────────────────────────
//  Instead of scattering state across stats:summary / stats:run /
//  stats:boards, the server now pushes ONE event:
//
//    "stats" → {
//        ok: true,
//        summary: <funnel>,              // aggregated across all runs
//        runId: "<current run id>",      // the latest / most-relevant run
//        counts: <funnel>,               // this run's funnel
//        boards: { <board>: <BoardState>, ... },
//        status: <pipeline_runs.status | null>,  // queued|scraping|processing|completed|failed|retrying
//        statusLabel: <human copy | null>
//    }
//
//  The frontend listens to ONE event and gets everything in one
//  object — no more juggling three separate payload shapes.
// ============================================================

import { Server as HttpServer } from "http";
import { Socket, Server as SocketIOServer } from "socket.io";
import { getSupabaseClient } from "./db";
import {
  cacheGetOrSet,
  getRunBoardCounts,
  getRunCounts,
  getUserSummary,
} from "./queue/upstash";

export function funnelFrom(counts: Record<string, number>) {
  const scraped = counts.scraped ?? 0;
  const duplicate = counts.duplicate ?? 0;
  const unique = Math.max(0, scraped - duplicate);
  // processing = live counter incremented/decremented by the job processor
  const processing = counts.processing ?? 0;
  return {
    scraped,
    duplicate,
    unique,
    processing,
  };
}

/** One board's live state as sent to the frontend over the socket. */
export interface BoardState {
  scraped: number; // listings found (live Redis counter)
  duplicate: number; // deduped (live Redis counter)
  unique: number; // scraped - duplicate
  processing: number; // jobs currently enriching (live Redis counter)
  stage: string; // pending | fetching | extracting | blocked | done | failed
  pagesFetched: number; // search pages successfully fetched
  pagesTotal: number; // search pages requested
  jobsFound: number; // listings extracted (run_boards)
  jobsProcessed: number; // jobs fully stored
  jobsFailed: number; // jobs that failed
  lastError: string | null; // anti-bot / proxy failure detail
  displayName: string; // human-readable board name
}

/**
 * One keyword batch's live evaluation state, as sent to the frontend over
 * the socket. Mirrors the `evaluation_runs` row for the run, plus fit/not-fit
 * counts derived from the run's scored `jobs`.
 */
export interface EvaluationBatchState {
  id: string;
  /** The pipeline_runs.id this batch belongs to (scopes the batch to a run). */
  pipelineRunId: string | null;
  keyword: string;
  status: string; // queued | evaluating | completed | failed
  totalJobs: number;
  processedJobs: number;
  failedJobs: number;
  /** Jobs scored as a fit (fit = true). */
  fitJobs: number;
  /** Jobs scored as not a fit (fit = false, not null). */
  notFitJobs: number;
  /** Jobs still waiting to be scored (fit_score IS NULL). */
  remainingJobs: number;
  lastError: string | null;
  /** ISO timestamp of the last update (used to detect stale active batches). */
  updatedAt?: string;
}

/**
 * The evaluation portion of the socket payload: overall run state + the
 * per-keyword batches. The frontend uses this to render the "Matching jobs
 * to your resume…" panel live over WebSocket (Supabase Realtime remains a
 * fallback for individual row changes).
 */
export interface EvaluationState {
  status: string; // none | queued | evaluating | completed | failed
  totalJobs: number;
  processedJobs: number;
  failedJobs: number;
  fitJobs: number;
  notFitJobs: number;
  remainingJobs: number;
  activeBatches: number;
  batches: EvaluationBatchState[];
}

/**
 * The SIMPLIFIED unified payload the frontend receives on ONE "stats" event.
 * Everything the dashboard needs in a single flat object.
 */
export interface StatsPayload {
  ok: boolean;
  /** Aggregated funnel across all the user's runs. */
  summary: ReturnType<typeof funnelFrom>;
  /** The current / most-recent run id (null when the user has no runs). */
  runId: string | null;
  /** This run's funnel counters. */
  counts: ReturnType<typeof funnelFrom>;
  /** Per-board live state for this run. */
  boards: Record<string, BoardState>;
  /** Run status: queued | scraping | processing | completed | failed | retrying | null. */
  status: string | null;
  /** Human-friendly status copy. */
  statusLabel: string | null;
  /** AI evaluation state for this run (present even when not evaluating). */
  evaluation: EvaluationState;
}

const BOARD_DISPLAY: Record<string, string> = {
  jobsdb: "JobsDB",
  ctgoodjobs: "CTgoodjobs",
  indeed: "Indeed",
  offertoday: "OfferToday",
  linkedin: "LinkedIn",
};

function emptyBoard(board: string): BoardState {
  return {
    scraped: 0,
    duplicate: 0,
    unique: 0,
    processing: 0,
    stage: "pending",
    pagesFetched: 0,
    pagesTotal: 0,
    jobsFound: 0,
    jobsProcessed: 0,
    jobsFailed: 0,
    lastError: null,
    displayName: BOARD_DISPLAY[board] ?? board,
  };
}

/** Map machine run status → warm human copy (mirrors runStatus.ts). */
function mapStatusLabel(status: string | null): string | null {
  switch (status) {
    case "queued":
      return "In line…";
    case "scraping":
      return "Searching the job boards…";
    case "processing":
      return "Loading job details…";
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

/**
 * Read run_boards rows + the run's requested board list from Supabase.
 * This is the authoritative source for EACH board's search stage
 * (pending → fetching → extracting → done | blocked | failed).
 *
 * CACHED in Redis (TTL 10s) keyed by runId so a run's board stages aren't
 * re-read from Supabase on every push during a busy scrape. The stages
 * change a handful of times per run; a 10s lag is fine and the per-board
 * live counters still come from Redis (real-time).
 */
async function getRunBoardDetail(runId: string): Promise<{
  rows: Record<string, unknown>[];
  requested: string[];
  status: string | null;
}> {
  return (
    (await cacheGetOrSet("run-board-detail", runId, 10, async () => {
      try {
        const supabase = getSupabaseClient();
        const [{ data: rows, error: rowErr }, { data: run, error: runErr }] =
          await Promise.all([
            supabase.from("run_boards").select("*").eq("run_id", runId),
            supabase
              .from("pipeline_runs")
              .select("boards, status")
              .eq("id", runId)
              .maybeSingle(),
          ]);
        if (rowErr)
          console.warn(`[ws] run_boards(${runId}) failed: ${rowErr.message}`);
        if (runErr)
          console.warn(
            `[ws] pipeline_runs(${runId}) failed: ${runErr.message}`,
          );
        return {
          rows: (rows ?? []) as Record<string, unknown>[],
          requested: ((run?.boards as string[]) ?? []) as string[],
          status: (run?.status as string | undefined) ?? null,
        };
      } catch (err) {
        console.warn(`[ws] getRunBoardDetail(${runId}) failed: ${err}`);
        return { rows: [], requested: [], status: null };
      }
    })) ?? { rows: [], requested: [], status: null }
  );
}

/**
 * The user's MOST RECENT run id (from Supabase pipeline_runs, ordered by
 * created_at desc). This is authoritative + ordered — the Redis SMEMBERS
 * set is unordered, so we don't rely on it for the "current run".
 *
 * CACHED in Redis (TTL 15s) so this isn't a Supabase query on every socket
 * push. A new run appearing is rare; a 15s staleness on "which run to show"
 * is imperceptible, and the frontend's own runId (from the scrape trigger)
 * is used for the active run anyway.
 */
async function getLatestRunId(userId: string): Promise<string | null> {
  return cacheGetOrSet("latest-run", userId, 15, async () => {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from("pipeline_runs")
        .select("id")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        console.warn(`[ws] latest run(${userId}) failed: ${error.message}`);
        return null;
      }
      return data?.id ? String(data.id) : null;
    } catch (err) {
      console.warn(`[ws] latest run(${userId}) failed: ${err}`);
      return null;
    }
  });
}

/**
 * Combine the Redis per-board counters (board:counter keys) with the
 * Supabase run_boards stage/progress into ONE frontend-friendly object:
 *   { "jobsdb": { scraped, duplicate, unique, processing, stage, jobsFound, ... }, ... }
 */
export function boardsFrom(
  boardCounts: Record<string, number>,
  rows: Record<string, unknown>[] = [],
  requested: string[] = [],
): Record<string, BoardState> {
  const boards: Record<string, BoardState> = {};
  // Pre-seed every requested board so the UI shows all chips immediately
  // (even before the worker creates its run_boards row).
  for (const board of requested) boards[board] = emptyBoard(board);

  // Overlay live counters from Redis (keys like "jobsdb:scraped").
  for (const [key, val] of Object.entries(boardCounts)) {
    const sep = key.indexOf(":");
    if (sep === -1) continue;
    const board = key.slice(0, sep);
    const name = key.slice(sep + 1);
    const b = boards[board] ?? (boards[board] = emptyBoard(board));
    if (name === "scraped" || name === "duplicate" || name === "processing") {
      b[name] = val;
    }
  }

  // Overlay authoritative stage + progress from Supabase run_boards.
  for (const row of rows) {
    const key = String(row.board_key);
    const b = boards[key] ?? (boards[key] = emptyBoard(key));
    b.stage = String(row.stage ?? "pending");
    b.pagesFetched = Number(row.pages_fetched ?? 0);
    b.pagesTotal = Number(row.pages_total ?? 0);
    b.jobsFound = Number(row.jobs_found ?? 0);
    b.jobsProcessed = Number(row.jobs_processed ?? 0);
    b.jobsFailed = Number(row.jobs_failed ?? 0);
    b.lastError = row.last_error == null ? null : String(row.last_error);
    b.displayName = BOARD_DISPLAY[key] ?? key;

    // ── Supabase fallback for live counters ──────────────────────────
    // The Redis (Upstash) live counters can be unavailable — e.g. the free
    // tier hits its request limit and `incrementCounters` silently no-ops
    // (best-effort), leaving scraped/duplicate/processing at 0 forever even
    // though the scraper found jobs. `run_boards` holds the authoritative
    // per-board progress, so when Redis hasn't reported any scraped count for
    // this board, fall back to jobs_found (= found) / jobs_processed (=
    // done) so the table shows REAL numbers instead of zeros.
    if (b.scraped === 0 && b.jobsFound > 0) {
      b.scraped = b.jobsFound;
      // unique = jobs not already known; run_boards doesn't split dup vs new,
      // so show jobs_found as new (the board's found count is what was new
      // this run — duplicates are already in the user's list and not counted
      // into jobs_found by the scraper for fresh results).
      b.unique = Math.max(0, b.jobsFound);
      b.duplicate = 0;
    }
    if (b.processing === 0 && b.jobsProcessed > 0 && b.stage === "done") {
      b.processing = 0; // done boards have nothing in flight
    }
  }

  // Ensure unique = scraped - duplicate per board.
  for (const b of Object.values(boards))
    b.unique = Math.max(0, b.scraped - b.duplicate);
  return boards;
}

/**
 * Compute the per-keyword fit / not-fit / remaining counts from a user's
 * jobs, for every evaluation batch. Shared by the run-scoped and the
 * account-wide variants.
 */
async function collectEvaluationBatches(
  userId: string | null,
  rows: Record<string, unknown>[],
): Promise<EvaluationBatchState[]> {
  if (!userId) return [];
  const supabase = getSupabaseClient();
  const { data: jobs, error: jobsErr } = await supabase
    .from("jobs")
    .select("search_key, fit, fit_score, updated_at")
    .eq("user_id", userId)
    .in("status", ["completed", "analysed"]);
  if (jobsErr) console.warn(`[ws] jobs failed: ${jobsErr.message}`);

  const jobsForUser = (jobs ?? []) as {
    search_key: string | null;
    fit: boolean | null;
    fit_score: number | null;
    updated_at: string | null;
  }[];

  return (rows ?? []).map((row) => {
    const key = String(row.keyword ?? "general")
      .trim()
      .toLowerCase();
    const batchStart = row.created_at
      ? new Date(row.created_at as string).getTime()
      : 0;

    let fit = 0;
    let notFit = 0;
    let remaining = 0;
    for (const j of jobsForUser) {
      if (
        String(j.search_key ?? "general")
          .trim()
          .toLowerCase() !== key
      )
        continue;
      // A job is part of THIS batch if it was scored at/after the batch was
      // created, OR it is still unscored (belongs to the in-progress batch).
      const touched =
        j.fit_score === null ||
        (j.updated_at && new Date(j.updated_at).getTime() >= batchStart);
      if (!touched) continue;
      if (j.fit_score === null) remaining++;
      else if (j.fit === true) fit++;
      else if (j.fit === false) notFit++;
    }

    return {
      id: String(row.id),
      pipelineRunId: row.pipeline_run_id ? String(row.pipeline_run_id) : null,
      keyword: String(row.keyword ?? "general"),
      status: String(row.status ?? "queued"),
      totalJobs: Number(row.total_jobs ?? 0),
      processedJobs: Number(row.processed_jobs ?? 0),
      failedJobs: Number(row.failed_jobs ?? 0),
      fitJobs: fit,
      notFitJobs: notFit,
      remainingJobs: remaining,
      lastError: row.last_error == null ? null : String(row.last_error),
      updatedAt: row.updated_at ? String(row.updated_at) : undefined,
    };
  });
}

/** Sum an EvaluationBatchState[] into the flattened EvaluationState fields. */
function summarizeBatches(
  batches: EvaluationBatchState[],
  status: string,
): EvaluationState {
  return {
    status,
    totalJobs: batches.reduce((n, b) => n + b.totalJobs, 0),
    processedJobs: batches.reduce((n, b) => n + b.processedJobs, 0),
    failedJobs: batches.reduce((n, b) => n + b.failedJobs, 0),
    fitJobs: batches.reduce((n, b) => n + b.fitJobs, 0),
    notFitJobs: batches.reduce((n, b) => n + b.notFitJobs, 0),
    remainingJobs: batches.reduce((n, b) => n + b.remainingJobs, 0),
    activeBatches: batches.filter(
      (b) => b.status === "queued" || b.status === "evaluating",
    ).length,
    batches,
  };
}

/**
 * The user's ACCOUNT-WIDE evaluation state — every keyword batch across all
 * their runs, with fit/not-fit/remaining computed from their jobs. This is
 * the source of truth for the "Matching jobs to your resume" panel: a
 * search-key evaluation spans multiple runs, so scoping to one run would
 * silently hide completed batches (the symptom behind "still no fit / not
 * fit"). Used on connect and on every stats push.
 *
 * CACHED in Redis (TTL 20s) — this was the #1 Supabase exhaustor: it ran a
 * FULL `select` over the user's `completed`/`analysed` jobs on EVERY stats
 * push. During an active evaluation the fit/not-fit counts update as jobs
 * are scored, so a 20s cache means the expensive query runs ~3×/min per user
 * instead of on every push (which can fire every second). The cache is
 * invalidated explicitly when a job changes (edge function → webhook) and by
 * TTL otherwise.
 */
async function getUserEvaluationState(
  userId: string,
): Promise<EvaluationState> {
  return (
    (await cacheGetOrSet("eval-state", userId, 20, async () => {
      try {
        const supabase = getSupabaseClient();
        const { data: rows, error: rowsErr } = await supabase
          .from("evaluation_runs")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: true });
        if (rowsErr)
          console.warn(
            `[ws] evaluation_runs(user ${userId}) failed: ${rowsErr.message}`,
          );
        const batches = await collectEvaluationBatches(
          userId,
          (rows ?? []) as Record<string, unknown>[],
        );
        // A batch only counts as ACTIVE if it is queued/evaluating AND was updated
        // recently. A batch stuck in "evaluating" for a long time (e.g. the worker
        // died mid-run, or a stale row from a previous session) must NOT keep the
        // whole account-wide status at "evaluating" — that made the match panel
        // show "Starting your match…" forever after a page refresh even though the
        // user's actual match had finished.
        const now = Date.now();
        const STALE_MS = 10 * 60 * 1000; // 10 minutes
        const isActive = (b: EvaluationBatchState): boolean => {
          if (b.status !== "queued" && b.status !== "evaluating") return false;
          const updatedAt = (b as { updatedAt?: string }).updatedAt;
          if (updatedAt) {
            const t = new Date(updatedAt).getTime();
            if (!Number.isNaN(t) && now - t > STALE_MS) return false;
          }
          return true;
        };
        const anyActive = batches.some(isActive);
        const anyProcessed = batches.some(
          (b) => b.status === "completed" && b.processedJobs > 0,
        );
        const status = anyActive
          ? "evaluating"
          : batches.length === 0
            ? "none"
            : anyProcessed
              ? "completed"
              : "failed";
        const state = summarizeBatches(batches, status);
        // activeBatches should reflect only genuinely-active batches, not stale ones.
        state.activeBatches = batches.filter(isActive).length;
        return state;
      } catch (err) {
        console.warn(`[ws] getUserEvaluationState(${userId}) failed: ${err}`);
        return {
          status: "none",
          totalJobs: 0,
          processedJobs: 0,
          failedJobs: 0,
          fitJobs: 0,
          notFitJobs: 0,
          remainingJobs: 0,
          activeBatches: 0,
          batches: [],
        };
      }
    })) ?? {
      status: "none",
      totalJobs: 0,
      processedJobs: 0,
      failedJobs: 0,
      fitJobs: 0,
      notFitJobs: 0,
      remainingJobs: 0,
      activeBatches: 0,
      batches: [],
    }
  );
}

/**
 * Read the run's AI evaluation state: the overall `evaluation_status` from
 * `pipeline_runs` plus each keyword batch from `evaluation_runs`. Kept for
 * run-scoped consumers; the socket uses the account-wide variant below.
 */
async function getEvaluationState(runId: string): Promise<EvaluationState> {
  try {
    const supabase = getSupabaseClient();
    const [{ data: run, error: runErr }, { data: rows, error: rowsErr }] =
      await Promise.all([
        supabase
          .from("pipeline_runs")
          .select("evaluation_status, user_id")
          .eq("id", runId)
          .maybeSingle(),
        supabase
          .from("evaluation_runs")
          .select("*")
          .eq("pipeline_run_id", runId)
          .order("created_at", { ascending: true }),
      ]);
    if (runErr)
      console.warn(`[ws] evaluation run(${runId}) failed: ${runErr.message}`);
    if (rowsErr)
      console.warn(`[ws] evaluation_runs(${runId}) failed: ${rowsErr.message}`);
    const userId = run?.user_id ?? null;
    const batches = await collectEvaluationBatches(
      userId,
      (rows ?? []) as Record<string, unknown>[],
    );
    return summarizeBatches(batches, String(run?.evaluation_status ?? "none"));
  } catch (err) {
    console.warn(`[ws] getEvaluationState(${runId}) failed: ${err}`);
    return {
      status: "none",
      totalJobs: 0,
      processedJobs: 0,
      failedJobs: 0,
      fitJobs: 0,
      notFitJobs: 0,
      remainingJobs: 0,
      activeBatches: 0,
      batches: [],
    };
  }
}

/**
 * Build the unified "stats" payload for a user + optional run.
 * When runId is omitted, uses the latest run (so connect always
 * delivers everything the dashboard needs in ONE event).
 */
async function buildStats(
  userId: string,
  runId?: string | null,
): Promise<StatsPayload> {
  const summary = funnelFrom(await getUserSummary(userId));

  // Resolve the run to show: the explicit one, else the latest.
  let targetRun = runId ?? null;
  if (!targetRun) targetRun = await getLatestRunId(userId);
  if (!targetRun) {
    return {
      ok: true,
      summary,
      runId: null,
      counts: funnelFrom({}),
      boards: {},
      status: null,
      statusLabel: null,
      evaluation: {
        status: "none",
        totalJobs: 0,
        processedJobs: 0,
        failedJobs: 0,
        fitJobs: 0,
        notFitJobs: 0,
        remainingJobs: 0,
        activeBatches: 0,
        batches: [],
      },
    };
  }

  const [runCounts, boardCounts, detail, evaluation] = await Promise.all([
    getRunCounts(userId, targetRun),
    getRunBoardCounts(userId, targetRun),
    getRunBoardDetail(targetRun),
    // ACCOUNT-WIDE evaluation state: every keyword batch across all the
    // user's runs. Scoping to `targetRun` would hide completed batches that
    // belong to an earlier run (the "still no fit / not fit" bug — the clerk
    // batch lives under an older run than the latest). The fit/not-fit panel
    // must show the full account picture.
    getUserEvaluationState(userId),
  ]);

  return {
    ok: true,
    summary,
    runId: targetRun,
    counts: funnelFrom(runCounts),
    boards: boardsFrom(boardCounts, detail.rows, detail.requested),
    status: detail.status,
    statusLabel: mapStatusLabel(detail.status),
    evaluation,
  };
}

let io: SocketIOServer | null = null;

/** Start Socket.io on the HTTP server. */
export function initWs(server: HttpServer): SocketIOServer {
  io = new SocketIOServer(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
  });

  // ── Auth + room join ─────────────────────────────────────
  io.use(async (socket, next) => {
    // Client passes the Supabase JWT as socket.handshake.auth.token
    const token = socket.handshake.auth?.token;
    if (!token || typeof token !== "string") {
      next(new Error("unauthorized: missing token"));
      return;
    }
    // FULL verification via Supabase Auth — prevents a forged token
    // from joining another user's room.
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data.user?.id) {
        next(new Error("unauthorized: invalid token"));
        return;
      }
      (socket.data as { userId?: string }).userId = data.user.id;
      next();
    } catch {
      next(new Error("unauthorized: verification failed"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const userId = socket.data.userId as string;
    // Join this user's private room → they only get their own updates
    socket.join(`user:${userId}`);
    console.log(`[ws] user ${userId} connected (socket ${socket.id})`);

    // On connect, push the full current state in ONE event so the UI
    // renders instantly without a separate fetch or a "waiting" state.
    buildStats(userId, null)
      .then((payload) => socket.emit("stats", payload))
      .catch(() => {});

    socket.on("disconnect", () => {
      console.log(`[ws] user ${userId} disconnected (socket ${socket.id})`);
    });
  });

  return io;
}

/**
 * Push the unified stats update to a user's room.
 * runId is optional — when given, that run is shown; otherwise the latest.
 */
export async function pushStats(userId: string, runId?: string): Promise<void> {
  if (!io) return;
  try {
    const payload = await buildStats(userId, runId);
    io.to(`user:${userId}`).emit("stats", payload);
  } catch (err) {
    console.warn(`[ws] pushStats(${userId}/${runId}) failed: ${err}`);
  }
}

/**
 * Push the CURRENT STATE OF ONE JOB to a user's room as a `job:state` event.
 *
 * The evaluator's document workers call the `/webhook/state` endpoint with
 * `{ userId, jobId, scope: "job" }` when a tailored resume or cover letter
 * completes/fails. The backend reads the job row (scoped to the owner) and
 * emits a compact object so the job detail page updates instantly without
 * polling. Supabase Realtime remains the fallback for row changes.
 */
export interface JobStatePayload {
  ok: boolean;
  jobId: string;
  fit: boolean | null;
  fit_score: number | null;
  resume_status: string | null;
  resume_url: string | null;
  cover_letter_status: string | null;
  cover_letter: string | null;
}

export async function pushJobState(
  userId: string,
  jobId: string,
): Promise<void> {
  if (!io || !userId || !jobId) return;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("jobs")
      .select(
        "fit, fit_score, resume_status, resume_url, cover_letter_status, cover_letter",
      )
      .eq("id", jobId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      console.warn(`[ws] pushJobState(${jobId}) read failed: ${error.message}`);
      return;
    }
    if (!data) return; // job not found or not owned → emit nothing

    const payload: JobStatePayload = {
      ok: true,
      jobId,
      fit: (data.fit as boolean | null) ?? null,
      fit_score: (data.fit_score as number | null) ?? null,
      resume_status: (data.resume_status as string | null) ?? null,
      resume_url: (data.resume_url as string | null) ?? null,
      cover_letter_status: (data.cover_letter_status as string | null) ?? null,
      cover_letter: (data.cover_letter as string | null) ?? null,
    };
    io.to(`user:${userId}`).emit("job:state", payload);
  } catch (err) {
    console.warn(`[ws] pushJobState(${userId}/${jobId}) failed: ${err}`);
  }
}

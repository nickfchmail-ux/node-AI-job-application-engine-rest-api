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
  scraped: number;      // listings found (live Redis counter)
  duplicate: number;    // deduped (live Redis counter)
  unique: number;       // scraped - duplicate
  processing: number;   // jobs currently enriching (live Redis counter)
  stage: string;        // pending | fetching | extracting | blocked | done | failed
  pagesFetched: number; // search pages successfully fetched
  pagesTotal: number;   // search pages requested
  jobsFound: number;    // listings extracted (run_boards)
  jobsProcessed: number; // jobs fully stored
  jobsFailed: number;   // jobs that failed
  lastError: string | null; // anti-bot / proxy failure detail
  displayName: string;  // human-readable board name
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
 */
async function getRunBoardDetail(
  runId: string,
): Promise<{
  rows: Record<string, unknown>[];
  requested: string[];
  status: string | null;
}> {
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
    if (rowErr) console.warn(`[ws] run_boards(${runId}) failed: ${rowErr.message}`);
    if (runErr) console.warn(`[ws] pipeline_runs(${runId}) failed: ${runErr.message}`);
    return {
      rows: (rows ?? []) as Record<string, unknown>[],
      requested: ((run?.boards as string[]) ?? []) as string[],
      status: (run?.status as string | undefined) ?? null,
    };
  } catch (err) {
    console.warn(`[ws] getRunBoardDetail(${runId}) failed: ${err}`);
    return { rows: [], requested: [], status: null };
  }
}

/**
 * The user's MOST RECENT run id (from Supabase pipeline_runs, ordered by
 * created_at desc). This is authoritative + ordered — the Redis SMEMBERS
 * set is unordered, so we don't rely on it for the "current run".
 */
async function getLatestRunId(userId: string): Promise<string | null> {
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
  }

  // Ensure unique = scraped - duplicate per board.
  for (const b of Object.values(boards)) b.unique = Math.max(0, b.scraped - b.duplicate);
  return boards;
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
    };
  }

  const [runCounts, boardCounts, detail] = await Promise.all([
    getRunCounts(userId, targetRun),
    getRunBoardCounts(userId, targetRun),
    getRunBoardDetail(targetRun),
  ]);

  return {
    ok: true,
    summary,
    runId: targetRun,
    counts: funnelFrom(runCounts),
    boards: boardsFrom(boardCounts, detail.rows, detail.requested),
    status: detail.status,
    statusLabel: mapStatusLabel(detail.status),
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

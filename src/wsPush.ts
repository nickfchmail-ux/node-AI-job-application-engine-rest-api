// ============================================================
//  wsPush.ts — WebSocket push layer for the Jobs Automation
//  platform (Socket.io). The browser connects ONCE and receives
//  LIVE job-state updates — no polling.
//
//  Flow:
//    Azure Functions write counters to Redis, then POST to
//    /webhook/state  →  this module looks up the counters and
//    emits a "stats" event to the user's Socket.io room.
//
//  Rooms are user-scoped:  user:{userId}
//  The client authenticates via the Supabase JWT on connect.
// ============================================================

import { Server as HttpServer } from "http";
import { Socket, Server as SocketIOServer } from "socket.io";
import { getSupabaseClient } from "./db";
import {
  getRunBoardCounts,
  getRunCounts,
  getUserSummary,
  listUserRuns,
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

/**
 * Read run_boards rows + the run's requested board list from Supabase.
 * This is the authoritative source for EACH board's search stage
 * (pending → fetching → extracting → done | blocked | failed).
 */
async function getRunBoardDetail(
  runId: string,
): Promise<{ rows: Record<string, unknown>[]; requested: string[] }> {
  try {
    const supabase = getSupabaseClient();
    const [{ data: rows, error: rowErr }, { data: run, error: runErr }] =
      await Promise.all([
        supabase.from("run_boards").select("*").eq("run_id", runId),
        supabase
          .from("pipeline_runs")
          .select("boards")
          .eq("id", runId)
          .maybeSingle(),
      ]);
    if (rowErr) console.warn(`[ws] run_boards(${runId}) failed: ${rowErr.message}`);
    if (runErr) console.warn(`[ws] pipeline_runs(${runId}) failed: ${runErr.message}`);
    return {
      rows: (rows ?? []) as Record<string, unknown>[],
      requested: ((run?.boards as string[]) ?? []) as string[],
    };
  } catch (err) {
    console.warn(`[ws] getRunBoardDetail(${runId}) failed: ${err}`);
    return { rows: [], requested: [] };
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

    // On connect, push the current aggregate summary so the UI
    // renders instantly without a separate fetch.
    getUserSummary(userId)
      .then((counts: Record<string, number>) => {
        socket.emit("stats:summary", { ok: true, counts: funnelFrom(counts) });
      })
      .catch(() => {});

    // Also push the latest run's per-board breakdown on connect so the
    // dashboard renders board chips immediately, without waiting for the
    // next Azure webhook push.
    listUserRuns(userId)
      .then((runs) => {
        const latestId = runs?.[0];
        if (!latestId) return;
        return Promise.all([
          getRunCounts(userId, latestId),
          getRunBoardCounts(userId, latestId),
          getRunBoardDetail(latestId),
        ]).then(([runCounts, boardCounts, detail]) => {
          socket.emit("stats:run", {
            ok: true,
            runId: latestId,
            counts: funnelFrom(runCounts),
          });
          socket.emit("stats:boards", {
            ok: true,
            runId: latestId,
            boards: boardsFrom(boardCounts, detail.rows, detail.requested),
          });
        });
      })
      .catch(() => {});

    socket.on("disconnect", () => {
      console.log(`[ws] user ${userId} disconnected (socket ${socket.id})`);
    });
  });

  return io;
}

/**
 * Push a stats update to a user's room.
 * runId is optional — when given, also emits the per-run funnel AND the
 * per-board breakdown (stats:boards) so the frontend can show each board's
 * live state from the socket alone.
 */
export async function pushStats(userId: string, runId?: string): Promise<void> {
  if (!io) return;
  try {
    const [summary, runCounts, boardCounts, detail] = await Promise.all([
      getUserSummary(userId),
      runId ? getRunCounts(userId, runId) : Promise.resolve({}),
      runId ? getRunBoardCounts(userId, runId) : Promise.resolve({}),
      runId ? getRunBoardDetail(runId) : Promise.resolve({ rows: [], requested: [] }),
    ]);
    io.to(`user:${userId}`).emit("stats:summary", {
      ok: true,
      counts: funnelFrom(summary),
    });
    if (runId) {
      io.to(`user:${userId}`).emit("stats:run", {
        ok: true,
        runId,
        counts: funnelFrom(runCounts),
      });
      // Per-board live state: counters (Redis) + search stage/progress (run_boards)
      io.to(`user:${userId}`).emit("stats:boards", {
        ok: true,
        runId,
        boards: boardsFrom(boardCounts, detail.rows, detail.requested),
      });
    }
  } catch (err) {
    console.warn(`[ws] pushStats(${userId}/${runId}) failed: ${err}`);
  }
}

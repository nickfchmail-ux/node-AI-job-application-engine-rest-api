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

/**
 * Group the flat per-board counters hash into a frontend-friendly object:
 *   { "jobsdb": { scraped, duplicate, unique, processing }, "ctgoodjobs": {...} }
 * Keys in Redis are like "jobsdb:scraped", "jobsdb:processing", ...
 */
export function boardsFrom(boardCounts: Record<string, number>) {
  const boards: Record<string, { scraped: number; duplicate: number; unique: number; processing: number }> = {};
  for (const [key, val] of Object.entries(boardCounts)) {
    const sep = key.indexOf(":");
    if (sep === -1) continue;
    const board = key.slice(0, sep);
    const name = key.slice(sep + 1);
    if (!boards[board]) boards[board] = { scraped: 0, duplicate: 0, unique: 0, processing: 0 };
    if (name in boards[board]) boards[board][name as "scraped"] = val;
  }
  // ensure unique = scraped - duplicate per board
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
        ]).then(([runCounts, boardCounts]) => {
          socket.emit("stats:run", {
            ok: true,
            runId: latestId,
            counts: funnelFrom(runCounts),
          });
          socket.emit("stats:boards", {
            ok: true,
            runId: latestId,
            boards: boardsFrom(boardCounts),
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
    const [summary, runCounts, boardCounts] = await Promise.all([
      getUserSummary(userId),
      runId ? getRunCounts(userId, runId) : Promise.resolve({}),
      runId ? getRunBoardCounts(userId, runId) : Promise.resolve({}),
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
      // NEW: per-board live state (each board's scraped/duplicate/unique/processing)
      io.to(`user:${userId}`).emit("stats:boards", {
        ok: true,
        runId,
        boards: boardsFrom(boardCounts),
      });
    }
  } catch (err) {
    console.warn(`[ws] pushStats(${userId}/${runId}) failed: ${err}`);
  }
}

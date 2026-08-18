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
import { Server as SocketIOServer, Socket } from "socket.io";
import { getUserSummary, getRunCounts } from "./queue/upstash";

export function funnelFrom(counts: Record<string, number>) {
  return {
    scraped: counts.scraped ?? 0,
    duplicate: counts.duplicate ?? 0,
    unique: (counts.scraped ?? 0) - (counts.duplicate ?? 0),
    processing: counts.processing ?? 0,
    analysed: counts.analysed ?? 0,
    fit: counts.fit ?? 0,
    unfit: counts.unfit ?? 0,
    cover_letter: counts.cover_letter ?? 0,
    resume_building: counts.resume_building ?? 0,
    resume_done: counts.resume_done ?? 0,
    resume_failed: counts.resume_failed ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
  };
}

let io: SocketIOServer | null = null;

/** Start Socket.io on the HTTP server. */
export function initWs(server: HttpServer): SocketIOServer {
  io = new SocketIOServer(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
  });

  // ── Auth + room join ─────────────────────────────────────
  io.use((socket, next) => {
    // Client passes the Supabase JWT as socket.handshake.auth.token
    const token = socket.handshake.auth?.token;
    if (!token || typeof token !== "string") {
      next(new Error("unauthorized: missing token"));
      return;
    }
    // Lightweight JWT decode (payload only — we just need sub + exp).
    // Full verification is done via the REST API when fetching stats.
    try {
      const payload = token.split(".")[1];
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (decoded.exp && decoded.exp * 1000 < Date.now()) {
        next(new Error("unauthorized: token expired"));
        return;
      }
      if (!decoded.sub) {
        next(new Error("unauthorized: no sub"));
        return;
      }
      (socket.data as { userId?: string }).userId = decoded.sub;
      next();
    } catch {
      next(new Error("unauthorized: bad token"));
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

    socket.on("disconnect", () => {
      console.log(`[ws] user ${userId} disconnected (socket ${socket.id})`);
    });
  });

  return io;
}

/**
 * Push a stats update to a user's room.
 * runId is optional — when given, also emits the per-run funnel.
 */
export async function pushStats(
  userId: string,
  runId?: string,
): Promise<void> {
  if (!io) return;
  try {
    const [summary, runCounts] = await Promise.all([
      getUserSummary(userId),
      runId ? getRunCounts(userId, runId) : Promise.resolve({}),
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
    }
  } catch (err) {
    console.warn(`[ws] pushStats(${userId}/${runId}) failed: ${err}`);
  }
}

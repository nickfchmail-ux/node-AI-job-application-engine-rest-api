import express, { Request, Response } from "express";
import { createServer } from "http";
import { loadEnvLocal } from "./db";
import { cacheDelete } from "./queue/upstash";
import authRouter from "./routes/auth";
import jobRouter from "./routes/jobs";
import statsRouter from "./routes/stats";
import { initWs, pushJobState, pushStats } from "./wsPush";

loadEnvLocal();

const app = express();
app.use(express.json());

app.use("/auth", authRouter);
app.use("/", jobRouter);
app.use("/stats", statsRouter);

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// ── Webhook: Azure Functions notify us after updating Redis ──
// POST /webhook/state  { userId, runId?, scope?, jobId? }
//   - default: push the unified `stats` event to the user's socket room
//   - scope: "job" with jobId: push a `job:state` event for one job
// Uses a shared secret so only our Azure functions can trigger pushes.
app.post("/webhook/state", async (req: Request, res: Response) => {
  const expected = process.env.STATE_WEBHOOK_SECRET;
  const provided = req.headers["x-webhook-secret"] ?? req.body?.secret;
  if (expected && provided !== expected) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const { userId, runId, scope, jobId } = req.body as {
    userId?: string;
    runId?: string;
    scope?: string;
    jobId?: string;
  };
  if (!userId) {
    res.status(400).json({ error: "userId required" });
    return;
  }
  // Fire-and-forget push (don't block the Azure function)
  if (scope === "job" && jobId) {
    pushJobState(userId, jobId).catch(() => {});
  } else {
    pushStats(userId, runId).catch(() => {});
  }
  res.json({ ok: true });
});

// ── Cache invalidation: Supabase Edge Function notifies us when a job
//    changes so the socket's cached evaluation state is refreshed on the
//    next push (event-driven — no polling, no per-push Supabase queries).
// POST /webhook/invalidate  { userId, runId? }
//   Deletes the Redis caches for `eval-state:{userId}` and (when runId is
//   given) `run-board-detail:{runId}` + `latest-run:{userId}`, so the next
//   `/webhook/state` push recomputes them ONCE (not on every push).
app.post("/webhook/invalidate", async (req: Request, res: Response) => {
  const expected = process.env.STATE_WEBHOOK_SECRET;
  const provided = req.headers["x-webhook-secret"] ?? req.body?.secret;
  if (expected && provided !== expected) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const { userId, runId } = req.body as { userId?: string; runId?: string };
  if (!userId) {
    res.status(400).json({ error: "userId required" });
    return;
  }
  try {
    await Promise.all([
      cacheDelete("eval-state", userId),
      cacheDelete("latest-run", userId),
      ...(runId ? [cacheDelete("run-board-detail", runId)] : []),
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.warn(`[webhook] invalidate(${userId}/${runId ?? "-"}) failed: ${err}`);
    res.status(500).json({ error: "invalidate failed" });
  }
});

const PORT = process.env.PORT ?? 3000;
const server = createServer(app);

// ── WebSocket: live job-state push to the browser ──
initWs(server);

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log("WebSocket (Socket.io) live stats push enabled.");
  console.log("POST /auth/register  { email, password }");
  console.log(
    "POST /auth/login     { email, password }  → access_token + refresh_token",
  );
  console.log(
    "POST /auth/refresh   { refresh_token }     → new access_token + refresh_token",
  );
  console.log(
    "POST /scrape         { keyword, pages?, force? }  [Bearer token required] → { jobId }",
  );
  console.log("GET  /jobs/:jobId    [Bearer token required] → status + result");
});

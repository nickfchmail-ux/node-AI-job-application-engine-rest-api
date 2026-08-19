// ============================================================
//  POST /api/jobs/{id}/generate-resume — HTTP trigger
//
//  DISABLED (scrape-only pipeline): no AI resume generation.
//  Kept for backwards compatibility — enqueues to the
//  `resume-builds` queue whose worker is now a no-op, so it never
//  calls DeepSeek or touches resume storage.
//
//  Auth: shared secret header (x-webhook-secret)
// ============================================================

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { enqueue } from "../serviceBus";

app.http("generate-resume", {
  methods: ["POST"],
  authLevel: "anonymous", // auth handled by shared secret header (webhook from Supabase)
  route: "jobs/{id}/generate-resume",
  handler: async (
    req: HttpRequest,
    context: InvocationContext,
  ): Promise<HttpResponseInit> => {
    // ── Auth: shared secret (same as Supabase Edge Function) ──
    const expected = process.env.AZURE_FUNCTION_WEBHOOK_SECRET;
    const provided = req.headers.get("x-webhook-secret");
    if (!expected || !provided || provided !== expected) {
      console.warn("[generate-resume] ⛔ Unauthorized webhook call");
      return { status: 401, jsonBody: { error: "unauthorized" } };
    }

    const jobId = req.params.id;
    if (!jobId) {
      return { status: 400, jsonBody: { error: "missing job id" } };
    }

    try {
      // DISABLED (scrape-only): enqueueing still works, but the
      // `resume-builds` worker is a no-op — no DeepSeek is called.
      await enqueue(
        "resumeBuilds",
        { type: "build-resume", jobId },
        { messageId: `resume-${jobId}`, ttlSeconds: 7200 },
      );
      console.info(`[generate-resume] enqueued resume build for job ${jobId}`);
      return { status: 202, jsonBody: { ok: true, jobId, queued: true } };
    } catch (err) {
      console.error(
        `[generate-resume] enqueue failed for job ${jobId}: ${err}`,
      );
      return { status: 500, jsonBody: { error: "enqueue failed" } };
    }
  },
});

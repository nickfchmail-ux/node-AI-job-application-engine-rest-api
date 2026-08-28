// ============================================================
//  resumeBuildWorker — Service Bus queue trigger on `resume-builds`
//
//  DISABLED (scrape-only pipeline): buildResumeForJob is a no-op,
//  so this worker never calls DeepSeek or touches resume storage.
//  Kept wired up so the queue + HTTP trigger stay backwards
//  compatible. If AI resumes are re-enabled, restore the original
//  throttled build flow here.
//
//  Message: { type: "build-resume", jobId }
//  Idempotent: messageId = resume-{jobId} (dup detection) +
//  buildResumeForJob skips already-completed jobs.
// ============================================================

import { app, InvocationContext } from "@azure/functions";
import { buildResumeForJob } from "../buildResumeForJob";

interface ResumeBuildMessage {
  type: "build-resume";
  jobId: string;
}

app.storageQueue("resume-builds", {
  queueName: "resume-builds",
  connection: "AzureWebJobsStorage",
  handler: async (rawBody: unknown, context: InvocationContext) => {
    const body =
      typeof rawBody === "string"
        ? (JSON.parse(rawBody) as ResumeBuildMessage)
        : (rawBody as ResumeBuildMessage);
    const jobId = body?.jobId;
    if (!jobId) {
      console.warn("[resume-build] message missing jobId");
      return;
    }

    console.info(`[resume-build] worker processing job ${jobId}`);
    const outcome = await buildResumeForJob(jobId, console.log);

    // If the user has no resume uploaded, don't retry forever —
    // it's a permanent condition (needs the user to upload one).
    if (!outcome.ok && outcome.error?.includes("No original resume found")) {
      console.warn(
        `[resume-build] job ${jobId} permanent failure (no source resume) — not retrying`,
      );
      return;
    }

    // On transient failure, rethrow → Service Bus retries with backoff
    // (maxDeliveryCount in the queue config = 5).
    if (!outcome.ok) {
      throw new Error(outcome.error ?? "resume build failed");
    }
  },
});

// ============================================================
//  buildResumeForJob.ts — shared resume-building logic used by
//  BOTH the HTTP generate-resume trigger AND the Service Bus
//  resume-builds worker.
//
//  SCRAPE-ONLY PIPELINE: AI resume generation is DISABLED.
//
//  The pipeline no longer runs DeepSeek, so there are no fit
//  scores and no tailored resumes to build. This function is kept
//  as a harmless no-op so the `resume-builds` queue worker and the
//  `/api/jobs/{id}/generate-resume` HTTP trigger can stay wired up
//  without ever calling DeepSeek or touching resume storage.
//
//  If the resume feature is ever re-enabled, restore the original
//  DeepSeek → HTML+PDF → upload → persist flow here.
// ============================================================

export interface ResumeBuildOutcome {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  resumeUrl?: string;
  pdfUrl?: string | null;
}

/**
 * No-op — resume generation is disabled (scrape-only pipeline).
 * Logs and returns skipped so callers treat it as success without
 * spending any AI tokens or doing any storage work.
 */
export async function buildResumeForJob(
  jobId: string,
  log: (msg: string) => void = console.log,
): Promise<ResumeBuildOutcome> {
  log(
    `[resume-build] job ${jobId} — AI resume generation is DISABLED (scrape-only pipeline), skipping`,
  );
  return { ok: true, skipped: true };
}

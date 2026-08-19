-- ============================================================
--  0005_resume_builds.sql
--  Track CV/resume building status per job (streams via Realtime).
--
--  Flow:
--    jobs.resume_status = 'ready_to_build'  (set by job processor after fit=true)
--      → Supabase DB webhook → on-job-changed Edge Function
--      → calls Azure /api/jobs/{id}/generate-resume
--      → Azure builds + uploads tailored resume, sets resume_status='completed'
--        + resume_url (public URL in generated-resumes bucket)
--
--  Status values:
--    none            (default — no resume needed / not a fit)
--    ready_to_build  (fit job — resume should be generated)
--    building        (Azure is generating the resume)
--    completed       (resume saved to bucket, resume_url set)
--    failed          (generation failed, resume_error set)
-- ============================================================

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS resume_status TEXT NOT NULL DEFAULT 'none'
    CHECK (resume_status IN
      ('none','ready_to_build','building','completed','failed'));

-- Public URL of the generated tailored resume (in the generated-resumes bucket)
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS resume_url TEXT;

-- Filename of the generated resume in storage (links userId + jobId)
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS resume_file_name TEXT;

-- Error message when resume generation failed
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS resume_error TEXT;

-- Timestamps
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS resume_started_at TIMESTAMPTZ;
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS resume_completed_at TIMESTAMPTZ;

-- Index for finding jobs pending resume generation
CREATE INDEX IF NOT EXISTS idx_jobs_resume_status ON jobs (resume_status);

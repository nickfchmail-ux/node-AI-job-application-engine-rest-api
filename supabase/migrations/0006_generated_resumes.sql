-- ============================================================
--  0006_generated_resumes.sql
--
--  Dedicated table linking a generated resume to its USER and
--  JOB POST so it can be accurately retrieved:
--
--      generated_resumes(user_id, job_id, resume_url, ...)
--
--  Flow:
--    1. Job processor (Azure) finds fit=true on a job
--    2. It inserts a generated_resumes row (status='queued') and
--       sets jobs.resume_status = 'ready_to_build'
--    3. Supabase DB webhook → on-job-changed Edge Function
--       → calls Azure /api/jobs/{id}/generate-resume
--    4. Azure builds a tailored resume, uploads it to the
--       `generated-resumes` storage bucket as
--       "<userId>-<jobId>.html", and updates this row:
--       status='completed', resume_url (public URL),
--       file_name, timestamps
--
--  Status values:
--    queued      (row created, Azure not yet called)
--    building    (Azure is generating)
--    completed   (resume saved; resume_url set)
--    failed      (generation failed; error set)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.generated_resumes (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── Links: user + job post ───────────────────────────────
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id        UUID        NOT NULL REFERENCES public.jobs(id)   ON DELETE CASCADE,

  -- ── Build status (streams to frontend via Realtime) ──────
  status        TEXT        NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','building','completed','failed')),

  -- ── Output location ──────────────────────────────────────
  resume_url    TEXT,        -- public URL of the generated resume in storage
  file_name     TEXT,        -- "<userId>-<jobId>.html"
  error         TEXT,        -- error message when failed

  -- ── Timestamps ───────────────────────────────────────────
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,

  -- One tailored resume per job per user (also prevents
  -- duplicate DeepSeek calls for the same job)
  CONSTRAINT uq_generated_resume_user_job UNIQUE (user_id, job_id)
);

-- Useful indexes
CREATE INDEX IF NOT EXISTS idx_generated_resumes_user_id ON generated_resumes (user_id);
CREATE INDEX IF NOT EXISTS idx_generated_resumes_job_id  ON generated_resumes (job_id);
CREATE INDEX IF NOT EXISTS idx_generated_resumes_status  ON generated_resumes (status);

-- ── Row Level Security ────────────────────────────────────
-- Users can only see / create their own generated resumes.
ALTER TABLE public.generated_resumes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users view own generated resumes" ON public.generated_resumes;
CREATE POLICY "Users view own generated resumes"
  ON public.generated_resumes
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users insert own generated resumes" ON public.generated_resumes;
CREATE POLICY "Users insert own generated resumes"
  ON public.generated_resumes
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Service role bypasses RLS (used by Azure Functions).
-- No UPDATE policy for end users — updates are done by the
-- service role only (Azure Functions).

-- ── Realtime: stream CV-building status to the frontend ────
ALTER PUBLICATION supabase_realtime ADD TABLE public.generated_resumes;

-- ── Storage bucket for generated resumes ──────────────────
-- Bucket name: generated-resumes  (private by default)
-- Public URL is produced by the Azure function after upload
-- (see supabase/README.md for bucket creation via CLI:
--   supabase storage create-bucket generated-resumes)
INSERT INTO storage.buckets (id, name, public)
VALUES ('generated-resumes', 'generated-resumes', false)
ON CONFLICT (id) DO NOTHING;

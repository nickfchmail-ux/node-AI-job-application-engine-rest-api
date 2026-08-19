-- ============================================================
--  0009_jobs_rls.sql
--  Enforce strict per-user isolation on the `jobs` table.
--
--  The `jobs` table had RLS enabled but NO policies — meaning
--  users (via anon key + user JWT) could not read/write their
--  own jobs, while the Azure service_role bypassed RLS entirely.
--
--  These policies ensure:
--    SELECT  → users only see their OWN jobs (user_id = auth.uid())
--    INSERT  → users can insert jobs with their own user_id
--    UPDATE  → users can only update their own jobs
--    DELETE  → users can only delete their own jobs
--
--  Note: jobs with user_id = NULL are "system" jobs (legacy /
--  CLI runs) — ordinary users never see them, only service_role.
-- ============================================================

-- ── jobs: SELECT own ────────────────────────────────────────
DROP POLICY IF EXISTS "Users select own jobs" ON public.jobs;
CREATE POLICY "Users select own jobs"
  ON public.jobs
  FOR SELECT
  USING (user_id = auth.uid());

-- ── jobs: INSERT own ────────────────────────────────────────
DROP POLICY IF EXISTS "Users insert own jobs" ON public.jobs;
CREATE POLICY "Users insert own jobs"
  ON public.jobs
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- ── jobs: UPDATE own ────────────────────────────────────────
DROP POLICY IF EXISTS "Users update own jobs" ON public.jobs;
CREATE POLICY "Users update own jobs"
  ON public.jobs
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── jobs: DELETE own ────────────────────────────────────────
DROP POLICY IF EXISTS "Users delete own jobs" ON public.jobs;
CREATE POLICY "Users delete own jobs"
  ON public.jobs
  FOR DELETE
  USING (user_id = auth.uid());

-- ── generated_resumes: DELETE own (parity with the rest) ────
DROP POLICY IF EXISTS "Users delete own generated resumes" ON public.generated_resumes;
CREATE POLICY "Users delete own generated resumes"
  ON public.generated_resumes
  FOR DELETE
  USING (auth.uid() = user_id);

-- ── pipeline_runs: DELETE own (parity with the rest) ────────
DROP POLICY IF EXISTS "Users delete own pipeline runs" ON public.pipeline_runs;
CREATE POLICY "Users delete own pipeline runs"
  ON public.pipeline_runs
  FOR DELETE
  USING (auth.uid() = user_id);

-- ── Realtime: only stream jobs the user owns ────────────────
-- (RLS applies to the realtime publication, so adding the table
--  to the publication + these policies = users only receive their
--  own rows via Realtime. Idempotent — jobs is likely already there.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'jobs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.jobs;
  END IF;
END $$;

-- ============================================================
--  0015_jobs_retrying.sql
--
--  Robust upstream error handling for the job processor.
--
--  When a detail-fetch / enrich / upsert fails due to a TRANSIENT
--  upstream issue (proxy timeout, anti-bot block, rate limit,
--  dead-letter), the processor now marks the job `retrying`
--  instead of `failed` and rethrows so Service Bus redelivers.
--  That lets a later delivery succeed (upsert flips it to
--  `completed`) WITHOUT prematurely finalizing the run.
--
--  Changes to `jobs`:
--    - add `retrying` to the status CHECK constraint
--    - add `last_error` TEXT (failure detail for the UI/ops)
-- ============================================================

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_status_check
  CHECK (status IN
    ('discovered','queued','scraping','processing','enriching',
     'analysing','completed','failed','duplicate','retrying'));

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS last_error TEXT;

COMMENT ON COLUMN jobs.last_error IS 'Last error message when a job is retrying or failed.';

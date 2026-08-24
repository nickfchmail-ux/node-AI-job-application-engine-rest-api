-- ============================================================
--  0016_jobs_url_user_unique.sql
--
--  Make job dedup DATE-INDEPENDENT.
--
--  PROBLEM
--  -------
--  `jobs` was unique on `(url, scraped_date, user_id)` and
--  `scraped_date` is set to "today" at scrape time, so re-searching
--  the SAME keyword on a DIFFERENT calendar day inserted DUPLICATE
--  rows for the same job URL.
--
--  FIX
--  ---
--  The new unique key is `(url, user_id)` — the same job URL
--  scraped by the same user is ONE record, regardless of the day.
--  `scraped_date` becomes the "first-seen folder name" (kept from
--  the earliest surviving row).  A new nullable `last_seen_at`
--  records the last time the URL was seen for that user.
--
--  APP BEHAVIOUR (companion note for the app/function teams)
--  ---------------------------------------------------------
--  • Upserts must target `ON CONFLICT (url, user_id)`.
--  • On conflict the app should NOT insert a new row; it can
--    update `last_seen_at = NOW()` (and refresh scraped content /
--    status as desired).  `scraped_date` is intentionally NOT
--    overwritten — it keeps "first-seen" semantics.
--  • `user_id` may be NULL for legacy/system jobs; the constraint
--    uses `NULLS NOT DISTINCT` (Postgres 15+) so NULLs still dedupe
--    against each other per URL.
--
--  Idempotent + versioned.  Postgres DDL is transactional, so the
--  dedup DELETE and the constraint swap are atomic.
-- ============================================================

BEGIN;

-- ── 1. Add `last_seen_at` (nullable) ─────────────────────────
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

COMMENT ON COLUMN jobs.last_seen_at IS
  'Last time this job URL was seen for this user (updated on duplicate detection). Keeps cross-day dedup without touching scraped_date (first-seen folder name).';

-- ── 2. Deduplicate existing cross-day rows FIRST ─────────────
-- The new UNIQUE (url, user_id) constraint would fail to build if
-- duplicates already exist, so clean them up before adding it.
-- Keep the EARLIEST row per (url, user_id): lowest created_at
-- (ties broken by lowest id).  Rows are deleted by PK so Postgres
-- picks the fastest plan; any ON DELETE CASCADE children
-- (generated_resumes) are removed alongside their parent.
--
-- No-op when there are no duplicates.  Idempotent: after the first
-- run the (url, user_id) key is unique, so rn > 1 never matches.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY url, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM jobs
)
DELETE FROM jobs
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- ── 3. Drop OLD unique constraints (name-exact, idempotent) ──
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_url_scraped_date_user_id_key;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_url_scraped_date_key;

-- ── 4. Add NEW date-independent unique key ───────────────────
-- Guard with a DO block: Postgres has no ADD CONSTRAINT IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_url_user_key'
      AND conrelid = 'jobs'::regclass
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_url_user_key
      UNIQUE NULLS NOT DISTINCT (url, user_id);
  END IF;
END $$;

-- ── 5. Recreate useful indexes (idempotent) ──────────────────
CREATE INDEX IF NOT EXISTS idx_jobs_url_user     ON jobs (url, user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_scraped_date ON jobs (scraped_date);
CREATE INDEX IF NOT EXISTS idx_jobs_keyword      ON jobs (keyword);
CREATE INDEX IF NOT EXISTS idx_jobs_fit          ON jobs (fit);
CREATE INDEX IF NOT EXISTS idx_jobs_company      ON jobs (company);

COMMIT;

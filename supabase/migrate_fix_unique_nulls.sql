-- ============================================================
--  Fix: UNIQUE constraint on (url, scraped_date, user_id)
--  does not prevent duplicate rows when user_id IS NULL because
--  in SQL NULL != NULL.  PostgreSQL 15+ supports NULLS NOT
--  DISTINCT which treats NULLs as equal for uniqueness checks.
--
--  Run this in the Supabase SQL Editor.
-- ============================================================

-- 1. Remove duplicate rows that already exist (keep the earliest created_at)
DELETE FROM jobs
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY url, scraped_date, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
             ORDER BY created_at ASC
           ) AS rn
    FROM jobs
  ) ranked
  WHERE rn > 1
);

-- 2. Drop the old constraint
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_url_scraped_date_user_id_key;

-- 3. Re-create with NULLS NOT DISTINCT (requires PostgreSQL 15+)
ALTER TABLE jobs
  ADD CONSTRAINT jobs_url_scraped_date_user_id_key
  UNIQUE NULLS NOT DISTINCT (url, scraped_date, user_id);

-- ============================================================
--  Jobs Automation – Supabase Table Schema
--  Run this in the Supabase SQL Editor (or via psql)
-- ============================================================

CREATE TABLE IF NOT EXISTS jobs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── Job listing ─────────────────────────────────────────
  title            TEXT        NOT NULL,
  company          TEXT        NOT NULL,
  location         TEXT,
  salary           TEXT,                  -- as listed in the posting, e.g. "$22,000 – $28,000 per month"
  posted_date      TEXT,                  -- raw string from site, e.g. "3d ago"
  url              TEXT        NOT NULL,
  short_description TEXT,
  keyword          TEXT        NOT NULL,  -- search keyword used, e.g. "web_developer"
  scraped_date     DATE        NOT NULL,  -- YYYY-MM-DD folder name

  -- ── Parsed job details ──────────────────────────────────
  responsibilities JSONB       NOT NULL DEFAULT '[]',
  requirements     JSONB       NOT NULL DEFAULT '[]',
  benefits         JSONB       NOT NULL DEFAULT '[]',
  skills           JSONB       NOT NULL DEFAULT '[]',
  employment_type  TEXT,
  experience_level TEXT,
  about_company    TEXT,
  raw_description  TEXT,

  -- ── Fit analysis (populated by coverLetter.ts) ──────────
  fit              BOOLEAN,               -- NULL = not yet analysed
  fit_score        SMALLINT    CHECK (fit_score BETWEEN 0 AND 100),
  fit_reasons      JSONB       DEFAULT '[]',
  cover_letter     TEXT,
  expected_salary  TEXT,                  -- e.g. "HK$18,000 – HK$22,000 per month"

  -- ── Ownership ──────────────────────────────────────────
  user_id          UUID        REFERENCES auth.users(id) ON DELETE CASCADE,

  -- ── Timestamps ──────────────────────────────────────────
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- same job URL scraped by the same user on the same date = same record
  UNIQUE NULLS NOT DISTINCT (url, scraped_date, user_id)
);

-- Auto-update updated_at on every row change
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_updated_at ON jobs;
CREATE TRIGGER jobs_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Useful indexes
CREATE INDEX IF NOT EXISTS idx_jobs_scraped_date ON jobs (scraped_date);
CREATE INDEX IF NOT EXISTS idx_jobs_keyword      ON jobs (keyword);
CREATE INDEX IF NOT EXISTS idx_jobs_fit          ON jobs (fit);
CREATE INDEX IF NOT EXISTS idx_jobs_company      ON jobs (company);

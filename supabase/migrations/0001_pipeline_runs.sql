-- ============================================================
--  0001_pipeline_runs.sql
--  pipeline_runs — tracks Azure Function run/subscription status
--  This is the "subscription" record: one row per scrape run.
--  Azure Functions update this table as the pipeline progresses;
--  Supabase Realtime streams changes to clients.
-- ============================================================

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── Who / what ───────────────────────────────────────────
  user_id         UUID        REFERENCES auth.users(id) ON DELETE CASCADE,
  keyword         TEXT        NOT NULL,
  search_key      TEXT        NOT NULL,            -- slugified keyword, e.g. web_developer
  boards          JSONB       NOT NULL DEFAULT '["jobsdb","ctgoodjobs"]',
  country_code    TEXT,

  -- ── Pipeline state machine ───────────────────────────────
  -- queued → scraping → processing → completed | failed
  --              ↘ retrying (transient board/proxy failure)
  status          TEXT        NOT NULL DEFAULT 'queued'
                  CHECK (status IN
                    ('queued','scraping','processing','completed','failed','retrying')),

  -- ── Progress / counters ──────────────────────────────────
  total_jobs      INTEGER     NOT NULL DEFAULT 0,   -- jobs discovered by scraper
  processed_jobs  INTEGER     NOT NULL DEFAULT 0,   -- jobs fully processed
  failed_jobs     INTEGER     NOT NULL DEFAULT 0,
  fit_jobs        INTEGER     NOT NULL DEFAULT 0,   -- jobs flagged as good fit

  -- ── Messaging / tracing ──────────────────────────────────
  azure_run_id    TEXT,                             -- Service Bus message id / function invocation
  last_error      TEXT,
  retry_count     INTEGER     NOT NULL DEFAULT 0,

  -- ── Timestamps ───────────────────────────────────────────
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at (idempotent)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pipeline_runs_updated_at ON pipeline_runs;
CREATE TRIGGER pipeline_runs_updated_at
  BEFORE UPDATE ON pipeline_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Indexes for fast per-user status queries
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_user_id  ON pipeline_runs (user_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status   ON pipeline_runs (status);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_created   ON pipeline_runs (created_at DESC);

-- ── RLS: users can only see/manage their own runs ─────────────
ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pipeline_runs_select_own ON pipeline_runs;
CREATE POLICY pipeline_runs_select_own ON pipeline_runs
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS pipeline_runs_insert_own ON pipeline_runs;
CREATE POLICY pipeline_runs_insert_own ON pipeline_runs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS pipeline_runs_update_own ON pipeline_runs;
CREATE POLICY pipeline_runs_update_own ON pipeline_runs
  FOR UPDATE USING (auth.uid() = user_id);

-- Service role (Azure Functions) bypasses RLS via service key.
-- Edge Function uses service key to update status on behalf of the pipeline.

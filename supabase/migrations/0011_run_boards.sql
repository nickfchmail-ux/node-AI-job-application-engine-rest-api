-- ============================================================
--  0011_run_boards.sql
--  Per-board scraping progress — the "which stage is EACH board
--  at" granularity the frontend dashboard needs.
--
--  One row per (run_id, board_key). Written by the scraper worker
--  and the job processor; read by GET /api/runs/{runId} and
--  streamed to the UI via Supabase Realtime on pipeline_runs /
--  run_boards.
--
--  Stages mirror the board lifecycle:
--    pending    → not yet started
--    fetching   → fetching search pages (proxy / public API)
--    extracting → parsing listings into ScrapedJob[]
--    blocked    → anti-bot / captcha / proxy failure (retryable)
--    done       → listing extraction finished
--  Jobs that later fail to process show up on the jobs rows, not
--  here — this table tracks the LISTING stage of each board.
-- ============================================================

CREATE TABLE IF NOT EXISTS run_boards (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── Link ───────────────────────────────────────────────
  run_id        UUID        NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  board_key     TEXT        NOT NULL,           -- jobsdb | ctgoodjobs | indeed | linkedin | offertoday

  -- ── Stage machine ─────────────────────────────────────
  stage         TEXT        NOT NULL DEFAULT 'pending'
                CHECK (stage IN
                  ('pending','fetching','extracting','blocked','done','failed')),

  -- ── Progress ──────────────────────────────────────────
  pages_fetched  INTEGER     NOT NULL DEFAULT 0,   -- search pages successfully fetched
  pages_total    INTEGER     NOT NULL DEFAULT 0,   -- pages available / requested
  jobs_found     INTEGER     NOT NULL DEFAULT 0,   -- listings extracted from this board
  jobs_processed INTEGER     NOT NULL DEFAULT 0,   -- jobs from this board fully stored
  jobs_failed    INTEGER     NOT NULL DEFAULT 0,
  duplicate      INTEGER     NOT NULL DEFAULT 0,   -- already-known (deduped)

  -- ── Failure detail ────────────────────────────────────
  last_error     TEXT,
  retry_count    INTEGER     NOT NULL DEFAULT 0,

  -- ── Timestamps ────────────────────────────────────────
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (run_id, board_key)
);

-- Auto-update updated_at
DROP TRIGGER IF EXISTS run_boards_updated_at ON run_boards;
CREATE TRIGGER run_boards_updated_at
  BEFORE UPDATE ON run_boards
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Indexes for fast per-run reads
CREATE INDEX IF NOT EXISTS idx_run_boards_run_id ON run_boards (run_id);

-- ── RLS: users can only see rows of their own runs ──────────
ALTER TABLE run_boards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS run_boards_select_own ON run_boards;
CREATE POLICY run_boards_select_own ON run_boards
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM pipeline_runs r
      WHERE r.id = run_boards.run_id AND r.user_id = auth.uid()
    )
  );

-- Service role (Azure Functions) bypasses RLS via service key.

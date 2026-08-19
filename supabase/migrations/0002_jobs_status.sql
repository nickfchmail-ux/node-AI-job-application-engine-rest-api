-- ============================================================
--  0002_jobs_status.sql
--  Add per-job processing status + pipeline linkage to jobs.
--  Azure Functions update these columns; Realtime streams to clients.
-- ============================================================

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'discovered'
    CHECK (status IN
      ('discovered','queued','scraping','processing','enriching',
       'analysing','completed','failed','duplicate'));

-- Link each job to the pipeline run (subscription) that produced it
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS pipeline_run_id UUID REFERENCES pipeline_runs(id) ON DELETE SET NULL;

-- Track where the job was scraped from (board key, e.g. jobsdb)
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS board TEXT;

-- Processing timestamps
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS processing_completed_at TIMESTAMPTZ;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_jobs_status           ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_pipeline_run_id   ON jobs (pipeline_run_id);

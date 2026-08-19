-- ============================================================
--  0003_realtime.sql
--  Enable Supabase Realtime for jobs + pipeline_runs so the
--  frontend streams live status without polling.
--
--  NOTE: On Supabase this is typically enabled in the Dashboard
--  (Database → Replication → supabase_realtime publication),
--  but the SQL below is the equivalent for scripted setups.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

-- Add tables to the realtime publication (idempotent)
ALTER PUBLICATION supabase_realtime ADD TABLE jobs;
ALTER PUBLICATION supabase_realtime ADD TABLE pipeline_runs;

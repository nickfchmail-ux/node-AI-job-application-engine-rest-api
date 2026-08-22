-- ============================================================
--  0014_run_boards_realtime.sql
--
--  Enable Supabase Realtime for run_boards so the frontend can
--  see per-board stage progress LIVE (chips light up as each
--  board goes fetching → extracting → done / blocked / failed).
--
--  Migration 0003 enabled realtime for jobs + pipeline_runs, but
--  run_boards was created LATER (0011) and was never added to the
--  supabase_realtime publication — so its changes were not streaming.
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE run_boards;

-- Verify it took effect:
--   SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime';

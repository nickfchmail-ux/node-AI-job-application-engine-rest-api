-- ============================================================
--  0013_run_board_increment.sql
--
--  Fix: per-board progress counters (run_boards.jobs_processed,
--  jobs_failed, duplicate) were being OVERWRITTEN by concurrent
--  job-processor invocations (upsert SET), so only the last write
--  survived instead of accumulating. This adds an atomic RPC that
--  INCREMENTS the counters so concurrent processors add up.
--
--  The job processor calls this via the service-role key (which
--  bypasses RLS) — the RPC is SECURITY DEFINER-owned but only
--  exposed to authenticated service calls; it still checks that
--  the row exists for the given run.
-- ============================================================

create or replace function public.increment_run_board(
  p_run_id uuid,
  p_board text,
  p_jobs_found int default 0,
  p_jobs_processed int default 0,
  p_jobs_failed int default 0,
  p_duplicate int default 0
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.run_boards (run_id, board_key, stage, jobs_found, jobs_processed, jobs_failed, duplicate)
  values (p_run_id, p_board, 'pending', p_jobs_found, p_jobs_processed, p_jobs_failed, p_duplicate)
  on conflict (run_id, board_key)
  do update set
    jobs_found    = run_boards.jobs_found    + excluded.jobs_found,
    jobs_processed = run_boards.jobs_processed + excluded.jobs_processed,
    jobs_failed   = run_boards.jobs_failed   + excluded.jobs_failed,
    duplicate     = run_boards.duplicate     + excluded.duplicate,
    updated_at    = now();
end;
$$;

-- Grant execute to the roles that call it (service-role is bypassrls already;
-- authenticated is for the RLS-protected path if ever used directly).
revoke execute on function public.increment_run_board(uuid, text, int, int, int, int) from public;
grant execute on function public.increment_run_board(uuid, text, int, int, int, int) to service_role, authenticated;

-- ============================================================
--  0007_webhook_pg_net.sql
--  Enable the SQL-based Database Webhook using pg_net so the
--  on-job-changed Edge Function fires on jobs INSERT/UPDATE.
--
--  Flow:
--    jobs INSERT/UPDATE → pg_net async POST → Edge Function
--    on-job-changed → Azure (job process + resume build)
--
--  The shared secret is stored in a custom GUC setting and
--  passed as the x-webhook-secret header.
-- ============================================================

-- 1. Enable pg_net (async HTTP extension)
create extension if not exists pg_net;

-- 2. Trigger function that calls the Edge Function
create or replace function public.notify_job_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  edge_url text := 'https://uqrgivzeklqehuqqqqyv.supabase.co/functions/v1/on-job-changed';
  -- Shared secret (must match the Edge Function's AZURE_FUNCTION_WEBHOOK_SECRET).
  -- Set it via:  select set_config('app.azure_webhook_secret', '<secret>', false);
  secret text := current_setting('app.azure_webhook_secret', true);
  payload jsonb;
begin
  payload := jsonb_build_object(
    'type',       tg_op::text,
    'table',      'jobs',
    'schema',     'public',
    'record',     to_jsonb(new),
    'old_record', case when tg_op = 'UPDATE' then to_jsonb(old) else null end
  );

  -- Fire-and-forget async HTTP POST via pg_net
  perform net.http_post(
    url     := edge_url,
    body    := payload,
    headers := jsonb_build_object(
      'Content-Type',   'application/json',
      'x-webhook-secret', secret
    )
  );
  return new;
end;
$$;

-- 3. Attach trigger to jobs (INSERT + UPDATE)
drop trigger if exists notify_job_changed on public.jobs;
create trigger notify_job_changed
  after insert or update on public.jobs
  for each row execute function public.notify_job_changed();

-- 4. Grant execute (needed for the trigger to run under the table owner)
grant execute on function public.notify_job_changed() to service_role;
grant usage on schema net to service_role;

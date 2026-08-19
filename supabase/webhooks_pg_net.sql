-- ============================================================
--  webhooks_pg_net.sql — SQL-based webhook using pg_net
--
--  ALTERNATIVE to the Dashboard-configured Database Webhook.
--  Fires an async HTTP POST to the on-job-changed Edge Function
--  whenever a job row is INSERTed or UPDATEed.
--
--  Requires: pg_net extension (enable via Dashboard → Database
--  → Extensions → pg_net, or the SQL below).
--
--  NOTE: The Edge Function still requires the shared secret
--  (x-webhook-secret) — set it via supabase secrets set.
-- ============================================================

-- 1. Enable pg_net (async HTTP)
create extension if not exists pg_net;

-- 2. Trigger function that calls the Edge Function
create or replace function public.notify_job_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  edge_url text := 'https://<project-ref>.supabase.co/functions/v1/on-job-changed';
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
      'x-webhook-secret', coalesce(secret, '')
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

-- ⚠️ Set the secret via:
--   supabase db query --linked "SELECT set_config('app.azure_webhook_secret','<your-secret>',false);"
-- OR better: pass the secret through an env-backed function (see README).

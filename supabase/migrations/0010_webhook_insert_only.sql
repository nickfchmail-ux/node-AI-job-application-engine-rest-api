-- ============================================================
--  0010_webhook_insert_only.sql
--
--  FIX: The previous webhook fired on jobs INSERT **and** UPDATE,
--  which caused a feedback loop:
--    Azure updates jobs.resume_status → webhook fires
--      → Edge Function → Azure generate-resume → more DB writes
--        → more webhook fires → flood → DB timeouts
--
--  NEW behaviour:
--    - The webhook fires ONLY on INSERT (a genuinely new job).
--      Internal state transitions (status, resume_status, fit...)
--      made by Azure itself NO LONGER trigger webhooks.
--    - Resume generation is triggered by the Azure job processor
--      directly via the Service Bus `resume-builds` queue (throttled,
--      no webhook round-trip). See the Azure function
--      `resumeBuildWorker` (Service Bus trigger on resume-builds).
-- ============================================================

-- Recreate the trigger function (no change to body, just clarity)
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
    'old_record', null
  );

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

-- Attach trigger: INSERT ONLY (this is the key fix — no more UPDATE loop)
drop trigger if exists notify_job_changed on public.jobs;
create trigger notify_job_changed
  after insert on public.jobs
  for each row execute function public.notify_job_changed();

grant execute on function public.notify_job_changed() to service_role;
grant usage on schema net to service_role;

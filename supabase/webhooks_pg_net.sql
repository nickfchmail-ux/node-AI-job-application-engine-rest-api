-- ============================================================
--  webhooks_pg_net.sql — SQL-based webhook using pg_net
--
--  ALTERNATIVE to the Dashboard-configured Database Webhook.
--  Fires an async HTTP POST to the on-job-changed Edge Function
--  whenever a job row is INSERTed.
--
--  Requires: pg_net extension (enable via Dashboard → Database
--  → Extensions → pg_net, or the SQL below).
--
--  NOTE: The Edge Function still requires the shared secret
--  (x-webhook-secret) — set it via supabase secrets set.
--
--  ⚠️ KEEP IN SYNC WITH migration 0017_webhook_batch_statement.sql.
--     The trigger is STATEMENT-level and BATCHED so one upsert
--     batch = ONE Edge Function invocation (was one per row).
--     It is INSERT-ONLY on purpose — see the note on step 2.
-- ============================================================

-- 1. Enable pg_net (async HTTP)
create extension if not exists pg_net;

-- 2. Trigger function that calls the Edge Function
--
--    STATEMENT-LEVEL + BATCHED. A row-level trigger fires once per row, so
--    a 50-row upsert batch would produce 50 pg_net requests → 50 Edge
--    Function invocations. This version uses a transition table so the whole
--    batch travels in ONE payload (`records` array), chunked at 50 rows per
--    request so the body can never grow unbounded.
--
--    INSERT ONLY: firing on UPDATE re-creates the
--    write → webhook → write feedback loop that caused DB timeouts.
create or replace function public.notify_job_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  edge_url   text := 'https://<project-ref>.supabase.co/functions/v1/on-job-changed';
  secret     text := coalesce(current_setting('app.azure_webhook_secret', true), '');
  chunk_size int  := 50;
  batch      jsonb;
  chunk      jsonb;
  total      int;
  i          int;
begin
  -- Only the columns the Edge Function reads — shipping the whole row
  -- (raw_description, cover_letter, fit_reasons, ...) wasted bandwidth.
  with slim as (
    select n.id, n.title, n.company, n.url, n.status,
           n.resume_status, n.pipeline_run_id, n.user_id
      from new_rows n
     order by n.id
  )
  select coalesce(jsonb_agg(to_jsonb(slim)), '[]'::jsonb)
    into batch
  from slim;

  total := jsonb_array_length(batch);
  if total = 0 then
    return null;  -- statement-level triggers fire even for zero rows
  end if;

  for i in 0 .. ((total - 1) / chunk_size) loop
    select jsonb_agg(batch -> g)
      into chunk
      from generate_series(
             i * chunk_size,
             least((i + 1) * chunk_size, total) - 1
           ) as g;

    -- Fire-and-forget async HTTP POST via pg_net.
    -- Failure isolation: a webhook problem must NEVER abort the job
    -- insert (this is an AFTER trigger — the rows are already written).
    begin
      perform net.http_post(
        url    := edge_url,
        body   := jsonb_build_object(
          'type',       tg_op::text,
          'table',      'jobs',
          'schema',     'public',
          'records',    chunk,
          'count',      jsonb_array_length(chunk),
          -- `record` kept for the legacy single-row Edge Function contract.
          'record',     chunk -> 0,
          'old_record', null
        ),
        headers := jsonb_build_object(
          'Content-Type',     'application/json',
          'x-webhook-secret', secret
        ),
        timeout_milliseconds := 5000
      );
    exception when others then
      raise warning
        '[notify_job_changed] webhook dispatch failed (chunk % of %) — jobs were still written: %',
        i + 1, ((total - 1) / chunk_size) + 1, sqlerrm;
    end;
  end loop;

  return null;
end;
$$;

-- 3. Attach trigger to jobs (INSERT only, once per statement)
drop trigger if exists notify_job_changed on public.jobs;
create trigger notify_job_changed
  after insert on public.jobs
  referencing new table as new_rows
  for each statement execute function public.notify_job_changed();

-- 4. Grant execute (needed for the trigger to run under the table owner)
grant execute on function public.notify_job_changed() to service_role;
grant usage on schema net to service_role;

-- ⚠️ Set the secret via:
--   supabase db query --linked "SELECT set_config('app.azure_webhook_secret','<your-secret>',false);"
-- OR better: pass the secret through an env-backed function (see README).

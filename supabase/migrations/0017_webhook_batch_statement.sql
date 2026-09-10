-- ============================================================
--  0017_webhook_batch_statement.sql
--
--  Reduce the `jobs` webhook fan-out from PER-ROW to PER-STATEMENT.
--
--  PROBLEM
--  -------
--  0010 attached `notify_job_changed` as `FOR EACH ROW`, so a single
--  50-row upsert batch (see src/pipeline/persist.ts, BATCH = 50)
--  produced 50 pg_net requests -> 50 Edge Function invocations ->
--  50 Azure POSTs + 150 socket POSTs (~200 outbound calls per batch,
--  each holding an Edge isolate open).
--
--  FIX
--  ---
--  `jobs` upserts are BATCHED at the application layer, so the trigger
--  can be batched too: a statement-level AFTER INSERT trigger with a
--  transition table sees EVERY row of the statement at once and emits
--  ONE payload (`records` = array) per statement.
--
--  Expected effect: 50 invocations -> 1 for a full upsert batch.
--
--  Also in this migration:
--   • The payload is SLIMMED to only the columns the Edge Function
--     actually reads. Previously `to_jsonb(new)` shipped the whole row
--     (including `raw_description`, `cover_letter`, `fit_reasons`,
--     `responsibilities`/`requirements` JSONB) — up to 3 KB of text per
--     job that was serialised, sent, parsed, and then discarded.
--   • Batches are CHUNKED at 50 rows per HTTP call so an unusually
--     large single statement can never build a giant JSON body
--     (pg_net warns about payload size) and no rows are dropped.
--   • `timeout_milliseconds` is set EXPLICITLY (was relying on the
--     pg_net 5s default, which silently marked slow calls as timed out).
--
--  Retained from 0010: INSERT ONLY. Firing on UPDATE re-created the
--  write -> webhook -> write feedback loop that caused DB timeouts.
--
--  SECRET SOURCE (changed) — this was a second, fatal defect in 0010
--  ----------------------------------------------------------------
--  0010 read the shared secret from a custom GUC:
--      current_setting('app.azure_webhook_secret', true)
--  That can NEVER work on this project. `postgres` is NOT a superuser
--  here (verified: SELECT rolsuper FROM pg_roles WHERE rolname =
--  current_user -> false; the superuser is `supabase_admin`), and
--  PostgreSQL only allows a superuser to SET a customized (`app.*`)
--  option. So this statement:
--      alter database postgres set app.azure_webhook_secret = '...';
--  fails with  42501: permission denied to set parameter. With the GUC
--  unset the trigger sent an EMPTY x-webhook-secret, the Edge Function
--  answered 401 every time, and the whole DB -> Edge -> Azure/socket
--  chain was silently dead.
--
--  The secret now lives in a locked-down table, `public.webhook_config`,
--  which the SECURITY DEFINER trigger function can read. Unlike setting a
--  customized option, a plain INSERT needs no superuser — so the secret
--  is also rotatable through the ordinary PostgREST service-role path,
--  without ever pasting it into a UI or a SQL script:
--      curl -X POST "$SUPABASE_URL/rest/v1/webhook_config" \
--        -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
--        -H "Content-Type: application/json" \
--        -H "Prefer: resolution=merge-duplicates" \
--        -d '{"key":"azure_webhook_secret","value":"<new secret>"}'
--  The GUC is still consulted as a fallback so the local pg_net harness
--  (which runs as a superuser and uses set_config) keeps working.
--
--  Companion change: the Edge Function tolerates both shapes —
--  `records` (batch, new) and `record` (single, legacy).
-- ============================================================

BEGIN;

-- ── Secret store ─────────────────────────────────────────────
-- One row per named secret. RLS is enabled with NO policies, so
-- `anon` / `authenticated` can never read it; the table owner
-- (postgres) and `service_role` can. The trigger function is
-- SECURITY DEFINER and owned by postgres, so it reads past RLS.
create table if not exists public.webhook_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

alter table public.webhook_config enable row level security;

revoke all on public.webhook_config from anon, authenticated;
grant select, insert, update on public.webhook_config to service_role;

-- ── Statement-level trigger function (batched) ───────────────
create or replace function public.notify_job_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  edge_url    text := 'https://uqrgivzeklqehuqqqqyv.supabase.co/functions/v1/on-job-changed';
  -- Shared secret (must match the Edge Function's
  -- AZURE_FUNCTION_WEBHOOK_SECRET). Resolved at runtime from
  -- public.webhook_config, with the GUC as a harness fallback.
  secret      text;
  chunk_size  int  := 50;
  batch       jsonb;
  chunk       jsonb;
  total       int;
  i           int;
begin
  -- Resolve the shared secret first: table (production), then the GUC
  -- (local pg_net harness, which runs as a superuser), else '' — which
  -- fails auth loudly as a logged 401 instead of sending a JSON `null`.
  select coalesce(
           (select wc.value
              from public.webhook_config wc
             where wc.key = 'azure_webhook_secret'),
           nullif(current_setting('app.azure_webhook_secret', true), ''),
           ''
         )
    into secret;

  -- Transition table `new_rows` holds every row inserted by THIS
  -- statement (INSERT ... ON CONFLICT DO UPDATE fires this only for
  -- rows that were actually inserted, never for the UPDATE path).
  with slim as (
    select
      n.id,
      n.title,
      n.company,
      n.url,
      n.status,
      n.resume_status,
      n.pipeline_run_id,
      n.user_id
    from new_rows n
    order by n.id
  )
  select coalesce(jsonb_agg(to_jsonb(slim)), '[]'::jsonb)
    into batch
  from slim;

  total := jsonb_array_length(batch);

  -- Statement-level triggers fire even for zero affected rows.
  if total = 0 then
    return null;
  end if;

  for i in 0 .. ((total - 1) / chunk_size) loop
    select jsonb_agg(batch -> g)
      into chunk
    from generate_series(
           i * chunk_size,
           least((i + 1) * chunk_size, total) - 1
         ) as g;

    -- Failure isolation: a webhook problem must NEVER abort the job
    -- insert. `net.http_post` is fire-and-forget (it only enqueues into
    -- net.http_request_queue and returns), but it still has failure
    -- modes — pg_net not installed, queue table missing, insufficient
    -- privileges. Without this handler any of those would raise here and
    -- roll back the entire scrape batch. We log and carry on instead;
    -- the rows are already written (this is an AFTER trigger).
    begin
      perform net.http_post(
        url    := edge_url,
        body   := jsonb_build_object(
          'type',       tg_op::text,
          'table',      'jobs',
          'schema',     'public',
          'records',    chunk,
          'count',      jsonb_array_length(chunk),
          -- `record` kept for backward compatibility with the single-row
          -- Edge Function contract and any Dashboard-configured webhook.
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

-- ── Swap the per-row trigger for a per-statement one ─────────
-- Transition tables require: AFTER + FOR EACH STATEMENT + plain table.
drop trigger if exists notify_job_changed on public.jobs;

create trigger notify_job_changed
  after insert on public.jobs
  referencing new table as new_rows
  for each statement
  execute function public.notify_job_changed();

grant execute on function public.notify_job_changed() to service_role;
grant usage on schema net to service_role;

COMMIT;

-- ── Verify ───────────────────────────────────────────────────
--   -- the secret is present, without printing it:
--   SELECT key, length(value) AS len, updated_at FROM public.webhook_config;
--
--   -- should be a STATEMENT-level trigger:
--   SELECT tgname, tgtype, tgenabled
--     FROM pg_trigger WHERE tgrelid = 'jobs'::regclass AND NOT tgisinternal;
--
--   -- recent webhook calls + their status:
--   SELECT id, status_code, error_msg, created
--     FROM net._http_response ORDER BY created DESC LIMIT 20;

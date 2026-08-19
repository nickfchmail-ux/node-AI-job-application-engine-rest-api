# ============================================================

# Supabase setup notes for the Jobs Automation platform

# ============================================================

## 1. Apply migrations

Run from the repo root (requires `supabase` CLI + linked project):

    supabase link --project-ref <your-project-ref>
    supabase db push

Or copy each file in `supabase/migrations/` into the Dashboard
SQL Editor in order:
0001_pipeline_runs.sql
0002_jobs_status.sql
0003_realtime.sql
0004_database_webhook.sql

## 2. Set Edge Function secrets

    supabase secrets set AZURE_FN_BASE_URL=https://<your-function-app>.azurewebsites.net
    supabase secrets set AZURE_FUNCTION_WEBHOOK_SECRET=<long-random-string>

## 3. Deploy the Edge Function

    supabase functions deploy on-job-changed

## 4. Realtime

In the Dashboard: Database → Replication → supabase_realtime →
ensure `jobs` and `pipeline_runs` are enabled.
(0003_realtime.sql does this too if your project allows ALTER PUBLICATION.)

## 5. Database Webhook (hosted projects only)

Database → Webhooks → Create:

- Name: on-job-changed
- Table: jobs
- Events: INSERT, UPDATE
- HTTP Method: POST
- URL: https://<project-ref>.supabase.co/functions/v1/on-job-changed
- Headers: x-webhook-secret: <same secret as above>
- Body: {"type":"{{TYPE}}","table":"jobs","schema":"public","record":"{{record}}","old_record":"{{old_record}}"}

## Env vars used by Azure Functions (see azure/ folder)

SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY,
DEEP_SEEK_API, CLOUDFLARE_PROXY_URL, AZURE_FUNCTION_WEBHOOK_SECRET,
ServiceBus**fullyQualifiedNamespace, ServiceBus**credential

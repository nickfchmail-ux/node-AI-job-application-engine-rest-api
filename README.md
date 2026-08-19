# Jobs Automation Platform — REST API

Automated job scraper for Hong Kong job boards (JobsDB, CTgoodjobs, OfferToday, LinkedIn).

## What it does

- **Scrapes job listings** from Hong Kong job boards: JobsDB, CTgoodjobs (via residential proxy), OfferToday + LinkedIn (via public APIs)
- **Enriches each listing** with the full job description — parses responsibilities, requirements, benefits, skills, employment type, and experience level
- **Dedupes** against already-stored jobs (same URL + user + date) so repeats aren't inserted twice
- **Streams live progress** to the frontend via WebSocket + Supabase Realtime (no polling)
- **Exposes a REST API** (Express + JWT) plus a serverless scrape pipeline (Azure Functions + Service Bus) for a frontend to consume

> **Scrape-only pipeline.** The current pipeline **scrapes and stores jobs only** — there is no AI fit scoring, cover-letter generation, or AI resume generation. `fit` / `fit_score` / `cover_letter` columns are stored as `NULL`. If you need AI analysis later, it can be re-enabled on top of the stored jobs.

## Architecture

```
┌────────────┐   POST /api/scrape (x-functions-key)   ┌──────────────────────────┐
│  Frontend  │ ──────────────────────────────────────▶ │  Azure Function (HTTP)   │
└─────┬──────┘                                        │  creates pipeline_run    │
      │                                               └───────────┬──────────────┘
      │   WebSocket (Socket.io) / Supabase Realtime                ▼
      │   ┌────────────────────────────┐   ┌──────────────────────────────────────┐
      └───│ Express server (Render)    │◀──│ Azure Scraper Worker (Service Bus)    │
          │  /stats/* + WS push        │   │  fetch pages → parse → dedupe → store │
          └────────────┬───────────────┘   └──────────────────────────────────────┘
                       │
                  Upstash Redis (user-keyed funnel counters)
```

## Stack

- **Node.js / TypeScript** (Express API + worker)
- **Azure Functions** (serverless scrape pipeline, Service Bus queue triggers)
- **Supabase** (database `jobs` + `pipeline_runs`, Realtime, Storage)
- **Upstash Redis** (live per-user funnel counters)
- **Cloudflare Workers** (job-board proxy for anti-bot bypass)
- **Railway / Render** (deployment)

## Quick start

1. Clone the repo
2. Copy the environment config and fill in your keys:
   - `Supabase URL` + service-role key
   - `KV_REST_API_URL` + `KV_REST_API_TOKEN` (Upstash)
   - Azure Function connection strings (`ServiceBus__connectionString`, etc.)
3. Install dependencies: `npm install`
4. Start the Express API: `npm start`
5. Start the worker (if using the legacy BullMQ path): `npm run worker`
6. Deploy the Azure Functions (see `azure/deploy-azure.sh`) for the serverless scrape pipeline

## Docs

| Document                             | Purpose                                                 |
| ------------------------------------ | ------------------------------------------------------- |
| `docs/API.md`                        | Authoritative REST / WebSocket / Supabase API reference |
| `docs/FRONTEND_API.md`               | Every API surface a frontend can use                    |
| `docs/FRONTEND_INTEGRATION_GUIDE.md` | Implementation task list for frontend agents            |
| `docs/UX_SPEC_REALTIME_DASHBOARD.md` | UX spec for the live dashboard                          |

## Feature status

| Feature                                        | Status      |
| ---------------------------------------------- | ----------- |
| Scrape JobsDB / CTgoodjobs (residential proxy) | ✅          |
| Scrape OfferToday / LinkedIn (public APIs)     | ✅          |
| Full description enrichment                    | ✅          |
| Dedupe (URL + user + date)                     | ✅          |
| Live funnel + WebSocket push                   | ✅          |
| Supabase Realtime job streaming                | ✅          |
| AI fit scoring (DeepSeek)                      | ⛔ disabled |
| Cover-letter generation                        | ⛔ disabled |
| Tailored resume generation (HTML/PDF)          | ⛔ disabled |

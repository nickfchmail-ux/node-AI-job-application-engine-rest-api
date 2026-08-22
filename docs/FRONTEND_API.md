# Jobs Automation Platform — Frontend API Reference

This document describes **every API surface** your frontend can use, including:

- REST endpoints on the **Express server** (Render)
- **Azure Functions** endpoints (scrape pipeline)
- **WebSocket (Socket.io)** live updates
- **Supabase** (Database + Realtime)

> **Base URLs & keys**
> | Item | Value |
> |------|-------|
> | Express API server | `https://ai-job-server.onrender.com` |
> | Azure Functions | `https://jobsautomation-fn.azurewebsites.net` |
> | Supabase | `https://uqrgivzeklqehuqqqqyv.supabase.co` |
> | Supabase anon key | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxcmdpdnpla2xxZWh1cXFxcXl2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0NDgwNjAsImV4cCI6MjA4ODAyNDA2MH0.NqayAccHCArnZK1T3Ws1l57-P_zMpTljOvv15jsGyi0` |
> | WebSocket | `wss://ai-job-server.onrender.com` |

> **Security model:** All data is **strictly per-user**. RLS on every Supabase table, user-keyed Redis keys, and verified WebSocket auth ensure a user can only see their own jobs, runs, and counters. You only ever pass the **user's own** `user_id` (from the JWT) — never trust a client-supplied id for a different user.

> **Scrape-only pipeline:** jobs are **scraped and stored** — there is no AI fit scoring, cover letter, or resume generation. `fit`, `fit_score`, `cover_letter`, and resume fields on a job are always `NULL` / unset. No resume upload is needed.

---

## 1. Authentication

All protected endpoints use **`Authorization: Bearer <access_token>`** where `<access_token>` is the Supabase JWT obtained from login.

### `POST /auth/register`

Create a new user account.

```bash
curl -X POST https://ai-job-server.onrender.com/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"YourPass123!"}'
```

**Response `201`**

```json
{ "id": "uuid", "email": "user@example.com" }
```

### `POST /auth/login`

Authenticate and get tokens.

```bash
curl -X POST https://ai-job-server.onrender.com/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"YourPass123!"}'
```

**Response `200`**

```json
{
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "user": { "id": "uuid", "email": "user@example.com" }
}
```

### `POST /auth/refresh`

Refresh an expired access token.

```bash
curl -X POST https://ai-job-server.onrender.com/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refresh_token":"eyJ..."}'
```

**Response `200`** — same shape as login (new `access_token` + `refresh_token`).

> ⚠️ **Important:** Store `access_token` + `refresh_token`. Refresh proactively (before expiry) to avoid a logout. On `401` from any endpoint, refresh then retry.

---

## 2. Triggering a Job Scrape (Azure Function)

### `POST /api/scrape` — start a scrape pipeline (RECOMMENDED)

**Auth:** `x-functions-key: <scrape function key>` (or `?code=<key>`).

| Field          | Type     | Default                   | Notes                                                     |
| -------------- | -------- | ------------------------- | --------------------------------------------------------- |
| `keyword`      | string   | **required**              | Search keyword, e.g. `"software engineer"`                |
| `pages`        | number   | `1`                       | 1–5 pages per board                                       |
| `boards`       | string[] | `["jobsdb","ctgoodjobs"]` | Allowed: `jobsdb`, `ctgoodjobs`, `offertoday`, `linkedin` |
| `user_id`      | string   | **required**              | The authenticated user's UUID                             |
| `country_code` | string   | —                         | e.g. `hk`                                                 |

```bash
curl -X POST https://jobsautomation-fn.azurewebsites.net/api/scrape \
  -H "Content-Type: application/json" \
  -H "x-functions-key: <KEY>" \
  -d '{
    "keyword": "react developer",
    "pages": 1,
    "boards": ["jobsdb","ctgoodjobs","offertoday","linkedin"],
    "user_id": "31c3b3a1-669d-4e21-8ec3-8f13c7e28630"
  }'
```

**Response `202`**

```json
{
  "runId": "07b0cadf-83f8-4350-8d26-cde10aa8f36d",
  "messageId": "scrape-07b0cadf-...",
  "status": "queued",
  "pollUrl": "/api/runs/07b0cadf-..."
}
```

### `POST /scrape` — legacy Express path (BullMQ)

**Auth:** Bearer token. Queues into BullMQ; poll `GET /jobs/:jobId`.

```bash
curl -X POST https://ai-job-server.onrender.com/scrape \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{"keyword":"react developer","pages":1,"boards":["jobsdb","ctgoodjobs","offertoday","linkedin"]}'
```

**Response `202`**

```json
{ "jobId": "bullmq-job-id", "pollUrl": "/jobs/bullmq-job-id" }
```

> If an identical scrape is already running for this user+keyword, returns `202` with the existing jobId + a `note`.

### `GET /jobs/:jobId` — poll legacy job result

**Auth:** Bearer token. Returns job status (scraping → done), child-job aggregation, fit results.

```bash
curl https://ai-job-server.onrender.com/jobs/<jobId> \
  -H "Authorization: Bearer <access_token>"
```

**Response (while running):** `{ "status": "scraping", "logs": [...] }`
**Response (done):** `{ "status": "done", "result": { "total", "fit", "jobs": [...] } }`

---

## 3. Live Pipeline State (Express Server — REST)

All `/stats/*` endpoints require **`Authorization: Bearer <user JWT>`** and are **strictly scoped to the authenticated user** — you only ever see your own data.

### `GET /stats/summary` — aggregated counters across all your runs

**Response `200`**

```json
{
  "ok": true,
  "userId": "31c3b3a1-...",
  "counts": {
    "scraped": 62,
    "duplicate": 34,
    "unique": 28,
    "processing": 3
  }
}
```

### `GET /stats/runs` — list all your runs (most recent first)

**Response `200`**

```json
{
  "ok": true,
  "runs": [
    {
      "runId": "07b0cadf-...",
      "keyword": "react developer",
      "boards": ["jobsdb", "ctgoodjobs", "offertoday", "linkedin"],
      "createdAt": "2026-08-19T...",
      "counts": { "scraped": 62, "...": "same funnel shape" }
    }
  ]
}
```

### `GET /api/runs/{runId}` — single run detail (status + per-board progress)

**Auth:** `x-functions-key: <key>` (or `?code=<key>`).

**Response `200`**

```json
{
  "run": {
    "id": "07b0cadf-...",
    "keyword": "react developer",
    "boards": ["jobsdb", "ctgoodjobs", "offertoday", "linkedin"],
    "status": "processing",
    "total_jobs": 34,
    "processed_jobs": 12,
    "failed_jobs": 1,
    "started_at": "2026-08-19T...",
    "completed_at": null
  },
  "jobsCount": 34,
  "boards": {
    "jobsdb": {
      "stage": "done",
      "pagesFetched": 1,
      "pagesTotal": 1,
      "jobsFound": 18,
      "jobsProcessed": 10,
      "jobsFailed": 0,
      "duplicate": 2,
      "displayName": "JobsDB HK"
    },
    "ctgoodjobs": {
      "stage": "extracting",
      "pagesFetched": 1,
      "pagesTotal": 1,
      "jobsFound": 12,
      "jobsProcessed": 2,
      "jobsFailed": 0,
      "duplicate": 0,
      "displayName": "CTgoodjobs HK"
    },
    "offertoday": {
      "stage": "done",
      "pagesFetched": 1,
      "pagesTotal": 1,
      "jobsFound": 30,
      "jobsProcessed": 0,
      "jobsFailed": 0,
      "duplicate": 0,
      "displayName": "Offer Today"
    },
    "linkedin": {
      "stage": "blocked",
      "pagesFetched": 0,
      "pagesTotal": 1,
      "jobsFound": 0,
      "jobsProcessed": 0,
      "jobsFailed": 0,
      "duplicate": 0,
      "lastError": "board linkedin page 1: blocked (Cloudflare challenge)",
      "displayName": "LinkedIn HK"
    }
  },
  "statusLabel": "Loading job details…"
}
```

### Board stages (`boards.<key>.stage`)

| Stage        | Meaning                                         | UI copy (per UX spec) |
| ------------ | ----------------------------------------------- | --------------------- |
| `pending`    | Not started yet                                 | "Waiting…"            |
| `fetching`   | Fetching search pages (proxy / public API)      | "Searching…"          |
| `extracting` | Parsing listings into job cards                 | "Reading listings…"   |
| `blocked`    | Anti-bot / proxy blocked this board (retryable) | "Blocked — retrying…" |
| `done`       | Listings extracted successfully                 | "Done ✓"              |
| `failed`     | Board failed this run                           | "Failed — retry"      |

> This endpoint streams live via **Supabase Realtime on `run_boards`** — subscribe
> to `postgres_changes` on `run_boards` filtered by `run_id` (or via the Express
> WebSocket push, which already forwards `pipeline_runs` + `jobs` changes).

### Counter semantics (the funnel)

| Counter      | Meaning                                              |
| ------------ | ---------------------------------------------------- |
| `scraped`    | Total job listings discovered by scrapers            |
| `duplicate`  | Already-known jobs (deduped, not inserted)           |
| `unique`     | `scraped - duplicate` (new unique jobs)              |
| `processing` | Live: jobs currently being detail-scraped / enriched |

Per-job terminal states (queued → processing → completed / failed) are not
tracked in these counters — they live in Supabase `jobs.status` and stream via
Realtime.

---

## 4. Live Pipeline State (WebSocket — realtime push)

Connect once — no polling. The server pushes updates whenever Azure changes a counter.

### Connect

```js
import { io } from "socket.io-client";

const socket = io("https://ai-job-server.onrender.com", {
  auth: { token: "<supabase access_token>" }, // REQUIRED
  transports: ["websocket"],
});
```

### Events

| Event           | Payload                           | When                                                           |
| --------------- | --------------------------------- | -------------------------------------------------------------- |
| `connect`       | —                                 | Connected to server                                            |
| `stats:summary` | `{ ok, counts: <funnel> }`        | On connect + every counter change (aggregated across all runs) |
| `stats:run`     | `{ ok, runId, counts: <funnel> }` | Counter change for a specific run                              |
| `connect_error` | `{ message }`                     | Auth failed (invalid/expired token)                            |

```js
socket.on("stats:summary", (data) => {
  // Update your dashboard funnel with data.counts
  console.log(data.counts);
});
socket.on("stats:run", (data) => {
  // Update the specific run card
  console.log(data.runId, data.counts);
});
```

> **Security:** The server verifies your Supabase JWT on connect and only pushes **your own** data into your private room.

---

## 5. Supabase (Database + Realtime)

The frontend can also use the **Supabase JS client** directly for row-level data (jobs, pipeline runs).

### Client setup

```js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://uqrgivzeklqehuqqqqyv.supabase.co",
  "<anon_key>",
);
// Set the session with the user's token:
supabase.auth.setSession({ access_token, refresh_token });
```

### Tables (all RLS-protected → users only see their own rows)

**`jobs`** — each scraped job
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `title`, `company`, `location`, `salary` | text | Listing info |
| `url` | text | Job post URL |
| `status` | text | `queued → processing → completed / failed` |
| `board` | text | `jobsdb` / `ctgoodjobs` / `offertoday` / `linkedin` |
| `responsibilities`, `requirements`, `benefits`, `skills` | jsonb | Parsed from the full description |
| `employment_type`, `experience_level`, `about_company` | text | Parsed detail |
| `raw_description` | text | Full raw description |
| `fit`, `fit_score`, `fit_reasons` | bool/int/jsonb | Always `NULL`/`[]` (AI disabled) |
| `cover_letter`, `expected_salary` | text | Always `NULL` (AI disabled) |
| `resume_status` | text | Always `none` (resume generation disabled) |
| `user_id` | uuid | Owner (RLS) |
| `pipeline_run_id` | uuid | Parent run |

**`pipeline_runs`** — a scrape run
| Column | Notes |
|--------|-------|
| `id`, `keyword`, `boards`, `status` | `queued → scraping → processing → completed / failed` |
| `total_jobs`, `processed_jobs`, `fit_jobs`, `failed_jobs` | Progress (`fit_jobs` stays 0) |
| `last_error` | Error detail when failed |
| `user_id` | Owner (RLS) |

**`run_boards`** — per-board progress for a run (NEW)
| Column | Notes |
|--------|-------|
| `run_id` | FK → `pipeline_runs.id` |
| `board_key` | `jobsdb` / `ctgoodjobs` / `offertoday` / `linkedin` / `indeed` |
| `stage` | `pending → fetching → extracting → done / blocked / failed` |
| `pages_fetched`, `pages_total` | Search-page progress |
| `jobs_found`, `jobs_processed`, `jobs_failed`, `duplicate` | Per-board funnel |
| `last_error`, `retry_count` | Failure detail |
| `started_at`, `completed_at` | Stage timing |
| `UNIQUE(run_id, board_key)` | One row per board per run |

> The `generated_resumes` table exists for backwards compatibility but is **not used** by the scrape-only pipeline.

### Realtime subscriptions (zero-poll live rows)

```js
// Live job rows for the current user (RLS filters automatically)
const jobChannel = supabase
  .channel("jobs")
  .on(
    "postgres_changes",
    { event: "*", schema: "public", table: "jobs" },
    (payload) => {
      console.log("Job changed:", payload.new);
    },
  )
  .subscribe();

// Live run status
supabase
  .channel("pipeline_runs")
  .on(
    "postgres_changes",
    { event: "*", schema: "public", table: "pipeline_runs" },
    (payload) => console.log("Run changed:", payload.new),
  )
  .subscribe();

// Live per-board progress (NEW)
supabase
  .channel("run_boards")
  .on(
    "postgres_changes",
    { event: "*", schema: "public", table: "run_boards" },
    (payload) => console.log("Board changed:", payload.new),
  )
  .subscribe();
```

> **Realtime + RLS:** Supabase Realtime enforces RLS — users only receive changes for their OWN rows. No extra filtering needed.

---

## 6. Job Processing Status (Azure Function — REST fallback)

### `GET /api/runs/{runId}` — run status + job count + per-board progress

**Auth:** `x-functions-key: <function key>`

**Response `200`**

```json
{
  "run": { "id": "...", "status": "processing", "keyword": "...", "..." },
  "jobsCount": 62,
  "boards": {
    "jobsdb":     { "stage": "done", "jobsFound": 30, "jobsProcessed": 20, "jobsFailed": 0, "duplicate": 4, "pagesFetched": 1, "pagesTotal": 1, "displayName": "JobsDB HK" },
    "ctgoodjobs": { "stage": "extracting", "jobsFound": 16, "jobsProcessed": 8, "jobsFailed": 0, "duplicate": 0, "pagesFetched": 1, "pagesTotal": 1, "displayName": "CTgoodjobs HK" }
  },
  "statusLabel": "Loading job details…"
}
```

---

## 7. Webhook (Internal — do NOT call from frontend)

`POST /webhook/state` — called by **Azure Functions** after updating Redis, to trigger the WebSocket push. Protected by `x-webhook-secret`. **Frontend should not call this** — it's documented for completeness only.

---

## 7b. Normalized Job Data Contract (quality layer)

Every job stored in `jobs` is **normalized from its board's raw output** before
fan-out (see `azure/functions/src/normalize.ts`). The frontend can therefore
render any job card without branching on `board`.

| Field                                                       | Type            | Notes                                                                                |
| ----------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------ |
| `title`                                                     | string          | HTML entities decoded, tags stripped, whitespace collapsed                           |
| `company`                                                   | string          | Same cleaning; `"N/A"`/missing → `"Unknown Company"` (consistent across boards)      |
| `location`                                                  | string          | Defaults `"Hong Kong"` when a board omits it                                         |
| `salary`                                                    | string \| null  | Original display string (e.g. `"HK$30,000 – HK$40,000 per month"`)                   |
| `salary_min` / `salary_max`                                 | integer \| null | Parsed numeric range (sortable/filterable)                                           |
| `salary_period`                                             | string \| null  | `month` / `year` / `hour` / `day`                                                    |
| `salary_currency`                                           | string \| null  | ISO 4217 (`HKD`, `USD`, ...) — inferred from board when the raw string has no symbol |
| `salary_confidence`                                         | string \| null  | `high` / `medium` / `low` / `none`                                                   |
| `data_quality`                                              | jsonb \| null   | `{ completeness, has_salary, has_description, has_posted_date, has_location }`       |
| `posted_date`                                               | string \| null  | **ISO `YYYY-MM-DD`** — relative strings (`3d ago`, `Today`) converted                |
| `url`                                                       | string          | Stable, deduped (unique per run)                                                     |
| `short_description`                                         | string \| null  | Listing snippet (cleaned)                                                            |
| `responsibilities` / `requirements` / `benefits` / `skills` | jsonb           | Parsed from the full detail page                                                     |
| `board`                                                     | string          | `jobsdb` / `ctgoodjobs` / `offertoday` / `linkedin`                                  |

**Data-quality signals** (computed at normalize time, useful for UI badges):

- `posted_date` is **null** when a board only says `"Promoted"` or is unparseable — treat as "date unknown", not "today".
- A job with `title`, `company`, `location`, and `url` is `completeness: 100`.
- Salary is **structured** (min/max/period/currency) — no client-side regex needed. `currency` is inferred as `HKD` for HK boards (e.g. Indeed's numeric-only ranges). Missing salary → `salary: null`, `salary_confidence: "none"`.

> **Consistency guarantee:** because normalization happens in the scraper worker
> BEFORE a job is written, every `jobs` row already carries the clean shape above —
> no frontend-side regex for entities, dates, or salary is needed. Every board
> (jobsdb, ctgoodjobs, indeed, linkedin, offertoday) returns the SAME contract.

---

## 8. Recommended Frontend Flow

```
1. User logs in  →  POST /auth/login  →  { access_token, refresh_token }
2. Open WebSocket with the token → receives live stats:summary + stats:run
3. Start a scrape  →  POST /api/scrape (Azure)  →  { runId }
4. Show the funnel dashboard from WebSocket events (no polling):
     scraped → duplicate → unique → processing
5. Subscribe to Supabase Realtime for the actual job rows (details list)
```

### Job lifecycle (what the frontend should show per job)

```
discovered/queued → processing (detail scrape) → completed
  → any step can fail → failed (see job.status / run.last_error)
```

Terminal job states come from Supabase `jobs.status` (Realtime), not the Redis
funnel counters.

### UI status label mapping (from `pipeline_runs.status`)

| status       | Suggested label           |
| ------------ | ------------------------- |
| `queued`     | "Queued..."               |
| `scraping`   | "Scraping job boards..."  |
| `processing` | "Scraping job details..." |
| `completed`  | "Completed"               |
| `failed`     | "Failed — view details"   |
| `retrying`   | "Retrying..."             |

### Notes

- **Boards supported:** `jobsdb`, `ctgoodjobs`, `offertoday`, `linkedin`, `indeed` — all routed through the **Cloudflare proxy** (or the boards' public APIs for OfferToday/LinkedIn). No ScraperAPI.
- **Per-user isolation:** RLS on all Supabase tables + user-keyed Redis + verified WebSocket auth → a user can only ever see their own jobs, runs, and counters.
- **No AI / no resume:** the pipeline is scrape-only. `fit`, `fit_score`, `cover_letter`, and resume fields are always `NULL`. No resume upload needed.
- **Error handling:** check `pipeline_runs.last_error` (run failures) and `jobs.status = failed` (per-job failures).

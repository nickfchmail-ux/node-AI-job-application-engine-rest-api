# Jobs Automation Platform — API Documentation

**Version:** 2.0 — Last updated 2026-08-19

This is the authoritative API reference for the Jobs Automation Platform backend. It covers all REST endpoints, WebSocket events, Supabase integration, and the data model.

> **Scrape-only pipeline.** The platform **scrapes and stores job listings only**. There is no AI fit scoring, cover-letter generation, or resume generation. `fit` / `fit_score` / `cover_letter` / `expected_salary` columns are stored as `NULL`. Per-job status (queued → processing → completed/failed) lives in Supabase `jobs.status` and streams via Realtime.

---

## Base URLs

| Service             | Base URL                                      | Auth                                     |
| ------------------- | --------------------------------------------- | ---------------------------------------- |
| **Express API**     | `https://ai-job-server.onrender.com`          | `Authorization: Bearer <JWT>`            |
| **Azure Functions** | `https://jobsautomation-fn.azurewebsites.net` | `x-functions-key: <key>`                 |
| **Supabase**        | `https://uqrgivzeklqehuqqqqyv.supabase.co`    | `apikey` + `Authorization: Bearer <JWT>` |
| **WebSocket**       | `wss://ai-job-server.onrender.com`            | `auth.token` on connect                  |

### Headers

- JSON requests use `Content-Type: application/json`.
- Authenticated requests use `Authorization: Bearer <access_token>`.
- Azure Function requests use `x-functions-key: <function_key>`.

---

## Data Model Overview

```
pipeline_runs  (1) ──< (N) jobs
```

| Table           | Purpose                                  | Owner column (RLS) |
| --------------- | ---------------------------------------- | ------------------ |
| `pipeline_runs` | A scrape run (keyword, boards, progress) | `user_id`          |
| `jobs`          | Each scraped job listing                 | `user_id`          |

> **Security:** RLS is enabled on all tables. Users can only SELECT/INSERT/UPDATE/DELETE rows where `user_id = auth.uid()`. The Azure service-role key bypasses RLS.

---

# A. Authentication

## `POST /auth/register`

Creates a user account.

**Request**

```json
{ "email": "user@example.com", "password": "YourPass123!" }
```

**201 Created**

```json
{ "id": "uuid", "email": "user@example.com" }
```

**400** — `{ "error": "..." }` if invalid/duplicate.

## `POST /auth/login`

Exchanges credentials for tokens.

**Request**

```json
{ "email": "user@example.com", "password": "YourPass123!" }
```

**200 OK**

```json
{
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "user": { "id": "uuid", "email": "user@example.com" }
}
```

**401** — `{ "error": "Invalid login credentials" }`

## `POST /auth/refresh`

Refreshes an expired access token.

**Request**

```json
{ "refresh_token": "eyJ..." }
```

**200 OK** — same shape as login (new tokens).
**401** — invalid/expired refresh token.

---

# B. Job Scraping (Azure Functions)

## `POST /api/scrape` — start a scrape run

Creates a `pipeline_run`, enqueues the scrape on Service Bus, returns immediately.

**Auth:** `x-functions-key: <scrape_key>`

**Request**
| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `keyword` | string | ✅ | — | Search keyword |
| `pages` | number | — | `1` | 1–5 pages per board |
| `boards` | string[] | — | `["jobsdb","ctgoodjobs"]` | Allowed: `jobsdb`, `ctgoodjobs`, `indeed`, `offertoday`, `linkedin` (all via Cloudflare proxy or public APIs) |
| `user_id` | string | ✅ | — | Owner UUID (must match the caller's user) |
| `country_code` | string | — | — | e.g. `hk` |

**202 Accepted**

```json
{
  "runId": "07b0cadf-83f8-4350-8d26-cde10aa8f36d",
  "messageId": "scrape-07b0cadf-...",
  "status": "queued",
  "pollUrl": "/api/runs/07b0cadf-..."
}
```

**Errors**
| Status | Meaning |
|--------|---------|
| 400 | invalid JSON / missing keyword |
| 401 | missing `user_id` |
| 500 | Service Bus enqueue failed (`{ error, detail }`) |

## `GET /api/runs/{runId}` — run status + job count

**Auth:** `x-functions-key: <key>`

**200 OK**

```json
{
  "run": {
    "id": "07b0cadf-...",
    "status": "processing",
    "keyword": "react developer",
    "total_jobs": 62,
    "processed_jobs": 40,
    "fit_jobs": 0,
    "failed_jobs": 0,
    "last_error": null
  },
  "jobsCount": 62,
  "statusLabel": "Scraping job details…"
}
```

**Errors:** 400 (missing id), 404 (not found), 500 (query failed).

### `status` → label mapping

| status       | statusLabel                    |
| ------------ | ------------------------------ |
| `queued`     | "In line…"                     |
| `scraping`   | "Searching the job boards…"    |
| `processing` | "Scraping job details…"        |
| `completed`  | "Done ✓"                       |
| `failed`     | "Something went wrong — retry" |
| `retrying`   | "Hitting a snag, retrying…"    |

## `POST /api/jobs/{id}/process` — (internal webhook)

Called by the Supabase Edge Function when a job row changes. **Not for frontend use.**

> Resume generation is **disabled** in the scrape-only pipeline — there is no `/api/jobs/{id}/generate-resume` flow and no `generated_resumes` table usage.

---

# C. Live Pipeline State (Express REST)

All endpoints require `Authorization: Bearer <user JWT>` and are scoped to the authenticated user only.

## `GET /stats/summary`

Aggregated funnel counters across **all** of the user's runs.

**200 OK**

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

## `GET /stats/runs`

All the user's runs, most recent first.

**200 OK**

```json
{
  "ok": true,
  "runs": [
    {
      "runId": "07b0cadf-...",
      "keyword": "react developer",
      "boards": ["jobsdb", "ctgoodjobs", "offertoday", "linkedin"],
      "createdAt": "2026-08-19T...",
      "counts": { "scraped": 62, "...": "funnel shape" }
    }
  ]
}
```

## `GET /stats/runs/:runId`

One run: funnel + per-board breakdown + metadata.

**200 OK**

```json
{
  "ok": true,
  "runId": "07b0cadf-...",
  "meta": { "keyword": "...", "boards": [...], "createdAt": "..." },
  "counts": { "scraped": 62, "...": "funnel shape" },
  "boards": {
    "jobsdb":     { "scraped": 30, "processing": 2 },
    "ctgoodjobs": { "scraped": 16, "processing": 1 },
    "offertoday": { "scraped": 10, "processing": 0 },
    "linkedin":   { "scraped": 9,  "processing": 1 }
  }
}
```

### Funnel counter reference

| Counter      | Type | Meaning                                                                                               |
| ------------ | ---- | ----------------------------------------------------------------------------------------------------- |
| `scraped`    | int  | Job listings discovered                                                                               |
| `duplicate`  | int  | Already-known (skipped)                                                                               |
| `unique`     | int  | Derived: `scraped - duplicate`                                                                        |
| `processing` | int  | Live counter: jobs currently being scraped/enriched (incremented on start, decremented on store/fail) |

Per-job terminal states (queued → processing → completed / failed) are not
tracked in Redis — they live in Supabase `jobs.status` and stream via Realtime.

**Errors:** `401` (missing/invalid token), `500` (`{ error }`).

---

# D. WebSocket (Live Push)

Connect once; the server pushes updates whenever Azure changes a counter.

## Connect

```js
import { io } from "socket.io-client";

const socket = io("wss://ai-job-server.onrender.com", {
  auth: { token: "<supabase access_token>" }, // REQUIRED
  transports: ["websocket"],
});
```

## Events

| Event           | Direction     | Payload                                 | Trigger                           |
| --------------- | ------------- | --------------------------------------- | --------------------------------- |
| `connect`       | server→client | —                                       | Connected                         |
| `stats:summary` | server→client | `{ ok: true, counts: <funnel> }`        | On connect + every counter change |
| `stats:run`     | server→client | `{ ok: true, runId, counts: <funnel> }` | Counter change for a run          |
| `connect_error` | server→client | `{ message }`                           | Auth failed                       |

## Error codes (`connect_error.message`)

| message                             | Meaning                         |
| ----------------------------------- | ------------------------------- |
| `unauthorized: missing token`       | No JWT provided                 |
| `unauthorized: invalid token`       | JWT not verifiable via Supabase |
| `unauthorized: verification failed` | Supabase unreachable            |

---

# E. Supabase (Database + Realtime + Storage)

## Client setup

```js
const supabase = createClient(
  "https://uqrgivzeklqehuqqqqyv.supabase.co",
  "<anon_key>",
);
supabase.auth.setSession({ access_token, refresh_token });
```

## Tables

### `jobs`

| Column                                   | Type        | Notes                                               |
| ---------------------------------------- | ----------- | --------------------------------------------------- |
| `id`                                     | uuid        | PK                                                  |
| `title`, `company`, `location`, `salary` | text        | Listing                                             |
| `url`                                    | text        | Job post                                            |
| `status`                                 | text        | `queued → processing → completed / failed`          |
| `board`                                  | text        | `jobsdb` / `ctgoodjobs` / `offertoday` / `linkedin` |
| `fit`                                    | boolean     | Always `NULL` (AI disabled)                         |
| `fit_score`                              | smallint    | Always `NULL` (AI disabled)                         |
| `fit_reasons`                            | jsonb       | Always `[]` (AI disabled)                           |
| `cover_letter`                           | text        | Always `NULL` (AI disabled)                         |
| `expected_salary`                        | text        | Always `NULL` (AI disabled)                         |
| `resume_status`                          | text        | Always `none` (resume generation disabled)          |
| `resume_url`                             | text        | Always `NULL`                                       |
| `resume_pdf_url`                         | text        | Always `NULL`                                       |
| `resume_error`                           | text        | Always `NULL`                                       |
| `user_id`                                | uuid        | Owner (RLS)                                         |
| `pipeline_run_id`                        | uuid        | Parent run                                          |
| `created_at` / `updated_at`              | timestamptz | Auto                                                |

### `pipeline_runs`

| Column                                                    | Type  | Notes                                                            |
| --------------------------------------------------------- | ----- | ---------------------------------------------------------------- |
| `id`                                                      | uuid  | PK                                                               |
| `keyword`, `search_key`                                   | text  | Search                                                           |
| `boards`                                                  | jsonb | Board list                                                       |
| `status`                                                  | text  | `queued → scraping → processing → completed / failed / retrying` |
| `total_jobs`, `processed_jobs`, `fit_jobs`, `failed_jobs` | int   | Progress (`fit_jobs` stays 0)                                    |
| `azure_run_id`                                            | text  | Service Bus message id                                           |
| `last_error`                                              | text  | Failure detail                                                   |
| `retry_count`                                             | int   |                                                                  |
| `user_id`                                                 | uuid  | Owner (RLS)                                                      |

> The `generated_resumes` table exists for backwards compatibility but is **not used** by the scrape-only pipeline.

## Realtime

RLS is enforced on Realtime — users only receive their own rows.

```js
supabase
  .channel("jobs")
  .on(
    "postgres_changes",
    { event: "*", schema: "public", table: "jobs" },
    (p) => console.log(p.new),
  )
  .subscribe();
```

Also subscribe to `pipeline_runs` the same way for live run status.

> **Storage buckets** (`resume` and `generated-resumes`) are part of the legacy AI resume feature and are **not used** by the scrape-only pipeline.

---

# F. Legacy Scraping (Express / BullMQ)

These are the original endpoints on the Express server (BullMQ-based). The Azure pipeline (§B) is the recommended path.

## `POST /scrape`

**Auth:** Bearer token.
**Request:** `{ keyword, pages?, force?, boards?, country_code? }`
**202:** `{ "jobId": "bullmq-id", "pollUrl": "/jobs/bullmq-id" }`
Duplicate submissions (same user+keyword active) return the existing `jobId` with a `note`.

## `GET /jobs/:jobId`

**Auth:** Bearer token.

- Running: `{ "status": "scraping", "logs": [...] }`
- Done: `{ "status": "done", "result": { total, fit, jobs: [...] } }`
- Failed: `{ "status": "error", "error": "...", "logs": [...] }`
- **403** if the job belongs to another user.

---

# G. Error Handling

### Standard error shapes

| Shape                                      | Used by                   |
| ------------------------------------------ | ------------------------- |
| `{ "error": "message" }`                   | Express + Azure endpoints |
| `{ "error": "message", "detail": "..." }`  | Azure 500s                |
| `{ "code": "PGRST...", "message": "..." }` | Supabase PostgREST        |

### Common status codes

| Code | Meaning                                 |
| ---- | --------------------------------------- |
| 200  | OK                                      |
| 201  | Created (register)                      |
| 202  | Accepted (scrape queued)                |
| 400  | Bad request / missing field             |
| 401  | Unauthorized (bad/missing token or key) |
| 403  | Forbidden (cross-user access)           |
| 404  | Not found                               |
| 500  | Internal error                          |
| 503  | Service unavailable (Redis down)        |

### Where to surface errors in the UI

- `pipeline_runs.last_error` — run failure (e.g. "All boards failed", "All scraped jobs already exist")
- `jobs.status = failed` — individual job scrape failure
- `connect_error.message` — WebSocket auth failure

---

# H. Integration Flow (Happy Path)

```
1. POST /auth/login                     → access_token
2. POST /api/scrape                     → runId
3. WebSocket connect (auth.token)       → live stats:summary / stats:run
4. Supabase Realtime (jobs / pipeline_runs) → live rows + per-job status
5. Read job details from jobs row (title, company, description, requirements, ...)
```

---

_For the frontend implementation task list (packages, code patterns, acceptance criteria), see `docs/FRONTEND_INTEGRATION_GUIDE.md`._

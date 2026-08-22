# Frontend Guide — Using the API & Configuring the State Display

> Give this to your frontend AI agent. It teaches two things:
> 1. **How to call the API** end-to-end (auth → start scrape → watch it run → browse jobs)
> 2. **How to configure the state display** (run status, per-board stages, per-job states, live funnel)
>
> All endpoints/payloads below match what is **actually deployed**. Boards: `jobsdb`, `ctgoodjobs`, `indeed`, `offertoday`, `linkedin`.

---

## 0. Environment variables

```env
NEXT_PUBLIC_SUPABASE_URL=https://uqrgivzeklqehuqqqqyv.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon_key_from_docs/FRONTEND_API.md>
NEXT_PUBLIC_API_SERVER=https://ai-job-server.onrender.com
NEXT_PUBLIC_AZURE_FN_URL=https://jobsautomation-fn.azurewebsites.net
# Server-side only (proxy route), never in the browser bundle:
AZURE_SCRAPE_KEY=<scrape-function-key>
```

**Security rule:** only the Supabase **anon key** is public. The Azure **function key** and Supabase **service key** must live in a backend proxy route (Next.js API route / your server), never `NEXT_PUBLIC_*`.

---

## 1. Auth (Supabase)

```ts
// lib/supabase.ts
import { createClient } from "@supabase/supabase-js";
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

// Register / login / refresh — standard Supabase:
await supabase.auth.signUp({ email, password });
await supabase.auth.signInWithPassword({ email, password });
// Keep the session: store access_token + refresh_token.
// On 401 from any endpoint → refresh → retry.
```

**You need the user's UUID** (`user.id` from `supabase.auth.getUser()` / the session) — pass it as `user_id` when starting a scrape.

---

## 2. Start a scrape (Azure Function, via your proxy route)

Because the function key is secret, proxy it:

```ts
// pages/api/scrape.ts (Next.js) — keep AZURE_SCRAPE_KEY server-side
export default async function handler(req, res) {
  const { keyword, pages, boards, user_id } = req.body;
  // verify the caller's JWT here (supabase.auth.getUser)
  const r = await fetch(`${process.env.NEXT_PUBLIC_AZURE_FN_URL}/api/scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-functions-key": process.env.AZURE_SCRAPE_KEY! },
    body: JSON.stringify({ keyword, pages, boards, user_id, country_code: "hk" }),
  });
  res.status(r.status).json(await r.json());
}
```

**Request body:**

| Field | Type | Notes |
|-------|------|-------|
| `keyword` | string | required, e.g. `"react developer"` |
| `pages` | number | 1–5 per board |
| `boards` | string[] | `["jobsdb","ctgoodjobs","indeed","offertoday","linkedin"]` |
| `user_id` | string | required — the authenticated user's UUID |
| `country_code` | string | `"hk"` |

**Response `202`:**

```json
{ "runId": "07b0cadf-...", "messageId": "scrape-...", "status": "queued", "pollUrl": "/api/runs/07b0cadf-..." }
```

**Save `runId`** — it ties everything together (pipeline_runs, jobs, run_boards).

---

## 3. Watch it run — the STATE DISPLAY (this is the core UI)

There are **two complementary live channels**. Use **both**:

### Channel A — Supabase Realtime (rows: run, jobs, boards) — RECOMMENDED

Subscribe once, no polling. RLS auto-filters to the user's own rows.

```ts
// The run's status + counters
supabase.channel(`run-${runId}`)
  .on("postgres_changes", { event: "*", schema: "public", table: "pipeline_runs", filter: `id=eq.${runId}` },
    (p) => setRun(p.new))
  .subscribe();

// The per-board stages (NEW — one row per board per run)
supabase.channel(`boards-${runId}`)
  .on("postgres_changes", { event: "*", schema: "public", table: "run_boards", filter: `run_id=eq.${runId}` },
    (p) => upsertBoard(p.new))
  .subscribe();

// The live job rows
supabase.channel(`jobs-${runId}`)
  .on("postgres_changes", { event: "*", schema: "public", table: "jobs", filter: `pipeline_run_id=eq.${runId}` },
    (p) => upsertJob(p.new))
  .subscribe();
```

### Channel B — WebSocket (live funnel counters) — optional but nice

```ts
import { io } from "socket.io-client";
const socket = io(process.env.NEXT_PUBLIC_API_SERVER!, {
  auth: { token: accessToken }, transports: ["websocket"],
});
socket.on("stats:summary", (d) => setFunnel(d.counts)); // { scraped, duplicate, unique, processing }
socket.on("stats:run", (d) => setRunFunnel(d.runId, d.counts));
```

---

## 4. The three state levels you must render

### 4.1 Run state — `pipeline_runs.status`

| Machine | User copy | Tone | Live |
|---------|-----------|------|------|
| `queued` | "In line…" | neutral | yes |
| `scraping` | "Searching the job boards…" | active | yes |
| `processing` | "Loading job details…" | active | yes |
| `completed` | "Done ✓" | success | no |
| `failed` | "Something went wrong — retry" | error | no |
| `retrying` | "Hitting a snag, retrying…" | active | yes |

`pipeline_runs` also has aggregate counters: `total_jobs`, `processed_jobs`, `failed_jobs`.

### 4.2 Per-board state — `run_boards.stage` (NEW)

| Stage | User copy | Meaning |
|-------|-----------|---------|
| `pending` | "Waiting…" | not started |
| `fetching` | "Searching…" | fetching search pages |
| `extracting` | "Reading listings…" | parsing cards |
| `blocked` | "Blocked — retrying…" | anti-bot/proxy blocked |
| `done` | "Done ✓" | listings extracted |
| `failed` | "Failed — retry" | board failed |

Per-board counters: `jobs_found`, `jobs_processed`, `jobs_failed`, `duplicate`, plus `last_error`.

**UI pattern — board chips:** render one chip per board, color by `stage`, show `jobsFound` count. This is how users see *which* board is slow (e.g. Indeed via ScraperAPI) vs done.

### 4.3 Per-job state — `jobs.status`

| Machine | User copy | Tone |
|---------|-----------|------|
| `discovered` / `queued` | "Found" / "In line" | neutral |
| `processing` | "Loading job details…" | active |
| `completed` | "Saved ✓" | success |
| `failed` | "Failed" | error |
| `duplicate` | "Already saved" | muted |

---

## 5. The job data contract (what to render per card)

Each `jobs` row already carries the **normalized quality contract** — render directly, no per-source branching:

| Field | Type | Notes |
|-------|------|-------|
| `title` | string | cleaned |
| `company` | string | `"N/A"`/missing → `"Unknown Company"` |
| `location` | string | default `"Hong Kong"` |
| `salary` | string \| null | display string, e.g. `"HK$30,000–HK$40,000 per month"` |
| `salary_min` / `salary_max` | int \| null | parsed range for sort/filter |
| `salary_currency` | string \| null | `HKD` etc. (inferred for HK boards) |
| `salary_period` | string \| null | `month`/`year`/`hour`/`day` |
| `posted_date` | string \| null | ISO `YYYY-MM-DD` |
| `responsibilities` / `requirements` / `benefits` / `skills` | jsonb | parsed from the full detail page |
| `data_quality` | jsonb | `{ completeness, has_salary, has_description, has_posted_date, has_location }` |
| `board` | string | source board key |
| `status` | string | see 4.3 |

**Rendering tips:**
- Sort by `salary_min DESC` or `posted_date DESC` directly.
- Badge `data_quality.has_salary === false` → "Salary not listed".
- `data_quality.completeness` → optional quality bar.

---

## 6. Initial fetch (REST fallback) — `GET /api/runs/{runId}`

Use this once on page load (before/alongside Realtime), or for a non-live fallback:

```ts
// server-side proxy (function key secret)
const r = await fetch(`${AZURE_FN_URL}/api/runs/${runId}?code=${AZURE_SCRAPE_KEY}`);
```

**Response `200`:**

```json
{
  "run": { "id": "...", "status": "processing", "total_jobs": 13, "processed_jobs": 5, "failed_jobs": 0, "boards": ["jobsdb","ctgoodjobs","indeed","offertoday","linkedin"] },
  "jobsCount": 13,
  "boards": {
    "jobsdb":     { "stage": "done", "jobsFound": 30, "jobsProcessed": 10, "jobsFailed": 0, "duplicate": 2, "pagesFetched": 1, "pagesTotal": 1, "displayName": "JobsDB HK" },
    "indeed":     { "stage": "fetching", "jobsFound": 0, "jobsProcessed": 0, "jobsFailed": 0, "duplicate": 0, "pagesFetched": 0, "pagesTotal": 1, "displayName": "Indeed HK", "lastError": null },
    "ctgoodjobs": { "stage": "done", "jobsFound": 18, "jobsProcessed": 8, "jobsFailed": 0, "duplicate": 0, "pagesFetched": 1, "pagesTotal": 1, "displayName": "CTgoodjobs HK" },
    "offertoday": { "stage": "done", "jobsFound": 10, "jobsProcessed": 10, "jobsFailed": 0, "duplicate": 0, "pagesFetched": 1, "pagesTotal": 1, "displayName": "Offer Today" },
    "linkedin":   { "stage": "done", "jobsFound": 10, "jobsProcessed": 10, "jobsFailed": 0, "duplicate": 0, "pagesFetched": 1, "pagesTotal": 1, "displayName": "LinkedIn HK" }
  },
  "statusLabel": "Loading job details…"
}
```

---

## 7. Recommended dashboard layout

```
┌────────────────────────────────────────────┐
│ ◀ My search: "react developer"     ● live  │  ← pipeline_runs.status (4.1)
│ ┌────────────────────────────────────────┐ │
│ │ Searching the job boards…              │ │  ← run status copy (statusLabel)
│ │ ▓ JobsDB ✓ 30   ▓ CTgoodjobs ✓ 18     │ │  ← run_boards chips (4.2)
│ │ ▓ Indeed ⏳      ▓ OfferToday ✓ 10     │ │
│ │ ▓ LinkedIn ✓ 10                       │ │
│ └────────────────────────────────────────┘ │
│ NEW THIS SEARCH (29)                        │
│ ┌─ Frontend Engineer ────────────────────┐ │  ← jobs rows (4.3 + §5)
│ │  Acme Ltd · HK · HKD 30–40k · Saved ✓ │ │
│ └────────────────────────────────────────┘ │
│ ┌─ Full-stack Dev ──────────────────────┐ │
│ │  Beta Co · HK · Loading job details…  │ │
│ └────────────────────────────────────────┘ │
└────────────────────────────────────────────┘
```

**Accessibility:** wrap live status text in `role="status"` / `aria-live="polite"`; color + text (never color alone); `prefers-reduced-motion` respected.

---

## 8. Acceptance criteria

1. Log in → start a scrape with boards → `runId` returned.
2. Run card transitions `queued → scraping → processing → completed` **without refresh** (Realtime).
3. Each board chip lights up per `run_boards.stage` and shows its found count.
4. Job rows stream in live and flip `processing → completed` (or `failed`).
5. Every job card renders the normalized contract (title/company/location/salary/date/skills) with **no per-board branching**.
6. Funnel (Scraped → Duplicate → Unique → Processing) updates live via WebSocket.
7. Empty/error states: no results, board blocked (chip shows "Blocked — retrying…"), run failed (retry button).

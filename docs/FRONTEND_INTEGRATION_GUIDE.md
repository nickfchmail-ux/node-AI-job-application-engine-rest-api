# FRONTEND AI — Integration Instructions (Jobs Automation Platform)

> **Give this file (or its contents) to your frontend AI agent.** It contains everything needed to integrate the Jobs Automation backend into the frontend: architecture, packages, exact code patterns, and acceptance criteria.
>
> Read `docs/FRONTEND_API.md` for the full API reference. This file is the **implementation task list**.

---

## 0. Context — what the backend does

The platform scrapes HK job boards (jobsdb, ctgoodjobs, offertoday, linkedin) via Azure Functions, **stores each scraped job** with its full parsed description in Supabase, and streams live progress to the frontend. There is **no AI** — no fit scoring, no cover letters, no resume generation.

**The frontend's job:** let the user log in, start a scrape, watch a **live funnel dashboard** (no polling), and browse the scraped jobs.

**Architecture (what you integrate against):**

```
Azure Functions (writes state) → Upstash Redis (counters) → Express server (Render)
   → WebSocket push → browser
Supabase (jobs, pipeline_runs) → Realtime → browser
```

---

## 1. Install these packages

```bash
# In your frontend project (assume Next.js / React)
npm install @supabase/supabase-js socket.io-client
```

---

## 2. Environment variables (`.env.local`)

```
NEXT_PUBLIC_SUPABASE_URL=https://uqrgivzeklqehuqqqqyv.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxcmdpdnpla2xxZWh1cXFxcXl2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0NDgwNjAsImV4cCI6MjA4ODAyNDA2MH0.NqayAccHCArnZK1T3Ws1l57-P_zMpTljOvv15jsGyi0
NEXT_PUBLIC_API_SERVER=https://ai-job-server.onrender.com
# The Azure scrape function key (ask the user for it, or use a proxy)
NEXT_PUBLIC_AZURE_FN_URL=https://jobsautomation-fn.azurewebsites.net
NEXT_PUBLIC_AZURE_SCRAPE_KEY=<scrape-function-key>
```

> ⚠️ **Never expose the service-role key.** Only the anon key is public. If you need to call the Azure scrape endpoint from the browser, keep the function key in a backend proxy route (see §4) or ask the user to add a CORS-friendly proxy.

---

## 3. Auth — build the login/register flow

Create an auth context that wraps the app:

```tsx
// lib/supabase.ts
import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);
```

```tsx
// lib/auth.tsx — React context
import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "./supabase";
import type { Session } from "@supabase/supabase-js";

const AuthCtx = createContext<{ session: Session | null; loading: boolean }>({
  session: null,
  loading: true,
});

export const AuthProvider = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);
  return (
    <AuthCtx.Provider value={{ session, loading }}>{children}</AuthCtx.Provider>
  );
};

export const useAuth = () => useContext(AuthCtx);
```

**Pages:** `/login`, `/register`. Use `supabase.auth.signInWithPassword` / `signUp`. Store the session automatically (Supabase persists it).

> **No resume upload needed.** The pipeline is scrape-only — there is no resume upload step.

---

## 4. Start a scrape

Call the Azure function. **Recommended:** proxy through your own backend route so the function key isn't in the browser bundle:

```ts
// pages/api/scrape.ts (Next.js API route — keeps the key server-side)
export default async function handler(req, res) {
  const { keyword, pages, boards } = req.body;
  // Verify the user's JWT here (supabase.auth.getUser)
  const r = await fetch(`${process.env.NEXT_PUBLIC_AZURE_FN_URL}/api/scrape`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-functions-key": process.env.AZURE_SCRAPE_KEY!, // server-side only
    },
    body: JSON.stringify({ keyword, pages, boards, user_id: req.user.id }),
  });
  res.status(r.status).json(await r.json());
}
```

Response → `{ runId, status: "queued", pollUrl }`. **Store `runId`** — it ties everything together.

---

## 5. LIVE funnel dashboard (the core UI) — WebSocket, NO polling

Connect Socket.io once with the user's JWT, subscribe to events, and render the funnel:

```tsx
// lib/liveStats.ts
import { io } from "socket.io-client";
import { useAuth } from "./auth";

export function useLiveStats() {
  const { session } = useAuth();
  const [stats, setStats] = useState<StatsPayload | null>(null);

  useEffect(() => {
    if (!session?.access_token) return;
    const socket = io(process.env.NEXT_PUBLIC_API_SERVER!, {
      auth: { token: session.access_token },
      transports: ["websocket"],
    });
    // ONE event carries everything: summary + run + boards + status.
    socket.on("stats", (d: StatsPayload) => setStats(d));
    return () => socket.disconnect();
  }, [session?.access_token]);

  return stats;
}
```

**Render the funnel (logically related numbers):**

```
Scraped (62)
 ├─ Duplicates (34)  ← already-known, skipped
 └─ Unique (28)
     └─ Processing (3)   ← detail-scrape / enriching now
```

Per-job terminal states (queued → processing → completed / failed / retrying)
are not in these counters — they live in Supabase `jobs.status` and stream via
Realtime.

**Use a funnel/stepper visual.** The `stats` payload you receive:

```json
{
  "ok": true,
  "summary": { "scraped": 200, "duplicate": 120, "unique": 80, "processing": 3 },
  "runId": "07b0cadf-...",
  "counts": { "scraped": 62, "duplicate": 34, "unique": 28, "processing": 3 },
  "boards": { "jobsdb": { "stage": "done", "jobsFound": 30, "...": "" } },
  "status": "processing",
  "statusLabel": "Loading job details…"
}
```

**Acceptance criteria:** numbers update LIVE as jobs process — no refresh, no polling. Per-board breakdown is inside the same `stats` event (`boards` key).

---

## 6. Job list — Supabase Realtime (live rows)

Subscribe to row changes for the current user (RLS auto-filters):

```tsx
useEffect(() => {
  const ch = supabase
    .channel("jobs")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "jobs" },
      (payload) => {
        // upsert payload.new into your jobs list state
        setJobs((prev) => upsertJob(prev, payload.new));
      },
    )
    .subscribe();
  return () => supabase.removeChannel(ch);
}, []);
```

Also subscribe to `pipeline_runs` the same way for live run status.

**Job card shows:** title, company, board badge, location/salary, status chip, and (in a detail view) the parsed description: responsibilities, requirements, benefits, skills, employment type, experience level.

**Status chips per job (`job.status`):**
| value | chip |
|-------|------|
| queued / processing | ⏳ Scraping details… |
| completed | ✅ Saved |
| failed | ❌ Failed |

---

## 7. Full page structure to build

1. **`/login`** + **`/register`** — Supabase auth
2. **`/dashboard`** —
   - Search bar (keyword + pages + board checkboxes) → POST /api/scrape
   - **Live funnel** (from WebSocket)
   - **Active runs list** (from `GET /stats/runs` + WS `stats`)   
   - **Live jobs table** (from Supabase Realtime)
3. **Job detail modal** — description, responsibilities, requirements, benefits, skills

---

## 8. Acceptance checklist (verify before done)

- [ ] User can register + login; tokens auto-refresh
- [ ] User starts a scrape → gets a `runId`
- [ ] **Dashboard funnel updates live** via WebSocket (scraped → duplicate → unique → processing)
- [ ] Jobs appear in the list **live** via Supabase Realtime
- [ ] Job detail shows the parsed description (responsibilities, requirements, benefits, skills)
- [ ] **Per-user isolation:** logging in as a different user shows ZERO of another user's data
- [ ] No polling anywhere (WebSocket + Realtime only)
- [ ] Works on mobile (responsive funnel)

---

## 9. Gotchas / important notes

- **Boards allowed:** `jobsdb`, `ctgoodjobs`, `offertoday`, `linkedin`, `indeed`. All routed through the **Cloudflare proxy** (or public APIs for OfferToday/LinkedIn). No ScraperAPI.
- **Don't expose the Azure function key or Supabase service key in the client bundle.** Use a backend proxy route for anything needing a secret.
- **Duplicate scrapes are auto-blocked** — if a user re-submits the same keyword while one is running, the backend returns the existing run.
- **No AI / no resume:** fit scores, cover letters, and resumes are **not generated**. `fit`, `fit_score`, `cover_letter` and resume fields are always `NULL`.
- **Error surfacing:** show `pipeline_runs.last_error` (run failures) and `jobs.status = failed` (per-job failures).
- **The WebSocket requires the JWT in `auth.token`** — if the token expires mid-session, reconnect after refresh.

---

_If the frontend AI needs exact response shapes or more endpoint detail, point it to `docs/FRONTEND_API.md` in this repo._

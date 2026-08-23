# Frontend — Using the WebSocket (Socket.io) Live Updates

> Give this to your frontend AI agent. It teaches **exactly** how to connect to the
> Jobs Automation WebSocket and render the live funnel — matching the deployed
> backend (`src/wsPush.ts`).
>
> **Package:** `socket.io-client`
> **Server:** `https://ai-job-server.onrender.com`
> **Purpose:** the user sees live `Scraped → Duplicate → Unique → Processing`
> counters, the run status, AND per-board chips update in real time with
> **zero polling** — all from a SINGLE event.

---

## 1. The contract (from `src/wsPush.ts`)

| Item              | Value                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| Connect auth      | `socket.handshake.auth.token` = the **Supabase access token** (JWT)                                           |
| Auth verification | Server verifies the JWT via `supabase.auth.getUser(token)` — a forged token is rejected                       |
| Scoping           | Each socket joins room `user:{userId}` — **you only ever receive your own data**                              |
| Event: `stats`    | **THE one event** — carries summary + run + boards + status in a single flat object. Sent on connect AND on every change |
| `connect_error`   | `{ message }` — auth failed (missing/invalid token)                                                           |

> **Simplified contract (2026-08-23):** the old `stats:summary` / `stats:run` /
> `stats:boards` events are **gone**. The server now emits **one** `stats` event
> that bundles everything the dashboard needs into a single object. One listener,
> one state update — no more juggling three payloads.

**The single payload shape (`stats`):**

```ts
type Funnel = {
  scraped: number; // total listings discovered
  duplicate: number; // already-known, skipped
  unique: number; // scraped - duplicate (clamped ≥ 0)
  processing: number; // jobs currently being detail-scraped/enriched (live)
};

type StatsPayload = {
  ok: boolean;
  summary: Funnel; // aggregated across all the user's runs
  runId: string | null; // the current / most-recent run id
  counts: Funnel; // this run's funnel counters
  boards: Record<string, BoardState>; // per-board live state
  status: string | null; // run status: queued|scraping|processing|completed|failed|retrying
  statusLabel: string | null; // human copy ("Searching the job boards…")
};

type BoardState = {
  // Live counters (Redis — update continuously while a run is in progress)
  scraped: number; // listings found on this board
  duplicate: number; // duplicates from this board
  unique: number; // scraped - duplicate on this board
  processing: number; // jobs from this board currently enriching (live)

  // Search stage (Supabase run_boards — authoritative "is it done?" answer)
  stage: string; // "pending" | "fetching" | "extracting" | "blocked" | "done" | "failed"
  pagesFetched: number; // search pages successfully fetched
  pagesTotal: number; // search pages requested
  jobsFound: number; // listings extracted from this board
  jobsProcessed: number; // jobs fully stored
  jobsFailed: number; // jobs that failed to process
  lastError: string | null; // anti-bot / proxy failure detail (when blocked/failed)
  displayName: string; // "JobsDB", "CTgoodjobs", "Indeed", ...
};
```

**Stage → UI mapping (the key answer):**

| `stage`      | Meaning              | Chip state                                                   |
| ------------ | -------------------- | ------------------------------------------------------------ |
| `pending`    | not started yet      | grey "Waiting…"                                              |
| `fetching`   | searching pages now  | amber spinner "Searching…"                                   |
| `extracting` | parsing listings now | amber spinner "Extracting…"                                  |
| `done`       | search finished      | green "✓ Done" (N found)                                     |
| `blocked`    | anti-bot/proxy hit   | red "⚠ Blocked — retrying" (show `lastError`)                |
| `failed`     | search failed        | red "✗ Failed" (show `lastError`)                            |

**Status → copy mapping (`statusLabel`):**

| `status`      | `statusLabel`                  |
| ------------- | ------------------------------ |
| `queued`      | "In line…"                     |
| `scraping`    | "Searching the job boards…"    |
| `processing`  | "Loading job details…"         |
| `completed`   | "Done ✓"                       |
| `failed`      | "Something went wrong — retry" |
| `retrying`    | "Hitting a snag, retrying…"    |

---

## 2. Connect (React example)

```tsx
// lib/useLiveStats.ts
import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { useAuth } from "./auth"; // your Supabase session context

export function useLiveStats() {
  const { session } = useAuth();
  // ONE state object — the server sends everything in a single `stats` event.
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!session?.access_token) return; // wait until logged in

    const socket = io(process.env.NEXT_PUBLIC_API_SERVER!, {
      auth: { token: session.access_token }, // REQUIRED — server verifies this
      transports: ["websocket"], // force WebSocket, no polling fallback
    });
    socketRef.current = socket;

    socket.on("connect", () => console.log("ws connected"));
    // ONE listener — `stats` carries summary + run + boards + status.
    socket.on("stats", (d: StatsPayload) => {
      setStats(d);
    });
    socket.on("connect_error", (err) => {
      // e.g. token expired → refresh the token and reconnect
      console.error("ws connect_error:", err.message);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [session?.access_token]); // reconnect when the token changes

  return stats;
}
```

Then derive the pieces you need:

```tsx
const stats = useLiveStats();
const summary = stats?.summary;   // { scraped, duplicate, unique, processing } — all runs
const runCounts = stats?.counts;  // this run's funnel
const boards = stats?.boards;     // { jobsdb: { stage, jobsFound, ... }, ... }
const statusLabel = stats?.statusLabel; // "Searching the job boards…"
```

---

## 3. Render the funnel

```tsx
function Funnel({ counts }: { counts: Funnel }) {
  return (
    <div role="status" aria-live="polite">
      {" "}
      {/* announce live changes */}
      <div>
        Scraped <b>{counts.scraped}</b>
      </div>
      <div>
        Duplicates <b>{counts.duplicate}</b>
      </div>
      <div>
        Unique <b>{counts.unique}</b>
      </div>
      <div>
        Processing <b>{counts.processing}</b>
      </div>
    </div>
  );
}
```

**Semantics to display:**

- `scraped` = listings found across all boards
- `duplicate` = already saved (deduped) — grey/muted
- `unique` = `scraped - duplicate` — the "new" number
- `processing` = **live** — jobs currently being enriched; should pulse/spinner

> The funnel is a **roll-up**. For per-job granularity (each job's
> queued → processing → completed), use **Supabase Realtime on `jobs`**
> (see `docs/FRONTEND_GUIDE.md`). For per-board stages, use Realtime on `run_boards`.

**When does the socket push?** Azure fires the webhook on:

- every **counter** change (scraped/duplicate/processing), and
- every **board stage** change (fetching → extracting → done | blocked | failed).

So a board chip goes `Waiting… → Searching… → ✓ Done` live, with no polling.
The very first push for a new run happens the moment the first board starts
`fetching` — before that the chips legitimately show `Waiting for status…`.

---

## 3b. Render per-board chips (from the unified `stats.boards`)

The socket carries **per-board** live state — both the live counters AND
the search stage (`pending → fetching → extracting → done | blocked | failed`).
You can render one chip per job board and show exactly **whether each board's
search is done or still processing** — all from the same `stats` event.

```tsx
// Each board chip shows: name, search stage, and live count.
// stage tells the user if THIS board's search is done or still working.
// - boards = stats.boards (from the single `stats` event)
// - "Waiting…" = the board is pending (queued, not yet started)
function BoardChip({ b }: { b: BoardState }) {
  const stageMeta: Record<string, { label: string; cls: string }> = {
    pending: { label: "Waiting…", cls: "chip-pending" },
    fetching: { label: "Searching…", cls: "chip-busy" },
    extracting: { label: "Extracting…", cls: "chip-busy" },
    done: { label: "✓ Done", cls: "chip-done" },
    blocked: { label: "⚠ Blocked", cls: "chip-error" },
    failed: { label: "✗ Failed", cls: "chip-error" },
  };
  const meta = stageMeta[b.stage] ?? stageMeta.pending;

  return (
    <div className={`board-chip ${meta.cls}`}>
      <span className="board-name">{b.displayName}</span>
      <span className="board-stage">{meta.label}</span>
      {b.stage === "done" && (
        <span className="board-count">{b.jobsFound} found</span>
      )}
      {b.stage === "blocked" && b.lastError && (
        <span className="board-error" title={b.lastError}>
          {b.lastError.slice(0, 40)}…
        </span>
      )}
    </div>
  );
}

// stats.boards is a plain object — render one chip per board.
function BoardChips({ boards }: { boards: Record<string, BoardState> | undefined }) {
  if (!boards) {
    return <div className="board-chips">Waiting for status…</div>;
  }
  const entries = Object.entries(boards);
  if (entries.length === 0) return null;

  return (
    <div role="status" aria-live="polite" className="board-chips">
      {entries.map(([board, b]) => (
        <BoardChip key={board} b={b} />
      ))}
    </div>
  );
}
```

Wire it into the hook:

```tsx
const stats = useLiveStats();
// stats.boards → { jobsdb: { scraped, stage, jobsFound, lastError, ... }, ... }
// stats.statusLabel → "Searching the job boards…"
```

**Semantics:**

- `stage` is the **authoritative answer** to "is this board's search done?":
  `fetching`/`extracting` = still searching (spinner), `done` = finished, `blocked`/`failed` = error
- `scraped` / `processing` per board = live Redis counters (update continuously)
- `jobsFound` per board = total listings extracted once the board is `done`
- `lastError` per board = why it got `blocked`/`failed` (e.g. "anti-bot challenge", "timeout")
- A board stuck on `fetching` for a long time while others are `done` = **slow** (likely proxy fallback); keep the spinner visible

---

## 4. Token refresh / reconnection

- On `connect_error` with an auth message, refresh the token and reconnect:
  ```ts
  const { data } = await supabase.auth.refreshSession();
  socket.auth = { token: data.session.access_token };
  socket.connect();
  ```
- The `useEffect` dependency `[session?.access_token]` already tears down and
  reconnects with the new token automatically.

---

## 5. Acceptance criteria

1. After login, the socket connects and the `stats` event fires immediately (no fetch needed).
2. While a scrape runs, the `stats` event updates the funnel live (`summary`, `counts`, `boards`, `statusLabel` all in one payload).
3. A logged-out / expired-token client gets `connect_error` and the UI shows a friendly "reconnecting…".
4. On connect, `stats.boards` is populated for the latest run — the board chips render immediately.
5. While a run is in progress, `stats.boards` updates each board chip as Azure bumps per-board counters.
6. Each board chip shows its **search stage** (`fetching`/`extracting` = spinner, `done` = ✓, `blocked`/`failed` = error + `lastError`) — so the user can see _which boards have finished searching and which are still working_.
7. A user **never** sees another user's counters (room-scoped by verified JWT).
8. The funnel is one source of truth for totals; per-job/per-board detail comes from Supabase Realtime.
9. The frontend listens to exactly **one** event (`stats`) — no `stats:summary` / `stats:run` / `stats:boards` listeners remain.

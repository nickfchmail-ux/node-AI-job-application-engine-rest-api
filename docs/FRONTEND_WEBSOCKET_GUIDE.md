# Frontend — Using the WebSocket (Socket.io) Live Updates

> Give this to your frontend AI agent. It teaches **exactly** how to connect to the
> Jobs Automation WebSocket and render the live funnel — matching the deployed
> backend (`src/wsPush.ts`).
>
> **Package:** `socket.io-client`
> **Server:** `https://ai-job-server.onrender.com`
> **Purpose:** the user sees live `Scraped → Duplicate → Unique → Processing`
> counters update in real time with **zero polling**.

---

## 1. The contract (from `src/wsPush.ts`)

| Item | Value |
|------|-------|
| Connect auth | `socket.handshake.auth.token` = the **Supabase access token** (JWT) |
| Auth verification | Server verifies the JWT via `supabase.auth.getUser(token)` — a forged token is rejected |
| Scoping | Each socket joins room `user:{userId}` — **you only ever receive your own counters** |
| Event: `stats:summary` | `{ ok: true, counts: <funnel> }` — sent on connect AND on every counter change |
| Event: `stats:run` | `{ ok: true, runId, counts: <funnel> }` — sent for a specific run when its counters change |
| Event: `stats:boards` | `{ ok: true, runId, boards: <per-board> }` — sent with each `stats:run`, and on connect for the latest run. **Per-board live state** |
| `connect_error` | `{ message }` — auth failed (missing/invalid token) |

**The funnel shape (all events):**

```ts
type Funnel = {
  scraped: number;      // total listings discovered
  duplicate: number;    // already-known, skipped
  unique: number;       // scraped - duplicate (clamped ≥ 0)
  processing: number;   // jobs currently being detail-scraped/enriched (live)
};
```

**Per-board shape (`stats:boards`):** each board key is one of
`jobsdb`, `ctgoodjobs`, `indeed`, `offertoday`, `linkedin`.

```ts
type BoardState = {
  // Live counters (Redis — update continuously while a run is in progress)
  scraped: number;      // listings found on this board
  duplicate: number;    // duplicates from this board
  unique: number;       // scraped - duplicate on this board
  processing: number;   // jobs from this board currently enriching (live)

  // Search stage (Supabase run_boards — authoritative "is it done?" answer)
  stage: string;        // "pending" | "fetching" | "extracting" | "blocked" | "done" | "failed"
  pagesFetched: number; // search pages successfully fetched
  pagesTotal: number;   // search pages requested
  jobsFound: number;    // listings extracted from this board
  jobsProcessed: number;// jobs fully stored
  jobsFailed: number;   // jobs that failed to process
  lastError: string | null; // anti-bot / proxy failure detail (when blocked/failed)
  displayName: string;  // "JobsDB", "CTgoodjobs", "Indeed", ...
};

type Boards = Record<string, BoardState>;
```

**Stage → UI mapping (the key answer):**

| `stage` | Meaning | Chip state |
|---------|---------|-----------|
| `pending` | not started yet | grey "Waiting…" |
| `fetching` | searching pages now | amber spinner "Searching…" |
| `extracting` | parsing listings now | amber spinner "Extracting…" |
| `done` | search finished | green "✓ Done" (N found) |
| `blocked` | anti-bot/proxy hit | red "⚠ Blocked — retrying via ScraperAPI" (show `lastError`) |
| `failed` | search failed | red "✗ Failed" (show `lastError`) |

---

## 2. Connect (React example)

```tsx
// lib/useLiveStats.ts
import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { useAuth } from "./auth"; // your Supabase session context

export function useLiveStats() {
  const { session } = useAuth();
  const [summary, setSummary] = useState<Funnel | null>(null);
  const [runs, setRuns] = useState<Record<string, Funnel>>({});
  const [boards, setBoards] = useState<Record<string, Boards | null>>({});
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!session?.access_token) return; // wait until logged in

    const socket = io(process.env.NEXT_PUBLIC_API_SERVER!, {
      auth: { token: session.access_token }, // REQUIRED — server verifies this
      transports: ["websocket"],             // force WebSocket, no polling fallback
    });
    socketRef.current = socket;

    socket.on("connect", () => console.log("ws connected"));
    socket.on("stats:summary", (d: { ok: boolean; counts: Funnel }) => {
      setSummary(d.counts);
    });
    socket.on("stats:run", (d: { ok: boolean; runId: string; counts: Funnel }) => {
      setRuns((prev) => ({ ...prev, [d.runId]: d.counts }));
    });
    socket.on("stats:boards", (d: { ok: boolean; runId: string; boards: Boards }) => {
      // per-board live state keyed by runId
      setBoards((prev) => ({ ...prev, [d.runId]: d.boards }));
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

  return { summary, runs, boards };
}
```

---

## 3. Render the funnel

```tsx
function Funnel({ counts }: { counts: Funnel }) {
  return (
    <div role="status" aria-live="polite"> {/* announce live changes */}
      <div>Scraped <b>{counts.scraped}</b></div>
      <div>Duplicates <b>{counts.duplicate}</b></div>
      <div>Unique <b>{counts.unique}</b></div>
      <div>Processing <b>{counts.processing}</b></div>
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

## 3b. Render per-board chips (NEW — from `stats:boards`)

The socket now carries **per-board** live state — both the live counters AND
the search stage (`pending → fetching → extracting → done | blocked | failed`).
You can render one chip per job board and show exactly **whether each board's
search is done or still processing** — all from the same socket.

```tsx
// Each board chip shows: name, search stage, and live count.
// stage tells the user if THIS board's search is done or still working.
// - "Waiting for status…" = we haven't received stats:boards for this run yet
//   (only happens for the first moment of a brand-new run — Azure pushes
//   as soon as the first board starts "fetching")
// - "Waiting…"            = the board is pending (queued, not yet started)
function BoardChip({ b }: { b: BoardState }) {
  const stageMeta: Record<string, { label: string; cls: string }> = {
    pending:    { label: "Waiting…",       cls: "chip-pending" },
    fetching:   { label: "Searching…",     cls: "chip-busy" },
    extracting: { label: "Extracting…",    cls: "chip-busy" },
    done:       { label: "✓ Done",         cls: "chip-done" },
    blocked:    { label: "⚠ Blocked",      cls: "chip-error" },
    failed:     { label: "✗ Failed",       cls: "chip-error" },
  };
  const meta = stageMeta[b.stage] ?? stageMeta.pending;

  return (
    <div className={`board-chip ${meta.cls}`}>
      <span className="board-name">{b.displayName}</span>
      <span className="board-stage">{meta.label}</span>
      {b.stage === "done" && <span className="board-count">{b.jobsFound} found</span>}
      {b.stage === "blocked" && b.lastError && (
        <span className="board-error" title={b.lastError}>
          {b.lastError.slice(0, 40)}…
        </span>
      )}
    </div>
  );
}

// If the socket hasn't delivered stats:boards yet (very first moment of a run),
// render a neutral placeholder so the user knows we're waiting on the backend:
function BoardChips({ boards }: { boards: Boards | null }) {
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
const { summary, runs, boards } = useLiveStats();
// boards["<runId>"] → { jobsdb: { scraped, stage, jobsFound, lastError, ... }, ... }
```

**Semantics:**
- `stage` is the **authoritative answer** to "is this board's search done?":
  `fetching`/`extracting` = still searching (spinner), `done` = finished, `blocked`/`failed` = error
- `scraped` / `processing` per board = live Redis counters (update continuously)
- `jobsFound` per board = total listings extracted once the board is `done`
- `lastError` per board = why it got `blocked`/`failed` (e.g. "anti-bot challenge", "timeout")
- A board stuck on `fetching` for a long time while others are `done` = **slow** (likely ScraperAPI fallback); keep the spinner visible

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

1. After login, the socket connects and `stats:summary` fires immediately (no fetch needed).
2. While a scrape runs, `stats:summary` / `stats:run` update the funnel live.
3. A logged-out / expired-token client gets `connect_error` and the UI shows a friendly "reconnecting…".
4. On connect, `stats:boards` fires for the latest run — the board chips render immediately.
5. While a run is in progress, `stats:boards` updates each board chip as Azure bumps per-board counters.
6. Each board chip shows its **search stage** (`fetching`/`extracting` = spinner, `done` = ✓, `blocked`/`failed` = error + `lastError`) — so the user can see *which boards have finished searching and which are still working*.
7. A user **never** sees another user's counters (room-scoped by verified JWT).
8. The funnel is one source of truth for totals; per-job/per-board detail comes from Supabase Realtime.

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
type Boards = Record<
  string,
  {
    scraped: number;    // listings found on this board
    duplicate: number;  // duplicates from this board
    unique: number;     // scraped - duplicate on this board
    processing: number; // jobs from this board currently processing
  }
>;
```

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

---

## 3b. Render per-board chips (NEW — from `stats:boards`)

The socket now carries **per-board** live state, so you can render one chip per
job board and see which board is slow/blocked/fast — all from the same socket.

```tsx
const BOARD_LABELS: Record<string, string> = {
  jobsdb: "JobsDB",
  ctgoodjobs: "CTgoodjobs",
  indeed: "Indeed",
  offertoday: "OfferToday",
  linkedin: "LinkedIn",
};

function BoardChips({ boards }: { boards: Boards | null }) {
  if (!boards) return null;
  const entries = Object.entries(boards);
  if (entries.length === 0) return null;

  return (
    <div role="status" aria-live="polite" className="board-chips">
      {entries.map(([board, b]) => (
        <div key={board} className="board-chip">
          <span className="board-name">{BOARD_LABELS[board] ?? board}</span>
          <span className="board-count">{b.scraped} found</span>
          {b.processing > 0 && <span className="board-spinner">⟳ {b.processing}</span>}
        </div>
      ))}
    </div>
  );
}
```

Wire it into the hook:

```tsx
const { summary, runs, boards } = useLiveStats();
// boards["<runId>"] → { jobsdb: {...}, indeed: {...}, ... }
```

**Semantics:**
- `scraped` per board = listings found from that board
- `processing` per board = jobs from that board still enriching — show a spinner
- `duplicate` per board = deduped from that board — grey
- `unique` per board = `scraped - duplicate`
- A board with `scraped: 0` while others have numbers = **blocked/slow** (fallback to ScraperAPI); highlight it in amber to draw the eye.

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
4. A user **never** sees another user's counters (room-scoped by verified JWT).
5. The funnel is one source of truth for totals; per-job/per-board detail comes from Supabase Realtime.

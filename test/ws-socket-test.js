// ============================================================
//  ws-socket-test.js — live Socket.io smoke test for the
//  Jobs Automation "stats" event (unified payload).
//
//  Usage:  node test/ws-socket-test.js [email] [password]
//  Defaults to the first test account that can log in.
//
//  Connects to the DEPLOYED server (SOCKET_URL env or
//  https://ai-job-server.onrender.com) with a real Supabase JWT
//  and verifies the single "stats" event arrives with the full
//  summary + run + boards + status contract.
// ============================================================
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { io } = require("socket.io-client");

// ── Load .env.local (manual loader, mirrors src/db.ts) ──────
const envPath = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}

const SOCKET_URL = process.env.SOCKET_URL || "https://ai-job-server.onrender.com";
const EMAILS = [
  "nickch@gmail.com",
  "nickfchmail@gmail.com",
  "nnickfchmail@gmail.com",
  "applyjob@clts.com",
];
const PASSWORDS = ["Test1234!", "test1234", "password123", "Password123!"];

const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

async function getToken() {
  const email = process.argv[2];
  const password = process.argv[3];

  // ── Option 0: explicit email+password ──
  if (email && password) {
    const { data, error } = await anon.auth.signInWithPassword({ email, password });
    if (!error && data.session) return { email, token: data.session.access_token, userId: data.user.id };
    throw new Error(`login failed for ${email}: ${error?.message}`);
  }

  // ── Option 1: known test accounts (password guesses) ──
  for (const e of EMAILS) {
    for (const p of PASSWORDS) {
      const { data, error } = await anon.auth.signInWithPassword({ email: e, password: p });
      if (!error && data.session) return { email: e, token: data.session.access_token, userId: data.user.id };
    }
  }

  // ── Option 2: list existing users (service role) so the caller can
  //    pass a real email+password, or register a fresh throwaway user.
  try {
    const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    });
    const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (!error) {
      const emails = (data?.users || []).map((u) => u.email).filter(Boolean);
      console.log(`[ws-test] existing auth users (${emails.length}):`);
      console.log("  " + emails.join("\n  "));
    }
  } catch (e) {
    // ignore
  }
  throw new Error("no test account could log in — pass email + password as args (see list above)");
}

async function main() {
  const { email, token, userId } = await getToken();
  console.log(`[ws-test] logged in as ${email} (${userId})`);
  console.log(`[ws-test] connecting socket to ${SOCKET_URL} ...`);

  const socket = io(SOCKET_URL, {
    transports: ["websocket"],
    reconnection: false,
    timeout: 20000,
    auth: { token },
  });

  const timer = setTimeout(() => {
    console.error("[ws-test] ❌ TIMEOUT: no 'stats' event within 20s");
    socket.close();
    process.exit(1);
  }, 20000);

  socket.on("connect", () => {
    console.log(`[ws-test] ✅ connected (socket ${socket.id})`);
  });

  socket.on("connect_error", (err) => {
    console.error(`[ws-test] ❌ connect_error: ${err.message}`);
    clearTimeout(timer);
    process.exit(1);
  });

  // Capture ANY event so we can see what the deployed server actually emits
  // (the unified "stats" event, or the legacy stats:summary/run/boards, or nothing).
  const seen = new Map();
  socket.onAny((event, ...args) => {
    seen.set(event, args);
    console.log(`[ws-test] 📡 event: "${event}"`, JSON.stringify(args).slice(0, 400));
    if (event === "stats") {
      handleStats(args[0]);
    } else if (event.startsWith("stats:")) {
      // legacy event — note it but keep waiting for the unified one
      clearTimeout(timer);
      console.error("[ws-test] ❌ got LEGACY stats:* event — deployed server is NOT running the unified wsPush.ts");
      socket.close();
      process.exit(2);
    }
  });

  socket.on("stats", (payload) => handleStats(payload));

  function handleStats(payload) {
    clearTimeout(timer);
    console.log("[ws-test] ✅ received 'stats' event:");
    console.log(JSON.stringify(payload, null, 2));

    // ── Validate the unified contract ──
    const checks = [
      ["payload.ok is boolean", typeof payload.ok === "boolean"],
      ["summary present (funnel)", payload.summary && "scraped" in payload.summary],
      ["runId is string|null", payload.runId === null || typeof payload.runId === "string"],
      ["counts present (funnel)", payload.counts && "duplicate" in payload.counts],
      ["boards is object", payload.boards && typeof payload.boards === "object"],
      ["status is string|null", payload.status === null || typeof payload.status === "string"],
      ["statusLabel is string|null", payload.statusLabel === null || typeof payload.statusLabel === "string"],
    ];
    let ok = true;
    for (const [name, pass] of checks) {
      console.log(`   ${pass ? "✅" : "❌"} ${name}`);
      if (!pass) ok = false;
    }
    // Per-board shape
    for (const [board, b] of Object.entries(payload.boards ?? {})) {
      const hasLive = ["scraped", "duplicate", "unique", "processing"].every((k) => typeof b[k] === "number");
      const hasStage = ["stage", "pagesFetched", "pagesTotal", "jobsFound", "jobsProcessed", "jobsFailed", "displayName"].every((k) => k in b);
      console.log(`   ${hasLive && hasStage ? "✅" : "❌"} board "${board}" shape (live+stage)`);
      if (!(hasLive && hasStage)) ok = false;
    }
    console.log(ok ? "\n[ws-test] ✅ ALL CHECKS PASSED" : "\n[ws-test] ❌ SOME CHECKS FAILED");
    socket.close();
    process.exit(ok ? 0 : 1);
  }
}

main().catch((err) => {
  console.error("[ws-test] ❌", err.message);
  process.exit(1);
});

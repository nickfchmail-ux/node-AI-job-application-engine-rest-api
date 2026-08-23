// ============================================================
//  verify-dedup.js — verify dedup state in Supabase via REST
//  (service role). No raw DB password needed.
//
//  Usage: node test/verify-dedup.js <user_id>
// ============================================================
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

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

const userId = process.argv[2];
if (!userId) throw new Error("usage: node test/verify-dedup.js <user_id>");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  // Total jobs for this user
  const { count: total, error: e0 } = await supabase
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (e0) throw new Error(`total query failed: ${e0.message}`);
  console.log(`[verify] total jobs for user: ${total}`);

  // Group by board
  const { data: byBoard, error: e1 } = await supabase
    .from("jobs")
    .select("board")
    .eq("user_id", userId);
  if (e1) throw new Error(`board query failed: ${e1.message}`);
  const boardCounts = {};
  for (const r of byBoard) boardCounts[r.board] = (boardCounts[r.board] ?? 0) + 1;
  console.log("[verify] jobs by board:", boardCounts);

  // Verify unique URLs = row count (dedup by (url, user_id))
  const { data: urls, error: e2 } = await supabase
    .from("jobs")
    .select("url, last_seen_at, scraped_date, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (e2) throw new Error(`url query failed: ${e2.message}`);
  const uniqueUrls = new Set(urls.map((r) => r.url));
  console.log(`[verify] rows=${urls.length} uniqueUrls=${uniqueUrls.size}`);
  console.log(`[verify] dedup OK (no dup URL rows): ${urls.length === uniqueUrls.size ? "✅" : "❌"}`);

  // Show a sample of rows to inspect last_seen_at vs scraped_date
  console.log("\n[verify] sample rows (first 6):");
  for (const r of urls.slice(0, 6)) {
    console.log(
      `  ${r.board ?? "?"}: scraped_date=${r.scraped_date} last_seen_at=${r.last_seen_at ? new Date(r.last_seen_at).toISOString() : "null"} created=${new Date(r.created_at).toISOString()}`,
    );
  }

  // Check for any duplicate URL rows (should be none)
  const seen = new Map();
  const dups = [];
  for (const r of urls) {
    if (seen.has(r.url)) dups.push({ url: r.url, count: seen.get(r.url) + 1 });
    seen.set(r.url, (seen.get(r.url) ?? 0) + 1);
  }
  if (dups.length === 0) {
    console.log("\n[verify] ✅ NO duplicate URL rows — (url, user_id) unique constraint working");
  } else {
    console.log(`\n[verify] ❌ FOUND ${dups.length} duplicated URLs:`);
    for (const d of dups.slice(0, 10)) console.log("  ", d.url, "x" + d.count);
  }
}

main().catch((err) => {
  console.error("[verify] ❌", err.message);
  process.exit(1);
});

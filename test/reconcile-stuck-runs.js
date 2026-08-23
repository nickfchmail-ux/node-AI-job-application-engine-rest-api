// ============================================================
//  reconcile-stuck-runs.js — one-time repair for runs stuck in
//  "processing" even though all their jobs are terminal.
//
//  Root cause (fixed in supabase.ts updateRun): the scraper worker
//  marks the run "processing" after enqueuing, but fast boards let
//  the job processor finalize (→ "completed") BEFORE the scraper
//  reaches that write, which then clobbers "completed" back to
//  "processing".
//
//  This script finds pipeline_runs with status='processing' whose
//  jobs are ALL terminal (completed/failed/duplicate) and flips
//  them to 'completed' with aggregated counters.
//
//  Usage: node test/reconcile-stuck-runs.js
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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const TERMINAL = new Set(["completed", "failed", "duplicate"]);

async function main() {
  // 1. Find all runs in 'processing' that look finished (have completed_at or are old)
  const { data: runs, error } = await supabase
    .from("pipeline_runs")
    .select("id, status, keyword, boards, total_jobs, created_at")
    .eq("status", "processing");
  if (error) throw new Error(`list runs failed: ${error.message}`);
  console.log(`[reconcile] found ${runs.length} run(s) in 'processing'`);

  let fixed = 0;
  for (const run of runs) {
    const { data: jobs, error: jErr } = await supabase
      .from("jobs")
      .select("status")
      .eq("pipeline_run_id", run.id);
    if (jErr) {
      console.warn(`  run ${run.id}: job query failed: ${jErr.message}`);
      continue;
    }
    if (!jobs || jobs.length === 0) {
      console.log(`  run ${run.id}: no jobs — skipping`);
      continue;
    }
    const allTerminal = jobs.every((j) => TERMINAL.has(j.status));
    if (!allTerminal) {
      const nonTerminal = jobs.filter((j) => !TERMINAL.has(j.status));
      console.log(
        `  run ${run.id}: NOT all terminal (${nonTerminal.length} non-terminal: ${[...new Set(nonTerminal.map((j) => j.status))].join(",")}) — skipping`,
      );
      continue;
    }

    const processed = jobs.filter((j) => j.status === "completed").length;
    const failed = jobs.filter((j) => j.status === "failed").length;
    const duplicate = jobs.filter((j) => j.status === "duplicate").length;

    const { error: updErr } = await supabase
      .from("pipeline_runs")
      .update({
        status: "completed",
        total_jobs: jobs.length,
        processed_jobs: processed,
        failed_jobs: failed,
        fit_jobs: 0,
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    if (updErr) {
      console.warn(`  run ${run.id}: update failed: ${updErr.message}`);
    } else {
      console.log(
        `  ✅ run ${run.id}: 'processing' → 'completed' (jobs=${jobs.length}, processed=${processed}, failed=${failed}, duplicate=${duplicate})`,
      );
      fixed++;
    }
  }
  console.log(`\n[reconcile] fixed ${fixed} stuck run(s)`);
}

main().catch((err) => {
  console.error("[reconcile] ❌", err.message);
  process.exit(1);
});

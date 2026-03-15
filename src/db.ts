import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";

// ── Env loader (dotenv v17 breaks on very long values) ────────────────────────
export function loadEnvLocal(): void {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    // Always prefer values from .env.local when present — override existing
    // environment variables to ensure local config (e.g., REDIS_URL) is used
    // during development and deployments that rely on this file.
    if (key) process.env[key] = value;
  }
}

// ── Supabase service-role client (admin ops + JWT verification) ───────────────
let _serviceClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (_serviceClient) return _serviceClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || url.includes("YOUR_PROJECT_ID")) {
    throw new Error("SUPABASE_URL is not configured in .env.local");
  }
  if (!key || key.includes("YOUR_SERVICE_ROLE_KEY")) {
    throw new Error("SUPABASE_SERVICE_KEY is not configured in .env.local");
  }
  _serviceClient = createClient(url, key, { auth: { persistSession: false } });
  return _serviceClient;
}

// ── Supabase anon client (user-facing auth: signUp, signIn) ──────────────────
let _anonClient: SupabaseClient | null = null;

export function getAnonSupabaseClient(): SupabaseClient {
  if (_anonClient) return _anonClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || url.includes("YOUR_PROJECT_ID")) {
    throw new Error("SUPABASE_URL is not configured in .env.local");
  }
  if (!key) {
    throw new Error("SUPABASE_ANON_KEY is not configured in .env.local");
  }
  _anonClient = createClient(url, key, { auth: { persistSession: false } });
  return _anonClient;
}

// ── Row type matching the jobs table ─────────────────────────────────────────
export interface JobRow {
  title: string;
  company: string;
  location: string | null;
  salary: string | null;
  posted_date: string | null;
  url: string;
  short_description: string | null;
  keyword: string;
  search_key: string;
  scraped_date: string; // YYYY-MM-DD
  responsibilities: string[];
  requirements: string[];
  benefits: string[];
  skills: string[];
  employment_type: string | null;
  experience_level: string | null;
  about_company: string | null;
  raw_description: string | null;
  fit: boolean | null;
  fit_score: number | null;
  fit_reasons: string[];
  cover_letter: string | null;
  expected_salary: string | null;
  user_id: string | null;
}

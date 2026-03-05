/**
 * pipeline.ts
 * All core business logic as exported async functions.
 * Used by server.ts (HTTP) and the individual CLI scripts.
 */

import axios from "axios";
import * as fs from "fs";
import mammoth from "mammoth";
import * as path from "path";
import { getSupabaseClient, JobRow } from "./db";
import {
  CTgoodjobsScraper,
  IndeedScraper,
  JobsDBScraper,
  MultiboardScraper,
} from "./scraper";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse") as (
  buf: Buffer,
) => Promise<{ text: string }>;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Job {
  source?: string;
  title: string;
  company: string;
  location: string;
  salary?: string;
  postedDate?: string;
  url: string;
  description?: string;
}

export interface JobDetail {
  responsibilities: string[];
  requirements: string[];
  benefits: string[];
  skills: string[];
  employmentType?: string;
  experienceLevel?: string;
  aboutCompany?: string;
  rawDescription: string;
}

export interface FitAnalysis {
  fit: boolean;
  score: number;
  reasons: string[];
  coverLetter?: string;
  expectedSalary?: string;
}

export type EnrichedJob = Job & { jobDetail: JobDetail };
export type AnalysedJob = EnrichedJob & { fitAnalysis?: FitAnalysis };

// ─────────────────────────────────────────────────────────────────────────────
// Resume loader — Supabase storage bucket "resume", file: {userId}-*.ext
// Falls back to local resume/ folder for CLI use.
// ─────────────────────────────────────────────────────────────────────────────

async function extractTextFromBuffer(
  buf: Buffer,
  filename: string,
): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") {
    const result = await pdfParse(buf);
    return result.text;
  }
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ buffer: buf });
    return result.value;
  }
  // .txt or anything else — treat as plain text
  return buf.toString("utf-8");
}

export async function loadResumeText(
  userId: string | undefined,
  log: (msg: string) => void = console.log,
): Promise<string> {
  // ── Server path: userId provided → Supabase only, no fallback ────────────
  if (userId) {
    const supabase = getSupabaseClient();
    const { data: files, error: listErr } = await supabase.storage
      .from("resume")
      .list("", { search: userId });

    if (listErr)
      throw new Error(`Failed to list resume bucket: ${listErr.message}`);

    const file = files?.find((f) => f.name.startsWith(userId));
    if (!file)
      throw new Error(
        `No resume found for this account. Please upload a resume first.`,
      );

    const { data, error: dlErr } = await supabase.storage
      .from("resume")
      .download(file.name);
    if (dlErr) throw new Error(`Failed to download resume: ${dlErr.message}`);

    const buf = Buffer.from(await (data as Blob).arrayBuffer());
    const text = await extractTextFromBuffer(buf, file.name);
    if (!text.trim())
      throw new Error(
        `Resume file "${file.name}" appears to be empty or unreadable.`,
      );
    log(`Resume loaded: ${file.name} (${text.length} chars)`);
    return text;
  }

  // ── CLI path: no userId → local resume/ folder ────────────────────────────
  const resumeDir = path.join(process.cwd(), "resume");
  const resumeFile = fs
    .readdirSync(resumeDir)
    .find((f) =>
      [".docx", ".pdf", ".txt"].includes(path.extname(f).toLowerCase()),
    );
  if (!resumeFile) throw new Error("No resume file found in resume/ folder.");
  const buf = fs.readFileSync(path.join(resumeDir, resumeFile));
  const text = await extractTextFromBuffer(buf, resumeFile);
  if (!text.trim())
    throw new Error(
      `Resume file "${resumeFile}" appears to be empty or unreadable.`,
    );
  log(`Resume loaded: ${resumeFile} (${text.length} chars)`);
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 – Scrape job listings (all boards in parallel)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert relative date strings from job boards into ISO date strings (YYYY-MM-DD).
 * e.g. "2d ago" → "2026-03-02", "53m ago" → "2026-03-04", "30+ days ago" → "2026-02-02"
 * Returns undefined for non-parseable strings like "Promoted".
 */
function parseRelativeDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  const now = new Date();

  // Match patterns like "53m ago", "2h ago", "3d ago", "1 day ago", "30+ days ago"
  const m = s.match(
    /^(\d+)\+?\s*(m|min|minute|h|hour|d|day|w|week|month)s?\s*(ago)?$/,
  );
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2][0]; // m, h, d, w
    const ms =
      { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit] ?? 0;
    const date = new Date(now.getTime() - n * ms);
    return date.toISOString().slice(0, 10);
  }
  // "just posted", "today"
  if (/just\s*posted|today/.test(s)) return now.toISOString().slice(0, 10);
  // "yesterday"
  if (/yesterday/.test(s)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  // Already looks like a date (YYYY-MM-DD or similar)
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);

  return undefined; // "Promoted", unknown — discard
}

const ALL_BOARDS = ["jobsdb", "indeed", "ctgoodjobs"] as const;
type BoardKey = (typeof ALL_BOARDS)[number];

// Indeed uses Cloudflare Bot Management which blocks cloud/datacenter IPs.
// Default boards exclude Indeed for Railway; pass boards=["indeed"] to opt in.
const DEFAULT_BOARDS: BoardKey[] = ["jobsdb", "ctgoodjobs"];

const BOARD_FACTORIES: Record<
  BoardKey,
  () => JobsDBScraper | IndeedScraper | CTgoodjobsScraper
> = {
  jobsdb: () => new JobsDBScraper(),
  indeed: () => new IndeedScraper(),
  ctgoodjobs: () => new CTgoodjobsScraper(),
};

export async function scrapeJobs(
  keyword: string,
  pages = 1,
  log: (msg: string) => void = console.log,
  boards: string[] = [...DEFAULT_BOARDS],
): Promise<Job[]> {
  const validBoards = boards.filter((b): b is BoardKey => b in BOARD_FACTORIES);
  if (validBoards.length === 0) throw new Error("No valid boards specified.");

  const scrapers = validBoards.map((b) => BOARD_FACTORIES[b]());
  log(
    `Boards: ${scrapers.map((s) => s.name).join(", ")} — running in parallel`,
  );

  const multi = new MultiboardScraper(scrapers);
  const jobs = await multi.scrape(keyword, pages, log);

  jobs.forEach((j) => log(`  [${j.source}] ${j.title} @ ${j.company}`));

  // Normalise relative date strings → ISO date (YYYY-MM-DD)
  return jobs.map((j) => ({
    ...j,
    postedDate: parseRelativeDate(j.postedDate) ?? j.postedDate,
  })) as Job[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 – Enrich each job with full description
// ─────────────────────────────────────────────────────────────────────────────

function toLines(text: string): string[] {
  return text
    .split(/\n|•|·|▪|◦|‣/)
    .map((s) => s.replace(/^[\s\-\*]+/, "").trim())
    .filter((s) => s.length > 4);
}

function parseDescription(raw: string): Omit<JobDetail, "rawDescription"> {
  const responsibilities: string[] = [];
  const requirements: string[] = [];
  const benefits: string[] = [];
  const skills: string[] = [];
  let employmentType: string | undefined;
  let experienceLevel: string | undefined;
  const companyLines: string[] = [];

  const SECTIONS = [
    {
      pattern: /responsibilit|duties|what you.ll do|your role|job function/i,
      target: "resp" as const,
    },
    {
      pattern:
        /requirement|qualif|what we.re looking|who you are|must have|minimum/i,
      target: "req" as const,
    },
    {
      pattern: /benefit|we offer|compensation|perks|package/i,
      target: "ben" as const,
    },
    {
      pattern: /skill|technolog|tool|stack|language|framework/i,
      target: "skill" as const,
    },
    {
      pattern: /about (us|the company|our company)|company overview/i,
      target: "co" as const,
    },
  ];

  let currentTarget: "resp" | "req" | "ben" | "skill" | "co" | null = null;

  for (const line of toLines(raw)) {
    let matched = false;
    for (const { pattern, target } of SECTIONS) {
      if (pattern.test(line) && line.length < 80) {
        currentTarget = target;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    if (!experienceLevel) {
      const m = line.match(
        /(\d+[\+\-\s]*year|fresh\s*grad|entry.level|senior|junior|mid.level)/i,
      );
      if (m) experienceLevel = m[0].trim();
    }
    if (!employmentType) {
      const m = line.match(
        /(full[- ]time|part[- ]time|contract|permanent|freelance|internship)/i,
      );
      if (m) employmentType = m[0].trim();
    }

    switch (currentTarget) {
      case "resp":
        responsibilities.push(line);
        break;
      case "req":
        requirements.push(line);
        break;
      case "ben":
        benefits.push(line);
        break;
      case "skill":
        skills.push(line);
        break;
      case "co":
        companyLines.push(line);
        break;
      default:
        responsibilities.push(line);
        break;
    }
  }

  return {
    responsibilities,
    requirements,
    benefits,
    skills,
    employmentType,
    experienceLevel,
    aboutCompany: companyLines.length ? companyLines.join(" ") : undefined,
  };
}

/** Strip HTML tags and decode common entities to plain text */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/  +/g, " ")
    .trim();
}

/** Extract the first JSON-like block starting after `marker=` in raw HTML */
function extractJsonBlock(html: string, marker: string): any | null {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const eqIdx = html.indexOf("=", idx);
  if (eqIdx === -1) return null;
  let depth = 0,
    start = -1;
  for (let i = eqIdx + 1; i < html.length; i++) {
    if (html[i] === "{") {
      if (start === -1) start = i;
      depth++;
    } else if (html[i] === "}") {
      if (--depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function scrapeDetail(url: string): Promise<JobDetail> {
  const empty: JobDetail = {
    responsibilities: [],
    requirements: [],
    benefits: [],
    skills: [],
    rawDescription: "",
  };
  const hostname = new URL(url).hostname;

  // ── Indeed — blocked by Cloudflare on Railway, skip ──────────────────────
  if (hostname.includes("indeed.com"))
    return {
      ...empty,
      rawDescription:
        "[Skipped — Indeed detail pages blocked by Cloudflare on Railway]",
    };

  let html = "";
  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(20000),
    });
    html = await res.text();
  } catch {
    return empty;
  }

  // ── JobsDB — extract from __NEXT_DATA__ JSON ──────────────────────────────
  if (hostname.includes("jobsdb.com")) {
    const m = html.match(
      /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (m) {
      try {
        const data = JSON.parse(m[1]);
        const job =
          data?.props?.pageProps?.jobDetail ||
          data?.props?.pageProps?.job ||
          data?.props?.pageProps?.result;
        const desc = job?.content || job?.jobContent || job?.description;
        if (typeof desc === "string" && desc.length > 20) {
          const raw = htmlToText(desc);
          return {
            ...parseDescription(raw),
            rawDescription: raw.slice(0, 3000),
          };
        }
      } catch {
        /* fall through */
      }
    }
    return empty;
  }

  // ── CTgoodjobs — extract description block from raw HTML ──────────────────
  if (hostname.includes("ctgoodjobs.hk")) {
    // Try id="jd__desc" block first
    const idMatch = html.match(/id="jd__desc"[^>]*>([\s\S]*?)<\/div>/i);
    if (idMatch) {
      const raw = htmlToText(idMatch[1]);
      if (raw.length > 50)
        return { ...parseDescription(raw), rawDescription: raw.slice(0, 3000) };
    }
    // Fallback: grab largest <section> or <article>
    const blocks = [
      ...html.matchAll(
        /<(?:section|article|div)[^>]*class="[^"]*(?:jd|job|desc|content)[^"]*"[^>]*>([\s\S]{200,5000}?)<\/(?:section|article|div)>/gi,
      ),
    ];
    for (const b of blocks) {
      const raw = htmlToText(b[1]);
      if (raw.length > 100)
        return { ...parseDescription(raw), rawDescription: raw.slice(0, 3000) };
    }
    return empty;
  }

  return empty;
}

export async function enrichJobs(
  jobs: Job[],
  log: (msg: string) => void = console.log,
): Promise<EnrichedJob[]> {
  // No browser needed — detail pages are fetched with plain HTTP fetch().
  // Playwright is only used during the scrape phase (search results).
  const JOB_TIMEOUT_MS = 20_000;
  const CONCURRENCY = 10; // plain fetch is cheap, no memory pressure

  const results: PromiseSettledResult<JobDetail>[] = Array(jobs.length);
  let nextIdx = 0;

  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= jobs.length) break;
      const job = jobs[i];
      try {
        const detail = await Promise.race([
          scrapeDetail(job.url),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(new Error(`timeout after ${JOB_TIMEOUT_MS / 1000}s`)),
              JOB_TIMEOUT_MS,
            ),
          ),
        ]);
        log(
          `[${i + 1}/${jobs.length}] ${job.title} @ ${job.company} | ${detail.responsibilities.length} resp | ${detail.requirements.length} req`,
        );
        results[i] = { status: "fulfilled", value: detail };
      } catch (reason) {
        log(
          `[${i + 1}] ✗ Failed (${job.title}): ${(reason as Error).message ?? reason}`,
        );
        results[i] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  return jobs.map((job, i) => {
    const r = results[i];
    if (r.status === "fulfilled") return { ...job, jobDetail: r.value };
    return {
      ...job,
      jobDetail: {
        responsibilities: [],
        requirements: [],
        benefits: [],
        skills: [],
        rawDescription: "",
      },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 – DeepSeek fit analysis
// ─────────────────────────────────────────────────────────────────────────────

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

async function analyzeOne(
  resumeText: string,
  job: EnrichedJob,
): Promise<FitAnalysis> {
  const apiKey = process.env.DEEP_SEEK_API;
  if (!apiKey) throw new Error("DEEP_SEEK_API is not set in .env.local");

  const jobSummary = [
    `Job Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location}`,
    job.salary ? `Salary: ${job.salary}` : "",
    job.jobDetail.experienceLevel
      ? `Experience Level: ${job.jobDetail.experienceLevel}`
      : "",
    job.jobDetail.employmentType
      ? `Employment Type: ${job.jobDetail.employmentType}`
      : "",
    "",
    "Responsibilities:",
    ...job.jobDetail.responsibilities.slice(0, 15).map((r) => `- ${r}`),
    job.jobDetail.responsibilities.length === 0 ? "(not listed)" : "",
    "",
    "Requirements:",
    ...job.jobDetail.requirements.slice(0, 15).map((r) => `- ${r}`),
    job.jobDetail.requirements.length === 0 ? "(not listed)" : "",
    "",
    "Key Skills:",
    ...job.jobDetail.skills.slice(0, 10).map((s) => `- ${s}`),
    job.jobDetail.skills.length === 0 ? "(not listed)" : "",
    job.jobDetail.aboutCompany
      ? `\nAbout Company:\n${job.jobDetail.aboutCompany.slice(0, 400)}`
      : "",
  ]
    .filter((l) => l !== "")
    .join("\n")
    .trim();

  const systemPrompt =
    "You are an honest, experienced career advisor helping a candidate assess job fit and write cover letters.\n" +
    "Be direct and realistic. Do not exaggerate or flatter. If the candidate is underqualified, say so clearly.\n" +
    "Always respond with a valid JSON object — no markdown, no code fences, just raw JSON.";

  const userPrompt =
    `Here is the candidate's resume:\n---\n${resumeText.slice(0, 3000)}\n---\n\n` +
    `Here is the job posting:\n---\n${jobSummary}\n---\n\n` +
    `Evaluate whether the candidate genuinely fits this role.\n\n` +
    `Respond ONLY with a valid JSON object in this exact shape:\n` +
    `{\n` +
    `  "fit": true or false,\n` +
    `  "score": integer from 0 to 100,\n` +
    `  "reasons": ["reason 1", "reason 2", ...],\n` +
    `  "expectedSalary": "please access based on the market rate for the title in hong kong, and the acedemic background, qulifications and exprience inside the resume",\n` +
    `  "coverLetter": "full cover letter text  (ONLY when fit is true)"\n` +
    `}\n\n` +
    `Rules:\n` +
    `- "reasons" must always be a non-empty array (strengths if fit, gaps if not fit)\n` +
    `- If fit is true:\n` +
    `  - "expectedSalary": conservative HKD monthly range based on candidate's actual level (career changer, project-based only) and HK market rate\n` +
    `  - "coverLetter": 3–4 realistic paragraphs, no buzzwords, addressed to the hiring team of ${job.company} for the role "${job.title}"\n` +
    `    Always close with:\n\nYours sincerely,\nFong, Chun Hong (Nick)\n+852 5108 0579\nnickfchmail@gmail.com\n` +
    `- If fit is false, omit "expectedSalary" and "coverLetter" entirely.`;

  const response = await axios.post(
    DEEPSEEK_URL,
    {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 1500,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 60000,
    },
  );

  const raw: string = response.data.choices[0].message.content.trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(cleaned) as FitAnalysis;
  } catch {
    throw new Error(`DeepSeek returned unparseable JSON: ${raw.slice(0, 200)}`);
  }
}

export async function analyzeJobs(
  jobs: EnrichedJob[],
  resumeText: string,
  force = false,
  log: (msg: string) => void = console.log,
): Promise<AnalysedJob[]> {
  const results: AnalysedJob[] = jobs.map((j) => ({ ...j }));

  const pending = jobs
    .map((j, i) => ({ j: j as AnalysedJob, i }))
    .filter(({ j }) => force || !j.fitAnalysis?.reasons?.length);

  if (!force) {
    const skipped = jobs.length - pending.length;
    if (skipped > 0) log(`⏭  Skipping ${skipped} already-analysed job(s).`);
  }
  log(`Analysing ${pending.length} job(s) with DeepSeek (parallel)...`);

  const settled = await Promise.allSettled(
    pending.map(({ j, i }) =>
      analyzeOne(resumeText, j).then((analysis) => ({ i, analysis })),
    ),
  );

  for (let idx = 0; idx < settled.length; idx++) {
    const outcome = settled[idx];
    const { i } = pending[idx];
    if (outcome.status === "fulfilled") {
      const { analysis } = outcome.value;
      results[i] = { ...results[i], fitAnalysis: analysis };
      const tag = analysis.fit
        ? `✅ FIT (${analysis.score})`
        : `❌ NO FIT (${analysis.score})`;
      log(
        `[${i + 1}/${jobs.length}] ${jobs[i].title} @ ${jobs[i].company} — ${tag}`,
      );
    } else {
      log(`[${i + 1}/${jobs.length}] ✗ ${(outcome.reason as Error).message}`);
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 – Persist (Supabase only)
// ─────────────────────────────────────────────────────────────────────────────

function toRow(
  job: AnalysedJob,
  keyword: string,
  scrapedDate: string,
  userId?: string,
): JobRow {
  return {
    title: job.title,
    company: job.company,
    location: job.location ?? null,
    salary: job.salary ?? null,
    posted_date: job.postedDate ?? null,
    url: job.url,
    short_description: job.description ?? null,
    keyword,
    search_key: keyword,
    scraped_date: scrapedDate,
    responsibilities: job.jobDetail.responsibilities,
    requirements: job.jobDetail.requirements,
    benefits: job.jobDetail.benefits,
    skills: job.jobDetail.skills,
    employment_type: job.jobDetail.employmentType ?? null,
    experience_level: job.jobDetail.experienceLevel ?? null,
    about_company: job.jobDetail.aboutCompany ?? null,
    raw_description: job.jobDetail.rawDescription ?? null,
    fit: job.fitAnalysis?.fit ?? null,
    fit_score: job.fitAnalysis?.score ?? null,
    fit_reasons: job.fitAnalysis?.reasons ?? [],
    cover_letter: job.fitAnalysis?.coverLetter ?? null,
    expected_salary: job.fitAnalysis?.expectedSalary ?? null,
    user_id: userId ?? null,
  };
}

export async function upsertToSupabase(
  jobs: AnalysedJob[],
  keyword: string,
  scrapedDate: string,
  log: (msg: string) => void = console.log,
  userId?: string,
): Promise<void> {
  const supabase = getSupabaseClient();
  const allRows = jobs.map((j) => toRow(j, keyword, scrapedDate, userId));

  // Deduplicate by conflict key (url + scraped_date + user_id) — duplicate
  // rows in the same upsert batch cause "ON CONFLICT DO UPDATE command cannot
  // affect row a second time" from Postgres.
  const seen = new Set<string>();
  const rows = allRows.filter((r) => {
    const key = `${r.url}|${r.scraped_date}|${r.user_id ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const BATCH = 50;
  let errors = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase
      .from("jobs")
      .upsert(rows.slice(i, i + BATCH), {
        onConflict: "url,scraped_date,user_id",
        ignoreDuplicates: false,
      });
    if (error) {
      log(`Supabase error: ${error.message}`);
      errors++;
    }
  }
  if (errors === 0) log(`✓ Upserted ${rows.length} rows to Supabase.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Full pipeline (used by the server)
// ─────────────────────────────────────────────────────────────────────────────

export interface PipelineOptions {
  keyword: string;
  pages?: number;
  force?: boolean;
  log?: (msg: string) => void;
  userId?: string;
  /** Which job boards to scrape. Defaults to DEFAULT_BOARDS (jobsdb, ctgoodjobs). Pass ["indeed"] to opt-in. */
  boards?: string[];
}

export interface PipelineResult {
  keyword: string;
  scrapedDate: string;
  total: number;
  fit: number;
  jobs: AnalysedJob[];
}

/**
 * Query Supabase for jobs that have already been analysed for this user (by URL).
 * Returns a map of url → AnalysedJob so already-processed jobs can be excluded
 * from enrichment, DeepSeek analysis, and upserting entirely.
 */
async function fetchExistingJobs(
  urls: string[],
  userId: string,
): Promise<Map<string, AnalysedJob>> {
  if (!urls.length) return new Map();
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("jobs")
    .select(
      "url, title, company, location, salary, posted_date, short_description, responsibilities, requirements, benefits, skills, employment_type, experience_level, about_company, raw_description, fit, fit_score, fit_reasons, cover_letter, expected_salary",
    )
    .eq("user_id", userId)
    .in("url", urls);

  if (error || !data) return new Map();

  const map = new Map<string, AnalysedJob>();
  for (const row of data as Record<string, unknown>[]) {
    const reasons: string[] = Array.isArray(row.fit_reasons)
      ? (row.fit_reasons as string[])
      : [];
    const job: AnalysedJob = {
      title: row.title as string,
      company: row.company as string,
      location: row.location as string,
      url: row.url as string,
      salary: (row.salary as string | null) ?? undefined,
      postedDate: (row.posted_date as string | null) ?? undefined,
      description: (row.short_description as string | null) ?? undefined,
      jobDetail: {
        responsibilities: (row.responsibilities as string[]) ?? [],
        requirements: (row.requirements as string[]) ?? [],
        benefits: (row.benefits as string[]) ?? [],
        skills: (row.skills as string[]) ?? [],
        employmentType: (row.employment_type as string | null) ?? undefined,
        experienceLevel: (row.experience_level as string | null) ?? undefined,
        aboutCompany: (row.about_company as string | null) ?? undefined,
        rawDescription: (row.raw_description as string) ?? "",
      },
      fitAnalysis: {
        fit: row.fit as boolean,
        score: (row.fit_score as number) ?? 0,
        reasons,
        coverLetter: (row.cover_letter as string | null) ?? undefined,
        expectedSalary: (row.expected_salary as string | null) ?? undefined,
      },
    };
    map.set(row.url as string, job);
  }
  return map;
}

export async function runPipeline(
  opts: PipelineOptions,
): Promise<PipelineResult> {
  const {
    keyword,
    pages = 1,
    force = false,
    log = console.log,
    userId,
    boards,
  } = opts;
  // Strip any characters that are unsafe in filenames/URLs (e.g. trailing \)
  const cleanKeyword = keyword
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "")
    .trim();
  const safeKeyword = cleanKeyword.toLowerCase().replace(/\s+/g, "_");
  const scrapedDate = new Date().toISOString().slice(0, 10);

  // 1. Load resume
  const resumeText = await loadResumeText(userId, log);

  // 2. Scrape
  const boardList = boards?.length ? boards : [...DEFAULT_BOARDS];
  log(
    `\n── Phase 1: Scraping "${cleanKeyword}" (${pages} page(s)) on [${boardList.join(", ")}] ──`,
  );
  const rawJobs = await scrapeJobs(cleanKeyword, pages, log, boardList);
  // Deduplicate by URL (same job can appear across boards or pages)
  const seenUrls = new Set<string>();
  const uniqueJobs = rawJobs.filter((j) => {
    if (seenUrls.has(j.url)) return false;
    seenUrls.add(j.url);
    return true;
  });
  log(
    `Scraped ${uniqueJobs.length} jobs (${rawJobs.length - uniqueJobs.length} duplicates removed).`,
  );
  if (uniqueJobs.length === 0)
    throw new Error("No jobs found for this keyword.");

  // Filter out jobs already processed for this user — skip enrich, DeepSeek, and upsert
  let newJobs = uniqueJobs;
  let cachedJobs: AnalysedJob[] = [];
  if (userId && !force) {
    const existingMap = await fetchExistingJobs(
      uniqueJobs.map((j) => j.url),
      userId,
    );
    if (existingMap.size > 0) {
      log(
        `⏭  ${existingMap.size} job(s) already in Supabase — skipping enrich, DeepSeek, and upsert for those.`,
      );
      newJobs = uniqueJobs.filter((j) => !existingMap.has(j.url));
      cachedJobs = uniqueJobs
        .filter((j) => existingMap.has(j.url))
        .map((j) => existingMap.get(j.url)!);
    }
  }

  let analysed: AnalysedJob[];
  if (newJobs.length === 0) {
    log(`\nAll scraped jobs are already processed. Nothing new to do.`);
    analysed = cachedJobs;
  } else {
    // 3. Enrich only new jobs
    log(`\n── Phase 2: Enriching ${newJobs.length} new job(s) ──`);
    const enriched = await enrichJobs(newJobs, log);

    // 4. Analyse only new jobs with DeepSeek
    log(`\n── Phase 3: Analysing fit with DeepSeek ──`);
    const freshAnalysed = await analyzeJobs(enriched, resumeText, force, log);

    // 5. Upsert only new jobs to Supabase
    log(`\n── Phase 4: Uploading to Supabase ──`);
    await upsertToSupabase(freshAnalysed, safeKeyword, scrapedDate, log, userId);

    analysed = [...freshAnalysed, ...cachedJobs];
  }

  const fit = analysed.filter((j) => j.fitAnalysis?.fit).length;
  return {
    keyword: safeKeyword,
    scrapedDate,
    total: analysed.length,
    fit,
    jobs: analysed,
  };
}

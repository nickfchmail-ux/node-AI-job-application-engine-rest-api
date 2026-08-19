// ============================================================
//  DeepSeek AI analysis — ported from src/pipeline/analyze.ts.
//  Uses fetch (Node 20 global) instead of axios.
//  Uses DeepSeek V4 Flash model by default (override via DEEP_SEEK_MODEL).
// ============================================================

import { EnrichedJob, FitAnalysis, ResumeProfile } from "./types";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-flash"; // DeepSeek V4 Flash

/** Resolve the model name (env override supported). */
function model(): string {
  return process.env.DEEP_SEEK_MODEL || DEFAULT_MODEL;
}

async function deepseekCall(opts: {
  system?: string;
  user: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}): Promise<string> {
  const apiKey = process.env.DEEP_SEEK_API;
  if (!apiKey) throw new Error("DEEP_SEEK_API is not set");

  const messages = opts.system
    ? [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ]
    : [{ role: "user", content: opts.user }];

  // deepseek-v4-flash is a REASONING model. It can spend its whole token
  // budget on reasoning and return EMPTY content, especially with
  // response_format=json_object. Retry with a plain (no response_format)
  // fallback which is far more reliable, then strip code fences.
  const attempts: { format: boolean; label: string }[] = [
    { format: true, label: "json" },
    { format: false, label: "plain" },
    { format: false, label: "plain-retry" },
  ];

  let lastErr: unknown = null;
  for (const attempt of attempts) {
    try {
      const body: Record<string, unknown> = {
        model: model(),
        messages,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
      };
      if (attempt.format) body.response_format = { type: "json_object" };

      const res = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });

      if (!res.ok) {
        throw new Error(
          `DeepSeek HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
        );
      }
      const data = (await res.json()) as {
        choices: {
          message: { content?: string; reasoning_content?: string };
        }[];
      };
      const content = (data.choices[0]?.message?.content ?? "").trim();
      if (content) {
        // Strip markdown code fences if the model wrapped JSON in ```json ... ```
        return content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
      }
      console.warn(
        `[deepseek] empty content (${attempt.label}) — reasoning=${(data.choices[0]?.message?.reasoning_content ?? "").length} tokens`,
      );
      lastErr = new Error("empty content");
    } catch (err) {
      lastErr = err;
      console.warn(`[deepseek] attempt ${attempt.label} failed: ${err}`);
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error("DeepSeek returned empty content");
}

// ── Resume profile extraction (once per run) ────────────────────────────────

export async function summarizeResume(
  resumeText: string,
): Promise<ResumeProfile> {
  const prompt =
    `Extract a structured profile from this resume. Return ONLY valid JSON:\n\n` +
    `Resume:\n---\n${resumeText.slice(0, 5000)}\n---\n\n` +
    `JSON shape:\n` +
    `{\n` +
    `  "yearsOfExperience": number,\n` +
    `  "currentRole": "string",\n` +
    `  "keySkills": ["skill1", "skill2", ...],\n` +
    `  "education": "highest degree + field",\n` +
    `  "industries": ["industry1", ...],\n` +
    `  "languages": ["language1", ...],\n` +
    `  "summary": "1-2 sentence career summary"\n` +
    `}`;

  // deepseek-v4-flash is a REASONING model — it spends tokens on internal
  // reasoning BEFORE producing content. A small max_tokens gets consumed by
  // reasoning, leaving content empty (which makes the profile "empty"). Use
  // a larger budget + retries so the extraction reliably succeeds.
  let raw = "";
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      raw = await deepseekCall({
        user: prompt,
        temperature: 0.1,
        maxTokens: 1500,
        timeoutMs: 45000,
      });
      if (raw?.trim()) break;
      lastErr = new Error("empty response");
      console.warn(
        `[deepseek] summarizeResume attempt ${attempt}/3 empty — retrying`,
      );
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[deepseek] summarizeResume attempt ${attempt}/3 failed: ${lastErr.message}`,
      );
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  if (!raw?.trim()) {
    throw lastErr ?? new Error("summarizeResume empty");
  }

  try {
    return JSON.parse(raw) as ResumeProfile;
  } catch {
    throw new Error(`Failed to parse resume profile: ${raw.slice(0, 200)}`);
  }
}

// ── Summary builders ────────────────────────────────────────────────────────

function buildJobSummary(job: EnrichedJob): string {
  return [
    `Job Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location}`,
    job.salary ? `Salary: ${job.salary}` : "",
    job.jobDetail.experienceLevel
      ? `Experience: ${job.jobDetail.experienceLevel}`
      : "",
    job.jobDetail.employmentType ? `Type: ${job.jobDetail.employmentType}` : "",
    "",
    "Responsibilities:",
    ...job.jobDetail.responsibilities.slice(0, 5).map((r) => `- ${r}`),
    "",
    "Requirements:",
    ...job.jobDetail.requirements.slice(0, 5).map((r) => `- ${r}`),
    "",
    "Skills:",
    ...job.jobDetail.skills.slice(0, 5).map((s) => `- ${s}`),
  ]
    .filter((l) => l !== "")
    .join("\n")
    .trim();
}

function buildResumeProfileText(profile: ResumeProfile): string {
  return [
    `Current Role: ${profile.currentRole}`,
    `Years of Experience: ${profile.yearsOfExperience}`,
    `Education: ${profile.education}`,
    `Key Skills: ${profile.keySkills.join(", ")}`,
    `Industries: ${profile.industries.join(", ")}`,
    `Languages: ${profile.languages.join(", ")}`,
    `Summary: ${profile.summary}`,
  ].join("\n");
}

// ── Tier 1: Quick fit check (all jobs) ─────────────────────────────────────

export async function quickFitCheck(
  resumeProfile: ResumeProfile,
  job: EnrichedJob,
): Promise<FitAnalysis> {
  const systemPrompt =
    "You are a direct, honest career advisor. Assess whether this candidate fits the job. " +
    "Return ONLY valid JSON, no markdown.";

  const userPrompt =
    `Candidate Profile:\n---\n${buildResumeProfileText(resumeProfile)}\n---\n\n` +
    `Job Posting:\n---\n${buildJobSummary(job)}\n---\n\n` +
    `Does this candidate genuinely fit this role? Return JSON:\n` +
    `{"fit": true|false, "score": 0-100, "reasons": ["reason1","reason2"]}`;

  const raw = await deepseekCall({
    system: systemPrompt,
    user: userPrompt,
    temperature: 0.3,
    // Reasoning model — give enough budget for reasoning + the JSON answer.
    maxTokens: 1500,
    timeoutMs: 45000,
  });
  try {
    return JSON.parse(raw) as FitAnalysis;
  } catch {
    throw new Error(`Unparseable fit check: ${raw.slice(0, 200)}`);
  }
}

// ── Tier 2: Cover letter + salary (fit jobs only) ──────────────────────────

export async function generateCoverLetter(
  resumeProfile: ResumeProfile,
  job: EnrichedJob,
): Promise<{ coverLetter: string; expectedSalary: string }> {
  const userPrompt =
    `Candidate Profile:\n---\n${buildResumeProfileText(resumeProfile)}\n---\n\n` +
    `Job:\n---\n${buildJobSummary(job)}\n---\n\n` +
    `Write a 3-paragraph cover letter for this candidate applying to ${job.company} for "${job.title}". ` +
    `No buzzwords. Be realistic about the candidate's qualifications.\n\n` +
    `Return JSON:\n` +
    `{\n` +
    `  "coverLetter": "full letter text",\n` +
    `  "expectedSalary": "HKD monthly range based on current HK market rate for this role, weighted by candidate qualifications"\n` +
    `}\n\n` +
    `Always close the letter with:\n` +
    `Yours sincerely,\nFong, Chun Hong (Nick)\n+852 5108 0579\nnickfchmail@gmail.com`;

  const raw = await deepseekCall({
    user: userPrompt,
    temperature: 0.5,
    // Reasoning model — cover letter is long, keep a generous budget.
    maxTokens: 2500,
    timeoutMs: 60000,
  });
  try {
    return JSON.parse(raw) as { coverLetter: string; expectedSalary: string };
  } catch {
    throw new Error(`Unparseable cover letter: ${raw.slice(0, 200)}`);
  }
}

// ── Tier 3: Tailored resume generation (fit jobs only) ─────────────────────
//
// DeepSeek is given EVERYTHING it needs to build a professional resume:
//   1. The user's original uploaded resume text (source of truth — the AI
//      must NOT invent facts; it rewrites/highlights what's already there)
//   2. The full job posting (title, company, location, salary, type, level,
//      about company, responsibilities, requirements, benefits, skills,
//      raw description)
//   3. The fit analysis (score + reasons) so the resume emphasises the
//      exact skills/experience that match the role
//   4. Explicit instructions on professional resume FORMAT/sections so the
//      output is a real resume, not a blob of text.

export interface ResumeBuildInput {
  originalResumeText: string;
  job: {
    title: string;
    company: string;
    location?: string | null;
    salary?: string | null;
    employmentType?: string | null;
    experienceLevel?: string | null;
    aboutCompany?: string | null;
    responsibilities?: string[] | null;
    requirements?: string[] | null;
    benefits?: string[] | null;
    skills?: string[] | null;
    rawDescription?: string | null;
    url?: string | null;
  };
  fitScore: number;
  fitReasons: string[];
}

export interface ResumeBuildOutput {
  /** The full professional resume text (may include markdown / sections). */
  resumeText: string;
  /** Short summary line for the resume (optional). */
  summary?: string;
}

/**
 * Some DeepSeek responses double-encode: the `resumeText` field is
 * itself a JSON string like '{"resumeText":"..."}' or '{"resume":"..."}'.
 * Detect and unwrap to the actual resume content.
 */
function unwrapNestedResumeText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return value;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const nested =
      typeof obj.resumeText === "string"
        ? obj.resumeText
        : typeof obj.resume === "string"
          ? obj.resume
          : typeof obj.content === "string"
            ? obj.content
            : null;
    if (nested && nested.trim()) return nested;
  } catch {
    /* not JSON — return as-is */
  }
  return value;
}

/** Build a complete, honest, professional resume tailored to a specific job. */
export async function generateResume(
  input: ResumeBuildInput,
): Promise<ResumeBuildOutput> {
  const systemPrompt =
    "You are an expert professional resume writer. You build resumes that are " +
    "100% honest — you ONLY use facts present in the candidate's provided resume. " +
    "You NEVER invent experience, employers, education, certifications, or skills. " +
    "You tailor the framing and emphasis of REAL facts to match the target job, " +
    "so the resume highlights the candidate's genuine strengths that are relevant " +
    "to that specific role. You follow a clean, professional resume FORMAT with " +
    "standard sections. Return ONLY valid JSON, no markdown fences.";

  const jobText = [
    `Job Title: ${input.job.title}`,
    `Company: ${input.job.company}`,
    input.job.location ? `Location: ${input.job.location}` : "",
    input.job.salary ? `Salary: ${input.job.salary}` : "",
    input.job.employmentType
      ? `Employment Type: ${input.job.employmentType}`
      : "",
    input.job.experienceLevel
      ? `Experience Level: ${input.job.experienceLevel}`
      : "",
    input.job.aboutCompany ? `About Company: ${input.job.aboutCompany}` : "",
    "",
    "Responsibilities:",
    ...(input.job.responsibilities ?? []).slice(0, 12).map((r) => `- ${r}`),
    "",
    "Requirements:",
    ...(input.job.requirements ?? []).slice(0, 12).map((r) => `- ${r}`),
    "",
    "Benefits:",
    ...(input.job.benefits ?? []).slice(0, 8).map((b) => `- ${b}`),
    "",
    "Skills mentioned in posting:",
    ...(input.job.skills ?? []).slice(0, 12).map((s) => `- ${s}`),
    "",
    "Full Job Description:",
    (input.job.rawDescription ?? "").slice(0, 4000),
    "",
    `Job URL: ${input.job.url ?? ""}`,
  ]
    .filter((l) => l !== "")
    .join("\n")
    .trim();

  const userPrompt =
    `The candidate's OWN resume (this is the ONLY source of truth — never add facts not present here):\n` +
    `---\n${input.originalResumeText.slice(0, 6000)}\n---\n\n` +
    `The target job posting:\n---\n${jobText}\n---\n\n` +
    `AI fit analysis — score ${input.fitScore}/100. Reasons:\n` +
    `---\n${input.fitReasons.map((r) => `- ${r}`).join("\n")}\n---\n\n` +
    `Build a professional, tailored resume for this candidate applying to ` +
    `"${input.job.title}" at ${input.job.company}.\n\n` +
    `RULES:\n` +
    `1. HONESTY: Use ONLY facts from the candidate's resume. Do NOT invent or ` +
    `exaggerate anything (no fake employers, dates, titles, schools, or skills).\n` +
    `2. TAILORING: Re-order, re-word, and emphasise the REAL experience/skills ` +
    `that match the job's requirements and the fit reasons.\n` +
    `3. FORMAT — output the resume as CLEAN MARKDOWN with EXACTLY these structures:\n` +
    `   - Line 1: "# Full Name" (use the candidate's real name from their resume; ` +
    `     if absent, use the most identifying line)\n` +
    `   - Lines 2-3: the contact details (phone, email, location, LinkedIn) each ` +
    `     on its own line, NO bullet marks\n` +
    `   - A blank line, then "## Professional Summary" followed by 2-3 honest sentences\n` +
    `   - "## Core Skills" followed by a single "- " bullet list (6-10 real skills, ` +
    `     concise, separated by commas is fine)\n` +
    `   - "## Work Experience" — include ONLY the 3-4 most relevant roles for ` +
    `     this job. Each role as "### Job Title, Company" on one line, then one ` +
    `     "Location / Dates" line, then 2-3 "- " bullet achievements each. ` +
    `     OMIT older/irrelevant roles to keep it to one page.\n` +
    `   - "## Education" — degree, school, year (honest only)\n` +
    `   - "## Certifications / Languages" — ONLY if present in the candidate resume\n` +
    `   IMPORTANT: Use "##" for section titles, "###" for role sub-headers, and "- " ` +
    `for bullets. Do NOT use tables, bold section headers, or any other markdown.\n` +
    `4. ONE PAGE: This is CRITICAL. The resume MUST fit on ONE A4 page. ` +
    `Be concise — aim for ~450-500 words total. Use strong action verbs. ` +
    `Quantify only where the resume already provides numbers (never invent them).\n\n` +
    `Return JSON exactly:\n` +
    `{\n` +
    `  "resumeText": "the full markdown resume (line 1 is the name; use ## for " +\n` +
    `                "sections, ### for roles, - for bullets; newlines between blocks)",\n` +
    `  "summary": "1-2 sentence honest summary"\n` +
    `}`;

  // deepseek-v4-flash is a REASONING model — it spends tokens on internal
  // reasoning BEFORE producing content. With large resume prompts it can
  // occasionally return empty content. Retry a couple of times (cheap,
  // deduped upstream by the generated_resumes unique constraint) to make
  // transient empty responses non-fatal.
  let raw = "";
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      raw = await deepseekCall({
        system: systemPrompt,
        user: userPrompt,
        temperature: 0.4,
        maxTokens: 6000,
        timeoutMs: 120000,
      });
      if (raw?.trim()) break;
      lastError = new Error("DeepSeek returned empty content");
      console.warn(
        `[deepseek] generateResume attempt ${attempt}/3 returned empty — retrying`,
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[deepseek] generateResume attempt ${attempt}/3 failed: ${lastError.message}`,
      );
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  if (!raw?.trim()) {
    throw lastError ?? new Error("DeepSeek returned empty resume");
  }

  try {
    const parsed = JSON.parse(raw) as ResumeBuildOutput;
    if (!parsed.resumeText?.trim()) {
      throw new Error("Empty resumeText in DeepSeek response");
    }
    // Some responses double-encode: resumeText itself is a JSON object
    // string like {"resumeText":"..."} (or {"resume": "..."}). Unwrap it.
    const unwrapped = unwrapNestedResumeText(parsed.resumeText);
    return { ...parsed, resumeText: unwrapped };
  } catch (err) {
    // ── Robust fallback ──────────────────────────────────────
    // DeepSeek may wrap JSON in markdown fences (```json ... ```)
    // or emit prose before/after the object. Extract the first
    // {...} block and re-parse. If all else fails, unwrap a
    // JSON-object-with-resumeText if present, else use raw text.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[deepseek] generateResume JSON parse failed (${message}) — trying extraction`,
    );

    // 1. Strip markdown code fences
    let candidate = raw
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    // 2. Extract the first { ... } balanced block
    const start = candidate.indexOf("{");
    if (start !== -1) {
      let depth = 0;
      let end = -1;
      for (let i = start; i < candidate.length; i++) {
        if (candidate[i] === "{") depth++;
        else if (candidate[i] === "}") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end !== -1) {
        const block = candidate.slice(start, end + 1);
        try {
          const parsed2 = JSON.parse(block) as ResumeBuildOutput;
          if (parsed2.resumeText?.trim()) {
            return {
              ...parsed2,
              resumeText: unwrapNestedResumeText(parsed2.resumeText),
            };
          }
          // JSON object but no resumeText — unwrap inner resumeText if present
          const obj = parsed2 as unknown as Record<string, unknown>;
          if (typeof obj.resumeText === "string") {
            return { resumeText: unwrapNestedResumeText(obj.resumeText) };
          }
          if (typeof obj.resume === "string") {
            return { resumeText: unwrapNestedResumeText(obj.resume) };
          }
        } catch {
          /* continue */
        }
      }
    }

    // 3. Last resort — if raw itself looks like {"resumeText":"..."} try unwrapping
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (typeof obj.resumeText === "string" && obj.resumeText.trim()) {
        return { resumeText: obj.resumeText };
      }
    } catch {
      /* continue */
    }

    // 4. Plain text fallback
    console.warn(
      `[deepseek] generateResume could not extract JSON — using raw text (${raw.length} chars)`,
    );
    return { resumeText: raw };
  }
}

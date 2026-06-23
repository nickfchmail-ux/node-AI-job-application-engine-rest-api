import axios from "axios";
import { EnrichedJob, FitAnalysis } from "./types";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

// ── Resume profile (extracted once, reused for all jobs) ──────────────────

export interface ResumeProfile {
  yearsOfExperience: number;
  currentRole: string;
  keySkills: string[];
  education: string;
  industries: string[];
  languages: string[];
  summary: string; // 1-2 sentence career summary
}

/**
 * Call DeepSeek ONCE to extract a compact structured profile from the resume.
 * This single call replaces sending the full resume text with every job analysis,
 * cutting input tokens by ~75%.
 */
export async function summarizeResume(
  resumeText: string,
): Promise<ResumeProfile> {
  const apiKey = process.env.DEEP_SEEK_API;
  if (!apiKey) throw new Error("DEEP_SEEK_API is not set");

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

  const response = await axios.post(
    DEEPSEEK_URL,
    {
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 400,
      response_format: { type: "json_object" },
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    },
  );

  const raw: string = response.data.choices[0].message.content.trim();
  try {
    return JSON.parse(raw) as ResumeProfile;
  } catch {
    throw new Error(`Failed to parse resume profile: ${raw.slice(0, 200)}`);
  }
}

// ── Trimmed job summary (5 items max per section) ─────────────────────────

function buildJobSummary(job: EnrichedJob): string {
  return [
    `Job Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location}`,
    job.salary ? `Salary: ${job.salary}` : "",
    job.jobDetail.experienceLevel
      ? `Experience: ${job.jobDetail.experienceLevel}`
      : "",
    job.jobDetail.employmentType
      ? `Type: ${job.jobDetail.employmentType}`
      : "",
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

// ── Tier 1: Quick fit check (cheap, runs for ALL jobs) ─────────────────────

async function quickFitCheck(
  resumeProfile: ResumeProfile,
  job: EnrichedJob,
): Promise<FitAnalysis> {
  const apiKey = process.env.DEEP_SEEK_API;
  if (!apiKey) throw new Error("DEEP_SEEK_API is not set");

  const systemPrompt =
    "You are a direct, honest career advisor. Assess whether this candidate fits the job. " +
    "Return ONLY valid JSON, no markdown.";

  const userPrompt =
    `Candidate Profile:\n---\n${buildResumeProfileText(resumeProfile)}\n---\n\n` +
    `Job Posting:\n---\n${buildJobSummary(job)}\n---\n\n` +
    `Does this candidate genuinely fit this role? Return JSON:\n` +
    `{"fit": true|false, "score": 0-100, "reasons": ["reason1","reason2"]}`;

  const response = await axios.post(
    DEEPSEEK_URL,
    {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 300,
      response_format: { type: "json_object" },
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 45000,
    },
  );

  const raw: string = response.data.choices[0].message.content.trim();
  try {
    return JSON.parse(raw) as FitAnalysis;
  } catch {
    throw new Error(`Unparseable fit check: ${raw.slice(0, 200)}`);
  }
}

// ── Tier 2: Cover letter + salary (only for fit jobs) ──────────────────────

async function generateCoverLetter(
  resumeProfile: ResumeProfile,
  job: EnrichedJob,
): Promise<{ coverLetter: string; expectedSalary: string }> {
  const apiKey = process.env.DEEP_SEEK_API;
  if (!apiKey) throw new Error("DEEP_SEEK_API is not set");

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

  const response = await axios.post(
    DEEPSEEK_URL,
    {
      model: "deepseek-chat",
      messages: [{ role: "user", content: userPrompt }],
      temperature: 0.5,
      max_tokens: 800,
      response_format: { type: "json_object" },
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 45000,
    },
  );

  const raw: string = response.data.choices[0].message.content.trim();
  try {
    const parsed = JSON.parse(raw);
    return {
      coverLetter: parsed.coverLetter || "",
      expectedSalary: parsed.expectedSalary || "",
    };
  } catch {
    return { coverLetter: "", expectedSalary: "" };
  }
}

// ── Main: Tiered analysis (Tier 1 for all, Tier 2 only for fits) ──────────

export async function analyzeOne(
  resumeProfile: ResumeProfile,
  job: EnrichedJob,
  genCoverLetter: boolean = true,
): Promise<FitAnalysis> {
  // Tier 1: quick fit check (always)
  const fit = await quickFitCheck(resumeProfile, job);

  // Tier 2: cover letter + salary only if fit AND requested
  if (fit.fit && genCoverLetter) {
    try {
      const details = await generateCoverLetter(resumeProfile, job);
      return { ...fit, ...details };
    } catch (err) {
      // Cover letter generation failed — return fit check result without it
      return fit;
    }
  }

  return fit;
}

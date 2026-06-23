import axios from "axios";
import * as fs from "fs";
import mammoth from "mammoth";
import * as path from "path";
import { getSupabaseClient, loadEnvLocal } from "./db";

loadEnvLocal();

// ── Types ─────────────────────────────────────────────────────────────────────

interface JobDetail {
  responsibilities: string[];
  requirements: string[];
  benefits: string[];
  skills: string[];
  employmentType?: string;
  experienceLevel?: string;
  aboutCompany?: string;
  rawDescription: string;
}

interface FitAnalysis {
  fit: boolean;
  score: number; // 0–100 honesty score
  reasons: string[]; // always present: why fit or why not
  coverLetter?: string; // present only when fit === true
  expectedSalary?: string; // realistic HKD monthly range, only when fit === true
}

interface EnrichedJob {
  title: string;
  company: string;
  location: string;
  salary?: string;
  postedDate?: string;
  url: string;
  description?: string;
  jobDetail: JobDetail;
  fitAnalysis?: FitAnalysis;
}

// ── DeepSeek call ─────────────────────────────────────────────────────────────

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

async function analyzeWithDeepSeek(
  resumeText: string,
  job: EnrichedJob,
): Promise<FitAnalysis> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");

  const jobSummary = `
Job Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
${job.salary ? `Salary: ${job.salary}` : ""}
${job.jobDetail.experienceLevel ? `Experience Level: ${job.jobDetail.experienceLevel}` : ""}
${job.jobDetail.employmentType ? `Employment Type: ${job.jobDetail.employmentType}` : ""}

Responsibilities:
${
  job.jobDetail.responsibilities
    .slice(0, 15)
    .map((r) => `- ${r}`)
    .join("\n") || "(not listed)"
}

Requirements:
${
  job.jobDetail.requirements
    .slice(0, 15)
    .map((r) => `- ${r}`)
    .join("\n") || "(not listed)"
}

Key Skills:
${
  job.jobDetail.skills
    .slice(0, 10)
    .map((s) => `- ${s}`)
    .join("\n") || "(not listed)"
}

${job.jobDetail.aboutCompany ? `About Company:\n${job.jobDetail.aboutCompany.slice(0, 400)}` : ""}
`.trim();

  const systemPrompt = `You are an honest, experienced career advisor helping a candidate assess job fit and write cover letters.
Be direct and realistic. Do not exaggerate or flatter. If the candidate is underqualified, say so clearly.
Always respond with a valid JSON object — no markdown, no code fences, just raw JSON.`;

  const userPrompt = `Here is the candidate's resume:
---
${resumeText.slice(0, 3000)}
---

Here is the job posting:
---
${jobSummary}
---

Evaluate whether the candidate genuinely fits this role.

Respond ONLY with a valid JSON object in this exact shape:
{
  "fit": true or false,
  "score": integer from 0 to 100 representing how well the candidate matches,
  "reasons": ["reason 1", "reason 2", ...],
  "expectedSalary": "realistic HKD monthly range e.g. HK$18,000 – HK$22,000 (ONLY include this key when fit is true)",
  "coverLetter": "full cover letter text here (ONLY include this key when fit is true)"
}

Rules:
- "reasons" should always be a non-empty array
  - If fit is true: list the main strengths that make the candidate suitable
  - If fit is false: list the specific gaps or mismatches
- If fit is true, suggest a realistic expected monthly salary range in HKD based on:
  - The candidate's actual experience level (career changer, project-based only, no commercial experience)
  - The market rate for this role in Hong Kong
  - Any salary range stated in the job posting
  Do NOT inflate. Be conservative and honest. Format as e.g. "HK$18,000 – HK$22,000 per month".
  If fit is false, omit the "expectedSalary" key entirely.
- If fit is true, write a realistic cover letter (3–4 paragraphs). No buzzwords, no exaggeration.
  Address it to the hiring team of ${job.company}. Mention the role "${job.title}" and relevant skills from the resume.
  Always end the letter with this exact closing (preserve the line breaks):

Yours sincerely,
Fong, Chun Hong (Nick)
+852 5108 0579
nickfchmail@gmail.com

- If fit is false, omit the "coverLetter" key entirely.`;

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

  // Strip any accidental markdown fences
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  try {
    const parsed = JSON.parse(cleaned) as FitAnalysis;
    return parsed;
  } catch {
    throw new Error(
      `Failed to parse DeepSeek JSON response: ${raw.slice(0, 200)}`,
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Load resume ─────────────────────────────────────────────────────────
  const resumeDir = path.join(process.cwd(), "resume");
  const resumeFiles = fs
    .readdirSync(resumeDir)
    .filter((f) => f.endsWith(".docx"));
  if (resumeFiles.length === 0) {
    console.error("No .docx file found in the resume/ folder.");
    process.exit(1);
  }
  const resumePath = path.join(resumeDir, resumeFiles[0]);
  console.log(`Reading resume: ${resumeFiles[0]}`);

  const { value: resumeText } = await mammoth.extractRawText({
    path: resumePath,
  });
  if (!resumeText.trim()) {
    console.error("Could not extract text from resume.");
    process.exit(1);
  }
  console.log(`Resume loaded (${resumeText.length} chars)\n`);

  // ── Load enriched jobs ───────────────────────────────────────────────────
  // Usage: npm run cover [date] [keyword] [--force]
  // --force: re-analyse all jobs, even ones already done (e.g. to update sign-off)
  const args = process.argv.slice(2);
  const forceFlag = args.includes("--force");
  const posArgs = args.filter((a) => !a.startsWith("--"));
  const dateArg = posArgs[0] ?? new Date().toISOString().slice(0, 10);
  const keywordArg = posArgs[1] ?? "web_developer";

  const inputFile = dateArg.endsWith(".json")
    ? dateArg // full path passed directly
    : path.join(
        process.cwd(),
        "results",
        dateArg,
        `${keywordArg}_enriched.json`,
      );

  if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
  }

  const jobs: EnrichedJob[] = JSON.parse(fs.readFileSync(inputFile, "utf-8"));
  console.log(`Loaded ${jobs.length} jobs from ${inputFile}`);

  // ── Skip already-analysed jobs (unless --force) ─────────────────────────
  const isDone = (j: EnrichedJob) =>
    !forceFlag &&
    !!j.fitAnalysis &&
    Array.isArray(j.fitAnalysis.reasons) &&
    j.fitAnalysis.reasons.length > 0;

  const pending = jobs.filter((j) => !isDone(j));
  const alreadyDone = jobs.length - pending.length;
  if (forceFlag) {
    console.log(`🔄 --force: re-analysing all ${jobs.length} jobs.`);
  } else if (alreadyDone > 0) {
    console.log(
      `⏭  Skipping ${alreadyDone} already-analysed job(s). Use --force to redo them.`,
    );
  }
  if (pending.length === 0) {
    console.log("All jobs already analysed. Nothing to do.");
    process.exit(0);
  }
  console.log(`Processing ${pending.length} job(s)...\n`);

  // ── Process in parallel ──────────────────────────────────────────────────
  const CONCURRENCY = 5; // DeepSeek rate-limit buffer
  const results: EnrichedJob[] = [...jobs];
  // Build an index map so we can write back to the correct slot in results[]
  const pendingIndexes = jobs
    .map((j, i) => ({ job: j, index: i }))
    .filter(({ job }) => !isDone(job));

  for (let b = 0; b < pendingIndexes.length; b += CONCURRENCY) {
    const batchSlice = pendingIndexes.slice(b, b + CONCURRENCY);
    const settled = await Promise.allSettled(
      batchSlice.map(({ job, index }) =>
        analyzeWithDeepSeek(resumeText, job).then((analysis) => ({
          index,
          analysis,
        })),
      ),
    );

    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        const { index, analysis } = outcome.value;
        results[index] = { ...results[index], fitAnalysis: analysis };
        const job = results[index];
        const tag = analysis.fit
          ? `✅ FIT   (score ${analysis.score})`
          : `❌ NO FIT (score ${analysis.score})`;
        console.log(
          `[${index + 1}/${jobs.length}] ${job.title} @ ${job.company} — ${tag}`,
        );
      } else {
        // find the global index this batch slot corresponds to
        const batchPos = settled.indexOf(outcome);
        const globalIndex = batchSlice[batchPos]?.index ?? -1;
        console.log(
          `[${globalIndex + 1}/${jobs.length}] ✗ Error: ${(outcome.reason as Error).message}`,
        );
      }
    }
  }

  // ── Save back to JSON (local cache) ──────────────────────────────────
  fs.writeFileSync(inputFile, JSON.stringify(results, null, 2), "utf-8");

  const fitCount = results.filter((j) => j.fitAnalysis?.fit).length;
  const analyzed = results.filter((j) => j.fitAnalysis !== undefined).length;
  console.log(`\nDone! ${fitCount}/${analyzed} jobs are a good fit.`);
  console.log(`Saved locally to: ${inputFile}`);

  // ── Upsert fit analysis to Supabase ────────────────────────────────
  const pathParts = inputFile.replace(/\\/g, "/").split("/");
  const filename = pathParts[pathParts.length - 1]; // web_developer_enriched.json
  const keyword = filename.replace(/_enriched\.json$/, ""); // web_developer
  const scrapedDate = pathParts[pathParts.length - 2]; // 2026-03-02

  try {
    const supabase = getSupabaseClient();

    // Only upsert jobs that have fit analysis
    const analysed = results.filter((j) => j.fitAnalysis !== undefined);
    const updates = analysed.map((job) => ({
      url: job.url,
      scraped_date: scrapedDate,
      // include all fields so a full upsert (enrich + analysis) works too
      title: job.title,
      company: job.company,
      location: job.location ?? null,
      salary: job.salary ?? null,
      posted_date: job.postedDate ?? null,
      short_description: job.description ?? null,
      keyword,
      responsibilities: job.jobDetail.responsibilities,
      requirements: job.jobDetail.requirements,
      benefits: job.jobDetail.benefits,
      skills: job.jobDetail.skills,
      employment_type: job.jobDetail.employmentType ?? null,
      experience_level: job.jobDetail.experienceLevel ?? null,
      about_company: job.jobDetail.aboutCompany ?? null,
      raw_description: job.jobDetail.rawDescription ?? null,
      fit: job.fitAnalysis!.fit,
      fit_score: job.fitAnalysis!.score,
      fit_reasons: job.fitAnalysis!.reasons,
      cover_letter: job.fitAnalysis!.coverLetter ?? null,
      expected_salary: job.fitAnalysis!.expectedSalary ?? null,
    }));

    const { error } = await supabase
      .from("jobs")
      .upsert(updates, {
        onConflict: "url,scraped_date",
        ignoreDuplicates: false,
      });

    if (error) throw error;
    console.log(
      `✓ Upserted ${updates.length} jobs with fit analysis to Supabase.`,
    );
  } catch (err) {
    console.warn(`⚠️  Supabase upsert skipped: ${(err as Error).message}`);
    console.warn(
      "   Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.local to enable.",
    );
  }
}

main().catch(console.error);

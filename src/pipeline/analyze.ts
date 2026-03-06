import axios from "axios";
import { AnalysedJob, EnrichedJob, FitAnalysis } from "./types";

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

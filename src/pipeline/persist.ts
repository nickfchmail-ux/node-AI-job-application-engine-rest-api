import { getSupabaseClient, JobRow } from "../db";
import { AnalysedJob } from "./types";

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
    const key = `${r.url}|${r.user_id ?? ""}`;
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

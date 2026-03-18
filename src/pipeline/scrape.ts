import {
  CTgoodjobsScraper,
  IndeedScraper,
  Job,
  JobScraper,
  JobsDBScraper,
  MultiboardScraper,
} from "../scrapers";

/**
 * Convert relative date strings from job boards into ISO date strings (YYYY-MM-DD).
 * e.g. "2d ago" → "2026-03-02", "53m ago" → "2026-03-04", "30+ days ago" → "2026-02-02"
 * Returns undefined for non-parseable strings like "Promoted".
 */
function parseRelativeDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  const now = new Date();

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
  if (/just\s*posted|today/.test(s)) return now.toISOString().slice(0, 10);
  if (/yesterday/.test(s)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);

  return undefined; // "Promoted", unknown — discard
}

const ALL_BOARDS = ["jobsdb", "indeed", "ctgoodjobs"] as const;
type BoardKey = (typeof ALL_BOARDS)[number];

// Indeed now works on Railway via ScraperAPI proxy (requires SCRAPERAPI_KEY env var).
export const DEFAULT_BOARDS: BoardKey[] = ["jobsdb", "ctgoodjobs", "indeed"];

const BOARD_FACTORIES: Record<BoardKey, () => JobScraper> = {
  jobsdb: () => new JobsDBScraper(),
  indeed: () => new IndeedScraper(),
  ctgoodjobs: () => new CTgoodjobsScraper(),
};

export async function scrapeJobs(
  keyword: string,
  pages = 1,
  log: (msg: string) => void = console.log,
  boards: string[] = [...DEFAULT_BOARDS],
  countryCode?: string,
): Promise<Job[]> {
  const validBoards = boards.filter((b): b is BoardKey => b in BOARD_FACTORIES);
  if (validBoards.length === 0) throw new Error("No valid boards specified.");

  const scrapers = validBoards.map((b) => BOARD_FACTORIES[b]());
  log(
    `Boards: ${scrapers.map((s) => s.name).join(", ")} — running in parallel`,
  );

  // Pass country code to scrapers that support geotargeting (e.g. Indeed via ScraperAPI)
  for (const s of scrapers) {
    if (s instanceof IndeedScraper && countryCode) {
      s.countryCode = countryCode;
    }
  }

  const multi = new MultiboardScraper(scrapers);
  const jobs = await multi.scrape(keyword, pages, log);

  jobs.forEach((j) => log(`  [${j.source}] ${j.title} @ ${j.company}`));

  // Normalise relative date strings → ISO date (YYYY-MM-DD)
  return jobs.map((j) => ({
    ...j,
    postedDate: parseRelativeDate(j.postedDate) ?? j.postedDate,
  })) as Job[];
}

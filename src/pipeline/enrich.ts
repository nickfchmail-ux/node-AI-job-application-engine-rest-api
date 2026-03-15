import { type BrowserContext } from "playwright";
import { browserPool } from "./browserPool";
import { EnrichedJob, Job, JobDetail } from "./types";

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

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const EMPTY_DETAIL: JobDetail = {
  responsibilities: [],
  requirements: [],
  benefits: [],
  skills: [],
  rawDescription: "",
};

/**
 * Phase 1 — try plain fetch. Returns null when content is absent so the job
 * can be retried with Playwright in phase 2.
 */
// Sites that are always bot-blocked or JS-rendered — skip fetch entirely
const PLAYWRIGHT_ONLY_HOSTS = ["jobsdb.com", "ctgoodjobs.hk", "indeed.com"];

async function scrapeDetailFetch(url: string): Promise<JobDetail | null> {
  const hostname = new URL(url).hostname;

  // Indeed is Cloudflare-blocked on Railway — return immediately
  if (hostname.includes("indeed.com"))
    return {
      ...EMPTY_DETAIL,
      rawDescription:
        "[Skipped — Indeed detail pages blocked by Cloudflare on Railway]",
    };

  // JobsDB and CTgoodjobs require a real browser — skip fetch, go straight to Playwright
  if (PLAYWRIGHT_ONLY_HOSTS.some((h) => hostname.includes(h))) return null;

  // For any other job board, attempt a plain fetch
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS });
    const html = await res.text();
    const blocks = [
      ...html.matchAll(
        /<(?:section|article|div)[^>]*class="[^"]*(?:job|desc|content|detail)[^"]*"[^>]*>([\s\S]{200,5000}?)<\/(?:section|article|div)>/gi,
      ),
    ];
    for (const b of blocks) {
      const raw = htmlToText(b[1]);
      if (raw.length > 100)
        return { ...parseDescription(raw), rawDescription: raw.slice(0, 3000) };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Phase 2 — try fetch once more, then fall back to Playwright if still empty.
 */
async function scrapeDetailPlaywright(
  url: string,
  browserContext: BrowserContext,
): Promise<JobDetail> {
  const hostname = new URL(url).hostname;

  if (hostname.includes("jobsdb.com")) {
    const page = await browserContext.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForSelector('[data-automation="jobAdDetails"]', {
        timeout: 12000,
      });
      const text = await page.evaluate(() => {
        const el = document.querySelector('[data-automation="jobAdDetails"]');
        return el ? (el as HTMLElement).innerText : null;
      });
      if (text && text.length > 20) {
        return {
          ...parseDescription(text),
          rawDescription: text.slice(0, 3000),
        };
      }
    } catch {
      /* fall through */
    } finally {
      await page.close();
    }
    return { ...EMPTY_DETAIL };
  }

  if (hostname.includes("ctgoodjobs.hk")) {
    const page = await browserContext.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
      await page
        .waitForSelector("#jd__desc, [class*='jd'], [class*='job-desc']", {
          timeout: 10000,
        })
        .catch(() => {});
      const html = await page.content();
      const idMatch = html.match(/id="jd__desc"[^>]*>([\s\S]*?)<\/div>/i);
      if (idMatch) {
        const raw = htmlToText(idMatch[1]);
        if (raw.length > 50)
          return {
            ...parseDescription(raw),
            rawDescription: raw.slice(0, 3000),
          };
      }
      const blocks = [
        ...html.matchAll(
          /<(?:section|article|div)[^>]*class="[^"]*(?:jd|job|desc|content)[^"]*"[^>]*>([\s\S]{200,5000}?)<\/(?:section|article|div)>/gi,
        ),
      ];
      for (const b of blocks) {
        const raw = htmlToText(b[1]);
        if (raw.length > 100)
          return {
            ...parseDescription(raw),
            rawDescription: raw.slice(0, 3000),
          };
      }
    } catch {
      /* fall through */
    } finally {
      await page.close();
    }
    return { ...EMPTY_DETAIL };
  }

  return { ...EMPTY_DETAIL };
}

/**
 * Enrich a single job listing (fetch first, then Playwright fallback).
 * Used by per-job workers so each listing is processed independently.
 */
export async function enrichOneJob(
  job: Job,
  log: (msg: string) => void = console.log,
): Promise<EnrichedJob> {
  const FETCH_TIMEOUT_MS = 15_000;
  const PW_TIMEOUT_MS = 25_000;

  // Phase 1: try plain fetch
  let detail: JobDetail | null = null;
  try {
    detail = await Promise.race([
      scrapeDetailFetch(job.url),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("fetch timeout")), FETCH_TIMEOUT_MS),
      ),
    ]);
  } catch {
    /* fall through to Playwright */
  }

  // Phase 2: Playwright fallback
  if (!detail) {
    const browserContext = await browserPool.acquire();
    try {
      detail = await Promise.race([
        scrapeDetailPlaywright(job.url, browserContext),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("pw timeout")), PW_TIMEOUT_MS),
        ),
      ]);
    } catch {
      detail = { ...EMPTY_DETAIL };
    } finally {
      await browserPool.release(browserContext);
    }
  }

  log(
    `Enriched: ${job.title} @ ${job.company} | ${detail.responsibilities.length} resp | ${detail.requirements.length} req`,
  );
  return { ...job, jobDetail: detail };
}

export async function enrichJobs(
  jobs: Job[],
  log: (msg: string) => void = console.log,
): Promise<EnrichedJob[]> {
  const FETCH_TIMEOUT_MS = 15_000;
  const PW_TIMEOUT_MS = 25_000;
  // 1 concurrent Playwright page on Railway free tier (512 MB).
  // Raise to 3-5 on a 2 GB+ container.
  const PW_CONCURRENCY = Number(process.env.PW_CONCURRENCY ?? 1);

  // ── Phase 1: fetch all jobs simultaneously ────────────────────────────────
  log(`⚡ Phase 1: fetching ${jobs.length} job(s) via HTTP in parallel...`);
  const fetchResults = await Promise.allSettled(
    jobs.map((j) =>
      Promise.race([
        scrapeDetailFetch(j.url),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("fetch timeout")),
            FETCH_TIMEOUT_MS,
          ),
        ),
      ]),
    ),
  );

  const details: (JobDetail | null)[] = fetchResults.map((r) =>
    r.status === "fulfilled" ? r.value : null,
  );

  // Log fetch results and identify which jobs need Playwright
  const playwrightIndices: number[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const d = details[i];
    if (d !== null) {
      log(
        `[fetch ${i + 1}/${jobs.length}] ${jobs[i].title} @ ${jobs[i].company} | ${d.responsibilities.length} resp | ${d.requirements.length} req`,
      );
    } else {
      playwrightIndices.push(i);
    }
  }

  log(
    `✅ Phase 1 done — ${jobs.length - playwrightIndices.length} enriched via fetch, ${playwrightIndices.length} need Playwright`,
  );

  // ── Phase 2: Playwright for jobs fetch couldn't enrich ───────────────────
  if (playwrightIndices.length > 0) {
    log(
      `🎭 Phase 2: launching Playwright for ${playwrightIndices.length} job(s)...`,
    );
    const browserContext = await browserPool.acquire();

    let nextPwIdx = 0;

    async function pwWorker() {
      while (true) {
        const localIdx = nextPwIdx++;
        if (localIdx >= playwrightIndices.length) break;
        const jobIdx = playwrightIndices[localIdx];
        const job = jobs[jobIdx];
        try {
          const detail = await Promise.race([
            scrapeDetailPlaywright(job.url, browserContext),
            new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(new Error(`timeout after ${PW_TIMEOUT_MS / 1000}s`)),
                PW_TIMEOUT_MS,
              ),
            ),
          ]);
          log(
            `[pw ${localIdx + 1}/${playwrightIndices.length}] ${job.title} @ ${job.company} | ${detail.responsibilities.length} resp | ${detail.requirements.length} req`,
          );
          details[jobIdx] = detail;
        } catch (reason) {
          log(
            `[pw ${localIdx + 1}] ✗ Failed (${job.title}): ${(reason as Error).message ?? reason}`,
          );
          details[jobIdx] = { ...EMPTY_DETAIL };
        }
      }
    }

    await Promise.all(Array.from({ length: PW_CONCURRENCY }, () => pwWorker()));
    await browserPool.release(browserContext);
  }

  return jobs.map((job, i) => ({
    ...job,
    jobDetail: details[i] ?? { ...EMPTY_DETAIL },
  }));
}

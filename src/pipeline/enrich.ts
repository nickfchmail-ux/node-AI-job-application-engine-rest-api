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
    const idMatch = html.match(/id="jd__desc"[^>]*>([\s\S]*?)<\/div>/i);
    if (idMatch) {
      const raw = htmlToText(idMatch[1]);
      if (raw.length > 50)
        return { ...parseDescription(raw), rawDescription: raw.slice(0, 3000) };
    }
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
  const JOB_TIMEOUT_MS = 20_000;
  const CONCURRENCY = 10;

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

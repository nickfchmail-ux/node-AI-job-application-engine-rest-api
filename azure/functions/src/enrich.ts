// ============================================================
//  Job enrichment — ported from src/pipeline/enrich.ts.
//  Parses raw job description HTML/text into structured details.
// ============================================================

import { JobDetail, ScrapedJob } from "./types";

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

/** Strip HTML tags and decode common entities to plain text. */
function htmlToText(html: string): string {
  // Remove non-content blocks (but KEEP application/ld+json — it often holds
  // the real JobPosting.description; we extract that separately in extractRawDescription)
  let clean = html
    .replace(
      /<script(?![^>]*type=["']application\/ld\+json["'])[^>]*>[\s\S]*?<\/script>/gi,
      " ",
    )
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/gi, " ")
    .replace(/self\.__next_f\.push\(\[1,"[\s\S]*?<\/script>/gi, " ");

  // Convert block elements to newlines
  clean = clean
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|li|h1|h2|h3|h4|h5|h6|div|tr|ul|ol|section|article)>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ");

  // Decode common entities
  clean = clean
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/\u00a0/g, " ");

  // Normalize whitespace per line, drop empties, join
  return clean
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n")
    .slice(0, 60_000); // cap: avoid storing megabytes of page chrome
}

/**
 * Try to extract a clean job description from Schema.org JSON-LD
 * (JobPosting.description). Many boards (CTgoodjobs) embed the full
 * description this way. Returns undefined if not present.
 */
function extractJsonLdDescription(html: string): string | undefined {
  const blocks = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  if (!blocks) return undefined;
  for (const block of blocks) {
    const jsonMatch = block.match(/>([\s\S]*?)<\/script>/i);
    if (!jsonMatch?.[1]) continue;
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      const desc =
        parsed?.["@type"] === "JobPosting" ? parsed.description : undefined;
      if (typeof desc === "string" && desc.trim().length > 20) {
        return htmlToText(desc);
      }
    } catch {
      // try next block
    }
  }
  return undefined;
}

/** Derive a raw description string from the scraped job (HTML or text). */
export function extractRawDescription(job: ScrapedJob): string {
  if (job.rawDetailHtml) {
    // 1. Prefer the clean JSON-LD JobPosting.description when present
    const jsonLd = extractJsonLdDescription(job.rawDetailHtml);
    if (jsonLd) return jsonLd;
    // 2. Otherwise strip the page down to text
    return htmlToText(job.rawDetailHtml);
  }
  return job.description ?? "";
}

/**
 * Enrich a scraped job: parse its raw description into structured
 * responsibilities / requirements / benefits / skills.
 */
export function enrichOneJob(
  job: ScrapedJob,
): ScrapedJob & { jobDetail: JobDetail } {
  const raw = extractRawDescription(job);
  const detail = parseDescription(raw);
  return { ...job, jobDetail: { ...detail, rawDescription: raw } };
}

// ============================================================
//  Board HTML parsers — extract job listings from raw HTML
//  returned by the Cloudflare jobboard-proxy worker.
//
//  Ported from the legacy Playwright scrapers in src/scrapers/*
//  but adapted to work on plain HTML strings (no browser needed):
//    - jobsdb     → DOM data-automation attributes (new layout) / __NEXT_DATA__ JSON fallback
//    - ctgoodjobs → Next.js RSC flight payload
//    - indeed     → window.mosaic.providerData JSON
//    - offertoday → DOM-ish regex extraction
// ============================================================

import type { ScrapedJob } from "./types";

const BASE_URL_JOBSDB = "https://hk.jobsdb.com";

// ── JobsDB: DOM data-automation attributes (current layout) ─────────────────

interface JobsDBResult {
  title: string;
  company: string;
  location: string;
  salary?: string;
  postedDate?: string;
  description?: string;
  url: string;
}

/** HTML-entity decode for common entities + strip tags. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Read the text inside the first element that has `data-automation="X"`. */
function textByAutomation(card: string, name: string): string | undefined {
  const re = new RegExp(`data-automation="${name}"[^>]*>([\\s\\S]*?)<\\/`, "i");
  const m = card.match(re);
  if (!m?.[1]) return undefined;
  const txt = decodeEntities(m[1]);
  return txt.length ? txt : undefined;
}

/** Read the href of the first element that has `data-automation="X"`. */
function hrefByAutomation(card: string, name: string): string | undefined {
  const re = new RegExp(`data-automation="${name}"[^>]*href="([^"]+)"`, "i");
  const m = card.match(re);
  return m?.[1];
}

function parseJobsDbHtml(html: string, board: string): ScrapedJob[] {
  const results: ScrapedJob[] = [];

  // ── Primary: DOM parsing of <article data-job-id="..."> cards ──
  // The regex matches the card's <article> open tag (capturing the whole open
  // tag in group 1) then captures the card BODY in group 2, then the closing
  // </article>. This is robust to either attribute order on the open tag.
  const cardRegex =
    /<article\b[^>]*(?:data-job-id="(\d+)"[^>]*data-automation="normalJob"|data-automation="normalJob"[^>]*data-job-id="(\d+)")[^>]*>([\s\S]*?)<\/article>/gi;
  let m: RegExpExecArray | null;
  while ((m = cardRegex.exec(html)) !== null) {
    const jobId = m[1] ?? m[2];
    const card = m[3];
    if (card == null) continue; // safety: never deref undefined

    // Title: aria-label is most reliable; fall back to jobTitle automation
    let title =
      card.match(/aria-label="([^"]+)"/)?.[1] ??
      textByAutomation(card, "jobTitle");
    // If title came from aria-label it may include company — trust automation first
    const titleAutomation = textByAutomation(card, "jobTitle");
    if (titleAutomation) title = titleAutomation;

    const company = textByAutomation(card, "jobCompany");
    const location = textByAutomation(card, "jobLocation");
    const postedDate = textByAutomation(card, "jobListingDate");
    const salary = textByAutomation(card, "jobSalary");

    // Job link
    const href =
      hrefByAutomation(card, "job-list-view-job-link") ??
      hrefByAutomation(card, "job-list-item-link-overlay");
    const rel = href ?? `/job/${jobId}`;
    const url = rel.startsWith("http") ? rel : `${BASE_URL_JOBSDB}${rel}`;

    // Teaser / short description if present
    const teaser =
      textByAutomation(card, "job-teaser") ??
      textByAutomation(card, "jobShortDescription");

    if (!title || !company) continue;

    results.push({
      title,
      company,
      location: location ?? "Hong Kong",
      salary,
      postedDate,
      url,
      description: teaser,
    });
  }

  if (results.length > 0) {
    return results.map((j) => ({ ...j, source: "jobsdb", board }));
  }

  // ── Fallback: __NEXT_DATA__ JSON (older layout) ───────────
  const nextData = html.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!nextData?.[1]) return [];

  try {
    const data = JSON.parse(nextData[1]);
    const candidates = [
      data?.props?.pageProps?.searchResults?.jobs,
      data?.props?.pageProps?.jobs,
      data?.props?.pageProps?.results?.jobs,
      data?.props?.pageProps?.initialData?.jobs,
      data?.props?.pageProps?.searchResults?.data?.jobs,
    ];
    const list: any[] =
      candidates.find((c) => Array.isArray(c) && c.length > 0) ?? [];

    for (const job of list) {
      const relPath: string = job.jobUrl || (job.id ? `/job/${job.id}` : "");
      const url = relPath.startsWith("http")
        ? relPath
        : `${BASE_URL_JOBSDB}${relPath}`;
      const description =
        job.teaser || job.abstract || job.jobDescription || job.description;
      results.push({
        title: job.title || job.jobTitle || "N/A",
        company:
          job.advertiser?.description ||
          job.company?.name ||
          job.companyName ||
          "N/A",
        location:
          job.suburb || job.location?.label || job.locationLabel || "Hong Kong",
        salary: job.salary || job.salaryLabel || undefined,
        postedDate: job.listingDate || job.postedAt || undefined,
        description,
        url,
      });
    }
  } catch {
    return [];
  }

  return results.map((j) => ({ ...j, source: "jobsdb", board }));
}

// ── CTgoodjobs: parse Next.js RSC flight payload ────────────────────────────

interface RscJobEntry {
  jobId: string;
  jobTitle: string;
  url: string;
  companyName: string;
  publishTime: string | { date?: string };
  salary: string | { salaryValue?: string };
  locations: string | string[];
}

function parseCtgoodjobsHtml(html: string, board: string): ScrapedJob[] {
  // 1. Collect and unescape all RSC push chunks
  const chunks: string[] = [];
  const rscRegex = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = rscRegex.exec(html)) !== null) {
    try {
      chunks.push(JSON.parse('"' + m[1] + '"'));
    } catch {
      /* skip malformed */
    }
  }
  if (chunks.length === 0) return [];
  const fullRsc = chunks.join("\n");

  // 2. Parse RSC entries: hexKey:jsonValue (one per line)
  const rscMap = new Map<string, unknown>();
  const entryRegex = /^([0-9a-f]+):(.+)$/gm;
  let em: RegExpExecArray | null;
  while ((em = entryRegex.exec(fullRsc)) !== null) {
    try {
      rscMap.set(em[1], JSON.parse(em[2]));
    } catch {
      /* skip */
    }
  }

  // 3. Find job objects and resolve $ref pointers
  const results: ScrapedJob[] = [];
  for (const [, entry] of rscMap) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("jobId" in entry) ||
      !("jobTitle" in entry) ||
      !("url" in entry) ||
      !("companyName" in entry)
    )
      continue;

    const job = entry as RscJobEntry;

    // Resolve salary ($ref → { salaryValue, ... })
    let salary: string | undefined;
    const salaryRef =
      typeof job.salary === "string" && job.salary.startsWith("$")
        ? job.salary.slice(1)
        : null;
    if (salaryRef) {
      const s = rscMap.get(salaryRef) as { salaryValue?: string } | undefined;
      if (s?.salaryValue && s.salaryValue !== "N/A") salary = s.salaryValue;
    }

    // Resolve publishTime ($ref → { date, ... })
    let postedDate: string | undefined;
    const ptRef =
      typeof job.publishTime === "string" && job.publishTime.startsWith("$")
        ? job.publishTime.slice(1)
        : null;
    if (ptRef) {
      const pt = rscMap.get(ptRef) as { date?: string } | undefined;
      if (pt?.date) postedDate = pt.date;
    }

    // Resolve locations ($ref → string[])
    let location = "Hong Kong";
    const locRef =
      typeof job.locations === "string" && job.locations.startsWith("$")
        ? job.locations.slice(1)
        : null;
    if (locRef) {
      const locArr = rscMap.get(locRef);
      if (
        Array.isArray(locArr) &&
        locArr.length > 0 &&
        typeof locArr[0] === "string"
      ) {
        location = locArr[0];
      }
    }

    results.push({
      title: (job.jobTitle as string).replace(/<[^>]+>/g, "").trim(),
      company: job.companyName as string,
      location,
      salary,
      postedDate,
      url: job.url as string,
      source: "ctgoodjobs",
      board,
    });
  }

  return results;
}

// ── Indeed: parse window.mosaic.providerData JSON ───────────────────────────

function parseIndeedHtml(html: string, board: string): ScrapedJob[] {
  const marker = 'window.mosaic.providerData["mosaic-provider-jobcards"]';
  const idx = html.indexOf(marker);
  if (idx === -1) return [];
  const eqIdx = html.indexOf("=", idx);
  if (eqIdx === -1) return [];

  let depth = 0,
    start = -1;
  const baseUrl = "https://hk.indeed.com";
  for (let i = eqIdx + 1; i < html.length; i++) {
    if (html[i] === "{") {
      if (start === -1) start = i;
      depth++;
    } else if (html[i] === "}") {
      if (--depth === 0) {
        try {
          const parsed = JSON.parse(html.slice(start, i + 1));
          const results: any[] =
            parsed?.metaData?.mosaicProviderJobCardsModel?.results ?? [];
          return results
            .filter((r: any) => r.jobkey && r.displayTitle)
            .map((r: any) => {
              const salaryMin = r.extractedSalary?.min;
              const salaryMax = r.extractedSalary?.max;
              const salaryType = r.extractedSalary?.type ?? "";
              return {
                title: (r.displayTitle ?? r.normTitle ?? "N/A").trim(),
                company: (r.company ?? "N/A").trim(),
                location: (
                  r.formattedLocation ??
                  r.jobLocationCity ??
                  "N/A"
                ).trim(),
                postedDate: r.formattedRelativeTime ?? undefined,
                url: `${baseUrl}/viewjob?jk=${r.jobkey}`,
                description: r.snippet
                  ? r.snippet
                      .replace(/<[^>]+>/g, " ")
                      .replace(/\s+/g, " ")
                      .trim()
                  : undefined,
                salary:
                  salaryMin != null || salaryMax != null
                    ? [salaryMin, salaryMax].filter(Boolean).join("–") +
                      (salaryType ? ` ${salaryType}` : "")
                    : undefined,
                source: "indeed",
                board,
              };
            });
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

// ── OfferToday: regex extraction from HTML (proxy fallback) ─────────────────
// Used ONLY when the public JSON API is blocked/empty. Mirrors the fields the
// API path returns (title, company, location, salary, postedDate, description)
// so the frontend gets the SAME contract regardless of which path succeeded.

/** Try to read the text of the first element matching a selector-ish regex. */
function offerTodayText(card: string, patterns: RegExp[]): string | undefined {
  for (const re of patterns) {
    const m = card.match(re);
    if (m?.[1]) {
      const txt = m[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (txt) return txt;
    }
  }
  return undefined;
}

function parseOfferTodayHtml(html: string, board: string): ScrapedJob[] {
  const results: ScrapedJob[] = [];

  // Match job-card anchors: /hk/job/{id} (and older /job/{id} /career paths).
  const cardRegex =
    /<a[^>]*href="(\/[^"]*\/(?:job|career)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = cardRegex.exec(html)) !== null) {
    const href = m[1];
    const card = m[2];
    const inner = card
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!inner || inner.length < 5) continue;

    // Title/company: prefer structured elements when present, else split text.
    const title =
      offerTodayText(card, [
        /(?:class|data-[a-z-]*)=["'][^"']*job(?:-|_)?(?:name|title)[^"']*["'][^>]*>([\s\S]*?)<\//i,
        /<h\d[^>]*>([\s\S]*?)<\/h\d>/i,
      ]) ??
      inner.split(/[–—|·•]/)[0]?.trim() ??
      inner;
    const company =
      offerTodayText(card, [
        /(?:class|data-[a-z-]*)=["'][^"']*(?:company|brand)[^"']*["'][^>]*>([\s\S]*?)<\//i,
      ]) ??
      inner.split(/[–—|·•]/)[1]?.trim() ??
      "";

    // Optional structured fields — best-effort, absent if not in the markup.
    const salary = offerTodayText(card, [
      /(?:class|data-[a-z-]*)=["'][^"']*salary[^"']*["'][^>]*>([\s\S]*?)<\//i,
    ]);
    const postedDateRaw = offerTodayText(card, [
      /(?:class|data-[a-z-]*)=["'][^"']*(?:date|time|post)[^"']*["'][^>]*>([\s\S]*?)<\//i,
      /<time[^>]*>([\s\S]*?)<\/time>/i,
    ]);
    const description = offerTodayText(card, [
      /(?:class|data-[a-z-]*)=["'][^"']*(?:job(?:-|_)?(?:desc|teaser|summary)|short(?:-|_)?desc)[^"']*["'][^>]*>([\s\S]*?)<\//i,
    ]);

    // Do NOT emit literal "N/A" — the normalizer maps empty/missing to the
    // SAME fallback ("Unknown Company") across every board.
    results.push({
      title,
      company,
      location: "Hong Kong",
      salary,
      postedDate: postedDateRaw,
      description,
      url: `https://www.offertoday.com${href.startsWith("/") ? href : `/${href}`}`,
      source: "offertoday",
      board,
    });
  }
  return results;
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Extract job listings from raw board HTML.
 * Returns an empty array when nothing parseable is found.
 * Defensive: returns [] for undefined/null/non-string input so a proxy error
 * response ({ ok:false, html:undefined }) can never crash the pipeline.
 */
export function extractListings(board: string, html: string): ScrapedJob[] {
  if (typeof html !== "string" || html.length === 0) return [];
  switch (board) {
    case "jobsdb":
      return parseJobsDbHtml(html, board);
    case "ctgoodjobs":
      return parseCtgoodjobsHtml(html, board);
    case "indeed":
      return parseIndeedHtml(html, board);
    case "offertoday":
      return parseOfferTodayHtml(html, board);
    default:
      return [];
  }
}

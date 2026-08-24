// ============================================================
//  normalize.ts — normalization layer for high-quality job data.
//
//  Every board returns raw ScrapedJob fields in its OWN shape
//  (different HTML entities, relative dates, salary strings,
//  missing locations...). This module turns those into ONE
//  consistent, frontend-friendly shape so the API consumer can
//  render a job card without branching on source.
//
//  It also computes lightweight DATA QUALITY signals per job:
//    dataQuality.completeness  (0–100: how many core fields are filled)
//    dataQuality.salary        (parsed structure + reliability)
//    dataQuality.postedDate    (ISO date when reliably parsed)
//
//  Pure functions — unit-testable, no I/O.
// ============================================================

import { ScrapedJob } from "./types";

// ── URL canonicalization ───────────────────────────────────────────────────
// URLs are the dedup key across runs (per-board `duplicate` counters and the
// `jobs` unique constraint). Board parsers emit byte-exact raw hrefs that vary
// run-over-run — tracking params, query order, trailing slash, host case — so
// canonicalize BEFORE dedup AND before persistence to keep the match stable.
// Pure + defensive: never throws, never crashes the pipeline.

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "msclkid",
  "ref",
  "referrer",
  "source",
  "mc_cid",
  "mc_eid",
  "igshid",
  "spm",
  "scm",
  "piwik_campaign",
  "piwik_kwd",
  "yclid",
  "trk",
  "trkCampaign",
  "fbc",
  "gbraid",
  "wbraid",
]);

/**
 * Canonicalize a URL so equal destinations compare equal:
 * trims + cleanTexts input, lowercases the hostname, strips the default
 * port, drops tracking/analytics query params, sorts remaining params,
 * strips a trailing `/` (unless the path is exactly `/`), and drops the
 * hash/fragment. Returns the canonical href — or the cleaned input unchanged
 * when parsing fails (defensive: never crash the pipeline).
 */
export function canonicalizeUrl(raw: string | undefined | null): string {
  const cleaned = cleanText(raw);
  if (!cleaned) return "";
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return cleaned;
  }
  url.hostname = url.hostname.toLowerCase();
  // Strip the default port (`:80` http / `:443` https).
  const explicitPort =
    url.port &&
    !(
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    );
  if (!explicitPort) url.port = "";

  // Drop tracking/analytics params (case-insensitive), sort the rest.
  const kept = [...url.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = kept.length > 0 ? `?${new URLSearchParams(kept).toString()}` : "";

  // Strip a trailing `/` unless the path is exactly `/`.
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  // Strip the hash/fragment entirely.
  url.hash = "";
  return url.href;
}

// ── HTML entity / tag cleaning ─────────────────────────────────────────────

/** Decode common HTML entities + strip any residual tags, collapse whitespace. */
export function cleanText(
  raw: string | undefined | null,
  fallback = "",
): string {
  if (raw == null) return fallback;
  const s = raw
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Boards emit literal "N/A", "N/A.", "-", "—" when a field is missing.
  // Collapse those to empty so every board's missing-field sentinel is the
  // SAME (then the caller applies its own fallback, e.g. "Unknown Company").
  if (!s || /^(n\/a|na|-|—|–|·)?$/i.test(s)) return "";
  return s;
}

/**
 * Clean a company name for consistency. Just runs cleanText + collapses
 * common recruiter prefixes ("Recruiter:", "via "), so the same fallback
 * ("Unknown Company") applies across every board. Does NOT split on
 * separators — that would corrupt legitimate names like "Deloitte - HK".
 */
export function cleanCompany(raw: string | undefined | null): string {
  if (raw == null) return "";
  let s = cleanText(raw);
  if (!s) return "";
  // Collapse a leading "Recruiter:" / "via <agency>" prefix when present.
  s = s
    .replace(/^(recruiter|agency|via)\s*[:\-–]\s*/i, "")
    .replace(/^via\s+/i, "")
    .trim();
  return s;
}

// ── Posted date → ISO (YYYY-MM-DD) ─────────────────────────────────────────
// Boards return one of:
//   "3d ago", "53m ago", "30+ days ago", "1 week ago", "Today", "Yesterday",
//   "2026-08-19" (ISO), "2026-08-19T..." (ISO datetime)
//   "2026-08-19 12:34" (datetime with a space) — CTgoodjobs detail pages
//
// The relative-date parser now accepts a LEADING date prefix too, so fields
// like "2026-08-19 3d ago" still resolve (some boards concatenate a raw date
// with a relative label).
export function normalizePostedDate(
  raw: string | undefined,
): string | undefined {
  if (!raw) return undefined;
  const s = cleanText(raw).toLowerCase();

  // Already ISO — support both "-" and "/" separators, plus datetime strings.
  // A leading ISO always wins over any trailing relative label.
  const iso = raw.match(
    /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/,
  );
  if (iso) {
    const [y, m, d] = iso[1].split(/[-\/]/).map((p) => p.padStart(2, "0"));
    const mm = m.slice(0, 2);
    const dd = d.slice(0, 2);
    return `${y}-${mm}-${dd}`;
  }

  const now = new Date();
  const m = s.match(
    /^(\d+)\+?\s*(m|min|minute|h|hour|d|day|w|week|month)s?\s*(ago)?$/,
  );
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2][0]; // m | h | d | w
    const ms =
      { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit] ?? 0;
    return new Date(now.getTime() - n * ms).toISOString().slice(0, 10);
  }
  if (/just\s*posted|today/.test(s)) return now.toISOString().slice(0, 10);
  if (/yesterday/.test(s)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  return undefined; // "Promoted" etc — discard
}

// ── Salary normalization ────────────────────────────────────────────────────
// Boards give us one of:
//   structured { min, max, type }  (Indeed)
//   "HK$30,000 - HK$40,000 per month"  (raw string)
//   "$22,000 – $28,000 per month"
//   undefined
//
// We keep the ORIGINAL display string (frontend renders it as-is)
// AND expose a structured parse so the frontend can sort/filter.
export interface NormalizedSalary {
  /** Original string as listed (or built from structured fields). */
  display: string | null;
  /** Parsed numeric range (currency-normalized to numbers where possible). */
  min: number | null;
  max: number | null;
  /** Frequency/period if detectable: per month / per year / per hour... */
  period: "month" | "year" | "hour" | "day" | null;
  /** ISO 4217 currency when detectable (HKD, USD, CNY, TWD...). */
  currency: string | null;
  /** Human reliability: how confident the parse is. */
  confidence: "high" | "medium" | "low" | "none";
}

const CURRENCY_MAP: Record<string, string> = {
  HK$: "HKD",
  HKD: "HKD",
  // Bare "$" is intentionally NOT mapped to USD here: on HK boards a bare "$"
  // is HKD, and the board-level inference (boardCurrency) decides. Mapping it
  // to USD would mislabel HK salaries as US dollars.
  USD: "USD",
  US$: "USD",
  "¥": "CNY",
  CNY: "CNY",
  RMB: "CNY",
  NT$: "TWD",
  TWD: "TWD",
  "€": "EUR",
  EUR: "EUR",
  "£": "GBP",
  GBP: "GBP",
  S$: "SGD",
  SGD: "SGD",
  A$: "AUD",
  AUD: "AUD",
};

function detectCurrency(s: string): string | null {
  for (const [token, code] of Object.entries(CURRENCY_MAP)) {
    if (s.includes(token)) return code;
  }
  return null;
}

function detectPeriod(s: string): NormalizedSalary["period"] {
  if (/per\s*(yr|year|annual|annum)/i.test(s)) return "year";
  if (/per\s*(hr|hour)/i.test(s)) return "hour";
  if (/per\s*day/i.test(s)) return "day";
  if (/per\s*(month|mth)|monthly/i.test(s)) return "month";
  return null;
}

function parseNumbers(s: string): number[] {
  // Handles:
  //   "HK$30,000 – HK$40,000" → [30000, 40000]
  //   "$10K-20K/M"            → [10000, 20000]  (K = thousands)
  //   "$2M-3M"                → [2000000, 3000000] (M = millions)
  const nums: number[] = [];
  const re = /(\d[\d,]*)(\.\d+)?\s*([kKmMbB])?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[1] == null) continue;
    let n = Number(m[1].replace(/,/g, "")) + (m[2] ? Number(m[2]) : 0);
    const suffix = (m[3] ?? "").toLowerCase();
    if (suffix === "k") n *= 1_000;
    else if (suffix === "m") n *= 1_000_000;
    else if (suffix === "b") n *= 1_000_000_000;
    if (n > 0) nums.push(n);
  }
  return nums;
}

/** Normalize a salary display string: unify dash separators, collapse spaces. */
function normalizeSalaryDisplay(s: string): string {
  return s
    .replace(/\s*–\s*/g, "–") // en-dash already: collapse spaces around it
    .replace(/\s*-\s*/g, "–") // hyphen range → en-dash
    .replace(/\s*—\s*/g, "–") // em-dash → en-dash
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a structured salary from a raw display string.
 * Normalizes the display (dash separators), parses the numeric range, and
 * keeps the original currency/period when detectable.
 */
export function parseSalary(raw: string | undefined | null): NormalizedSalary {
  if (!raw) {
    return {
      display: null,
      min: null,
      max: null,
      period: null,
      currency: null,
      confidence: "none",
    };
  }
  const cleaned = cleanText(raw);
  if (!cleaned) {
    return {
      display: null,
      min: null,
      max: null,
      period: null,
      currency: null,
      confidence: "none",
    };
  }
  // Normalize dash separators BEFORE parsing numbers so ranges like
  // "15,000 - 30,000" become "15,000–30,000" (consistent with other boards).
  const display = normalizeSalaryDisplay(cleaned);
  const nums = parseNumbers(display);
  const period = detectPeriod(display);
  const currency = detectCurrency(display);
  const hasRange = nums.length >= 2;
  const single = nums.length === 1;

  return {
    display,
    min: hasRange ? nums[0] : single ? nums[0] : null,
    max: hasRange ? nums[nums.length - 1] : null,
    period,
    currency,
    confidence:
      hasRange && period
        ? "high"
        : hasRange || (single && period)
          ? "medium"
          : single
            ? "low"
            : "none",
  };
}

/** Merge a structured Indeed salary { min, max, type } into a display string. */
export function salaryFromRange(
  min?: number | null,
  max?: number | null,
  type?: string,
  currency = "HKD",
): NormalizedSalary {
  if (min == null && max == null) return parseSalary(undefined);
  const lo = min ?? max ?? null;
  const hi = max ?? min ?? null;
  const parts = [lo, hi].filter((n): n is number => n != null);
  const display = parts.join("–") + (type ? ` ${type}` : "");
  return {
    display,
    min: lo,
    max: hi,
    period: null,
    currency,
    confidence: hi != null && lo != null ? "medium" : "low",
  };
}

/** Infer the salary currency from a board key when the board gives no symbol. */
export function boardCurrency(board: string): string | null {
  // HK boards report salaries in HKD by default even when the raw string has
  // no currency symbol (e.g. Indeed's "30000–40000 per year").
  switch (board) {
    case "jobsdb":
    case "ctgoodjobs":
    case "indeed":
    case "offertoday":
    case "linkedin":
      return "HKD";
    default:
      return null;
  }
}

// ── Location normalization ──────────────────────────────────────────────────

/** Default when a board omits location. */
export function normalizeLocation(raw: string | undefined): string {
  const s = cleanText(raw);
  if (!s) return "Hong Kong";
  return s;
}

// ── The main normalizer ─────────────────────────────────────────────────────

export interface NormalizedJob {
  /** Stable unique id: sha-ish of normalized URL (for idempotency). */
  jobId: string;
  title: string;
  company: string;
  location: string;
  salary: NormalizedSalary;
  /** Raw salary string (convenience for card rendering). */
  salaryDisplay: string | null;
  postedDate: string | null; // ISO YYYY-MM-DD when reliable
  /** Raw posted date from the board (for debugging). */
  postedDateRaw: string | null;
  url: string;
  board: string;
  /** Short snippet/description from the listing. */
  description: string | null;
  /** Full raw detail HTML (if pre-fetched). */
  rawDetailHtml?: string;
  /** Data-quality signals (0–100 completeness + flags). */
  dataQuality: {
    completeness: number;
    hasSalary: boolean;
    hasDescription: boolean;
    hasPostedDate: boolean;
    hasLocation: boolean;
  };
  /** The source board's name for display. */
  source: string;
}

/** Deterministic short hash from a string (FNV-1a 32-bit → hex). */
export function hashId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Normalize a raw scraped job from ANY board into the single
 * frontend-facing shape. Pure — no network, no DB.
 */
export function normalizeJob(
  job: ScrapedJob,
  opts: { board?: string; defaultLocation?: string } = {},
): NormalizedJob {
  const board = opts.board ?? job.board ?? job.source ?? "unknown";

  const title = cleanText(job.title) || "Untitled";
  // Company: some boards return a "brand · company" or "recruiter · company"
  // combined string (OfferToday). Prefer the LAST segment after a separator —
  // that's the hiring company, not the recruiter — and clean it.
  const company = cleanCompany(job.company) || "Unknown Company";
  const location = normalizeLocation(job.location ?? opts.defaultLocation);
  const postedDate = normalizePostedDate(job.postedDate) ?? null;
  // Canonicalize so `jobId: hashId(`${board}|${url}`)` and the persisted
  // `url` are STABLE across runs (tracking params / query order / trailing
  // slash / host case no longer break idempotency or per-board dedup).
  const url = canonicalizeUrl(job.url);
  const description = job.description
    ? cleanText(job.description) || null
    : null;

  // Salary: structured (Indeed) beats raw string — same parser for both now.
  const salary = parseSalary(job.salary);
  // If the raw salary string had no currency symbol (e.g. Indeed's numeric
  // range), infer it from the board so every board's salary has a currency.
  if (salary.currency == null && salary.display != null) {
    salary.currency = boardCurrency(board);
  }

  // ── Data-quality score ──
  const coreFields = [
    title && title !== "Untitled",
    company && company !== "Unknown Company",
    !!location,
    !!url,
  ];
  const scored = coreFields.filter(Boolean).length;
  const completeness = Math.round((scored / coreFields.length) * 100);

  return {
    jobId: hashId(`${board}|${url}`),
    title,
    company,
    location,
    salary,
    salaryDisplay: salary.display,
    postedDate,
    postedDateRaw: job.postedDate ?? null,
    url,
    board,
    description,
    rawDetailHtml: job.rawDetailHtml,
    dataQuality: {
      completeness,
      hasSalary: salary.display != null,
      hasDescription: description != null && description.length > 0,
      hasPostedDate: postedDate != null,
      hasLocation: location.length > 0,
    },
    source: board,
  };
}

/** Normalize a whole batch (dedupes by normalized URL). */
export function normalizeJobs(
  jobs: ScrapedJob[],
  opts: { board?: string; defaultLocation?: string } = {},
): NormalizedJob[] {
  const seen = new Set<string>();
  const out: NormalizedJob[] = [];
  for (const j of jobs) {
    const n = normalizeJob(j, opts);
    if (seen.has(n.url)) continue;
    seen.add(n.url);
    out.push(n);
  }
  return out;
}

// ── Transporting the normalized contract ────────────────────────────────────
// The scraper worker normalizes listings, then sends each job to the
// processor via Service Bus. The ScrapedJob carried in JobMessage is the
// handoff — so we stamp the normalized fields onto it so the quality
// contract (ISO date, structured salary, dataQuality) actually REACHES the
// processor and Supabase instead of being discarded.

export interface SalaryTransport {
  display: string | null;
  min: number | null;
  max: number | null;
  period: "month" | "year" | "hour" | "day" | null;
  currency: string | null;
  confidence: "high" | "medium" | "low" | "none";
}

export interface DataQualityTransport {
  completeness: number;
  hasSalary: boolean;
  hasDescription: boolean;
  hasPostedDate: boolean;
  hasLocation: boolean;
}

/**
 * Stamp normalized quality fields onto a ScrapedJob so they survive the
 * Service Bus hop. Returns a NEW object (does not mutate the input).
 */
export function applyNormalized(
  job: ScrapedJob,
  n: NormalizedJob,
): ScrapedJob & {
  _normSalary?: SalaryTransport;
  _normDataQuality?: DataQualityTransport;
  _normJobId?: string;
  _normPostedDate?: string;
} {
  return {
    ...job,
    title: n.title,
    company: n.company,
    location: n.location,
    salary: n.salaryDisplay ?? undefined,
    postedDate: n.postedDate ?? undefined,
    description: n.description ?? undefined,
    _normSalary: n.salary,
    _normDataQuality: n.dataQuality,
    _normJobId: n.jobId,
    _normPostedDate: n.postedDate ?? undefined,
  };
}

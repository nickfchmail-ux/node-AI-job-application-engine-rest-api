// ============================================================
//  boardRegistry.ts — accurate per-board scraping patterns.
//
//  Single source of truth for HOW each HK job board exposes its
//  listing data and what quirks each extraction path has. This is
//  the "observe the accurate patterns" registry: the scraper
//  worker, the Cloudflare proxy, and the normalization layer all
//  derive their behaviour from these facts so the frontend gets
//  consistent, high-quality job data regardless of source.
//
//  Keyed by the SAME board keys used in Service Bus messages,
//  `pipeline_runs.boards`, and `jobs.board`.
// ============================================================

export type BoardKey =
  | "jobsdb"
  | "ctgoodjobs"
  | "indeed"
  | "linkedin"
  | "offertoday";

/**
 * How a board's listing data is embedded / returned. This drives
 * which fetcher + parser is used and what the normalizer expects.
 */
export type DataSource =
  | "next_data" // Next.js __NEXT_DATA__ JSON embedded in SSR HTML
  | "rsc_flight" // React Server Components flight payload (self.__next_f.push)
  | "mosaic_json" // Indeed window.mosaic.providerData JSON blob
  | "public_api" // Board's own public JSON/HTML guest API (no proxy)
  | "dom_attrs" // Plain DOM attributes (data-automation etc.)
  | "dom_regex"; // HTML fragment parsed with regexes

export interface BoardPattern {
  /** Board key (stable id used across the platform). */
  key: BoardKey;
  /** Human display name shown in the UI / board chips. */
  displayName: string;
  /** Root URL. */
  baseUrl: string;
  /** Primary data source for listings. */
  dataSource: DataSource;
  /** Fallback source when the primary is blocked or empty. */
  fallbackSource?: DataSource;
  /** Needs a browser/JS render (Playwright / render=true)? */
  requiresRender: boolean;
  /**
   * Proxy strategy:
   *  - "public"  → board's own API, no proxy needed (0 credits)
   *  - "proxy"   → Cloudflare worker → board HTML
   *  - "proxy+render" → Cloudflare worker + JS render (anti-bot)
   */
  proxyStrategy: "public" | "proxy" | "proxy+render";
  /** Credentials/cost notes for ops. */
  costNotes: string;
  /** Known anti-bot behaviours (observed). */
  antiBot: {
    cloudflare: boolean;
    captcha: boolean;
    rateLimit: boolean;
    datacenterBlocked: boolean;
  };
  /** Extraction specifics per field (what each parser actually reads). */
  extraction: {
    title: string;
    company: string;
    location: string;
    salary: string;
    postedDate: string;
    description: string;
    url: string;
  };
  /** Known quirks the normalizer must handle. */
  quirks: string[];
}

export const BOARD_PATTERNS: Record<BoardKey, BoardPattern> = {
  jobsdb: {
    key: "jobsdb",
    displayName: "JobsDB HK",
    baseUrl: "https://hk.jobsdb.com",
    dataSource: "dom_attrs",
    fallbackSource: "next_data",
    requiresRender: false,
    proxyStrategy: "proxy",
    costNotes: "Cloudflare proxy (DataImpulse residential fallback)",
    antiBot: {
      cloudflare: true,
      captcha: false,
      rateLimit: true,
      datacenterBlocked: true,
    },
    extraction: {
      title: "data-automation=jobTitle",
      company: "data-automation=jobCompany",
      location: "data-automation=jobLocation",
      salary: "data-automation=jobSalary",
      postedDate: "data-automation=jobListingDate",
      description: "data-automation=job-teaser / jobShortDescription",
      url: "data-automation=job-list-view-job-link href (falls back to /job/{id})",
    },
    quirks: [
      "Card root is <article data-job-id=... data-automation=normalJob>",
      "aria-label on the title anchor often includes company — must prefer jobTitle automation",
      "New layout: slug path /{slug}-jobs/in-hong-kong?page=N",
      "Posted date is a relative string ('3d ago') — normalizer converts to ISO",
      "Salary may be absent or in a combined label",
      "Location defaults to 'Hong Kong' when missing",
    ],
  },

  ctgoodjobs: {
    key: "ctgoodjobs",
    displayName: "CTgoodjobs HK",
    baseUrl: "https://jobs.ctgoodjobs.hk",
    dataSource: "rsc_flight",
    requiresRender: false,
    proxyStrategy: "proxy",
    costNotes: "Cloudflare proxy (DataImpulse residential fallback)",
    antiBot: {
      cloudflare: true,
      captcha: true,
      rateLimit: true,
      datacenterBlocked: true,
    },
    extraction: {
      title: "RSC jobTitle (strip HTML tags)",
      company: "RSC companyName",
      location: "RSC locations[0] ($ref-resolved)",
      salary: "RSC salary.salaryValue ($ref-resolved)",
      postedDate: "RSC publishTime.date ($ref-resolved)",
      description: "Schema.org JobPosting JSON-LD on the DETAIL page",
      url: "RSC url (absolute)",
    },
    quirks: [
      "Migrated to Next.js App Router — data lives in self.__next_f.push([1,...]) flight chunks",
      "Flat hexKey→JSON map with $hexKey references for salary/publishTime/locations",
      "PAGE_SIZE observed = 18 jobs per page",
      "Total pages from Schema.org numberOfItems",
      "Details: prefer JSON-LD JobPosting.description, else htmlToText of the page",
      "May serve a CAPTCHA/Human Verification page from datacenter IPs",
      "HTML entities in jobTitle (e.g. &amp;) must be decoded",
    ],
  },

  indeed: {
    key: "indeed",
    displayName: "Indeed HK",
    baseUrl: "https://hk.indeed.com",
    dataSource: "mosaic_json",
    fallbackSource: "dom_regex",
    requiresRender: true,
    proxyStrategy: "proxy+render",
    costNotes:
      "Cloudflare proxy (render/anti-bot) + RPC batch detail — no ScraperAPI",
    antiBot: {
      cloudflare: true,
      captcha: true,
      rateLimit: true,
      datacenterBlocked: true,
    },
    extraction: {
      title: "mosaic-provider-jobcards displayTitle/normTitle",
      company: "company",
      location: "formattedLocation / jobLocationCity",
      salary: "extractedSalary min–max + type",
      postedDate: "formattedRelativeTime",
      description:
        "snippet (stripped) + RPC /viewjob detail via /rpc/jobdescs?jks= batch",
      url: "/viewjob?jk={jobkey}",
    },
    quirks: [
      "Aggressively blocks datacenter IPs with Cloudflare — the jobboard-proxy worker (Cloudflare egress) is the path; residential fallback if challenged",
      "Salary is structured (min/max/type) — normalize to 'min–max type' string",
      "jobkey is the stable id — used for /viewjob?jk= and RPC detail batch",
      "Descriptions fetched in batch via /rpc/jobdescs?jks= (25 per chunk) through the proxy",
      "Page size 10 — 'start' offset pagination",
    ],
  },

  linkedin: {
    key: "linkedin",
    displayName: "LinkedIn HK",
    baseUrl: "https://www.linkedin.com",
    dataSource: "public_api",
    requiresRender: false,
    proxyStrategy: "public",
    costNotes: "Public guest API — 0 credits, no proxy",
    antiBot: {
      cloudflare: false,
      captcha: false,
      rateLimit: true,
      datacenterBlocked: false,
    },
    extraction: {
      title: "base-search-card__title",
      company: "hidden-nested-link",
      location: "job-search-card__location",
      salary: "not available on guest listing API",
      postedDate: "datetime attribute on time element",
      description: "guest jobPosting detail API (description__text section)",
      url: "/jobs/view/{jobId} (from data-entity-urn)",
    },
    quirks: [
      "Guest API returns server-rendered HTML fragment (not JSON) — parse with regex on job-search-card",
      "10 results per page, 'start' offset pagination",
      "No salary in listing — detail page may have it",
      "Company is inside hidden-nested-link anchor",
      "Posted date is an ISO date in datetime attribute",
    ],
  },

  offertoday: {
    key: "offertoday",
    displayName: "Offer Today",
    baseUrl: "https://www.offertoday.com",
    dataSource: "public_api",
    requiresRender: false,
    proxyStrategy: "public",
    costNotes: "Public JSON API — 0 credits, no proxy",
    antiBot: {
      cloudflare: false,
      captcha: false,
      rateLimit: true,
      datacenterBlocked: false,
    },
    extraction: {
      title: "jobName",
      company: "brandName || companyName",
      location: "locationDesc",
      salary: "salaryDesc",
      postedDate: "jobPostTime (relative → ISO)",
      description:
        "jobTypeDesc + experience + educationDesc + skills joined; detail API translateJobDesc/jobDesc",
      url: "/hk/job/{jobId}",
    },
    quirks: [
      "Public JSON API: POST /wapi/geek/recommend/search/list (code===0, data.resultList)",
      "jobId is encrypted — used for /wapi/geek/recommend/jobDetail?encryptJobId=",
      "postedDate is relative ('2 days ago') — normalizer converts",
      "Description assembled from several short fields on listing; full text on detail API",
      "hasMore flag drives pagination; pageSize 30",
      "Detail API prefers translateJobDesc (English) over jobDesc",
    ],
  },
};

/** Ordered list of board keys (stable, used for iteration). */
export const BOARD_KEYS = Object.keys(BOARD_PATTERNS) as BoardKey[];

/** Get a pattern by key (undefined-safe). */
export function getBoardPattern(key: string): BoardPattern | undefined {
  return BOARD_PATTERNS[key as BoardKey];
}

/** All display names (used by the frontend board chips). */
export function boardDisplayName(key: string): string {
  return getBoardPattern(key)?.displayName ?? key;
}

export interface Job {
  source: string;
  title: string;
  company: string;
  location: string;
  salary?: string;
  postedDate?: string;
  url: string;
  description?: string;
}

/** Common interface that all scrapers (Playwright-based and fetch-based) implement. */
export interface JobScraper {
  readonly name: string;
  log: (msg: string) => void;
  scrape(keyword: string, pages?: number): Promise<Job[]>;
}

/**
 * CSS selector configuration used by the shared DOM extractor.
 * Each field is an ordered array of selectors tried one by one until a non-empty
 * text value is found. `card` is the root element that groups one job listing.
 */
export interface DomSelectors {
  /** One or more selectors for the card root; the first that returns results wins */
  card: string[];
  title: string[];
  company: string[];
  location: string[];
  salary?: string[];
  postedDate?: string[];
  description?: string[];
  /** Selector for the <a> tag inside a card */
  link?: string[];
}

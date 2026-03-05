export interface Job {
  source: string; // which job board this came from
  title: string;
  company: string;
  location: string;
  salary?: string;
  postedDate?: string;
  url: string;
  description?: string;
}


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

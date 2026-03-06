export interface Job {
  source?: string;
  title: string;
  company: string;
  location: string;
  salary?: string;
  postedDate?: string;
  url: string;
  description?: string;
}

export interface JobDetail {
  responsibilities: string[];
  requirements: string[];
  benefits: string[];
  skills: string[];
  employmentType?: string;
  experienceLevel?: string;
  aboutCompany?: string;
  rawDescription: string;
}

export interface FitAnalysis {
  fit: boolean;
  score: number;
  reasons: string[];
  coverLetter?: string;
  expectedSalary?: string;
}

export type EnrichedJob = Job & { jobDetail: JobDetail };
export type AnalysedJob = EnrichedJob & { fitAnalysis?: FitAnalysis };

export interface PipelineOptions {
  keyword: string;
  pages?: number;
  force?: boolean;
  log?: (msg: string) => void;
  userId?: string;
  /** Which job boards to scrape. Defaults to DEFAULT_BOARDS (jobsdb, ctgoodjobs). Pass ["indeed"] to opt-in. */
  boards?: string[];
}

export interface PipelineResult {
  keyword: string;
  scrapedDate: string;
  total: number;
  fit: number;
  jobs: AnalysedJob[];
}

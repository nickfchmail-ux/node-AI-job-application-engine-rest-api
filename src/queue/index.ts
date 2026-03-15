import { Queue } from "bullmq";
import { redisConnection } from "./redis";
import type { Job as ScrapedJob } from "../pipeline/types";

// ── Job data types (discriminated union) ────────────────────────────────────

/** Phase 1 – scrape listings and fan-out child jobs */
export interface ScrapeJobData {
  type: "scrape";
  keyword: string;
  pages: number;
  force: boolean;
  boards?: string[];
  userId: string;
}

/** Phase 2 – enrich + analyse + persist ONE listing */
export interface ProcessJobData {
  type: "process-job";
  scrapedJob: ScrapedJob;
  resumeText: string;
  safeKeyword: string;
  scrapedDate: string;
  userId: string;
  force: boolean;
  parentJobId: string;
}

export type PipelineJobData = ScrapeJobData | ProcessJobData;

/** Shape returned by a completed "scrape" parent job */
export interface ScrapeResult {
  childJobIds: string[];
  totalJobs: number;
  keyword: string;
  scrapedDate: string;
}

export const QUEUE_NAME = "pipelines";

export const pipelineQueue = new Queue<PipelineJobData, unknown, string>(
  QUEUE_NAME,
  {
    connection: redisConnection,
    defaultJobOptions: {
      // Keep completed/failed jobs for 24h so GET /jobs/:jobId still works
      removeOnComplete: { age: 21_600 },
      removeOnFail: { age: 21_600 },
      attempts: 1, // pipelines are not safe to auto-retry (side effects)
    },
  },
);

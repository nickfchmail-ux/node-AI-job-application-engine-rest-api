# AI powered Job Application Engine — rest api

Automated job scraper and applicant assistant for Hong Kong job boards (JobsDB, CTgoodjobs).

## What it does

- Scrapes job listings from JobsDB and CTgoodjobs
- Enriches each listing with full job description
- Reads your resume from Supabase storage
- Uses DeepSeek AI to score job fit and generate cover letters
- Exposes a REST API (Express + JWT) for a frontend to consume

## Stack

- Node.js / TypeScript
- Playwright (scraping)
- Supabase (database + resume storage)
- DeepSeek API (AI analysis)
- Railway (deployment)

## Setup

1. Clone the repo
2. Copy `.env.example` to `.env` and fill in your keys
3. `npm install`
4. `npm start`



## Note
> For expriencing fast development,
> 95% of the code in this project was written by AI spending 2 days (GitHub Copilot / Claude) with simple and modular guidances.

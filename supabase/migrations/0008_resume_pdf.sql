-- ============================================================
--  0008_resume_pdf.sql
--  Add PDF URL columns for the generated resumes.
--
--  generated_resumes.pdf_url  → public PDF URL (if generated)
--  jobs.resume_pdf_url        → mirrored on the job row for easy
--                               frontend access via Realtime
-- ============================================================

ALTER TABLE generated_resumes
  ADD COLUMN IF NOT EXISTS pdf_url TEXT;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS resume_pdf_url TEXT;

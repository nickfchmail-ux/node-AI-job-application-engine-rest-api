-- ============================================================
--  0012_jobs_quality_contract.sql
--  Persist the normalized quality contract so EVERY board's job
--  exposes the same structured shape to the frontend.
--
--  Added to `jobs`:
--    salary_min / salary_max      → numeric salary range (sortable)
--    salary_period                → month | year | hour | day | null
--    salary_currency              → ISO 4217 (HKD, USD, ...)
--    salary_confidence            → high | medium | low | none
--    data_quality                 → jsonb { completeness, has_salary, ... }
-- ============================================================

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS salary_min      INTEGER,
  ADD COLUMN IF NOT EXISTS salary_max      INTEGER,
  ADD COLUMN IF NOT EXISTS salary_period   TEXT
    CHECK (salary_period IN ('month','year','hour','day') OR salary_period IS NULL),
  ADD COLUMN IF NOT EXISTS salary_currency TEXT,
  ADD COLUMN IF NOT EXISTS salary_confidence TEXT
    CHECK (salary_confidence IN ('high','medium','low','none') OR salary_confidence IS NULL),
  ADD COLUMN IF NOT EXISTS data_quality    JSONB;

-- Indexes for frontend filtering/sorting on salary
CREATE INDEX IF NOT EXISTS idx_jobs_salary_min ON jobs (salary_min) WHERE salary_min IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_salary_currency ON jobs (salary_currency) WHERE salary_currency IS NOT NULL;

COMMENT ON COLUMN jobs.salary_min IS 'Parsed numeric lower bound of the salary range (consistent across boards).';
COMMENT ON COLUMN jobs.salary_max IS 'Parsed numeric upper bound of the salary range (consistent across boards).';
COMMENT ON COLUMN jobs.salary_period IS 'Salary frequency: month / year / hour / day, when detectable.';
COMMENT ON COLUMN jobs.salary_currency IS 'ISO 4217 currency code when detectable (HKD, USD, ...).';
COMMENT ON COLUMN jobs.salary_confidence IS 'How reliable the salary parse is: high / medium / low / none.';
COMMENT ON COLUMN jobs.data_quality IS 'jsonb quality signals: { completeness, has_salary, has_description, has_posted_date, has_location }.';

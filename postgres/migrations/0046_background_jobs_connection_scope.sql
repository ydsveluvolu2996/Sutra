ALTER TABLE background_jobs
  ADD COLUMN IF NOT EXISTS connection_id text;

CREATE INDEX IF NOT EXISTS background_jobs_connection
  ON background_jobs (org_id, connection_id, kind, status, run_after);

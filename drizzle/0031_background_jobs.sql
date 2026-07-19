CREATE TABLE IF NOT EXISTS background_jobs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'succeeded', 'failed', 'dead_letter')),
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  lease_expires_at INTEGER,
  run_after INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS background_jobs_ready ON background_jobs (org_id, kind, status, run_after);
CREATE INDEX IF NOT EXISTS background_jobs_scope ON background_jobs (org_id, customer_id, created_at);

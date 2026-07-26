-- SQLite/D1 mirror of postgres/migrations/0049_background_jobs_kind_index.sql.
-- Supporting index for JobQueueRepository.leaseNext(kind), which filters
-- background_jobs by (kind, status, run_after) with no org_id and so could not
-- use the org_id-leading indexes. Additive and idempotent.
CREATE INDEX IF NOT EXISTS background_jobs_kind_ready
  ON background_jobs (kind, status, run_after);

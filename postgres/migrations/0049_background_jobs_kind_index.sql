-- Supporting index for the cross-tenant job poller.
--
-- JobQueueRepository.leaseNext(kind) — the system worker's hot path — filters
-- background_jobs by (kind, status, run_after) with NO org_id, so it could not
-- use the existing org_id-leading indexes (background_jobs_ready /
-- background_jobs_connection) and fell back to a sequential scan on every poll.
-- This composite index makes that lease lookup index-driven as the table grows.
--
-- Additive and idempotent (CREATE INDEX IF NOT EXISTS); no data change.
CREATE INDEX IF NOT EXISTS background_jobs_kind_ready
  ON background_jobs (kind, status, run_after);

-- Platform health probe samples for the public /status page. This is
-- SYSTEM/platform health, NOT tenant data: there is deliberately no org_id and
-- no foreign key into any tenant-gated table. Each row is one recorded
-- observation of one platform component (web app, database, background job
-- runner, collector) captured by the uptime-probe background job. The status
-- page derives current state and uptime % strictly from these recorded rows —
-- a component with no sample is honestly "unknown", never assumed operational.
CREATE TABLE IF NOT EXISTS uptime_samples (
  id TEXT PRIMARY KEY,
  component TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  healthy INTEGER NOT NULL DEFAULT 0 CHECK (healthy IN (0, 1)),
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS uptime_samples_component_observed ON uptime_samples (component, observed_at);

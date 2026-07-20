CREATE TABLE IF NOT EXISTS finops_scheduled_reports (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly')),
  delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('webhook', 'email')),
  delivery_target TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_run_at TEXT,
  next_run_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS finops_scheduled_reports_name ON finops_scheduled_reports (org_id, name);
CREATE INDEX IF NOT EXISTS finops_scheduled_reports_due ON finops_scheduled_reports (enabled, next_run_at);

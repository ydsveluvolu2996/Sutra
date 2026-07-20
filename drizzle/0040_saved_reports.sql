CREATE TABLE IF NOT EXISTS saved_reports (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT,
  name TEXT NOT NULL,
  dataset TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS saved_reports_name ON saved_reports (org_id, name);

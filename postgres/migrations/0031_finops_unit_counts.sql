CREATE TABLE IF NOT EXISTS finops_unit_counts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  period TEXT NOT NULL,
  unit_label TEXT NOT NULL,
  unit_count INTEGER NOT NULL DEFAULT 0 CHECK (unit_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS finops_unit_counts_key ON finops_unit_counts (org_id, customer_id, period, unit_label);

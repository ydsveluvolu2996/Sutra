CREATE TABLE IF NOT EXISTS finops_cur_lines (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  billing_period TEXT NOT NULL,
  line_item_id TEXT NOT NULL,
  usage_account_id TEXT NOT NULL,
  service TEXT NOT NULL,
  charge_category TEXT NOT NULL,
  usage_start TEXT NOT NULL,
  amount_micros TEXT NOT NULL,
  currency TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS finops_cur_lines_scope ON finops_cur_lines (org_id, customer_id, connection_id, billing_period);
CREATE TABLE IF NOT EXISTS finops_budgets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  limit_micros TEXT NOT NULL,
  filter_json TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS finops_budgets_name ON finops_budgets (org_id, name);

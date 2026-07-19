CREATE TABLE IF NOT EXISTS custom_frameworks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  claim_boundary TEXT NOT NULL,
  controls_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS custom_frameworks_name ON custom_frameworks (org_id, name);
CREATE TABLE IF NOT EXISTS control_assignments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  control_id TEXT NOT NULL,
  owner_team TEXT,
  owner_email TEXT,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS control_assignments_scope ON control_assignments (org_id, control_id);
CREATE TABLE IF NOT EXISTS compliance_signoffs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  report_sha256 TEXT NOT NULL,
  decision TEXT NOT NULL,
  note TEXT,
  signed_by TEXT NOT NULL,
  mfa_verified INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS compliance_signoffs_scope ON compliance_signoffs (org_id, connection_id, created_at);
CREATE TABLE IF NOT EXISTS compliance_trend_points (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  framework_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  collected_at INTEGER NOT NULL,
  pass_count INTEGER NOT NULL,
  fail_count INTEGER NOT NULL,
  unknown_count INTEGER NOT NULL,
  not_collected_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS compliance_trend_identity ON compliance_trend_points (org_id, connection_id, framework_id, snapshot_id);

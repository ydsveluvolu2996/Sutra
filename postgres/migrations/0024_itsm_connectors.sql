CREATE TABLE IF NOT EXISTS itsm_connectors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  connector_type TEXT NOT NULL CHECK (connector_type IN ('jira', 'servicenow')),
  base_url TEXT NOT NULL,
  project_key TEXT,
  shared_secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS itsm_connectors_name ON itsm_connectors (org_id, name);
CREATE INDEX IF NOT EXISTS itsm_connectors_scope ON itsm_connectors (org_id, customer_id, enabled);

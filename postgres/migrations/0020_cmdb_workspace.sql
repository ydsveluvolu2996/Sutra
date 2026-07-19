CREATE TABLE IF NOT EXISTS resource_annotations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  owner_team TEXT,
  owner_email TEXT,
  custom_fields_json TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS resource_annotations_scope ON resource_annotations (org_id, connection_id, resource_key);
CREATE INDEX IF NOT EXISTS resource_annotations_customer ON resource_annotations (org_id, customer_id);
CREATE TABLE IF NOT EXISTS cmdb_saved_queries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  query_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cmdb_saved_queries_name ON cmdb_saved_queries (org_id, name);

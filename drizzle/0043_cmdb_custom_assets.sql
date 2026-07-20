CREATE TABLE IF NOT EXISTS cmdb_custom_assets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  external_id TEXT,
  fields_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cmdb_custom_assets_key ON cmdb_custom_assets (org_id, asset_type, name);
CREATE INDEX IF NOT EXISTS cmdb_custom_assets_scope ON cmdb_custom_assets (org_id, customer_id, asset_type);

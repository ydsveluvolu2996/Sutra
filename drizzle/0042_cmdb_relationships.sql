CREATE TABLE IF NOT EXISTS cmdb_manual_relationships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  from_key TEXT NOT NULL,
  to_key TEXT NOT NULL,
  rel_type TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cmdb_manual_relationships_edge ON cmdb_manual_relationships (org_id, from_key, to_key, rel_type);
CREATE INDEX IF NOT EXISTS cmdb_manual_relationships_customer ON cmdb_manual_relationships (org_id, customer_id);

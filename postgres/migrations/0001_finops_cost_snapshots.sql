CREATE TABLE IF NOT EXISTS cost_snapshots (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  source text DEFAULT 'aws_cost_explorer' NOT NULL,
  status text NOT NULL,
  currency text NOT NULL,
  period_start text NOT NULL,
  period_end text NOT NULL,
  collected_at bigint NOT NULL,
  payload_json text NOT NULL,
  payload_sha256 text NOT NULL,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS cost_snapshots_connection_hash_uq ON cost_snapshots (org_id, connection_id, payload_sha256);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cost_snapshots_scope_time_idx ON cost_snapshots (org_id, customer_id, connection_id, collected_at, id);

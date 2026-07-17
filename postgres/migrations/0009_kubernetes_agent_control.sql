CREATE TABLE IF NOT EXISTS kubernetes_agent_bootstraps (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  cluster_id text NOT NULL REFERENCES kubernetes_clusters(id),
  token_digest text NOT NULL,
  expires_at bigint NOT NULL,
  consumed_at bigint,
  consumed_agent_id text,
  created_by text NOT NULL REFERENCES users(id),
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS kubernetes_agent_bootstraps_digest_uq ON kubernetes_agent_bootstraps (token_digest);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS kubernetes_agent_bootstraps_scope_expiry_idx ON kubernetes_agent_bootstraps (org_id, customer_id, connection_id, cluster_id, expires_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kubernetes_agents (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  cluster_id text NOT NULL REFERENCES kubernetes_clusters(id),
  status text DEFAULT 'active' NOT NULL,
  current_token_digest text NOT NULL,
  previous_token_digest text,
  previous_token_expires_at bigint,
  credential_expires_at bigint NOT NULL,
  agent_version text NOT NULL,
  capabilities_json text NOT NULL,
  deployment_namespace text,
  deployment_pod_name text,
  deployment_started_at bigint,
  module_health_json text DEFAULT '{}' NOT NULL,
  last_heartbeat_at bigint,
  last_scan_at bigint,
  enrolled_at bigint NOT NULL,
  rotated_at bigint,
  revoked_at bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS kubernetes_agents_current_digest_uq ON kubernetes_agents (current_token_digest);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS kubernetes_agents_previous_digest_uq ON kubernetes_agents (previous_token_digest) WHERE previous_token_digest IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS kubernetes_agents_active_cluster_uq ON kubernetes_agents (org_id, customer_id, cluster_id) WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS kubernetes_agents_scope_health_idx ON kubernetes_agents (org_id, customer_id, connection_id, cluster_id, status, last_heartbeat_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kubernetes_agent_scan_receipts (
  id text PRIMARY KEY NOT NULL,
  agent_id text NOT NULL REFERENCES kubernetes_agents(id),
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  cluster_id text NOT NULL REFERENCES kubernetes_clusters(id),
  idempotency_key text NOT NULL,
  payload_sha256 text NOT NULL,
  scan_run_id text NOT NULL REFERENCES kubernetes_scan_runs(id),
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS kubernetes_agent_scan_receipts_idempotency_uq ON kubernetes_agent_scan_receipts (agent_id, idempotency_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS kubernetes_agent_scan_receipts_scope_time_idx ON kubernetes_agent_scan_receipts (org_id, customer_id, connection_id, cluster_id, created_at);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sutra_reject_kubernetes_agent_receipt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'kubernetes agent scan receipts are immutable'; END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS kubernetes_agent_scan_receipts_no_update ON kubernetes_agent_scan_receipts;
--> statement-breakpoint
CREATE TRIGGER kubernetes_agent_scan_receipts_no_update BEFORE UPDATE ON kubernetes_agent_scan_receipts FOR EACH ROW EXECUTE FUNCTION sutra_reject_kubernetes_agent_receipt_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS kubernetes_agent_scan_receipts_no_delete ON kubernetes_agent_scan_receipts;
--> statement-breakpoint
CREATE TRIGGER kubernetes_agent_scan_receipts_no_delete BEFORE DELETE ON kubernetes_agent_scan_receipts FOR EACH ROW EXECUTE FUNCTION sutra_reject_kubernetes_agent_receipt_mutation();

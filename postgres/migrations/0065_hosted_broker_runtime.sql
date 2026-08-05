CREATE TABLE IF NOT EXISTS hosted_broker_connections (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  encrypted_state text,
  state_sha256 text,
  tombstoned_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, connection_id),
  CHECK (
    (tombstoned_at IS NULL AND encrypted_state IS NOT NULL AND state_sha256 IS NOT NULL)
    OR
    (tombstoned_at IS NOT NULL AND encrypted_state IS NULL AND state_sha256 IS NULL)
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hosted_broker_request_nonces (
  nonce_key text PRIMARY KEY NOT NULL,
  expires_at bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hosted_broker_request_nonces_expiry_idx
  ON hosted_broker_request_nonces (expires_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hosted_broker_operation_leases (
  operation_key text PRIMARY KEY NOT NULL,
  lease_token text NOT NULL,
  lease_owner text NOT NULL,
  expires_at bigint NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hosted_broker_operation_leases_expiry_idx
  ON hosted_broker_operation_leases (expires_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hosted_broker_agentless_runs (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  connection_id text NOT NULL,
  phase text NOT NULL,
  request_json text NOT NULL,
  request_sha256 text NOT NULL,
  execution_json text,
  error_code text,
  error_message text,
  lease_token text,
  lease_owner text,
  lease_expires_at bigint,
  started_at bigint NOT NULL,
  finished_at bigint,
  updated_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, run_id),
  CHECK (phase IN ('running', 'recovering', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hosted_broker_agentless_runs_recovery_idx
  ON hosted_broker_agentless_runs (phase, lease_expires_at, updated_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hosted_broker_agentless_resources (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  connection_id text NOT NULL,
  source_volume_id text NOT NULL,
  resource_id text NOT NULL,
  resource_kind text NOT NULL,
  account_scope text NOT NULL,
  region text NOT NULL,
  deleted_at bigint,
  last_error text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, run_id, resource_id),
  CHECK (resource_kind IN ('customer_snapshot', 'scan_snapshot', 'scan_volume', 'scan_instance')),
  CHECK (account_scope IN ('customer', 'sutra-scan-account'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hosted_broker_agentless_resources_open_idx
  ON hosted_broker_agentless_resources (tenant_id, run_id, deleted_at, created_at);

-- PostgreSQL 18 baseline for the local Sutra control plane.
-- Keep table and index names aligned with db/schema.ts and the D1 migrations.
CREATE TABLE IF NOT EXISTS organizations (
  id text PRIMARY KEY NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_uq ON organizations (slug);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  email text NOT NULL,
  display_name text,
  status text DEFAULT 'active' NOT NULL,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_issuer_subject_uq ON users (issuer, subject);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_issuer_email_uq ON users (issuer, email);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS local_password_credentials (
  user_id text PRIMARY KEY NOT NULL REFERENCES users(id),
  algorithm text NOT NULL,
  iterations integer NOT NULL,
  salt text NOT NULL,
  password_hash text NOT NULL,
  failed_attempts integer DEFAULT 0 NOT NULL,
  locked_until bigint,
  changed_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS memberships (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  user_id text NOT NULL REFERENCES users(id),
  role text NOT NULL,
  scope_mode text DEFAULT 'assigned_customers' NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS memberships_org_user_uq ON memberships (org_id, user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS memberships_org_user_status_idx ON memberships (org_id, user_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS local_sessions (
  id text PRIMARY KEY NOT NULL,
  token_digest text NOT NULL,
  user_id text NOT NULL REFERENCES users(id),
  selected_org_id text NOT NULL REFERENCES organizations(id),
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  expires_at bigint NOT NULL,
  last_seen_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  mfa_verified_at bigint,
  revoked_at bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS local_sessions_token_digest_uq ON local_sessions (token_digest);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS local_sessions_user_expiry_idx ON local_sessions (user_id, expires_at, revoked_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS totp_credentials (
  user_id text PRIMARY KEY NOT NULL REFERENCES users(id),
  secret_ciphertext text NOT NULL,
  secret_key_version text NOT NULL,
  confirmed_at bigint,
  last_used_step bigint,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS customers (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  slug text NOT NULL,
  name text NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS customers_org_slug_uq ON customers (org_id, slug);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS customers_org_id_uq ON customers (org_id, id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS customer_access (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  membership_id text NOT NULL REFERENCES memberships(id),
  role text NOT NULL,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS customer_access_scope_uq ON customer_access (org_id, customer_id, membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_access_member_idx ON customer_access (org_id, membership_id, customer_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS aws_connections (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  source_kind text DEFAULT 'aws_trust_role' NOT NULL,
  fixture_id text,
  fixture_version text,
  partition text DEFAULT 'aws' NOT NULL,
  aws_account_id text NOT NULL,
  role_arn text NOT NULL,
  external_id_ciphertext text NOT NULL,
  external_id_key_version text NOT NULL,
  permission_pack_version text NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  enabled_regions_json text DEFAULT '[]' NOT NULL,
  last_validated_at bigint,
  last_successful_sync_at bigint,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS aws_connections_customer_account_uq ON aws_connections (org_id, customer_id, partition, aws_account_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS aws_connections_scope_status_idx ON aws_connections (org_id, customer_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sync_runs (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  trigger_kind text NOT NULL,
  schedule_id text,
  status text NOT NULL,
  coverage_state text DEFAULT 'unknown' NOT NULL,
  collector_pack_version text NOT NULL,
  totals_json text DEFAULT '{}' NOT NULL,
  idempotency_key text NOT NULL,
  started_at bigint,
  finished_at bigint,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS sync_runs_connection_idempotency_uq ON sync_runs (org_id, connection_id, idempotency_key);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS sync_runs_one_active_connection_uq ON sync_runs (org_id, connection_id) WHERE status IN ('queued', 'running');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sync_runs_scope_started_idx ON sync_runs (org_id, customer_id, connection_id, started_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS collector_runs (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  sync_run_id text NOT NULL REFERENCES sync_runs(id),
  collector_key text NOT NULL,
  region_key text NOT NULL,
  status text NOT NULL,
  items_observed integer DEFAULT 0 NOT NULL,
  pages_observed integer DEFAULT 0 NOT NULL,
  error_code text,
  error_message text,
  started_at bigint,
  finished_at bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS collector_runs_sync_collector_region_uq ON collector_runs (sync_run_id, collector_key, region_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS collector_runs_scope_sync_idx ON collector_runs (org_id, customer_id, connection_id, sync_run_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cmdb_snapshots (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  sync_run_id text NOT NULL REFERENCES sync_runs(id),
  status text DEFAULT 'staging' NOT NULL,
  collected_at bigint NOT NULL,
  completed_at bigint,
  coverage_json text DEFAULT '{}' NOT NULL,
  summary_json text DEFAULT '{}' NOT NULL,
  snapshot_sha256 text,
  origin_kind text DEFAULT 'unknown' NOT NULL,
  fixture_id text,
  fixture_version text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS cmdb_snapshots_sync_run_uq ON cmdb_snapshots (sync_run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cmdb_snapshots_connection_time_idx ON cmdb_snapshots (org_id, connection_id, collected_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS connection_heads (
  connection_id text PRIMARY KEY NOT NULL REFERENCES aws_connections(id),
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  snapshot_id text NOT NULL REFERENCES cmdb_snapshots(id),
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS connection_heads_scope_idx ON connection_heads (org_id, customer_id, connection_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cmdb_resources (
  id text PRIMARY KEY NOT NULL,
  snapshot_id text NOT NULL REFERENCES cmdb_snapshots(id),
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  resource_key text NOT NULL,
  provider_key text DEFAULT 'aws' NOT NULL,
  service text NOT NULL,
  resource_type text NOT NULL,
  native_id text NOT NULL,
  arn text,
  name text,
  region_key text NOT NULL,
  state text DEFAULT 'unknown' NOT NULL,
  tags_json text DEFAULT '{}' NOT NULL,
  configuration_json text DEFAULT '{}' NOT NULL,
  source_json text DEFAULT '{}' NOT NULL,
  content_sha256 text NOT NULL,
  collected_at bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS cmdb_resources_snapshot_key_uq ON cmdb_resources (snapshot_id, resource_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cmdb_resources_scope_type_idx ON cmdb_resources (org_id, customer_id, connection_id, resource_type, region_key);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cmdb_change_events (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  from_snapshot_id text REFERENCES cmdb_snapshots(id),
  to_snapshot_id text NOT NULL REFERENCES cmdb_snapshots(id),
  resource_key text NOT NULL,
  change_type text NOT NULL,
  changed_paths_json text DEFAULT '[]' NOT NULL,
  before_json text,
  after_json text,
  occurred_at bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS cmdb_change_events_snapshot_resource_uq ON cmdb_change_events (to_snapshot_id, resource_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cmdb_change_events_scope_time_idx ON cmdb_change_events (org_id, customer_id, connection_id, occurred_at, id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cmdb_relationships (
  id text PRIMARY KEY NOT NULL,
  snapshot_id text NOT NULL REFERENCES cmdb_snapshots(id),
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  from_resource_key text NOT NULL,
  to_resource_key text NOT NULL,
  relation_type text NOT NULL,
  evidence_json text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS cmdb_relationships_snapshot_edge_uq ON cmdb_relationships (snapshot_id, from_resource_key, to_resource_key, relation_type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cmdb_relationships_scope_from_idx ON cmdb_relationships (org_id, customer_id, connection_id, from_resource_key);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cmdb_findings (
  id text PRIMARY KEY NOT NULL,
  snapshot_id text NOT NULL REFERENCES cmdb_snapshots(id),
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  resource_key text,
  control_key text NOT NULL,
  control_version text NOT NULL,
  fingerprint text NOT NULL,
  severity text NOT NULL,
  status text DEFAULT 'open' NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  remediation text NOT NULL,
  evidence_json text NOT NULL,
  evaluated_at bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS cmdb_findings_snapshot_fingerprint_uq ON cmdb_findings (snapshot_id, fingerprint);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cmdb_findings_scope_severity_idx ON cmdb_findings (org_id, customer_id, connection_id, status, severity);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS finding_workflow_states (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  fingerprint text NOT NULL,
  status text NOT NULL,
  note text,
  actor_id text NOT NULL,
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS finding_workflow_scope_fingerprint_uq ON finding_workflow_states (org_id, connection_id, fingerprint);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finding_workflow_scope_status_idx ON finding_workflow_states (org_id, customer_id, connection_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS local_job_publications (
  job_id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  sync_run_id text NOT NULL REFERENCES sync_runs(id),
  snapshot_id text NOT NULL REFERENCES cmdb_snapshots(id),
  fixture_id text NOT NULL,
  fixture_version text NOT NULL,
  schedule_id text,
  actor_id text NOT NULL,
  published_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS local_job_publications_sync_uq ON local_job_publications (org_id, sync_run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS local_job_publications_scope_time_idx ON local_job_publications (org_id, customer_id, published_at, job_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS resources (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  provider_key text NOT NULL,
  aws_account_id text NOT NULL,
  region_key text NOT NULL,
  resource_type text NOT NULL,
  native_id text NOT NULL,
  arn text,
  name text,
  lifecycle_state text DEFAULT 'active' NOT NULL,
  configuration_json text DEFAULT '{}' NOT NULL,
  content_sha256 text NOT NULL,
  first_seen_at bigint NOT NULL,
  last_seen_at bigint NOT NULL,
  seen_in_run_id text REFERENCES sync_runs(id),
  deleted_at bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS resources_provider_identity_uq ON resources (org_id, connection_id, resource_type, region_key, native_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS resources_scope_type_state_idx ON resources (org_id, customer_id, lifecycle_state, resource_type, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS resources_scope_account_region_idx ON resources (org_id, customer_id, aws_account_id, region_key, id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS control_versions (
  id text PRIMARY KEY NOT NULL,
  control_key text NOT NULL,
  version text NOT NULL,
  title text NOT NULL,
  default_severity text NOT NULL,
  rule_ast_json text NOT NULL,
  remediation_json text NOT NULL,
  released_at bigint NOT NULL,
  retired_at bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS control_versions_key_version_uq ON control_versions (control_key, version);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS findings (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  resource_id text REFERENCES resources(id),
  control_key text NOT NULL,
  fingerprint text NOT NULL,
  severity text NOT NULL,
  confidence text DEFAULT 'high' NOT NULL,
  status text DEFAULT 'open' NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  current_evidence_json text NOT NULL,
  first_seen_at bigint NOT NULL,
  last_seen_at bigint NOT NULL,
  resolved_at bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS findings_org_fingerprint_uq ON findings (org_id, fingerprint);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS findings_scope_status_severity_idx ON findings (org_id, customer_id, status, severity, last_seen_at, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS findings_scope_resource_status_idx ON findings (org_id, customer_id, resource_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text REFERENCES customers(id),
  occurred_at bigint NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  outcome text NOT NULL,
  request_id text NOT NULL,
  metadata_json text DEFAULT '{}' NOT NULL,
  previous_event_hash text,
  event_hash text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_events_org_time_idx ON audit_events (org_id, occurred_at, id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS audit_events_org_request_id_uq ON audit_events (org_id, request_id);
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS local_schedule_mutation_sequence AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS local_schedule_mutation_outbox (
  operation_id text PRIMARY KEY NOT NULL,
  mutation_sequence bigint DEFAULT nextval('local_schedule_mutation_sequence'),
  org_id text NOT NULL REFERENCES organizations(id),
  actor_id text NOT NULL,
  customer_id text REFERENCES customers(id),
  schedule_id text NOT NULL,
  fixture_id text NOT NULL,
  connection_id text NOT NULL,
  operation_kind text NOT NULL,
  command_json text NOT NULL,
  command_sha256 text NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  completed_at bigint,
  failure_code text,
  failed_at bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS local_schedule_mutation_outbox_sequence_uq ON local_schedule_mutation_outbox (mutation_sequence);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS local_schedule_mutation_outbox_pending_idx ON local_schedule_mutation_outbox (org_id, status, created_at, operation_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS local_schedule_mutation_outbox_scope_idx ON local_schedule_mutation_outbox (org_id, customer_id, schedule_id, created_at);

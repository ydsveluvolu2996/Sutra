CREATE TABLE IF NOT EXISTS security_event_sources (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  source text DEFAULT 'aws_cloudtrail_lookup_events' NOT NULL,
  status text DEFAULT 'NOT_COLLECTED' NOT NULL,
  retention_days integer DEFAULT 30 NOT NULL,
  lookback_hours integer DEFAULT 1 NOT NULL,
  overlap_minutes integer DEFAULT 5 NOT NULL,
  last_window_start bigint,
  last_window_end bigint,
  last_collected_at bigint,
  last_run_id text,
  last_error_code text,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS security_event_sources_scope_uq ON security_event_sources (org_id, customer_id, connection_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS security_event_runs (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  source text DEFAULT 'aws_cloudtrail_lookup_events' NOT NULL,
  status text NOT NULL,
  window_start bigint NOT NULL,
  window_end bigint NOT NULL,
  collected_at bigint NOT NULL,
  finished_at bigint NOT NULL,
  coverage_json text NOT NULL,
  events_observed integer DEFAULT 0 NOT NULL,
  events_inserted integer DEFAULT 0 NOT NULL,
  duplicate_events integer DEFAULT 0 NOT NULL,
  detections_observed integer DEFAULT 0 NOT NULL,
  payload_sha256 text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS security_event_runs_scope_hash_uq ON security_event_runs (org_id, connection_id, payload_sha256);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS security_event_runs_scope_time_idx ON security_event_runs (org_id, customer_id, connection_id, collected_at, id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS security_events (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  source_run_id text NOT NULL REFERENCES security_event_runs(id),
  provider_event_id text NOT NULL,
  account_id text NOT NULL,
  region_key text NOT NULL,
  event_time bigint NOT NULL,
  event_name text NOT NULL,
  event_source text NOT NULL,
  read_only integer,
  management_event integer,
  event_category text,
  username text,
  identity_type text,
  principal_arn text,
  source_ip text,
  user_agent text,
  error_code text,
  request_id text,
  console_login_result text,
  mfa_used integer,
  detail_status text NOT NULL,
  resources_json text DEFAULT '[]' NOT NULL,
  ingested_at bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS security_events_provider_identity_uq ON security_events (org_id, connection_id, provider_event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS security_events_scope_time_idx ON security_events (org_id, customer_id, connection_id, event_time, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS security_events_scope_name_idx ON security_events (org_id, customer_id, connection_id, event_name, region_key, event_time);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS security_event_detections (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  source_run_id text NOT NULL REFERENCES security_event_runs(id),
  rule_key text NOT NULL,
  rule_version text NOT NULL,
  severity text NOT NULL,
  status text DEFAULT 'open' NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  first_event_at bigint NOT NULL,
  last_event_at bigint NOT NULL,
  event_ids_json text NOT NULL,
  evidence_json text NOT NULL,
  limitation text NOT NULL,
  note text,
  actor_id text REFERENCES users(id),
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS security_event_detections_scope_id_uq ON security_event_detections (org_id, connection_id, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS security_event_detections_scope_status_idx ON security_event_detections (org_id, customer_id, connection_id, status, severity, last_event_at, id);

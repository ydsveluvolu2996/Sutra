CREATE TABLE IF NOT EXISTS falco_ingestion_nonces (
  cluster_id text NOT NULL REFERENCES kubernetes_clusters(id),
  key_id text NOT NULL,
  nonce_sha256 text NOT NULL,
  expires_at bigint NOT NULL,
  consumed_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  PRIMARY KEY (cluster_id, key_id, nonce_sha256)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS falco_ingestion_nonces_expiry_idx ON falco_ingestion_nonces (expires_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS falco_runtime_events (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  cluster_id text NOT NULL REFERENCES kubernetes_clusters(id),
  occurred_at bigint NOT NULL,
  rule_name text NOT NULL,
  priority text NOT NULL,
  source text NOT NULL,
  node_name text,
  namespace_name text,
  pod_name text,
  pod_uid text,
  container_id text,
  container_name text,
  container_image text,
  process_name text,
  process_executable text,
  process_id integer,
  parent_process_id integer,
  user_name text,
  user_id text,
  event_type text,
  evidence_json text NOT NULL,
  evidence_sha256 text NOT NULL,
  ingested_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS falco_runtime_events_cluster_evidence_uq ON falco_runtime_events (cluster_id, evidence_sha256);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS falco_runtime_events_scope_time_idx ON falco_runtime_events (org_id, customer_id, cluster_id, occurred_at, id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS falco_runtime_sources (
  cluster_id text PRIMARY KEY NOT NULL REFERENCES kubernetes_clusters(id),
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  last_heartbeat_at bigint,
  last_event_at bigint,
  falco_version text,
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS falco_runtime_sources_scope_idx ON falco_runtime_sources (org_id, customer_id, cluster_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sutra_reject_falco_runtime_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'falco runtime evidence is immutable'; END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS falco_runtime_events_no_update ON falco_runtime_events;
--> statement-breakpoint
CREATE TRIGGER falco_runtime_events_no_update BEFORE UPDATE ON falco_runtime_events
FOR EACH ROW EXECUTE FUNCTION sutra_reject_falco_runtime_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS falco_runtime_events_no_delete ON falco_runtime_events;
--> statement-breakpoint
CREATE TRIGGER falco_runtime_events_no_delete BEFORE DELETE ON falco_runtime_events
FOR EACH ROW EXECUTE FUNCTION sutra_reject_falco_runtime_mutation();

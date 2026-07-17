CREATE TABLE IF NOT EXISTS hubble_flow_evidence (
  id text PRIMARY KEY NOT NULL, org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id), cluster_id text NOT NULL REFERENCES kubernetes_clusters(id),
  observed_at bigint NOT NULL, source_namespace text, source_workload_kind text,
  source_workload_name text, source_service_name text, source_world integer NOT NULL,
  destination_namespace text, destination_workload_kind text, destination_workload_name text,
  destination_service_name text, destination_world integer NOT NULL, direction text NOT NULL,
  verdict text NOT NULL, protocol text NOT NULL, destination_port integer, observations integer NOT NULL,
  evidence_sha256 text NOT NULL, ingested_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS hubble_flow_cluster_evidence_uq ON hubble_flow_evidence (cluster_id, evidence_sha256);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hubble_flow_scope_time_idx ON hubble_flow_evidence (org_id, customer_id, cluster_id, observed_at, id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hubble_flow_sources (
  cluster_id text PRIMARY KEY NOT NULL REFERENCES kubernetes_clusters(id),
  org_id text NOT NULL REFERENCES organizations(id), customer_id text NOT NULL REFERENCES customers(id),
  hubble_version text NOT NULL, last_batch_at bigint NOT NULL, last_flow_at bigint,
  last_batch_sha256 text NOT NULL, updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hubble_flow_sources_scope_idx ON hubble_flow_sources (org_id, customer_id, cluster_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sutra_reject_hubble_flow_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Hubble flow evidence is immutable'; END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS hubble_flow_no_update ON hubble_flow_evidence;
--> statement-breakpoint
CREATE TRIGGER hubble_flow_no_update BEFORE UPDATE ON hubble_flow_evidence FOR EACH ROW EXECUTE FUNCTION sutra_reject_hubble_flow_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS hubble_flow_no_delete ON hubble_flow_evidence;
--> statement-breakpoint
CREATE TRIGGER hubble_flow_no_delete BEFORE DELETE ON hubble_flow_evidence FOR EACH ROW EXECUTE FUNCTION sutra_reject_hubble_flow_mutation();

CREATE TABLE IF NOT EXISTS kubernetes_clusters (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  cluster_uid text NOT NULL,
  name text NOT NULL,
  distribution text,
  version text,
  status text DEFAULT 'active' NOT NULL,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS kubernetes_clusters_scope_uid_uq ON kubernetes_clusters (org_id, customer_id, cluster_uid);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS kubernetes_clusters_scope_id_uq ON kubernetes_clusters (org_id, customer_id, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS kubernetes_clusters_scope_status_idx ON kubernetes_clusters (org_id, customer_id, status, name);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kubernetes_scan_runs (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  cluster_id text NOT NULL REFERENCES kubernetes_clusters(id),
  status text NOT NULL,
  collected_at bigint NOT NULL,
  idempotency_key text NOT NULL,
  evidence_sha256 text NOT NULL,
  posture_sha256 text NOT NULL,
  resource_count integer NOT NULL,
  finding_count integer NOT NULL,
  coverage_count integer NOT NULL,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS kubernetes_scan_runs_scope_idempotency_uq ON kubernetes_scan_runs (org_id, cluster_id, idempotency_key);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS kubernetes_scan_runs_scope_id_uq ON kubernetes_scan_runs (org_id, customer_id, cluster_id, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS kubernetes_scan_runs_scope_time_idx ON kubernetes_scan_runs (org_id, customer_id, cluster_id, collected_at, id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kubernetes_scan_heads (
  cluster_id text PRIMARY KEY NOT NULL REFERENCES kubernetes_clusters(id),
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  scan_run_id text NOT NULL REFERENCES kubernetes_scan_runs(id),
  collected_at bigint NOT NULL,
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS kubernetes_scan_heads_scope_idx ON kubernetes_scan_heads (org_id, customer_id, cluster_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kubernetes_scan_resources (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  cluster_id text NOT NULL REFERENCES kubernetes_clusters(id),
  scan_run_id text NOT NULL REFERENCES kubernetes_scan_runs(id),
  resource_key text NOT NULL,
  kind text NOT NULL,
  namespace text,
  name text NOT NULL,
  evidence_json text NOT NULL,
  evidence_sha256 text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS kubernetes_scan_resources_run_key_uq ON kubernetes_scan_resources (scan_run_id, resource_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS kubernetes_scan_resources_scope_kind_idx ON kubernetes_scan_resources (org_id, customer_id, cluster_id, kind, namespace, name);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kubernetes_scan_findings (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  cluster_id text NOT NULL REFERENCES kubernetes_clusters(id),
  scan_run_id text NOT NULL REFERENCES kubernetes_scan_runs(id),
  control_id text NOT NULL,
  subject text NOT NULL,
  state text NOT NULL,
  severity text NOT NULL,
  message text NOT NULL,
  evidence_json text NOT NULL,
  finding_sha256 text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS kubernetes_scan_findings_run_control_subject_uq ON kubernetes_scan_findings (scan_run_id, control_id, subject);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS kubernetes_scan_findings_scope_state_idx ON kubernetes_scan_findings (org_id, customer_id, cluster_id, state, severity, control_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kubernetes_scan_coverage (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  cluster_id text NOT NULL REFERENCES kubernetes_clusters(id),
  scan_run_id text NOT NULL REFERENCES kubernetes_scan_runs(id),
  evidence_kind text NOT NULL,
  state text NOT NULL,
  items_observed integer NOT NULL,
  error_code text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS kubernetes_scan_coverage_run_kind_uq ON kubernetes_scan_coverage (scan_run_id, evidence_kind);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS kubernetes_scan_coverage_scope_state_idx ON kubernetes_scan_coverage (org_id, customer_id, cluster_id, state, evidence_kind);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sutra_reject_kubernetes_scan_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'kubernetes scan evidence is immutable'; END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS kubernetes_scan_runs_no_update ON kubernetes_scan_runs;
--> statement-breakpoint
CREATE TRIGGER kubernetes_scan_runs_no_update BEFORE UPDATE ON kubernetes_scan_runs FOR EACH ROW EXECUTE FUNCTION sutra_reject_kubernetes_scan_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS kubernetes_scan_runs_no_delete ON kubernetes_scan_runs;
--> statement-breakpoint
CREATE TRIGGER kubernetes_scan_runs_no_delete BEFORE DELETE ON kubernetes_scan_runs FOR EACH ROW EXECUTE FUNCTION sutra_reject_kubernetes_scan_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS kubernetes_scan_resources_no_update ON kubernetes_scan_resources;
--> statement-breakpoint
CREATE TRIGGER kubernetes_scan_resources_no_update BEFORE UPDATE ON kubernetes_scan_resources FOR EACH ROW EXECUTE FUNCTION sutra_reject_kubernetes_scan_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS kubernetes_scan_resources_no_delete ON kubernetes_scan_resources;
--> statement-breakpoint
CREATE TRIGGER kubernetes_scan_resources_no_delete BEFORE DELETE ON kubernetes_scan_resources FOR EACH ROW EXECUTE FUNCTION sutra_reject_kubernetes_scan_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS kubernetes_scan_findings_no_update ON kubernetes_scan_findings;
--> statement-breakpoint
CREATE TRIGGER kubernetes_scan_findings_no_update BEFORE UPDATE ON kubernetes_scan_findings FOR EACH ROW EXECUTE FUNCTION sutra_reject_kubernetes_scan_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS kubernetes_scan_findings_no_delete ON kubernetes_scan_findings;
--> statement-breakpoint
CREATE TRIGGER kubernetes_scan_findings_no_delete BEFORE DELETE ON kubernetes_scan_findings FOR EACH ROW EXECUTE FUNCTION sutra_reject_kubernetes_scan_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS kubernetes_scan_coverage_no_update ON kubernetes_scan_coverage;
--> statement-breakpoint
CREATE TRIGGER kubernetes_scan_coverage_no_update BEFORE UPDATE ON kubernetes_scan_coverage FOR EACH ROW EXECUTE FUNCTION sutra_reject_kubernetes_scan_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS kubernetes_scan_coverage_no_delete ON kubernetes_scan_coverage;
--> statement-breakpoint
CREATE TRIGGER kubernetes_scan_coverage_no_delete BEFORE DELETE ON kubernetes_scan_coverage FOR EACH ROW EXECUTE FUNCTION sutra_reject_kubernetes_scan_mutation();

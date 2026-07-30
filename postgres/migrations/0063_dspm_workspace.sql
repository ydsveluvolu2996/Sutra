CREATE TABLE IF NOT EXISTS dspm_scan_runs (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  source text NOT NULL,
  status text NOT NULL,
  coverage_json text NOT NULL,
  evidence_sha256 text NOT NULL,
  asset_count integer NOT NULL,
  finding_count integer NOT NULL,
  collected_at bigint NOT NULL,
  imported_by text NOT NULL,
  idempotency_key text NOT NULL,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS dspm_scan_runs_scope_id_uq ON dspm_scan_runs (org_id, customer_id, connection_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS dspm_scan_runs_idempotency_uq ON dspm_scan_runs (org_id, connection_id, idempotency_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dspm_scan_runs_scope_time_idx ON dspm_scan_runs (org_id, customer_id, connection_id, collected_at, id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS dspm_asset_evidence (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  scan_run_id text NOT NULL REFERENCES dspm_scan_runs(id),
  resource_key text NOT NULL,
  resource_type text NOT NULL,
  region_key text NOT NULL,
  classification text NOT NULL,
  categories_json text NOT NULL,
  owner_ref text,
  encrypted integer,
  public_access integer,
  cross_account_access integer,
  external_sharing integer,
  credentials_detected integer,
  data_size_bytes bigint,
  risk_score integer NOT NULL,
  risk_severity text NOT NULL,
  risk_title text,
  risk_factors_json text NOT NULL,
  recommendations_json text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS dspm_asset_evidence_run_resource_uq ON dspm_asset_evidence (scan_run_id, resource_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dspm_asset_evidence_scope_risk_idx ON dspm_asset_evidence (org_id, customer_id, connection_id, risk_severity, risk_score);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS dspm_scan_heads (
  connection_id text PRIMARY KEY NOT NULL REFERENCES aws_connections(id),
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  scan_run_id text NOT NULL REFERENCES dspm_scan_runs(id),
  collected_at bigint NOT NULL,
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dspm_scan_heads_scope_idx ON dspm_scan_heads (org_id, customer_id, connection_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sutra_reject_dspm_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DSPM evidence is immutable';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS dspm_scan_runs_no_mutation ON dspm_scan_runs;
--> statement-breakpoint
CREATE TRIGGER dspm_scan_runs_no_mutation BEFORE UPDATE OR DELETE ON dspm_scan_runs
FOR EACH ROW EXECUTE FUNCTION sutra_reject_dspm_evidence_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS dspm_asset_evidence_no_mutation ON dspm_asset_evidence;
--> statement-breakpoint
CREATE TRIGGER dspm_asset_evidence_no_mutation BEFORE UPDATE OR DELETE ON dspm_asset_evidence
FOR EACH ROW EXECUTE FUNCTION sutra_reject_dspm_evidence_mutation();

CREATE TABLE gcp_billing_connections (
  id text PRIMARY KEY CHECK (id ~ '^gcpconn_[a-f0-9]{32}$'), org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE, provider text NOT NULL CHECK (provider='GCP'),
  billing_account_id text NOT NULL CHECK (billing_account_id ~ '^[0-9A-Z]{6}-[0-9A-Z]{6}-[0-9A-Z]{6}$'),
  export_project_id text NOT NULL CHECK (export_project_id ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'), dataset_id text NOT NULL,
  billing_table_id text NOT NULL, pricing_project_id text NOT NULL CHECK (pricing_project_id ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'), pricing_dataset_id text NOT NULL, pricing_table_id text NOT NULL, location text NOT NULL,
  identity_binding_id text NOT NULL CHECK (identity_binding_id ~ '^gcpwif_[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('pending','active','disabled')), created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991), UNIQUE(org_id,customer_id,id,billing_account_id),
  CHECK (char_length(dataset_id) BETWEEN 1 AND 1024), CHECK (char_length(billing_table_id) BETWEEN 1 AND 1024), CHECK (char_length(pricing_dataset_id) BETWEEN 1 AND 1024), CHECK (char_length(pricing_table_id) BETWEEN 1 AND 1024), CHECK (char_length(location) BETWEEN 1 AND 128)
);
CREATE INDEX gcp_billing_connections_scope_idx ON gcp_billing_connections(org_id,customer_id,status);
CREATE TABLE finops_gcp_billing_snapshots (
  generation_id text PRIMARY KEY CHECK (generation_id ~ '^gcpg_[a-f0-9]{64}$'), org_id text NOT NULL, customer_id text NOT NULL,
  connection_id text NOT NULL, billing_account_id text NOT NULL, capture_id text NOT NULL CHECK (capture_id ~ '^gcpbilling_[a-f0-9]{64}$'),
  source_state text NOT NULL CHECK (source_state IN ('CONFIGURATION_REQUIRED','PERMISSION_REQUIRED','WAITING_FIRST_DELIVERY','PARTIAL_PIPELINE','EMPTY','READY')),
  complete boolean NOT NULL, content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'), snapshot_json text NOT NULL,
  completed_at text NOT NULL CHECK (char_length(completed_at)=24), data_through_at text CHECK (data_through_at IS NULL OR char_length(data_through_at)=24),
  billing_row_count bigint NOT NULL CHECK (billing_row_count BETWEEN 0 AND 1000000), opportunity_row_count bigint NOT NULL CHECK (opportunity_row_count BETWEEN 0 AND 100000),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (org_id,customer_id,connection_id,billing_account_id) REFERENCES gcp_billing_connections(org_id,customer_id,id,billing_account_id) ON DELETE CASCADE,
  UNIQUE(org_id,customer_id,connection_id,capture_id), CHECK (octet_length(snapshot_json) BETWEEN 2 AND 268435456), CHECK (NOT complete OR source_state IN ('READY','EMPTY'))
);
CREATE INDEX finops_gcp_billing_history_idx ON finops_gcp_billing_snapshots(org_id,customer_id,connection_id,completed_at DESC,generation_id DESC);
CREATE TABLE finops_gcp_billing_snapshot_heads(org_id text NOT NULL,customer_id text NOT NULL,connection_id text NOT NULL,active_generation_id text NOT NULL UNIQUE REFERENCES finops_gcp_billing_snapshots(generation_id),advanced_at bigint NOT NULL CHECK(advanced_at BETWEEN 0 AND 9007199254740991),PRIMARY KEY(org_id,customer_id,connection_id));
CREATE OR REPLACE FUNCTION finops_gcp_billing_snapshot_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'FINOPS_GCP_BILLING_SNAPSHOT_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_gcp_billing_snapshots_update_guard BEFORE UPDATE OR DELETE ON finops_gcp_billing_snapshots FOR EACH ROW EXECUTE FUNCTION finops_gcp_billing_snapshot_immutable();
CREATE OR REPLACE FUNCTION finops_gcp_billing_head_guard() RETURNS trigger AS $$ DECLARE candidate finops_gcp_billing_snapshots%ROWTYPE; active finops_gcp_billing_snapshots%ROWTYPE; BEGIN SELECT * INTO candidate FROM finops_gcp_billing_snapshots WHERE generation_id=NEW.active_generation_id; IF candidate.generation_id IS NULL OR NOT candidate.complete OR candidate.source_state NOT IN ('READY','EMPTY') OR candidate.org_id<>NEW.org_id OR candidate.customer_id<>NEW.customer_id OR candidate.connection_id<>NEW.connection_id THEN RAISE EXCEPTION 'FINOPS_GCP_BILLING_HEAD_REJECTED'; END IF; IF TG_OP='UPDATE' THEN IF NEW.org_id<>OLD.org_id OR NEW.customer_id<>OLD.customer_id OR NEW.connection_id<>OLD.connection_id THEN RAISE EXCEPTION 'FINOPS_GCP_BILLING_HEAD_REJECTED'; END IF; SELECT * INTO active FROM finops_gcp_billing_snapshots WHERE generation_id=OLD.active_generation_id; IF NOT(candidate.completed_at>active.completed_at OR(candidate.completed_at=active.completed_at AND candidate.generation_id>active.generation_id)) THEN RAISE EXCEPTION 'FINOPS_GCP_BILLING_HEAD_REJECTED'; END IF; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_gcp_billing_heads_write_guard BEFORE INSERT OR UPDATE ON finops_gcp_billing_snapshot_heads FOR EACH ROW EXECUTE FUNCTION finops_gcp_billing_head_guard();
CREATE TRIGGER finops_gcp_billing_heads_delete_guard BEFORE DELETE ON finops_gcp_billing_snapshot_heads FOR EACH ROW EXECUTE FUNCTION finops_gcp_billing_snapshot_immutable();
REVOKE ALL ON gcp_billing_connections FROM PUBLIC;
REVOKE ALL ON finops_gcp_billing_snapshots FROM PUBLIC;
REVOKE ALL ON finops_gcp_billing_snapshot_heads FROM PUBLIC;

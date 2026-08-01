CREATE TABLE finops_scad_allocation_snapshots (
 generation_id text PRIMARY KEY CHECK (generation_id ~ '^scg_[a-f0-9]{64}$'),
 org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
 capture_id text NOT NULL CHECK (capture_id ~ '^scad_[a-f0-9]{64}$'),
 active_billing_generation_id text NOT NULL CHECK (active_billing_generation_id ~ '^fbg_[a-f0-9]{64}$'),
 manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
 source_state text NOT NULL CHECK (source_state IN ('CONFIGURATION_REQUIRED','WAITING_FIRST_DELIVERY','READY','PARTIAL','STALE','NO_USAGE')),
 complete boolean NOT NULL, content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
 snapshot_json text NOT NULL CHECK (octet_length(snapshot_json) BETWEEN 2 AND 134217728),
 billing_period_start_at text NOT NULL CHECK (char_length(billing_period_start_at)=24),
 billing_period_end_at text NOT NULL CHECK (char_length(billing_period_end_at)=24),
 generated_at text NOT NULL CHECK (char_length(generated_at)=24), data_through_at text NOT NULL CHECK (char_length(data_through_at)=24),
 row_count bigint NOT NULL CHECK (row_count BETWEEN 0 AND 750000), group_count bigint NOT NULL CHECK (group_count BETWEEN 0 AND 100000),
 object_expected bigint NOT NULL CHECK (object_expected BETWEEN 0 AND 20000), object_processed bigint NOT NULL CHECK (object_processed BETWEEN 0 AND 20000),
 created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
 UNIQUE (org_id,customer_id,connection_id,billing_period_start_at,capture_id),
 CHECK (NOT complete OR source_state IN ('READY','STALE','NO_USAGE'))
);
CREATE INDEX finops_scad_allocation_history_idx ON finops_scad_allocation_snapshots
 (org_id,customer_id,connection_id,billing_period_start_at DESC,generated_at DESC,generation_id DESC);
CREATE TABLE finops_scad_allocation_heads (
 org_id text NOT NULL, customer_id text NOT NULL, connection_id text NOT NULL,
 billing_period_start_at text NOT NULL, active_generation_id text NOT NULL UNIQUE REFERENCES finops_scad_allocation_snapshots(generation_id),
 advanced_at bigint NOT NULL CHECK (advanced_at BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY (org_id,customer_id,connection_id,billing_period_start_at)
);
CREATE OR REPLACE FUNCTION finops_scad_allocation_snapshot_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'FINOPS_SCAD_ALLOCATION_SNAPSHOT_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_scad_allocation_snapshots_update_guard BEFORE UPDATE ON finops_scad_allocation_snapshots FOR EACH ROW EXECUTE FUNCTION finops_scad_allocation_snapshot_immutable();
CREATE TRIGGER finops_scad_allocation_snapshots_delete_guard BEFORE DELETE ON finops_scad_allocation_snapshots FOR EACH ROW EXECUTE FUNCTION finops_scad_allocation_snapshot_immutable();
CREATE OR REPLACE FUNCTION finops_scad_allocation_head_guard() RETURNS trigger AS $$
DECLARE candidate finops_scad_allocation_snapshots%ROWTYPE; DECLARE active finops_scad_allocation_snapshots%ROWTYPE;
BEGIN SELECT * INTO candidate FROM finops_scad_allocation_snapshots WHERE generation_id=NEW.active_generation_id;
 IF candidate.generation_id IS NULL OR NOT candidate.complete OR candidate.org_id<>NEW.org_id OR candidate.customer_id<>NEW.customer_id OR candidate.connection_id<>NEW.connection_id OR candidate.billing_period_start_at<>NEW.billing_period_start_at THEN RAISE EXCEPTION 'FINOPS_SCAD_ALLOCATION_HEAD_REJECTED'; END IF;
 IF TG_OP='UPDATE' THEN IF NEW.org_id<>OLD.org_id OR NEW.customer_id<>OLD.customer_id OR NEW.connection_id<>OLD.connection_id OR NEW.billing_period_start_at<>OLD.billing_period_start_at THEN RAISE EXCEPTION 'FINOPS_SCAD_ALLOCATION_HEAD_REJECTED'; END IF;
 SELECT * INTO active FROM finops_scad_allocation_snapshots WHERE generation_id=OLD.active_generation_id;
 IF NOT (candidate.generated_at>active.generated_at OR (candidate.generated_at=active.generated_at AND candidate.generation_id>active.generation_id)) THEN RAISE EXCEPTION 'FINOPS_SCAD_ALLOCATION_HEAD_REJECTED'; END IF; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_scad_allocation_heads_write_guard BEFORE INSERT OR UPDATE ON finops_scad_allocation_heads FOR EACH ROW EXECUTE FUNCTION finops_scad_allocation_head_guard();
CREATE TRIGGER finops_scad_allocation_heads_delete_guard BEFORE DELETE ON finops_scad_allocation_heads FOR EACH ROW EXECUTE FUNCTION finops_scad_allocation_snapshot_immutable();
REVOKE ALL ON finops_scad_allocation_snapshots FROM PUBLIC;
REVOKE ALL ON finops_scad_allocation_heads FROM PUBLIC;

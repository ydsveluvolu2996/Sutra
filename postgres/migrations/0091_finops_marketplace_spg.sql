CREATE TABLE finops_marketplace_spg_snapshots (
  generation_id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  account_id text NOT NULL, partition text NOT NULL CHECK (partition='aws'), source_capture_id text NOT NULL,
  source_state text NOT NULL CHECK (source_state IN ('READY','EMPTY','PARTIAL','CONFIGURATION_REQUIRED','STALE')),
  content_sha256 text NOT NULL, snapshot_json text NOT NULL, summary_json text NOT NULL,
  captured_at text NOT NULL, data_through_at text NOT NULL,
  organization_coverage text NOT NULL CHECK (organization_coverage IN ('COMPLETE','PARTIAL','SINGLE_ACCOUNT_ONLY')),
  agreement_state text NOT NULL CHECK (agreement_state IN ('READY','EMPTY','PARTIAL')),
  license_state text NOT NULL CHECK (license_state IN ('READY','EMPTY','PARTIAL','CONFIGURATION_REQUIRED')),
  spend_state text NOT NULL CHECK (spend_state IN ('READY','EMPTY','PARTIAL','CONFIGURATION_REQUIRED')),
  agreement_count bigint NOT NULL CHECK (agreement_count BETWEEN 0 AND 50000),
  license_count bigint NOT NULL CHECK (license_count BETWEEN 0 AND 50000),
  grant_count bigint NOT NULL CHECK (grant_count BETWEEN 0 AND 250000),
  spend_row_count bigint NOT NULL CHECK (spend_row_count BETWEEN 0 AND 500000),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id,customer_id,connection_id,generation_id), UNIQUE (org_id,customer_id,connection_id,source_capture_id),
  CHECK (generation_id ~ '^mspg_[a-f0-9]{64}$'), CHECK (source_capture_id ~ '^marketplace_[a-f0-9]{64}$'),
  CHECK (content_sha256 ~ '^[a-f0-9]{64}$'), CHECK (account_id ~ '^[0-9]{12}$'),
  CHECK (octet_length(snapshot_json) BETWEEN 2 AND 25165824), CHECK (octet_length(summary_json) BETWEEN 2 AND 262144),
  CHECK (char_length(captured_at)=24 AND char_length(data_through_at)=24 AND data_through_at<=captured_at)
);
CREATE INDEX finops_marketplace_spg_history_idx ON finops_marketplace_spg_snapshots
  (org_id,customer_id,connection_id,captured_at DESC,generation_id DESC);
CREATE TABLE finops_marketplace_spg_heads (
  org_id text NOT NULL, customer_id text NOT NULL, connection_id text NOT NULL,
  active_generation_id text NOT NULL UNIQUE REFERENCES finops_marketplace_spg_snapshots(generation_id),
  advanced_at bigint NOT NULL CHECK (advanced_at BETWEEN 0 AND 9007199254740991), PRIMARY KEY (org_id,customer_id,connection_id)
);
CREATE OR REPLACE FUNCTION finops_marketplace_spg_snapshot_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'FINOPS_MARKETPLACE_SPG_SNAPSHOT_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_marketplace_spg_snapshots_update_guard BEFORE UPDATE OR DELETE ON finops_marketplace_spg_snapshots
  FOR EACH ROW EXECUTE FUNCTION finops_marketplace_spg_snapshot_immutable();
CREATE OR REPLACE FUNCTION finops_marketplace_spg_head_guard() RETURNS trigger AS $$
DECLARE candidate finops_marketplace_spg_snapshots%ROWTYPE; active finops_marketplace_spg_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO candidate FROM finops_marketplace_spg_snapshots WHERE generation_id=NEW.active_generation_id;
  IF candidate.generation_id IS NULL OR candidate.org_id<>NEW.org_id OR candidate.customer_id<>NEW.customer_id OR candidate.connection_id<>NEW.connection_id
    OR candidate.organization_coverage<>'COMPLETE' OR candidate.source_state NOT IN ('READY','EMPTY')
    OR candidate.agreement_state NOT IN ('READY','EMPTY') OR candidate.license_state NOT IN ('READY','EMPTY') OR candidate.spend_state NOT IN ('READY','EMPTY')
  THEN RAISE EXCEPTION 'FINOPS_MARKETPLACE_SPG_HEAD_REJECTED'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.org_id<>OLD.org_id OR NEW.customer_id<>OLD.customer_id OR NEW.connection_id<>OLD.connection_id THEN RAISE EXCEPTION 'FINOPS_MARKETPLACE_SPG_HEAD_REJECTED'; END IF;
    SELECT * INTO active FROM finops_marketplace_spg_snapshots WHERE generation_id=OLD.active_generation_id;
    IF NOT candidate.captured_at>active.captured_at THEN RAISE EXCEPTION 'FINOPS_MARKETPLACE_SPG_HEAD_REJECTED'; END IF;
  END IF; RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_marketplace_spg_heads_write_guard BEFORE INSERT OR UPDATE ON finops_marketplace_spg_heads
  FOR EACH ROW EXECUTE FUNCTION finops_marketplace_spg_head_guard();
CREATE TRIGGER finops_marketplace_spg_heads_delete_guard BEFORE DELETE ON finops_marketplace_spg_heads
  FOR EACH ROW EXECUTE FUNCTION finops_marketplace_spg_snapshot_immutable();
--> statement-breakpoint
REVOKE ALL ON finops_marketplace_spg_snapshots FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_marketplace_spg_heads FROM PUBLIC;

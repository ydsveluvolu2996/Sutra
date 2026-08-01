CREATE TABLE finops_cora_snapshots (
  generation_id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  source_capture_id text NOT NULL,
  source_state text NOT NULL CHECK (source_state IN
    ('READY','PARTIAL','CONFIGURATION_REQUIRED','STALE','EMPTY','ERROR')),
  content_sha256 text NOT NULL,
  snapshot_json text NOT NULL,
  summary_json text NOT NULL,
  collected_at text NOT NULL,
  data_through_at text,
  organization_coverage text NOT NULL CHECK (organization_coverage IN
    ('COMPLETE','PARTIAL','SINGLE_ACCOUNT_ONLY')),
  enrollment_state text NOT NULL CHECK (enrollment_state IN
    ('READY','PARTIAL','CONFIGURATION_REQUIRED')),
  recommendation_state text NOT NULL CHECK (recommendation_state IN
    ('READY','PARTIAL','EMPTY','CONFIGURATION_REQUIRED','ERROR','STALE')),
  expected_account_count bigint NOT NULL CHECK (expected_account_count BETWEEN 1 AND 10000),
  active_enrollment_account_count bigint NOT NULL,
  recommendation_count bigint NOT NULL CHECK (recommendation_count BETWEEN 0 AND 500000),
  accepted_record_count bigint NOT NULL,
  rejected_record_count bigint NOT NULL CHECK (rejected_record_count BETWEEN 0 AND 500000),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id, customer_id, connection_id, generation_id),
  UNIQUE (org_id, customer_id, connection_id, source_capture_id),
  CHECK (generation_id ~ '^corg_[a-f0-9]{64}$'),
  CHECK (source_capture_id ~ '^cora_[a-f0-9]{64}$'),
  CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (octet_length(snapshot_json) BETWEEN 2 AND 25165824),
  CHECK (octet_length(summary_json) BETWEEN 2 AND 262144),
  CHECK (char_length(collected_at) = 24),
  CHECK (data_through_at IS NULL OR (char_length(data_through_at) = 24 AND data_through_at <= collected_at)),
  CHECK (active_enrollment_account_count BETWEEN 0 AND expected_account_count),
  CHECK (accepted_record_count = recommendation_count),
  CHECK (source_state <> 'READY' OR (
    organization_coverage = 'COMPLETE' AND enrollment_state = 'READY'
    AND recommendation_state IN ('READY','EMPTY')
    AND active_enrollment_account_count = expected_account_count
    AND rejected_record_count = 0 AND data_through_at IS NOT NULL
  ))
);
CREATE INDEX finops_cora_snapshots_history_idx ON finops_cora_snapshots
  (org_id, customer_id, connection_id, collected_at DESC, generation_id DESC);

CREATE TABLE finops_cora_snapshot_heads (
  org_id text NOT NULL,
  customer_id text NOT NULL,
  connection_id text NOT NULL,
  active_generation_id text NOT NULL UNIQUE REFERENCES finops_cora_snapshots(generation_id),
  advanced_at bigint NOT NULL CHECK (advanced_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (org_id, customer_id, connection_id)
);

CREATE OR REPLACE FUNCTION finops_cora_snapshot_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'FINOPS_CORA_SNAPSHOT_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_cora_snapshots_update_guard BEFORE UPDATE ON finops_cora_snapshots
  FOR EACH ROW EXECUTE FUNCTION finops_cora_snapshot_immutable();
CREATE TRIGGER finops_cora_snapshots_delete_guard BEFORE DELETE ON finops_cora_snapshots
  FOR EACH ROW EXECUTE FUNCTION finops_cora_snapshot_immutable();

CREATE OR REPLACE FUNCTION finops_cora_head_guard() RETURNS trigger AS $$
DECLARE candidate finops_cora_snapshots%ROWTYPE; active finops_cora_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO candidate FROM finops_cora_snapshots WHERE generation_id = NEW.active_generation_id;
  IF candidate.generation_id IS NULL OR candidate.source_state <> 'READY'
    OR candidate.org_id <> NEW.org_id OR candidate.customer_id <> NEW.customer_id
    OR candidate.connection_id <> NEW.connection_id THEN
    RAISE EXCEPTION 'FINOPS_CORA_HEAD_REJECTED';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.org_id <> OLD.org_id OR NEW.customer_id <> OLD.customer_id
      OR NEW.connection_id <> OLD.connection_id THEN RAISE EXCEPTION 'FINOPS_CORA_HEAD_REJECTED'; END IF;
    SELECT * INTO active FROM finops_cora_snapshots WHERE generation_id = OLD.active_generation_id;
    IF NOT (candidate.data_through_at > active.data_through_at OR
      (candidate.data_through_at = active.data_through_at AND candidate.collected_at > active.collected_at)) THEN
      RAISE EXCEPTION 'FINOPS_CORA_HEAD_REJECTED';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_cora_heads_write_guard BEFORE INSERT OR UPDATE ON finops_cora_snapshot_heads
  FOR EACH ROW EXECUTE FUNCTION finops_cora_head_guard();
CREATE TRIGGER finops_cora_heads_delete_guard BEFORE DELETE ON finops_cora_snapshot_heads
  FOR EACH ROW EXECUTE FUNCTION finops_cora_snapshot_immutable();
--> statement-breakpoint
REVOKE ALL ON finops_cora_snapshots FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_cora_snapshot_heads FROM PUBLIC;

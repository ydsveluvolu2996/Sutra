CREATE TABLE finops_aws_support_case_snapshots (
  generation_id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  capture_id text NOT NULL, content_sha256 text NOT NULL, snapshot_json text NOT NULL,
  observed_at text NOT NULL, data_through_at text NOT NULL,
  configuration_state text NOT NULL CHECK (configuration_state IN ('ready','unverified','unavailable')),
  collection_state text NOT NULL CHECK (collection_state IN ('complete','partial','unavailable')),
  intended_account_count bigint NOT NULL CHECK (intended_account_count BETWEEN 1 AND 200),
  complete_account_count bigint NOT NULL,
  case_count bigint NOT NULL CHECK (case_count BETWEEN 0 AND 50000),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id, customer_id, connection_id, generation_id),
  UNIQUE (org_id, customer_id, connection_id, capture_id),
  CHECK (generation_id ~ '^supg_[a-f0-9]{64}$'), CHECK (capture_id ~ '^support_[a-f0-9]{64}$'),
  CHECK (content_sha256 ~ '^[a-f0-9]{64}$'), CHECK (octet_length(snapshot_json) BETWEEN 2 AND 67108864),
  CHECK (char_length(observed_at) = 24 AND char_length(data_through_at) = 24 AND data_through_at <= observed_at),
  CHECK (complete_account_count BETWEEN 0 AND intended_account_count),
  CHECK (collection_state <> 'complete' OR (configuration_state = 'ready' AND complete_account_count = intended_account_count))
);
CREATE INDEX finops_aws_support_case_snapshots_history_idx ON finops_aws_support_case_snapshots
  (org_id, customer_id, connection_id, observed_at DESC, generation_id DESC);

CREATE TABLE finops_aws_support_case_heads (
  org_id text NOT NULL, customer_id text NOT NULL, connection_id text NOT NULL,
  active_generation_id text NOT NULL UNIQUE REFERENCES finops_aws_support_case_snapshots(generation_id),
  advanced_at bigint NOT NULL CHECK (advanced_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (org_id, customer_id, connection_id)
);

CREATE OR REPLACE FUNCTION finops_support_case_snapshot_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'FINOPS_SUPPORT_CASE_SNAPSHOT_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_aws_support_case_snapshots_update_guard BEFORE UPDATE ON finops_aws_support_case_snapshots
  FOR EACH ROW EXECUTE FUNCTION finops_support_case_snapshot_immutable();
CREATE TRIGGER finops_aws_support_case_snapshots_delete_guard BEFORE DELETE ON finops_aws_support_case_snapshots
  FOR EACH ROW EXECUTE FUNCTION finops_support_case_snapshot_immutable();

CREATE OR REPLACE FUNCTION finops_support_case_head_guard() RETURNS trigger AS $$
DECLARE candidate finops_aws_support_case_snapshots%ROWTYPE; active finops_aws_support_case_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO candidate FROM finops_aws_support_case_snapshots WHERE generation_id = NEW.active_generation_id;
  IF candidate.generation_id IS NULL OR candidate.configuration_state <> 'ready' OR candidate.collection_state <> 'complete'
    OR candidate.org_id <> NEW.org_id OR candidate.customer_id <> NEW.customer_id OR candidate.connection_id <> NEW.connection_id
  THEN RAISE EXCEPTION 'FINOPS_SUPPORT_CASE_HEAD_REJECTED'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.org_id <> OLD.org_id OR NEW.customer_id <> OLD.customer_id OR NEW.connection_id <> OLD.connection_id
    THEN RAISE EXCEPTION 'FINOPS_SUPPORT_CASE_HEAD_REJECTED'; END IF;
    SELECT * INTO active FROM finops_aws_support_case_snapshots WHERE generation_id = OLD.active_generation_id;
    IF NOT (candidate.data_through_at > active.data_through_at OR
      (candidate.data_through_at = active.data_through_at AND candidate.observed_at > active.observed_at))
    THEN RAISE EXCEPTION 'FINOPS_SUPPORT_CASE_HEAD_REJECTED'; END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_aws_support_case_heads_write_guard BEFORE INSERT OR UPDATE ON finops_aws_support_case_heads
  FOR EACH ROW EXECUTE FUNCTION finops_support_case_head_guard();
CREATE TRIGGER finops_aws_support_case_heads_delete_guard BEFORE DELETE ON finops_aws_support_case_heads
  FOR EACH ROW EXECUTE FUNCTION finops_support_case_snapshot_immutable();
--> statement-breakpoint
REVOKE ALL ON finops_aws_support_case_snapshots FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_aws_support_case_heads FROM PUBLIC;

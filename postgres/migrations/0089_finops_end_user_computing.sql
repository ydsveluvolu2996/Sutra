CREATE TABLE finops_euc_snapshots (
  generation_id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  partition text NOT NULL CHECK (partition IN ('aws','aws-us-gov','aws-cn')),
  source_capture_id text NOT NULL,
  source_state text NOT NULL CHECK (source_state IN ('READY','PARTIAL','STALE','UNAVAILABLE')),
  observed_at text NOT NULL,
  content_sha256 text NOT NULL,
  snapshot_json text NOT NULL,
  workspace_count bigint NOT NULL CHECK (workspace_count BETWEEN 0 AND 50000),
  fleet_count bigint NOT NULL CHECK (fleet_count BETWEEN 0 AND 10000),
  metric_count bigint NOT NULL CHECK (metric_count BETWEEN 0 AND 100000),
  cost_line_count bigint NOT NULL CHECK (cost_line_count BETWEEN 0 AND 250000),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id, customer_id, connection_id, generation_id),
  UNIQUE (org_id, customer_id, connection_id, source_capture_id),
  CHECK (generation_id ~ '^eucg_[a-f0-9]{64}$'),
  CHECK (source_capture_id ~ '^euc_[a-f0-9]{64}$'),
  CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (octet_length(snapshot_json) BETWEEN 2 AND 8388608),
  CHECK (char_length(observed_at) = 24)
);
CREATE INDEX finops_euc_snapshots_history_idx ON finops_euc_snapshots
  (org_id, customer_id, connection_id, observed_at DESC, generation_id DESC);

CREATE TABLE finops_euc_snapshot_heads (
  org_id text NOT NULL, customer_id text NOT NULL, connection_id text NOT NULL,
  active_generation_id text NOT NULL UNIQUE REFERENCES finops_euc_snapshots(generation_id),
  advanced_at bigint NOT NULL CHECK (advanced_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (org_id, customer_id, connection_id)
);

CREATE OR REPLACE FUNCTION finops_euc_snapshot_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'FINOPS_EUC_SNAPSHOT_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_euc_snapshots_update_guard BEFORE UPDATE ON finops_euc_snapshots FOR EACH ROW EXECUTE FUNCTION finops_euc_snapshot_immutable();
CREATE TRIGGER finops_euc_snapshots_delete_guard BEFORE DELETE ON finops_euc_snapshots FOR EACH ROW EXECUTE FUNCTION finops_euc_snapshot_immutable();

CREATE OR REPLACE FUNCTION finops_euc_head_guard() RETURNS trigger AS $$
DECLARE candidate finops_euc_snapshots%ROWTYPE; active finops_euc_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO candidate FROM finops_euc_snapshots WHERE generation_id = NEW.active_generation_id;
  IF candidate.generation_id IS NULL OR candidate.source_state <> 'READY' OR candidate.org_id <> NEW.org_id OR candidate.customer_id <> NEW.customer_id OR candidate.connection_id <> NEW.connection_id THEN RAISE EXCEPTION 'FINOPS_EUC_HEAD_REJECTED'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.org_id <> OLD.org_id OR NEW.customer_id <> OLD.customer_id OR NEW.connection_id <> OLD.connection_id THEN RAISE EXCEPTION 'FINOPS_EUC_HEAD_REJECTED'; END IF;
    SELECT * INTO active FROM finops_euc_snapshots WHERE generation_id = OLD.active_generation_id;
    IF NOT candidate.observed_at > active.observed_at THEN RAISE EXCEPTION 'FINOPS_EUC_HEAD_REJECTED'; END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_euc_heads_write_guard BEFORE INSERT OR UPDATE ON finops_euc_snapshot_heads FOR EACH ROW EXECUTE FUNCTION finops_euc_head_guard();
CREATE TRIGGER finops_euc_heads_delete_guard BEFORE DELETE ON finops_euc_snapshot_heads FOR EACH ROW EXECUTE FUNCTION finops_euc_snapshot_immutable();
--> statement-breakpoint
REVOKE ALL ON finops_euc_snapshots FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_euc_snapshot_heads FROM PUBLIC;

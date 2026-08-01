CREATE TABLE finops_kubecost_snapshots (
  generation_id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  partition text NOT NULL CHECK (partition IN ('aws','aws-us-gov','aws-cn')),
  billing_period text NOT NULL, active_cur2_generation_id text NOT NULL,
  source_capture_id text NOT NULL,
  source_state text NOT NULL CHECK (source_state IN ('CONFIGURATION_REQUIRED','WAITING_FIRST_DELIVERY','UNKNOWN','ERROR','EMPTY','PARTIAL','STALE','READY')),
  complete boolean NOT NULL, data_through_at text NOT NULL,
  content_sha256 text NOT NULL, snapshot_json text NOT NULL,
  row_count bigint NOT NULL CHECK (row_count BETWEEN 0 AND 750000),
  group_count bigint NOT NULL CHECK (group_count BETWEEN 0 AND 250000),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id,customer_id,connection_id,generation_id),
  UNIQUE (org_id,customer_id,connection_id,source_capture_id),
  CHECK (generation_id ~ '^kcg_[a-f0-9]{64}$'),
  CHECK (source_capture_id ~ '^kubecost_[a-f0-9]{64}$'),
  CHECK (active_cur2_generation_id ~ '^fbg_[a-f0-9]{64}$'),
  CHECK (billing_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (octet_length(snapshot_json) BETWEEN 2 AND 25165824),
  CHECK (char_length(data_through_at)=24),
  CHECK (NOT complete OR source_state IN ('READY','EMPTY'))
);
CREATE INDEX finops_kubecost_snapshots_history_idx ON finops_kubecost_snapshots (org_id,customer_id,connection_id,data_through_at DESC,generation_id DESC);
CREATE TABLE finops_kubecost_snapshot_heads (
  org_id text NOT NULL, customer_id text NOT NULL, connection_id text NOT NULL,
  active_generation_id text NOT NULL UNIQUE REFERENCES finops_kubecost_snapshots(generation_id),
  advanced_at bigint NOT NULL CHECK (advanced_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (org_id,customer_id,connection_id)
);
CREATE OR REPLACE FUNCTION finops_kubecost_snapshot_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'FINOPS_KUBECOST_SNAPSHOT_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_kubecost_snapshots_update_guard BEFORE UPDATE ON finops_kubecost_snapshots FOR EACH ROW EXECUTE FUNCTION finops_kubecost_snapshot_immutable();
CREATE TRIGGER finops_kubecost_snapshots_delete_guard BEFORE DELETE ON finops_kubecost_snapshots FOR EACH ROW EXECUTE FUNCTION finops_kubecost_snapshot_immutable();
CREATE OR REPLACE FUNCTION finops_kubecost_head_guard() RETURNS trigger AS $$
DECLARE candidate finops_kubecost_snapshots%ROWTYPE; active finops_kubecost_snapshots%ROWTYPE;
BEGIN
 SELECT * INTO candidate FROM finops_kubecost_snapshots WHERE generation_id=NEW.active_generation_id;
 IF candidate.generation_id IS NULL OR NOT candidate.complete OR candidate.source_state NOT IN ('READY','EMPTY') OR candidate.org_id<>NEW.org_id OR candidate.customer_id<>NEW.customer_id OR candidate.connection_id<>NEW.connection_id THEN RAISE EXCEPTION 'FINOPS_KUBECOST_HEAD_REJECTED'; END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.org_id<>OLD.org_id OR NEW.customer_id<>OLD.customer_id OR NEW.connection_id<>OLD.connection_id THEN RAISE EXCEPTION 'FINOPS_KUBECOST_HEAD_REJECTED'; END IF;
  SELECT * INTO active FROM finops_kubecost_snapshots WHERE generation_id=OLD.active_generation_id;
  IF NOT candidate.data_through_at>active.data_through_at THEN RAISE EXCEPTION 'FINOPS_KUBECOST_HEAD_REJECTED'; END IF;
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_kubecost_heads_write_guard BEFORE INSERT OR UPDATE ON finops_kubecost_snapshot_heads FOR EACH ROW EXECUTE FUNCTION finops_kubecost_head_guard();
CREATE TRIGGER finops_kubecost_heads_delete_guard BEFORE DELETE ON finops_kubecost_snapshot_heads FOR EACH ROW EXECUTE FUNCTION finops_kubecost_snapshot_immutable();
--> statement-breakpoint
REVOKE ALL ON finops_kubecost_snapshots FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_kubecost_snapshot_heads FROM PUBLIC;

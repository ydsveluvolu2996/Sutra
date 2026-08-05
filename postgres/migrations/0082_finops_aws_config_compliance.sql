-- PostgreSQL parity for immutable normalized AWS Config compliance generations.
CREATE TABLE finops_config_compliance_snapshots (
  snapshot_id text PRIMARY KEY NOT NULL CHECK (snapshot_id ~ '^acc_[a-f0-9]{64}$'),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  capture_id text NOT NULL CHECK (capture_id ~ '^config_[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('READY','EMPTY','PARTIAL','CONFIGURATION_REQUIRED','STALE','FAILED')),
  captured_at text NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  payload_json text NOT NULL CHECK (octet_length(payload_json) BETWEEN 2 AND 16777216),
  rule_count integer NOT NULL CHECK (rule_count BETWEEN 0 AND 250000),
  evaluation_count integer NOT NULL CHECK (evaluation_count BETWEEN 0 AND 1000000),
  resource_count integer NOT NULL CHECK (resource_count BETWEEN 0 AND 250000),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id, customer_id, connection_id, capture_id),
  UNIQUE (org_id, customer_id, connection_id, snapshot_id)
);
--> statement-breakpoint
CREATE INDEX finops_config_compliance_history_idx ON finops_config_compliance_snapshots
  (org_id, customer_id, connection_id, captured_at DESC, snapshot_id DESC);
--> statement-breakpoint
CREATE TABLE finops_config_compliance_heads (
  org_id text NOT NULL,
  customer_id text NOT NULL,
  connection_id text NOT NULL,
  active_snapshot_id text NOT NULL UNIQUE REFERENCES finops_config_compliance_snapshots(snapshot_id),
  advanced_at bigint NOT NULL CHECK (advanced_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (org_id, customer_id, connection_id)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_finops_config_compliance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FINOPS_CONFIG_COMPLIANCE_IMMUTABLE'; END; $$;
--> statement-breakpoint
CREATE TRIGGER finops_config_snapshot_update_guard BEFORE UPDATE ON finops_config_compliance_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_finops_config_compliance_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_config_snapshot_delete_guard BEFORE DELETE ON finops_config_compliance_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_finops_config_compliance_immutable();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_finops_config_compliance_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_captured_at text; current_snapshot_id text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM finops_config_compliance_snapshots s
    WHERE s.snapshot_id = NEW.active_snapshot_id AND s.org_id = NEW.org_id
      AND s.customer_id = NEW.customer_id AND s.connection_id = NEW.connection_id
      AND s.state IN ('READY','EMPTY')) THEN
    RAISE EXCEPTION 'FINOPS_CONFIG_COMPLIANCE_HEAD_REJECTED';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
      OR NEW.connection_id IS DISTINCT FROM OLD.connection_id THEN
      RAISE EXCEPTION 'FINOPS_CONFIG_COMPLIANCE_HEAD_REJECTED';
    END IF;
    SELECT captured_at, snapshot_id INTO current_captured_at, current_snapshot_id
      FROM finops_config_compliance_snapshots WHERE snapshot_id = OLD.active_snapshot_id;
    IF NOT EXISTS (SELECT 1 FROM finops_config_compliance_snapshots candidate
      WHERE candidate.snapshot_id = NEW.active_snapshot_id
        AND (candidate.captured_at > current_captured_at
          OR (candidate.captured_at = current_captured_at AND candidate.snapshot_id > current_snapshot_id))) THEN
      RAISE EXCEPTION 'FINOPS_CONFIG_COMPLIANCE_HEAD_REJECTED';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER finops_config_head_insert_guard BEFORE INSERT ON finops_config_compliance_heads
FOR EACH ROW EXECUTE FUNCTION guard_finops_config_compliance_head();
--> statement-breakpoint
CREATE TRIGGER finops_config_head_update_guard BEFORE UPDATE ON finops_config_compliance_heads
FOR EACH ROW EXECUTE FUNCTION guard_finops_config_compliance_head();
--> statement-breakpoint
REVOKE ALL ON finops_config_compliance_snapshots FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_config_compliance_heads FROM PUBLIC;

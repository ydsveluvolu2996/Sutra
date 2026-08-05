-- Immutable normalized AWS Config compliance generations.
CREATE TABLE finops_config_compliance_snapshots (
  snapshot_id TEXT PRIMARY KEY NOT NULL CHECK (snapshot_id GLOB 'acc_[0-9a-f]*' AND length(snapshot_id) = 68),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  capture_id TEXT NOT NULL CHECK (capture_id GLOB 'config_[0-9a-f]*' AND length(capture_id) = 71),
  state TEXT NOT NULL CHECK (state IN ('READY','EMPTY','PARTIAL','CONFIGURATION_REQUIRED','STALE','FAILED')),
  captured_at TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 GLOB '[0-9a-f]*' AND length(content_sha256) = 64),
  payload_json TEXT NOT NULL CHECK (length(payload_json) BETWEEN 2 AND 16777216),
  rule_count INTEGER NOT NULL CHECK (rule_count BETWEEN 0 AND 250000),
  evaluation_count INTEGER NOT NULL CHECK (evaluation_count BETWEEN 0 AND 1000000),
  resource_count INTEGER NOT NULL CHECK (resource_count BETWEEN 0 AND 250000),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id, customer_id, connection_id, capture_id),
  UNIQUE (org_id, customer_id, connection_id, snapshot_id)
);
--> statement-breakpoint
CREATE INDEX finops_config_compliance_history_idx ON finops_config_compliance_snapshots
  (org_id, customer_id, connection_id, captured_at DESC, snapshot_id DESC);
--> statement-breakpoint
CREATE TABLE finops_config_compliance_heads (
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  active_snapshot_id TEXT NOT NULL UNIQUE REFERENCES finops_config_compliance_snapshots(snapshot_id),
  advanced_at INTEGER NOT NULL CHECK (advanced_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (org_id, customer_id, connection_id)
);
--> statement-breakpoint
CREATE TRIGGER finops_config_snapshot_update_guard BEFORE UPDATE ON finops_config_compliance_snapshots
BEGIN SELECT RAISE(ABORT, 'FINOPS_CONFIG_COMPLIANCE_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER finops_config_snapshot_delete_guard BEFORE DELETE ON finops_config_compliance_snapshots
BEGIN SELECT RAISE(ABORT, 'FINOPS_CONFIG_COMPLIANCE_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER finops_config_head_insert_guard BEFORE INSERT ON finops_config_compliance_heads
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM finops_config_compliance_snapshots s
    WHERE s.snapshot_id = NEW.active_snapshot_id AND s.org_id = NEW.org_id
      AND s.customer_id = NEW.customer_id AND s.connection_id = NEW.connection_id
      AND s.state IN ('READY','EMPTY')
  ) THEN RAISE(ABORT, 'FINOPS_CONFIG_COMPLIANCE_HEAD_REJECTED') END;
END;
--> statement-breakpoint
CREATE TRIGGER finops_config_head_update_guard BEFORE UPDATE ON finops_config_compliance_heads
BEGIN
  SELECT CASE WHEN NEW.org_id <> OLD.org_id OR NEW.customer_id <> OLD.customer_id
    OR NEW.connection_id <> OLD.connection_id OR NOT EXISTS (
      SELECT 1 FROM finops_config_compliance_snapshots candidate
      JOIN finops_config_compliance_snapshots current ON current.snapshot_id = OLD.active_snapshot_id
      WHERE candidate.snapshot_id = NEW.active_snapshot_id
        AND candidate.org_id = NEW.org_id AND candidate.customer_id = NEW.customer_id
        AND candidate.connection_id = NEW.connection_id AND candidate.state IN ('READY','EMPTY')
        AND (candidate.captured_at > current.captured_at
          OR (candidate.captured_at = current.captured_at AND candidate.snapshot_id > current.snapshot_id))
    ) THEN RAISE(ABORT, 'FINOPS_CONFIG_COMPLIANCE_HEAD_REJECTED') END;
END;

CREATE TABLE IF NOT EXISTS compute_optimizer_export_launch_executions (
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  launch_attempt_id TEXT NOT NULL,
  attempt_content_sha256 TEXT NOT NULL,
  attempt_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PREPARED','IN_PROGRESS','TERMINAL','AMBIGUOUS')),
  claim_token TEXT,
  lease_expires_at BIGINT,
  execution_json TEXT,
  execution_sha256 TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, connection_id, launch_attempt_id),
  CHECK (connection_id ~ '^conn_[a-f0-9]{32}$'),
  CHECK (launch_attempt_id ~ '^coela_[a-f0-9]{64}$'),
  CHECK (attempt_content_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (octet_length(attempt_json) BETWEEN 2 AND 524288),
  CHECK (execution_sha256 IS NULL OR execution_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (execution_json IS NULL OR octet_length(execution_json) BETWEEN 2 AND 524288),
  CHECK (
    (state = 'PREPARED' AND claim_token IS NULL AND lease_expires_at IS NULL
      AND execution_json IS NULL AND execution_sha256 IS NULL) OR
    (state = 'IN_PROGRESS' AND claim_token ~ '^coelc_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      AND lease_expires_at IS NOT NULL AND execution_json IS NULL AND execution_sha256 IS NULL) OR
    (state = 'TERMINAL' AND claim_token IS NULL AND lease_expires_at IS NULL
      AND execution_json IS NOT NULL AND execution_sha256 IS NOT NULL) OR
    (state = 'AMBIGUOUS' AND claim_token IS NULL AND lease_expires_at IS NULL
      AND execution_json IS NULL AND execution_sha256 IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS compute_optimizer_export_launch_state_expiry_idx
  ON compute_optimizer_export_launch_executions (state, lease_expires_at)
  WHERE state = 'IN_PROGRESS';

CREATE OR REPLACE FUNCTION enforce_compute_optimizer_export_launch_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
    OR NEW.connection_id <> OLD.connection_id
    OR NEW.launch_attempt_id <> OLD.launch_attempt_id
    OR NEW.attempt_content_sha256 <> OLD.attempt_content_sha256
    OR NEW.attempt_json <> OLD.attempt_json
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'COMPUTE_OPTIMIZER_EXPORT_LAUNCH_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.state IN ('TERMINAL','AMBIGUOUS') THEN
    RAISE EXCEPTION 'COMPUTE_OPTIMIZER_EXPORT_LAUNCH_TERMINAL_IMMUTABLE';
  END IF;
  IF NOT (
    (OLD.state = 'PREPARED' AND NEW.state = 'IN_PROGRESS') OR
    (OLD.state = 'IN_PROGRESS' AND NEW.state IN ('TERMINAL','AMBIGUOUS'))
  ) THEN
    RAISE EXCEPTION 'COMPUTE_OPTIMIZER_EXPORT_LAUNCH_TRANSITION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS compute_optimizer_export_launch_transition_guard
  ON compute_optimizer_export_launch_executions;
CREATE TRIGGER compute_optimizer_export_launch_transition_guard
BEFORE UPDATE ON compute_optimizer_export_launch_executions
FOR EACH ROW EXECUTE FUNCTION enforce_compute_optimizer_export_launch_transition();

REVOKE ALL ON compute_optimizer_export_launch_executions FROM PUBLIC;

CREATE TABLE finops_scad_runtime_attempts (
  replay_key text PRIMARY KEY CHECK (replay_key ~ '^scrq_[a-f0-9]{64}$'),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  job_id text NOT NULL CHECK (job_id ~ '^job_[a-f0-9]{32}$'),
  scheduled_window text NOT NULL CHECK (char_length(scheduled_window)=24),
  state text NOT NULL CHECK (state IN ('IN_PROGRESS','PERSISTED','SUCCEEDED','RETRYABLE_FAILED','FAILED')),
  lease_token text,
  lease_expires_at bigint,
  attempt_count bigint NOT NULL CHECK (attempt_count BETWEEN 1 AND 25),
  generation_id text REFERENCES finops_scad_allocation_snapshots(generation_id) ON DELETE RESTRICT,
  result_json text,
  result_sha256 text CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[a-f0-9]{64}$'),
  failure_code text CHECK (failure_code IS NULL OR failure_code='SCAD_CUR2_RUNTIME_FAILED'),
  started_at bigint NOT NULL CHECK (started_at BETWEEN 0 AND 9007199254740991),
  completed_at bigint,
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id,customer_id,connection_id,scheduled_window),
  CHECK (lease_token IS NULL OR lease_token ~ '^scrtl_[a-f0-9]{32}$'),
  CHECK (state NOT IN ('IN_PROGRESS','PERSISTED') OR lease_expires_at>=started_at+1860000),
  CHECK ((state='IN_PROGRESS' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND generation_id IS NULL AND result_json IS NULL AND result_sha256 IS NULL AND failure_code IS NULL AND completed_at IS NULL)
    OR (state='PERSISTED' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND generation_id IS NOT NULL AND result_json IS NOT NULL AND result_sha256 IS NOT NULL AND failure_code IS NULL AND completed_at IS NULL)
    OR (state='SUCCEEDED' AND lease_token IS NULL AND lease_expires_at IS NULL AND result_json IS NOT NULL AND result_sha256 IS NOT NULL AND failure_code IS NULL AND completed_at IS NOT NULL)
    OR (state IN ('RETRYABLE_FAILED','FAILED') AND lease_token IS NULL AND lease_expires_at IS NULL AND generation_id IS NULL AND result_json IS NULL AND result_sha256 IS NULL AND failure_code IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX finops_scad_runtime_attempts_scope_idx ON finops_scad_runtime_attempts
  (org_id,customer_id,connection_id,updated_at DESC);
CREATE FUNCTION finops_scad_runtime_attempts_terminal_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF OLD.state IN ('SUCCEEDED','FAILED') THEN RAISE EXCEPTION 'FINOPS_SCAD_RUNTIME_TERMINAL_IMMUTABLE'; END IF; RETURN NEW; END $$;
CREATE TRIGGER finops_scad_runtime_attempts_terminal_guard BEFORE UPDATE ON finops_scad_runtime_attempts
  FOR EACH ROW EXECUTE FUNCTION finops_scad_runtime_attempts_terminal_guard_fn();
REVOKE ALL ON finops_scad_runtime_attempts FROM PUBLIC;

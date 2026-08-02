CREATE TABLE finops_cora_runtime_attempts (
  request_key text PRIMARY KEY CHECK (request_key ~ '^corarq_[a-f0-9]{64}$'),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  job_id text NOT NULL CHECK (job_id ~ '^job_[a-f0-9]{32}([a-f0-9]{32})?$'),
  scheduled_window text NOT NULL CHECK (char_length(scheduled_window)=24),
  state text NOT NULL CHECK (state IN ('IN_PROGRESS','SUCCEEDED','RETRYABLE_FAILED','FAILED')),
  lease_token text,
  lease_expires_at bigint,
  attempt_count bigint NOT NULL CHECK (attempt_count BETWEEN 1 AND 25),
  generation_id text REFERENCES finops_cora_export_object_generations(generation_id) ON DELETE RESTRICT,
  failure_code text CHECK (failure_code IS NULL OR failure_code IN ('ADAPTER_TIMEOUT','ADAPTER_UNAVAILABLE','CAPTURE_REJECTED','PERSISTENCE_REJECTED')),
  started_at bigint NOT NULL CHECK (started_at BETWEEN 0 AND 9007199254740991),
  completed_at bigint,
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id,customer_id,connection_id,scheduled_window),
  CHECK (lease_token IS NULL OR lease_token ~ '^coral_[a-f0-9]{32}$'),
  CHECK (state<>'IN_PROGRESS' OR lease_expires_at>=started_at+1020000),
  CHECK ((state='IN_PROGRESS' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND generation_id IS NULL AND failure_code IS NULL AND completed_at IS NULL)
    OR (state='SUCCEEDED' AND lease_token IS NULL AND lease_expires_at IS NULL AND generation_id IS NOT NULL AND failure_code IS NULL AND completed_at IS NOT NULL)
    OR (state IN ('RETRYABLE_FAILED','FAILED') AND lease_token IS NULL AND lease_expires_at IS NULL AND generation_id IS NULL AND failure_code IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX finops_cora_runtime_attempts_scope_idx ON finops_cora_runtime_attempts(org_id,customer_id,connection_id,updated_at DESC);
CREATE FUNCTION finops_cora_runtime_terminal_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF OLD.state IN ('SUCCEEDED','FAILED') THEN RAISE EXCEPTION 'FINOPS_CORA_RUNTIME_TERMINAL_IMMUTABLE'; END IF; RETURN NEW; END $$;
CREATE TRIGGER finops_cora_runtime_terminal_immutable BEFORE UPDATE ON finops_cora_runtime_attempts FOR EACH ROW EXECUTE FUNCTION finops_cora_runtime_terminal_immutable_fn();
REVOKE ALL ON finops_cora_runtime_attempts FROM PUBLIC;

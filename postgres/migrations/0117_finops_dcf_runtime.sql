CREATE TABLE finops_dcf_module_bindings (
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  module_id text NOT NULL CHECK (char_length(module_id) BETWEEN 1 AND 128),
  module_name text NOT NULL CHECK (char_length(module_name) BETWEEN 1 AND 256),
  source_id text CHECK (source_id IS NULL OR char_length(source_id) BETWEEN 1 AND 128),
  region text NOT NULL CHECK (char_length(region) BETWEEN 9 AND 32),
  state_machine_arn text NOT NULL CHECK (char_length(state_machine_arn) BETWEEN 20 AND 256),
  enabled boolean NOT NULL,
  expected_cadence_minutes integer NOT NULL CHECK (expected_cadence_minutes BETWEEN 5 AND 10080),
  verified_at bigint NOT NULL CHECK (verified_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (org_id,customer_id,connection_id,module_id),
  UNIQUE (org_id,customer_id,connection_id,state_machine_arn)
);
CREATE INDEX finops_dcf_module_bindings_scheduler_idx
  ON finops_dcf_module_bindings(enabled,connection_id,region);
CREATE TABLE finops_dcf_runtime_attempts (
  idempotency_key text PRIMARY KEY CHECK (char_length(idempotency_key) BETWEEN 80 AND 1024),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  job_id text NOT NULL CHECK (job_id ~ '^job_[a-f0-9]{32}$'),
  scheduled_window text NOT NULL CHECK (char_length(scheduled_window)=24),
  state text NOT NULL CHECK (state IN ('IN_PROGRESS','COMPLETED','FAILED')),
  lease_token text NOT NULL CHECK (lease_token ~ '^[a-f0-9]{64}$'),
  lease_expires_at bigint NOT NULL CHECK (lease_expires_at BETWEEN 0 AND 9007199254740991),
  result_json text,
  result_sha256 text,
  failure_code text,
  started_at bigint NOT NULL CHECK (started_at BETWEEN 0 AND 9007199254740991),
  completed_at bigint,
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id,customer_id,connection_id,scheduled_window),
  CHECK ((state='COMPLETED' AND result_json IS NOT NULL AND octet_length(result_json) BETWEEN 2 AND 65536 AND result_sha256~'^[a-f0-9]{64}$' AND failure_code IS NULL AND completed_at IS NOT NULL)
      OR (state='FAILED' AND result_json IS NULL AND result_sha256 IS NULL AND failure_code='DCF_STEP_FUNCTIONS_COLLECTION_FAILED' AND completed_at IS NOT NULL)
      OR (state='IN_PROGRESS' AND result_json IS NULL AND result_sha256 IS NULL AND failure_code IS NULL AND completed_at IS NULL))
);
CREATE INDEX finops_dcf_runtime_status_idx
  ON finops_dcf_runtime_attempts(org_id,customer_id,connection_id,updated_at DESC);
CREATE OR REPLACE FUNCTION finops_dcf_module_binding_scope_guard() RETURNS trigger AS $$
DECLARE connection aws_connections%ROWTYPE;
BEGIN
  SELECT * INTO connection FROM aws_connections c WHERE c.id=NEW.connection_id;
  IF connection.id IS NULL OR connection.org_id<>NEW.org_id OR connection.customer_id<>NEW.customer_id
    OR connection.source_kind<>'aws_trust_role' OR connection.status<>'active'
    OR connection.permission_pack_version<>'standard-2026-08.10' THEN
    RAISE EXCEPTION 'FINOPS_DCF_RUNTIME_SCOPE_REJECTED';
  END IF;
  IF NEW.state_machine_arn NOT LIKE
    'arn:' || connection.partition || ':states:' || NEW.region || ':' || connection.aws_account_id || ':stateMachine:%' THEN
    RAISE EXCEPTION 'FINOPS_DCF_MODULE_BINDING_REJECTED';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_dcf_module_binding_scope_guard
  BEFORE INSERT OR UPDATE ON finops_dcf_module_bindings
  FOR EACH ROW EXECUTE FUNCTION finops_dcf_module_binding_scope_guard();
CREATE OR REPLACE FUNCTION finops_dcf_runtime_attempt_scope_guard() RETURNS trigger AS $$
DECLARE connection aws_connections%ROWTYPE;
BEGIN
  SELECT * INTO connection FROM aws_connections c WHERE c.id=NEW.connection_id;
  IF connection.id IS NULL OR connection.org_id<>NEW.org_id OR connection.customer_id<>NEW.customer_id
    OR connection.source_kind<>'aws_trust_role' OR connection.status<>'active'
    OR connection.permission_pack_version<>'standard-2026-08.10' THEN
    RAISE EXCEPTION 'FINOPS_DCF_RUNTIME_SCOPE_REJECTED';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_dcf_runtime_attempt_scope_guard
  BEFORE INSERT ON finops_dcf_runtime_attempts
  FOR EACH ROW EXECUTE FUNCTION finops_dcf_runtime_attempt_scope_guard();
REVOKE ALL ON finops_dcf_module_bindings FROM PUBLIC;
REVOKE ALL ON finops_dcf_runtime_attempts FROM PUBLIC;

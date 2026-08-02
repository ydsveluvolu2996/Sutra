CREATE TABLE IF NOT EXISTS finops_aws_health_runtime_attempts (
  request_id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  scheduled_window text NOT NULL,
  state text NOT NULL CHECK (state IN ('IN_PROGRESS','SUCCEEDED','FAILED')),
  failure_code text,
  generation_id text REFERENCES finops_aws_health_snapshots(generation_id) ON DELETE RESTRICT,
  lease_token text NOT NULL,
  lease_expires_at bigint NOT NULL CHECK (lease_expires_at BETWEEN 0 AND 9007199254740991),
  started_at bigint NOT NULL CHECK (started_at BETWEEN 0 AND 9007199254740991),
  completed_at bigint,
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id,customer_id,connection_id,scheduled_window),
  CHECK (request_id ~ '^hrr_[a-f0-9]{64}$'),
  CHECK (scheduled_window ~ '^\\d{4}-\\d{2}-\\d{2}T00:00:00\\.000Z$'),
  CHECK (lease_token ~ '^[a-f0-9]{64}$'),
  CHECK ((state='IN_PROGRESS' AND failure_code IS NULL AND generation_id IS NULL AND completed_at IS NULL) OR (state='FAILED' AND failure_code IS NOT NULL AND generation_id IS NULL AND completed_at IS NOT NULL) OR (state='SUCCEEDED' AND failure_code IS NULL AND generation_id IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS finops_aws_health_runtime_attempt_scope_idx ON finops_aws_health_runtime_attempts (org_id,customer_id,connection_id,updated_at DESC);

CREATE OR REPLACE FUNCTION finops_aws_health_runtime_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.request_id<>NEW.request_id OR OLD.org_id<>NEW.org_id OR OLD.customer_id<>NEW.customer_id OR OLD.connection_id<>NEW.connection_id OR OLD.scheduled_window<>NEW.scheduled_window OR OLD.started_at<>NEW.started_at THEN RAISE EXCEPTION 'FINOPS_AWS_HEALTH_RUNTIME_IDENTITY_IMMUTABLE'; END IF;
  IF OLD.state='SUCCEEDED' THEN RAISE EXCEPTION 'FINOPS_AWS_HEALTH_RUNTIME_SUCCESS_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finops_aws_health_runtime_attempt_guard_trigger ON finops_aws_health_runtime_attempts;
CREATE TRIGGER finops_aws_health_runtime_attempt_guard_trigger BEFORE UPDATE ON finops_aws_health_runtime_attempts FOR EACH ROW EXECUTE FUNCTION finops_aws_health_runtime_attempt_guard();

CREATE TABLE IF NOT EXISTS finops_aws_health_runtime_configuration (
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  last_organization_view_status text NOT NULL CHECK (last_organization_view_status IN ('ENABLED','DISABLED','PENDING','UNKNOWN')),
  enabled_observed_since text,
  last_verified_at text NOT NULL,
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (org_id,customer_id,connection_id),
  CHECK (last_verified_at ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'),
  CHECK (enabled_observed_since IS NULL OR enabled_observed_since ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'),
  CHECK (last_organization_view_status='ENABLED' OR enabled_observed_since IS NULL)
);
REVOKE ALL ON finops_aws_health_runtime_attempts FROM PUBLIC;
REVOKE ALL ON finops_aws_health_runtime_configuration FROM PUBLIC;

CREATE TABLE IF NOT EXISTS finops_graviton_runtime_authorities (
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  cur2_generation_id text NOT NULL CHECK (length(cur2_generation_id) BETWEEN 1 AND 128),
  cur2_content_sha256 text NOT NULL CHECK (cur2_content_sha256 ~ '^[a-f0-9]{64}$'),
  pricing_catalog_version text NOT NULL CHECK (length(pricing_catalog_version) BETWEEN 1 AND 128),
  pricing_content_sha256 text NOT NULL CHECK (pricing_content_sha256 ~ '^[a-f0-9]{64}$'),
  compatibility_policy_version text NOT NULL CHECK (length(compatibility_policy_version) BETWEEN 1 AND 128),
  compatibility_content_sha256 text NOT NULL CHECK (compatibility_content_sha256 ~ '^[a-f0-9]{64}$'),
  workload_attestation_set_id text NOT NULL CHECK (length(workload_attestation_set_id) BETWEEN 1 AND 128),
  workload_attestation_sha256 text NOT NULL CHECK (workload_attestation_sha256 ~ '^[a-f0-9]{64}$'),
  license_attestation_set_id text NOT NULL CHECK (length(license_attestation_set_id) BETWEEN 1 AND 128),
  license_attestation_sha256 text NOT NULL CHECK (license_attestation_sha256 ~ '^[a-f0-9]{64}$'),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (org_id,customer_id,connection_id)
);

CREATE TABLE IF NOT EXISTS finops_graviton_runtime_attempts (
  request_key text PRIMARY KEY CHECK (request_key ~ '^gvrq_[a-f0-9]{64}$'),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  scheduled_window text NOT NULL CHECK (scheduled_window ~ '^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$'),
  state text NOT NULL CHECK (state IN ('IN_PROGRESS','SUCCEEDED','FAILED')),
  failure_code text,
  generation_id text REFERENCES finops_graviton_snapshots(generation_id) ON DELETE RESTRICT,
  receipt_json text,
  lease_token_sha256 text NOT NULL CHECK (lease_token_sha256 ~ '^[a-f0-9]{64}$'),
  lease_expires_at bigint NOT NULL CHECK (lease_expires_at BETWEEN 0 AND 9007199254740991),
  started_at bigint NOT NULL CHECK (started_at BETWEEN 0 AND 9007199254740991),
  completed_at bigint,
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id,customer_id,connection_id,scheduled_window),
  CHECK (receipt_json IS NULL OR length(receipt_json) BETWEEN 2 AND 65536),
  CHECK ((state='IN_PROGRESS' AND failure_code IS NULL AND generation_id IS NULL AND receipt_json IS NULL AND completed_at IS NULL)
    OR (state='FAILED' AND failure_code IS NOT NULL AND generation_id IS NULL AND receipt_json IS NULL AND completed_at IS NOT NULL)
    OR (state='SUCCEEDED' AND failure_code IS NULL AND generation_id IS NOT NULL AND receipt_json IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS finops_graviton_runtime_attempt_scope_idx ON finops_graviton_runtime_attempts (org_id,customer_id,connection_id,updated_at DESC);

CREATE OR REPLACE FUNCTION finops_graviton_runtime_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.request_key<>NEW.request_key OR OLD.org_id<>NEW.org_id OR OLD.customer_id<>NEW.customer_id OR OLD.connection_id<>NEW.connection_id OR OLD.scheduled_window<>NEW.scheduled_window OR OLD.started_at<>NEW.started_at THEN RAISE EXCEPTION 'FINOPS_GRAVITON_RUNTIME_IDENTITY_IMMUTABLE'; END IF;
  IF OLD.state='SUCCEEDED' THEN RAISE EXCEPTION 'FINOPS_GRAVITON_RUNTIME_SUCCESS_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finops_graviton_runtime_attempt_guard_trigger ON finops_graviton_runtime_attempts;
CREATE TRIGGER finops_graviton_runtime_attempt_guard_trigger BEFORE UPDATE ON finops_graviton_runtime_attempts FOR EACH ROW EXECUTE FUNCTION finops_graviton_runtime_attempt_guard();

REVOKE ALL ON finops_graviton_runtime_authorities FROM PUBLIC;
REVOKE ALL ON finops_graviton_runtime_attempts FROM PUBLIC;

-- ADV-04 durable execution receipts. Evidence remains in immutable snapshots.
CREATE TABLE finops_extended_support_runtime_receipts (
  idempotency_key text PRIMARY KEY CHECK (char_length(idempotency_key) BETWEEN 1 AND 512),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE CHECK (connection_id ~ '^conn_[a-f0-9]{32}$'),
  scheduled_window text NOT NULL CHECK (char_length(scheduled_window) = 24),
  state text NOT NULL CHECK (state IN ('IN_PROGRESS','COMPLETED','FAILED')),
  job_id text NOT NULL CHECK (job_id ~ '^job_[a-f0-9]{32}$'),
  lease_token text CHECK (lease_token IS NULL OR lease_token ~ '^lease_[a-f0-9]{32}$'),
  lease_expires_at bigint CHECK (lease_expires_at IS NULL OR lease_expires_at BETWEEN 0 AND 9007199254740991),
  result_json text CHECK (result_json IS NULL OR char_length(result_json) BETWEEN 2 AND 2048),
  result_sha256 text CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[a-f0-9]{64}$'),
  failure_code text CHECK (failure_code IS NULL OR failure_code = 'EXTENDED_SUPPORT_COLLECTION_FAILED'),
  completed_at bigint CHECK (completed_at IS NULL OR completed_at BETWEEN 0 AND 9007199254740991),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN created_at AND 9007199254740991),
  UNIQUE (org_id,customer_id,connection_id,scheduled_window),
  CHECK ((state = 'IN_PROGRESS' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND result_json IS NULL AND result_sha256 IS NULL AND failure_code IS NULL AND completed_at IS NULL)
    OR (state = 'COMPLETED' AND lease_token IS NULL AND lease_expires_at IS NULL
      AND result_json IS NOT NULL AND result_sha256 IS NOT NULL AND failure_code IS NULL AND completed_at IS NOT NULL)
    OR (state = 'FAILED' AND lease_token IS NULL AND lease_expires_at IS NULL
      AND result_json IS NULL AND result_sha256 IS NULL
      AND failure_code = 'EXTENDED_SUPPORT_COLLECTION_FAILED' AND completed_at IS NOT NULL))
);
CREATE INDEX finops_extended_support_runtime_receipts_lease_idx
  ON finops_extended_support_runtime_receipts (state,lease_expires_at,updated_at);
CREATE TABLE finops_extended_support_runtime_failures (
  failure_id text PRIMARY KEY CHECK (failure_id ~ '^esf_[a-f0-9]{64}$'),
  idempotency_key text NOT NULL REFERENCES finops_extended_support_runtime_receipts(idempotency_key) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  job_id text NOT NULL CHECK (job_id ~ '^job_[a-f0-9]{32}$'),
  failure_code text NOT NULL CHECK (failure_code = 'EXTENDED_SUPPORT_COLLECTION_FAILED'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  failed_at bigint NOT NULL CHECK (failed_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (idempotency_key,job_id,content_sha256)
);
CREATE INDEX finops_extended_support_runtime_failures_scope_idx
  ON finops_extended_support_runtime_failures
  (org_id,customer_id,connection_id,failed_at DESC,failure_id DESC);
CREATE OR REPLACE FUNCTION guard_finops_extended_support_runtime_receipt() RETURNS trigger AS $$
BEGIN
  IF NEW.idempotency_key <> OLD.idempotency_key OR NEW.org_id <> OLD.org_id
    OR NEW.customer_id <> OLD.customer_id OR NEW.connection_id <> OLD.connection_id
    OR NEW.scheduled_window <> OLD.scheduled_window OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'FINOPS_EXTENDED_SUPPORT_RUNTIME_IDENTITY_IMMUTABLE';
  END IF;
  IF NOT ((OLD.state = 'IN_PROGRESS' AND NEW.state IN ('COMPLETED','FAILED')
      AND NEW.job_id = OLD.job_id AND NEW.updated_at >= OLD.updated_at)
    OR (OLD.state = 'IN_PROGRESS' AND OLD.lease_expires_at <= NEW.updated_at AND NEW.state = 'IN_PROGRESS')
    OR (OLD.state = 'FAILED' AND NEW.state = 'IN_PROGRESS' AND NEW.updated_at >= OLD.updated_at)) THEN
    RAISE EXCEPTION 'FINOPS_EXTENDED_SUPPORT_RUNTIME_TRANSITION_REJECTED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER finops_extended_support_runtime_receipts_update_guard
BEFORE UPDATE ON finops_extended_support_runtime_receipts
FOR EACH ROW EXECUTE FUNCTION guard_finops_extended_support_runtime_receipt();
CREATE OR REPLACE FUNCTION reject_finops_extended_support_runtime_receipt_delete() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'FINOPS_EXTENDED_SUPPORT_RUNTIME_RECEIPT_IMMUTABLE'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER finops_extended_support_runtime_receipts_delete_guard
BEFORE DELETE ON finops_extended_support_runtime_receipts
FOR EACH ROW EXECUTE FUNCTION reject_finops_extended_support_runtime_receipt_delete();
CREATE OR REPLACE FUNCTION reject_finops_extended_support_runtime_failure_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'FINOPS_EXTENDED_SUPPORT_RUNTIME_FAILURE_IMMUTABLE'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER finops_extended_support_runtime_failures_update_guard
BEFORE UPDATE OR DELETE ON finops_extended_support_runtime_failures
FOR EACH ROW EXECUTE FUNCTION reject_finops_extended_support_runtime_failure_mutation();
--> statement-breakpoint
REVOKE ALL ON finops_extended_support_runtime_receipts FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_extended_support_runtime_failures FROM PUBLIC;

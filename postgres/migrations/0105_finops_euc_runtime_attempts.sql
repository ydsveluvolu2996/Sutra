CREATE TABLE finops_euc_runtime_attempts (
  execution_id text PRIMARY KEY CHECK (execution_id ~ '^eue_[a-f0-9]{64}$'),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  partition text NOT NULL CHECK (partition IN ('aws','aws-us-gov','aws-cn')),
  boundary_sha256 text NOT NULL CHECK (boundary_sha256 ~ '^[a-f0-9]{64}$'),
  account_count integer NOT NULL CHECK (account_count BETWEEN 1 AND 200),
  region_count integer NOT NULL CHECK (region_count BETWEEN 1 AND 50),
  request_id text NOT NULL CHECK (request_id ~ '^eur_[a-f0-9]{64}$'),
  job_id text NOT NULL CHECK (job_id ~ '^job_[a-f0-9]{32}$'),
  job_attempt integer NOT NULL CHECK (job_attempt BETWEEN 1 AND 25),
  scheduled_window text NOT NULL CHECK (char_length(scheduled_window)=24),
  state text NOT NULL CHECK (state IN ('READY','PARTIAL','STALE','UNAVAILABLE','FAILED')),
  generation_id text REFERENCES finops_euc_snapshots(generation_id) CHECK (generation_id IS NULL OR generation_id ~ '^eucg_[a-f0-9]{64}$'),
  capture_id text CHECK (capture_id IS NULL OR capture_id ~ '^euc_[a-f0-9]{64}$'),
  cur2_generation_id text CHECK (cur2_generation_id IS NULL OR cur2_generation_id ~ '^fbg_[a-f0-9]{64}$'),
  cur2_projection_sha256 text CHECK (cur2_projection_sha256 IS NULL OR cur2_projection_sha256 ~ '^[a-f0-9]{64}$'),
  request_body_sha256 text CHECK (request_body_sha256 IS NULL OR request_body_sha256 ~ '^[a-f0-9]{64}$'),
  response_body_sha256 text CHECK (response_body_sha256 IS NULL OR response_body_sha256 ~ '^[a-f0-9]{64}$'),
  broker_key_id text,
  failure_code text CHECK (failure_code IN ('BROKER_AUTHENTICATION_FAILED','BROKER_TIMEOUT','BROKER_UNAVAILABLE','BROKER_RESPONSE_INVALID','SCOPE_REJECTED','PRIVACY_REJECTED','CUR2_LINEAGE_REJECTED','EVIDENCE_REJECTED','PERSISTENCE_REJECTED','INTERNAL_ERROR')),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  completed_at bigint NOT NULL CHECK (completed_at BETWEEN 0 AND 9007199254740991),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id,customer_id,connection_id,request_id,job_attempt),
  CHECK ((cur2_generation_id IS NULL) = (cur2_projection_sha256 IS NULL)),
  CHECK ((state='FAILED' AND generation_id IS NULL AND capture_id IS NULL
    AND response_body_sha256 IS NULL AND broker_key_id IS NULL AND failure_code IS NOT NULL)
    OR (state<>'FAILED' AND generation_id IS NOT NULL AND capture_id IS NOT NULL
    AND request_body_sha256 IS NOT NULL AND response_body_sha256 IS NOT NULL
    AND broker_key_id IS NOT NULL AND failure_code IS NULL))
);
CREATE INDEX finops_euc_runtime_attempts_history_idx ON finops_euc_runtime_attempts
  (org_id,customer_id,connection_id,completed_at DESC,execution_id DESC);
CREATE OR REPLACE FUNCTION finops_euc_runtime_attempt_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.state<>'FAILED' AND NOT EXISTS (
    SELECT 1 FROM finops_euc_snapshots s WHERE s.generation_id=NEW.generation_id
      AND s.org_id=NEW.org_id AND s.customer_id=NEW.customer_id
      AND s.connection_id=NEW.connection_id AND s.partition=NEW.partition
      AND s.source_capture_id=NEW.capture_id
  ) THEN RAISE EXCEPTION 'FINOPS_EUC_RUNTIME_ATTEMPT_SCOPE_REJECTED'; END IF;
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'FINOPS_EUC_RUNTIME_ATTEMPT_IMMUTABLE'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_euc_runtime_attempts_scope_guard BEFORE INSERT ON finops_euc_runtime_attempts
  FOR EACH ROW EXECUTE FUNCTION finops_euc_runtime_attempt_guard();
CREATE TRIGGER finops_euc_runtime_attempts_update_guard BEFORE UPDATE OR DELETE ON finops_euc_runtime_attempts
  FOR EACH ROW EXECUTE FUNCTION finops_euc_runtime_attempt_guard();
--> statement-breakpoint
REVOKE ALL ON finops_euc_runtime_attempts FROM PUBLIC;

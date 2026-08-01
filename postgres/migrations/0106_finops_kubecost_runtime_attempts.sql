CREATE TABLE finops_kubecost_runtime_attempts (
  execution_id text PRIMARY KEY CHECK (execution_id ~ '^kue_[a-f0-9]{64}$'),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  partition text NOT NULL CHECK (partition IN ('aws','aws-us-gov','aws-cn')),
  billing_period text NOT NULL CHECK (billing_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  active_cur2_generation_id text NOT NULL CHECK (active_cur2_generation_id ~ '^fbg_[a-f0-9]{64}$'),
  scope_sha256 text NOT NULL CHECK (scope_sha256 ~ '^[a-f0-9]{64}$'),
  destination_sha256 text NOT NULL CHECK (destination_sha256 ~ '^[a-f0-9]{64}$'),
  active_cur2_sha256 text NOT NULL CHECK (active_cur2_sha256 ~ '^[a-f0-9]{64}$'),
  account_count integer NOT NULL CHECK (account_count BETWEEN 1 AND 10000),
  cluster_count integer NOT NULL CHECK (cluster_count BETWEEN 1 AND 5000),
  request_id text NOT NULL CHECK (request_id ~ '^kur_[a-f0-9]{64}$'),
  job_id text NOT NULL CHECK (job_id ~ '^job_[a-f0-9]{32}$'),
  job_attempt integer NOT NULL CHECK (job_attempt BETWEEN 1 AND 25),
  scheduled_window text NOT NULL CHECK (char_length(scheduled_window)=24),
  state text NOT NULL CHECK (state IN ('CONFIGURATION_REQUIRED','WAITING_FIRST_DELIVERY','UNKNOWN','ERROR','EMPTY','PARTIAL','STALE','READY','FAILED')),
  generation_id text REFERENCES finops_kubecost_snapshots(generation_id) CHECK (generation_id IS NULL OR generation_id ~ '^kcg_[a-f0-9]{64}$'),
  capture_id text CHECK (capture_id IS NULL OR capture_id ~ '^kubecost_[a-f0-9]{64}$'),
  request_body_sha256 text NOT NULL CHECK (request_body_sha256 ~ '^[a-f0-9]{64}$'),
  response_body_sha256 text CHECK (response_body_sha256 IS NULL OR response_body_sha256 ~ '^[a-f0-9]{64}$'),
  broker_key_id text,
  failure_code text CHECK (failure_code IN ('BROKER_AUTHENTICATION_FAILED','BROKER_TIMEOUT','BROKER_UNAVAILABLE','BROKER_RESPONSE_INVALID','SCOPE_REJECTED','DESTINATION_REJECTED','VERSION_PIN_REJECTED','CUR2_LINEAGE_REJECTED','EVIDENCE_REJECTED','PERSISTENCE_REJECTED','INTERNAL_ERROR')),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  completed_at bigint NOT NULL CHECK (completed_at BETWEEN 0 AND 9007199254740991),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id,customer_id,connection_id,request_id,job_attempt),
  CHECK ((state='FAILED' AND generation_id IS NULL AND capture_id IS NULL
    AND response_body_sha256 IS NULL AND broker_key_id IS NULL AND failure_code IS NOT NULL)
    OR (state<>'FAILED' AND generation_id IS NOT NULL AND capture_id IS NOT NULL
    AND response_body_sha256 IS NOT NULL AND broker_key_id IS NOT NULL AND failure_code IS NULL))
);
CREATE INDEX finops_kubecost_runtime_attempts_history_idx ON finops_kubecost_runtime_attempts
  (org_id,customer_id,connection_id,completed_at DESC,execution_id DESC);
CREATE OR REPLACE FUNCTION finops_kubecost_runtime_attempt_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.state<>'FAILED' AND NOT EXISTS (
    SELECT 1 FROM finops_kubecost_snapshots s WHERE s.generation_id=NEW.generation_id
      AND s.org_id=NEW.org_id AND s.customer_id=NEW.customer_id
      AND s.connection_id=NEW.connection_id AND s.partition=NEW.partition
      AND s.billing_period=NEW.billing_period
      AND s.active_cur2_generation_id=NEW.active_cur2_generation_id
      AND s.source_capture_id=NEW.capture_id AND s.source_state=NEW.state
  ) THEN RAISE EXCEPTION 'FINOPS_KUBECOST_RUNTIME_ATTEMPT_SCOPE_REJECTED'; END IF;
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'FINOPS_KUBECOST_RUNTIME_ATTEMPT_IMMUTABLE'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_kubecost_runtime_attempts_scope_guard BEFORE INSERT ON finops_kubecost_runtime_attempts
  FOR EACH ROW EXECUTE FUNCTION finops_kubecost_runtime_attempt_guard();
CREATE TRIGGER finops_kubecost_runtime_attempts_update_guard BEFORE UPDATE OR DELETE ON finops_kubecost_runtime_attempts
  FOR EACH ROW EXECUTE FUNCTION finops_kubecost_runtime_attempt_guard();
--> statement-breakpoint
REVOKE ALL ON finops_kubecost_runtime_attempts FROM PUBLIC;

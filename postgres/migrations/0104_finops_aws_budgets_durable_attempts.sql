-- ADV-08 immutable signed-broker attempt evidence. Provider budgets remain in
-- finops_aws_budget_snapshots; this table proves scheduler/transport execution.
CREATE TABLE finops_aws_budget_job_attempts (
  execution_id text PRIMARY KEY CHECK (execution_id ~ '^abe_[a-f0-9]{64}$'),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  account_id text NOT NULL CHECK (account_id ~ '^[0-9]{12}$'),
  partition text NOT NULL CHECK (partition IN ('aws','aws-us-gov','aws-cn')),
  request_id text NOT NULL CHECK (request_id ~ '^abr_[a-f0-9]{64}$'),
  job_id text NOT NULL CHECK (job_id ~ '^job_[a-f0-9]{32}$'),
  job_attempt integer NOT NULL CHECK (job_attempt BETWEEN 1 AND 25),
  scheduled_window text NOT NULL CHECK (char_length(scheduled_window) = 24),
  state text NOT NULL CHECK (state IN ('ready','partial','configuration_required','unavailable','failed')),
  generation_id text REFERENCES finops_aws_budget_snapshots(generation_id),
  capture_id text,
  hierarchy_evidence_id text,
  request_body_sha256 text CHECK (request_body_sha256 IS NULL OR request_body_sha256 ~ '^[a-f0-9]{64}$'),
  response_body_sha256 text CHECK (response_body_sha256 IS NULL OR response_body_sha256 ~ '^[a-f0-9]{64}$'),
  broker_key_id text,
  failure_code text CHECK (failure_code IN (
    'BROKER_AUTHENTICATION_FAILED','BROKER_TIMEOUT','BROKER_UNAVAILABLE',
    'BROKER_RESPONSE_INVALID','SCOPE_REJECTED','EVIDENCE_REJECTED',
    'PERSISTENCE_REJECTED','INTERNAL_ERROR'
  )),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  completed_at bigint NOT NULL CHECK (completed_at BETWEEN 0 AND 9007199254740991),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id,customer_id,connection_id,request_id,job_attempt),
  CHECK ((state = 'failed' AND generation_id IS NULL AND capture_id IS NULL
      AND hierarchy_evidence_id IS NULL AND response_body_sha256 IS NULL
      AND broker_key_id IS NULL AND failure_code IS NOT NULL)
    OR (state <> 'failed' AND generation_id IS NOT NULL AND capture_id IS NOT NULL
      AND request_body_sha256 IS NOT NULL AND response_body_sha256 IS NOT NULL
      AND broker_key_id IS NOT NULL AND failure_code IS NULL
      AND (state <> 'ready' OR hierarchy_evidence_id IS NOT NULL)))
);
CREATE INDEX finops_aws_budget_job_attempts_history_idx
  ON finops_aws_budget_job_attempts
  (org_id,customer_id,connection_id,completed_at DESC,execution_id DESC);

CREATE OR REPLACE FUNCTION finops_aws_budget_job_attempt_scope_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.state <> 'failed' AND NOT EXISTS (
    SELECT 1 FROM finops_aws_budget_snapshots s
     WHERE s.generation_id = NEW.generation_id
       AND s.org_id = NEW.org_id AND s.customer_id = NEW.customer_id
       AND s.connection_id = NEW.connection_id AND s.account_id = NEW.account_id
       AND s.partition = NEW.partition AND s.source_capture_id = NEW.capture_id
  ) THEN RAISE EXCEPTION 'FINOPS_AWS_BUDGET_JOB_ATTEMPT_SCOPE_REJECTED'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_aws_budget_job_attempts_scope_guard
  BEFORE INSERT ON finops_aws_budget_job_attempts
  FOR EACH ROW EXECUTE FUNCTION finops_aws_budget_job_attempt_scope_guard();

CREATE OR REPLACE FUNCTION finops_aws_budget_job_attempt_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'FINOPS_AWS_BUDGET_JOB_ATTEMPT_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_aws_budget_job_attempts_update_guard
  BEFORE UPDATE ON finops_aws_budget_job_attempts
  FOR EACH ROW EXECUTE FUNCTION finops_aws_budget_job_attempt_immutable();
CREATE TRIGGER finops_aws_budget_job_attempts_delete_guard
  BEFORE DELETE ON finops_aws_budget_job_attempts
  FOR EACH ROW EXECUTE FUNCTION finops_aws_budget_job_attempt_immutable();
--> statement-breakpoint
REVOKE ALL ON finops_aws_budget_job_attempts FROM PUBLIC;

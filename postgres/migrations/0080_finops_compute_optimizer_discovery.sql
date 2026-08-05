-- PostgreSQL parity for immutable Compute Optimizer organization discovery.
CREATE TABLE finops_co_discovery_runs (
  run_id text PRIMARY KEY NOT NULL CHECK (run_id ~ '^cor_[a-f0-9]{64}$'),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  job_id text NOT NULL CHECK (char_length(job_id) BETWEEN 1 AND 256),
  account_id text NOT NULL CHECK (account_id ~ '^[0-9]{12}$'),
  partition text NOT NULL CHECK (partition IN ('aws','aws-us-gov','aws-cn')),
  region text NOT NULL CHECK (char_length(region) BETWEEN 9 AND 32),
  status text NOT NULL CHECK (status IN ('pending','running','complete','partial','unavailable')),
  content_sha256 text CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[a-f0-9]{64}$'),
  collected_at text,
  data_through_at text,
  enrollment_status text CHECK (enrollment_status IS NULL OR enrollment_status IN ('ACTIVE','INACTIVE','PENDING','FAILED')),
  enrollment_reason_code text,
  member_accounts_enrolled integer CHECK (member_accounts_enrolled IS NULL OR member_accounts_enrolled IN (0,1)),
  number_of_member_accounts_opted_in integer CHECK (number_of_member_accounts_opted_in IS NULL OR number_of_member_accounts_opted_in BETWEEN 0 AND 1000000000),
  enrollment_last_updated_at text,
  member_count integer NOT NULL DEFAULT 0 CHECK (member_count BETWEEN 0 AND 1000),
  export_job_count integer NOT NULL DEFAULT 0 CHECK (export_job_count BETWEEN 0 AND 5000),
  coverage_count integer NOT NULL DEFAULT 0 CHECK (coverage_count BETWEEN 0 AND 3),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  limitations_json text CHECK (limitations_json IS NULL OR char_length(limitations_json) BETWEEN 2 AND 8192),
  evidence_reference_ciphertext text CHECK (evidence_reference_ciphertext IS NULL OR (char_length(evidence_reference_ciphertext) BETWEEN 32 AND 8192 AND evidence_reference_ciphertext ~ '^fsev1\.[A-Za-z0-9_-]+$')),
  evidence_reference_key_version text CHECK (evidence_reference_key_version IS NULL OR char_length(evidence_reference_key_version) BETWEEN 1 AND 128),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  started_at bigint,
  finalized_at bigint,
  UNIQUE (org_id, customer_id, connection_id, job_id),
  UNIQUE (org_id, customer_id, connection_id, run_id),
  CHECK (started_at IS NULL OR started_at BETWEEN created_at AND 9007199254740991),
  CHECK (finalized_at IS NULL OR (started_at IS NOT NULL AND finalized_at >= started_at)),
  CHECK ((status = 'pending' AND started_at IS NULL AND finalized_at IS NULL AND content_sha256 IS NULL)
    OR (status = 'running' AND started_at IS NOT NULL AND finalized_at IS NULL AND content_sha256 IS NULL)
    OR (status IN ('complete','partial','unavailable') AND started_at IS NOT NULL AND finalized_at IS NOT NULL
      AND content_sha256 IS NOT NULL AND collected_at IS NOT NULL AND limitations_json IS NOT NULL
      AND evidence_reference_ciphertext IS NOT NULL AND evidence_reference_key_version IS NOT NULL)),
  CHECK (status <> 'complete' OR (error_code IS NULL AND data_through_at IS NOT NULL AND limitations_json = '[]')),
  CHECK (status <> 'partial' OR error_code IS NOT NULL),
  CHECK (status <> 'unavailable' OR (error_code IS NOT NULL AND member_count = 0 AND export_job_count = 0))
);
--> statement-breakpoint
CREATE INDEX finops_co_runs_history_idx ON finops_co_discovery_runs
  (org_id, customer_id, connection_id, finalized_at DESC, run_id DESC);
--> statement-breakpoint
CREATE TABLE finops_co_member_enrollments (
  run_id text NOT NULL REFERENCES finops_co_discovery_runs(run_id),
  account_id text NOT NULL CHECK (account_id ~ '^[0-9]{12}$'),
  status text NOT NULL CHECK (status IN ('ACTIVE','INACTIVE','PENDING','FAILED')),
  reason_code text CHECK (reason_code IS NULL OR char_length(reason_code) BETWEEN 1 AND 128),
  last_updated_at text,
  PRIMARY KEY (run_id, account_id)
);
--> statement-breakpoint
CREATE TABLE finops_co_export_jobs (
  run_id text NOT NULL REFERENCES finops_co_discovery_runs(run_id),
  job_id text NOT NULL CHECK (char_length(job_id) BETWEEN 1 AND 128),
  resource_type text NOT NULL CHECK (char_length(resource_type) BETWEEN 1 AND 128),
  status text NOT NULL CHECK (status IN ('QUEUED','IN_PROGRESS','COMPLETE','FAILED')),
  created_at_iso text NOT NULL,
  last_updated_at_iso text NOT NULL,
  failure_code text,
  bucket_sha256 text CHECK (bucket_sha256 IS NULL OR bucket_sha256 ~ '^[a-f0-9]{64}$'),
  object_key_sha256 text CHECK (object_key_sha256 IS NULL OR object_key_sha256 ~ '^[a-f0-9]{64}$'),
  metadata_key_sha256 text CHECK (metadata_key_sha256 IS NULL OR metadata_key_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (run_id, job_id)
);
--> statement-breakpoint
CREATE TABLE finops_co_discovery_coverage (
  run_id text NOT NULL REFERENCES finops_co_discovery_runs(run_id),
  operation text NOT NULL CHECK (operation IN ('GET_ENROLLMENT_STATUS','GET_ENROLLMENT_STATUSES_FOR_ORGANIZATION','DESCRIBE_RECOMMENDATION_EXPORT_JOBS')),
  status text NOT NULL CHECK (status IN ('SUCCEEDED','PARTIAL','FAILED')),
  pages_observed integer NOT NULL CHECK (pages_observed BETWEEN 0 AND 10),
  records_observed bigint NOT NULL CHECK (records_observed BETWEEN 0 AND 1000000000),
  records_accepted bigint NOT NULL CHECK (records_accepted BETWEEN 0 AND 1000000000),
  records_rejected bigint NOT NULL CHECK (records_rejected BETWEEN 0 AND 1000000000),
  records_omitted bigint NOT NULL CHECK (records_omitted BETWEEN 0 AND 1000000000),
  error_code text,
  PRIMARY KEY (run_id, operation)
);
--> statement-breakpoint
CREATE TABLE finops_co_discovery_heads (
  org_id text NOT NULL,
  customer_id text NOT NULL,
  connection_id text NOT NULL,
  active_run_id text NOT NULL UNIQUE REFERENCES finops_co_discovery_runs(run_id),
  advanced_at bigint NOT NULL CHECK (advanced_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (org_id, customer_id, connection_id)
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_finops_co_run_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.partition IS DISTINCT FROM OLD.partition OR NEW.region IS DISTINCT FROM OLD.region
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NOT ((OLD.status = 'pending' AND NEW.status = 'running')
      OR (OLD.status = 'running' AND NEW.status IN ('complete','partial','unavailable'))) THEN
    RAISE EXCEPTION 'FINOPS_CO_RUN_TRANSITION_REJECTED';
  END IF;
  IF OLD.status = 'running' AND NEW.status IN ('complete','partial','unavailable') AND (
    NEW.member_count <> (SELECT count(*) FROM finops_co_member_enrollments m WHERE m.run_id = NEW.run_id)
    OR NEW.export_job_count <> (SELECT count(*) FROM finops_co_export_jobs j WHERE j.run_id = NEW.run_id)
    OR NEW.coverage_count <> (SELECT count(*) FROM finops_co_discovery_coverage c WHERE c.run_id = NEW.run_id)
  ) THEN RAISE EXCEPTION 'FINOPS_CO_MATERIALIZATION_INCOMPLETE'; END IF;
  IF OLD.status = 'running' AND NEW.status = 'complete' THEN
    RAISE EXCEPTION 'FINOPS_CO_EXPORT_OBJECT_BINDING_REQUIRED';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER finops_co_run_update_guard BEFORE UPDATE ON finops_co_discovery_runs
FOR EACH ROW EXECUTE FUNCTION guard_finops_co_run_update();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_finops_co_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FINOPS_CO_IMMUTABLE'; END; $$;
--> statement-breakpoint
CREATE TRIGGER finops_co_run_delete_guard BEFORE DELETE ON finops_co_discovery_runs FOR EACH ROW EXECUTE FUNCTION reject_finops_co_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_co_member_update_guard BEFORE UPDATE ON finops_co_member_enrollments FOR EACH ROW EXECUTE FUNCTION reject_finops_co_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_co_member_delete_guard BEFORE DELETE ON finops_co_member_enrollments FOR EACH ROW EXECUTE FUNCTION reject_finops_co_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_co_export_update_guard BEFORE UPDATE ON finops_co_export_jobs FOR EACH ROW EXECUTE FUNCTION reject_finops_co_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_co_export_delete_guard BEFORE DELETE ON finops_co_export_jobs FOR EACH ROW EXECUTE FUNCTION reject_finops_co_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_co_coverage_update_guard BEFORE UPDATE ON finops_co_discovery_coverage FOR EACH ROW EXECUTE FUNCTION reject_finops_co_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_co_coverage_delete_guard BEFORE DELETE ON finops_co_discovery_coverage FOR EACH ROW EXECUTE FUNCTION reject_finops_co_immutable();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_finops_co_child_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM finops_co_discovery_runs r WHERE r.run_id = NEW.run_id AND r.status = 'running') THEN
    RAISE EXCEPTION 'FINOPS_CO_RUN_NOT_RUNNING';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER finops_co_member_insert_guard BEFORE INSERT ON finops_co_member_enrollments FOR EACH ROW EXECUTE FUNCTION guard_finops_co_child_insert();
--> statement-breakpoint
CREATE TRIGGER finops_co_export_insert_guard BEFORE INSERT ON finops_co_export_jobs FOR EACH ROW EXECUTE FUNCTION guard_finops_co_child_insert();
--> statement-breakpoint
CREATE TRIGGER finops_co_coverage_insert_guard BEFORE INSERT ON finops_co_discovery_coverage FOR EACH ROW EXECUTE FUNCTION guard_finops_co_child_insert();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_finops_co_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM finops_co_discovery_runs r WHERE r.run_id = NEW.active_run_id
    AND r.org_id = NEW.org_id AND r.customer_id = NEW.customer_id AND r.connection_id = NEW.connection_id
    AND r.status = 'complete') THEN RAISE EXCEPTION 'FINOPS_CO_HEAD_ADVANCE_REJECTED'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.connection_id IS DISTINCT FROM OLD.connection_id) THEN RAISE EXCEPTION 'FINOPS_CO_HEAD_ADVANCE_REJECTED'; END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER finops_co_head_insert_guard BEFORE INSERT ON finops_co_discovery_heads FOR EACH ROW EXECUTE FUNCTION guard_finops_co_head();
--> statement-breakpoint
CREATE TRIGGER finops_co_head_update_guard BEFORE UPDATE ON finops_co_discovery_heads FOR EACH ROW EXECUTE FUNCTION guard_finops_co_head();

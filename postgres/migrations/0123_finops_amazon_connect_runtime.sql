CREATE TABLE finops_amazon_connect_runtime_attempts (
  request_id text PRIMARY KEY CHECK (request_id ~ '^acr_[a-f0-9]{64}$'),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  scheduled_window text NOT NULL CHECK (char_length(scheduled_window)=24),
  source_boundary_sha256 text NOT NULL CHECK (source_boundary_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('IN_PROGRESS','SUCCEEDED','FAILED')),
  lease_token text, lease_expires_at bigint,
  generation_id text REFERENCES finops_amazon_connect_cost_snapshots(generation_id),
  evidence_generation_id text, evidence_object_id text, evidence_content_sha256 text,
  evidence_reference text, evidence_key_version text,
  failure_code text CHECK (failure_code IS NULL OR failure_code IN ('MATERIALIZER_AUTHENTICATION_FAILED','MATERIALIZER_TIMEOUT','MATERIALIZER_UNAVAILABLE','CAPTURE_REJECTED','EVIDENCE_REJECTED','PERSISTENCE_REJECTED')),
  started_at bigint NOT NULL CHECK (started_at BETWEEN 0 AND 9007199254740991),
  completed_at bigint, updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id,customer_id,connection_id,scheduled_window,source_boundary_sha256),
  CHECK (completed_at IS NULL OR completed_at BETWEEN started_at AND 9007199254740991),
  CHECK ((state='IN_PROGRESS' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND generation_id IS NULL AND failure_code IS NULL AND completed_at IS NULL)
    OR (state='SUCCEEDED' AND lease_token IS NULL AND lease_expires_at IS NULL AND generation_id IS NOT NULL AND evidence_generation_id IS NOT NULL AND evidence_object_id IS NOT NULL AND evidence_content_sha256 IS NOT NULL AND evidence_reference IS NOT NULL AND evidence_key_version IS NOT NULL AND failure_code IS NULL AND completed_at IS NOT NULL)
    OR (state='FAILED' AND lease_token IS NULL AND lease_expires_at IS NULL AND generation_id IS NULL AND evidence_generation_id IS NULL AND evidence_object_id IS NULL AND evidence_content_sha256 IS NULL AND evidence_reference IS NULL AND evidence_key_version IS NULL AND failure_code IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX finops_amazon_connect_runtime_status_idx ON finops_amazon_connect_runtime_attempts(org_id,customer_id,connection_id,updated_at DESC,request_id DESC);
CREATE TABLE finops_amazon_connect_runtime_failures (
  failure_id text PRIMARY KEY, request_id text NOT NULL REFERENCES finops_amazon_connect_runtime_attempts(request_id) ON DELETE CASCADE,
  org_id text NOT NULL, customer_id text NOT NULL, connection_id text NOT NULL, failure_code text NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  failed_at bigint NOT NULL CHECK (failed_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (request_id,failed_at,content_sha256)
);
CREATE OR REPLACE FUNCTION finops_amazon_connect_runtime_failure_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'FINOPS_AMAZON_CONNECT_RUNTIME_FAILURE_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_amazon_connect_runtime_failure_guard BEFORE UPDATE OR DELETE ON finops_amazon_connect_runtime_failures FOR EACH ROW EXECUTE FUNCTION finops_amazon_connect_runtime_failure_immutable();
--> statement-breakpoint
REVOKE ALL ON finops_amazon_connect_runtime_attempts FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_amazon_connect_runtime_failures FROM PUBLIC;

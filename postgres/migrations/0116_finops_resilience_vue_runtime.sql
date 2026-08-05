CREATE TABLE finops_resilience_vue_runtime_attempts (
  request_id text PRIMARY KEY CHECK (request_id ~ '^rvr_[a-f0-9]{64}$'),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE RESTRICT,
  account_id text NOT NULL CHECK (account_id ~ '^[0-9]{12}$'),
  partition text NOT NULL CHECK (partition IN ('aws','aws-cn','aws-us-gov')),
  region text NOT NULL CHECK (region ~ '^[a-z]{2}(-[a-z0-9]+)+-[0-9]$'),
  scheduled_window text NOT NULL CHECK (scheduled_window ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00[.]000Z$'),
  state text NOT NULL CHECK (state IN ('IN_PROGRESS','SUCCEEDED','FAILED')),
  failure_code text,
  generation_id text REFERENCES finops_resilience_vue_snapshots(generation_id) ON DELETE RESTRICT,
  evidence_generation_id text,
  evidence_object_id text REFERENCES evidence_objects(id) ON DELETE RESTRICT,
  evidence_content_sha256 text,
  evidence_reference_ciphertext text,
  evidence_reference_key_version text,
  lease_token_sha256 text NOT NULL CHECK (lease_token_sha256 ~ '^[a-f0-9]{64}$'),
  lease_expires_at bigint NOT NULL CHECK (lease_expires_at BETWEEN 0 AND 8640000000000000),
  started_at bigint NOT NULL CHECK (started_at BETWEEN 0 AND 8640000000000000),
  completed_at bigint CHECK (completed_at BETWEEN 0 AND 8640000000000000),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 8640000000000000),
  UNIQUE (org_id,customer_id,connection_id,account_id,partition,region,scheduled_window),
  CHECK ((state='IN_PROGRESS' AND failure_code IS NULL AND generation_id IS NULL AND completed_at IS NULL)
    OR (state='FAILED' AND failure_code IS NOT NULL AND generation_id IS NULL AND completed_at IS NOT NULL)
    OR (state='SUCCEEDED' AND failure_code IS NULL AND generation_id IS NOT NULL
      AND evidence_generation_id IS NOT NULL AND evidence_object_id IS NOT NULL
      AND evidence_content_sha256 IS NOT NULL AND evidence_reference_ciphertext IS NOT NULL
      AND evidence_reference_key_version IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (state='SUCCEEDED' OR (evidence_generation_id IS NULL AND evidence_object_id IS NULL
    AND evidence_content_sha256 IS NULL AND evidence_reference_ciphertext IS NULL
    AND evidence_reference_key_version IS NULL))
);
CREATE INDEX finops_resilience_vue_runtime_scope_idx ON finops_resilience_vue_runtime_attempts
  (org_id,customer_id,connection_id,updated_at DESC,request_id DESC);
CREATE OR REPLACE FUNCTION finops_resilience_vue_runtime_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (OLD.state='SUCCEEDED'
    OR NEW.request_id<>OLD.request_id OR NEW.org_id<>OLD.org_id
    OR NEW.customer_id<>OLD.customer_id OR NEW.connection_id<>OLD.connection_id
    OR NEW.account_id<>OLD.account_id OR NEW.partition<>OLD.partition
    OR NEW.region<>OLD.region OR NEW.scheduled_window<>OLD.scheduled_window
    OR NEW.started_at<>OLD.started_at OR NEW.updated_at<OLD.updated_at)) THEN
    RAISE EXCEPTION 'FINOPS_RESILIENCE_VUE_RUNTIME_IMMUTABLE';
  END IF;
  IF TG_OP='INSERT' AND NOT EXISTS (SELECT 1 FROM aws_connections c
    JOIN organizations o ON o.id=c.org_id AND o.status='active'
    JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status IN ('active','trial')
    WHERE c.org_id=NEW.org_id AND c.customer_id=NEW.customer_id AND c.id=NEW.connection_id
      AND c.aws_account_id=NEW.account_id AND c.partition=NEW.partition
      AND c.source_kind='aws_trust_role' AND c.status='active') THEN
    RAISE EXCEPTION 'FINOPS_RESILIENCE_VUE_RUNTIME_SCOPE_REJECTED';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_resilience_vue_runtime_write_guard BEFORE INSERT OR UPDATE OR DELETE
  ON finops_resilience_vue_runtime_attempts FOR EACH ROW EXECUTE FUNCTION finops_resilience_vue_runtime_guard();
REVOKE ALL ON finops_resilience_vue_runtime_attempts FROM PUBLIC;

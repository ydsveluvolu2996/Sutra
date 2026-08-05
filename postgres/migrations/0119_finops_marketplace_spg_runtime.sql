CREATE TABLE finops_marketplace_spg_runtime_boundaries (
  org_id text NOT NULL, customer_id text NOT NULL, connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE RESTRICT,
  boundary_json text NOT NULL, content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'), updated_at bigint NOT NULL,
  PRIMARY KEY(org_id,customer_id,connection_id), CHECK(octet_length(boundary_json) BETWEEN 2 AND 33554432)
);
CREATE TABLE finops_marketplace_spg_runtime_attempts (
  request_id text PRIMARY KEY CHECK(request_id ~ '^mpr_[0-9a-f]{64}$'), org_id text NOT NULL, customer_id text NOT NULL,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE RESTRICT, scheduled_window text, source_boundary_sha256 text,
  state text NOT NULL CHECK(state IN ('IN_PROGRESS','SUCCEEDED','FAILED')), failure_code text,
  generation_id text REFERENCES finops_marketplace_spg_snapshots(generation_id) ON DELETE RESTRICT,
  evidence_generation_id text, evidence_object_id text REFERENCES evidence_objects(id) ON DELETE RESTRICT,
  evidence_content_sha256 text, evidence_reference_ciphertext text, evidence_reference_key_version text,
  lease_token_sha256 text NOT NULL, lease_expires_at bigint NOT NULL, started_at bigint NOT NULL, completed_at bigint, updated_at bigint NOT NULL,
  CHECK(state<>'SUCCEEDED' OR (scheduled_window IS NOT NULL AND source_boundary_sha256 IS NOT NULL AND generation_id IS NOT NULL AND evidence_generation_id IS NOT NULL AND evidence_object_id IS NOT NULL AND evidence_content_sha256 IS NOT NULL AND evidence_reference_ciphertext IS NOT NULL AND evidence_reference_key_version IS NOT NULL))
);
CREATE INDEX finops_marketplace_spg_runtime_scope_idx ON finops_marketplace_spg_runtime_attempts(org_id,customer_id,connection_id,updated_at DESC);
CREATE OR REPLACE FUNCTION finops_marketplace_spg_runtime_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.request_id<>NEW.request_id OR OLD.org_id<>NEW.org_id OR OLD.customer_id<>NEW.customer_id OR OLD.connection_id<>NEW.connection_id OR OLD.started_at<>NEW.started_at OR OLD.state='SUCCEEDED' THEN RAISE EXCEPTION 'FINOPS_MARKETPLACE_SPG_RUNTIME_IMMUTABLE'; END IF; RETURN NEW; END $$;
CREATE TRIGGER finops_marketplace_spg_runtime_guard_trigger BEFORE UPDATE ON finops_marketplace_spg_runtime_attempts FOR EACH ROW EXECUTE FUNCTION finops_marketplace_spg_runtime_guard();
CREATE OR REPLACE FUNCTION finops_marketplace_spg_runtime_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FINOPS_MARKETPLACE_SPG_RUNTIME_IMMUTABLE'; END $$;
CREATE TRIGGER finops_marketplace_spg_runtime_delete_guard_trigger BEFORE DELETE ON finops_marketplace_spg_runtime_attempts FOR EACH ROW EXECUTE FUNCTION finops_marketplace_spg_runtime_delete_guard();
REVOKE ALL ON finops_marketplace_spg_runtime_boundaries FROM PUBLIC;
REVOKE ALL ON finops_marketplace_spg_runtime_attempts FROM PUBLIC;

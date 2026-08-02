CREATE TABLE finops_sustainability_target_versions (
 version_id text PRIMARY KEY,target_id text NOT NULL,org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
 metric text NOT NULL CHECK(metric IN ('COMPUTE_VCPU_HOURS','COMPUTE_MEMORY_GB_HOURS','LAMBDA_GB_SECONDS','STORAGE_GB_HOURS','STORAGE_REQUESTS','DATA_TRANSFER_GB','DATABASE_VCPU_HOURS')),
 workload_tag_key text,workload_tag_value text,period_start text NOT NULL,target_value_micros text,
 unit text NOT NULL CHECK(unit IN ('vCPU-hours','GB-hours','GB-seconds','requests','GB')),
 state text NOT NULL CHECK(state IN ('ACTIVE','REVOKED')),reason text NOT NULL,actor_id text NOT NULL,
 prior_version_id text REFERENCES finops_sustainability_target_versions(version_id),content_sha256 text NOT NULL,
 created_at bigint NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
 UNIQUE(org_id,customer_id,connection_id,target_id,version_id),CHECK(version_id ~ '^stgv_[a-f0-9]{64}$'),CHECK(target_id ~ '^stgt_[a-f0-9]{64}$'),
 CHECK((workload_tag_key IS NULL)=(workload_tag_value IS NULL)),CHECK(period_start ~ '^\d{4}-(0[1-9]|1[0-2])$'),
 CHECK((state='ACTIVE' AND target_value_micros ~ '^(0|[1-9][0-9]*)$') OR (state='REVOKED' AND target_value_micros IS NULL)),
 CHECK(char_length(reason) BETWEEN 1 AND 1024),CHECK(char_length(actor_id) BETWEEN 1 AND 256),CHECK(content_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE INDEX finops_sustainability_target_history_idx ON finops_sustainability_target_versions(org_id,customer_id,connection_id,target_id,created_at DESC);
CREATE TABLE finops_sustainability_target_heads(org_id text NOT NULL,customer_id text NOT NULL,connection_id text NOT NULL,target_id text NOT NULL,active_version_id text NOT NULL UNIQUE REFERENCES finops_sustainability_target_versions(version_id),advanced_at bigint NOT NULL CHECK(advanced_at BETWEEN 0 AND 9007199254740991),PRIMARY KEY(org_id,customer_id,connection_id,target_id));
CREATE OR REPLACE FUNCTION finops_sustainability_target_version_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'FINOPS_SUSTAINABILITY_TARGET_VERSION_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_sustainability_target_versions_update_guard BEFORE UPDATE ON finops_sustainability_target_versions FOR EACH ROW EXECUTE FUNCTION finops_sustainability_target_version_immutable();
CREATE TRIGGER finops_sustainability_target_versions_delete_guard BEFORE DELETE ON finops_sustainability_target_versions FOR EACH ROW EXECUTE FUNCTION finops_sustainability_target_version_immutable();
CREATE OR REPLACE FUNCTION finops_sustainability_target_head_guard() RETURNS trigger AS $$ DECLARE candidate finops_sustainability_target_versions%ROWTYPE; BEGIN SELECT * INTO candidate FROM finops_sustainability_target_versions WHERE version_id=NEW.active_version_id; IF candidate.version_id IS NULL OR candidate.target_id<>NEW.target_id OR candidate.org_id<>NEW.org_id OR candidate.customer_id<>NEW.customer_id OR candidate.connection_id<>NEW.connection_id OR (TG_OP='INSERT' AND candidate.prior_version_id IS NOT NULL) OR (TG_OP='UPDATE' AND (NEW.org_id<>OLD.org_id OR NEW.customer_id<>OLD.customer_id OR NEW.connection_id<>OLD.connection_id OR NEW.target_id<>OLD.target_id OR candidate.prior_version_id<>OLD.active_version_id OR candidate.created_at<OLD.advanced_at)) THEN RAISE EXCEPTION 'FINOPS_SUSTAINABILITY_TARGET_HEAD_REJECTED'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_sustainability_target_heads_write_guard BEFORE INSERT OR UPDATE ON finops_sustainability_target_heads FOR EACH ROW EXECUTE FUNCTION finops_sustainability_target_head_guard();
CREATE TRIGGER finops_sustainability_target_heads_delete_guard BEFORE DELETE ON finops_sustainability_target_heads FOR EACH ROW EXECUTE FUNCTION finops_sustainability_target_version_immutable();
--> statement-breakpoint
REVOKE ALL ON finops_sustainability_target_versions FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_sustainability_target_heads FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE finops_sustainability_runtime_attempts(
 request_id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
 scheduled_window text NOT NULL,source_boundary_sha256 text NOT NULL,snapshot_generation_id text NOT NULL REFERENCES finops_sustainability_snapshots(generation_id),evidence_generation_id text NOT NULL,evidence_object_id text NOT NULL,evidence_content_sha256 text NOT NULL,
 accepted_json text NOT NULL,accepted_sha256 text NOT NULL,created_at bigint NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
 CHECK(request_id ~ '^scr_[a-f0-9]{64}$'),CHECK(source_boundary_sha256 ~ '^[a-f0-9]{64}$'),CHECK(snapshot_generation_id ~ '^scg_[a-f0-9]{64}$'),CHECK(evidence_generation_id ~ '^fss_[a-f0-9]{64}$'),CHECK(evidence_object_id ~ '^eobj_[a-f0-9]{32}$'),CHECK(evidence_content_sha256 ~ '^[a-f0-9]{64}$'),CHECK(octet_length(accepted_json) BETWEEN 2 AND 117440512),CHECK(accepted_sha256 ~ '^[a-f0-9]{64}$'),UNIQUE(org_id,customer_id,connection_id,request_id)
);
CREATE TABLE finops_sustainability_runtime_failures(
 failure_id text PRIMARY KEY,org_id text NOT NULL,customer_id text NOT NULL,connection_id text NOT NULL,request_id text NOT NULL,scheduled_window text NOT NULL,failure_code text NOT NULL CHECK(failure_code IN ('MATERIALIZER_UNAVAILABLE','MATERIALIZER_TIMEOUT','MATERIALIZER_AUTHENTICATION_FAILED','CAPTURE_REJECTED','EVIDENCE_REJECTED','PERSISTENCE_REJECTED')),completed_at bigint NOT NULL CHECK(completed_at BETWEEN 0 AND 9007199254740991),CHECK(failure_id ~ '^srf_[a-f0-9]{64}$'),UNIQUE(org_id,customer_id,connection_id,request_id,failure_id)
);
CREATE TRIGGER finops_sustainability_runtime_attempts_update_guard BEFORE UPDATE ON finops_sustainability_runtime_attempts FOR EACH ROW EXECUTE FUNCTION finops_sustainability_target_version_immutable();
CREATE TRIGGER finops_sustainability_runtime_attempts_delete_guard BEFORE DELETE ON finops_sustainability_runtime_attempts FOR EACH ROW EXECUTE FUNCTION finops_sustainability_target_version_immutable();
CREATE TRIGGER finops_sustainability_runtime_failures_update_guard BEFORE UPDATE ON finops_sustainability_runtime_failures FOR EACH ROW EXECUTE FUNCTION finops_sustainability_target_version_immutable();
CREATE TRIGGER finops_sustainability_runtime_failures_delete_guard BEFORE DELETE ON finops_sustainability_runtime_failures FOR EACH ROW EXECUTE FUNCTION finops_sustainability_target_version_immutable();
--> statement-breakpoint
REVOKE ALL ON finops_sustainability_runtime_attempts FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_sustainability_runtime_failures FROM PUBLIC;

CREATE TABLE finops_pricing_change_runtime_acceptances (
 request_key text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE, connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
 job_id text NOT NULL, policy_id text NOT NULL, snapshot_id text NOT NULL REFERENCES finops_pricing_change_materializations(snapshot_id),
 evidence_generation_id text NOT NULL, content_sha256 text NOT NULL, active_cur2_generation_id text NOT NULL,
 captured_at text NOT NULL, became_active integer NOT NULL CHECK(became_active IN (0,1)),
 accepted_at bigint NOT NULL CHECK(accepted_at BETWEEN 0 AND 9007199254740991),
 CHECK(request_key ~ '^pcrt_[a-f0-9]{64}$'), CHECK(snapshot_id ~ '^pca_[a-f0-9]{64}$'),
 CHECK(evidence_generation_id ~ '^fss_[a-f0-9]{64}$'), CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
 CHECK(active_cur2_generation_id ~ '^fbg_[a-f0-9]{64}$'), UNIQUE(org_id,customer_id,connection_id,job_id)
);
CREATE TABLE finops_pricing_change_runtime_failures (
 failure_id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE, connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
 request_key text NOT NULL, job_id text NOT NULL, policy_id text NOT NULL, attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 5),
 failure_code text NOT NULL CHECK(failure_code IN ('POLICY_UNAVAILABLE','CUR2_UNAVAILABLE','PROVIDER_UNAVAILABLE','MATERIALIZATION_REJECTED','EVIDENCE_REJECTED','PERSISTENCE_REJECTED')),
 failed_at bigint NOT NULL CHECK(failed_at BETWEEN 0 AND 9007199254740991), CHECK(failure_id ~ '^pcrf_[a-f0-9]{64}$'),
 CHECK(request_key ~ '^pcrt_[a-f0-9]{64}$'), UNIQUE(org_id,customer_id,connection_id,job_id,attempt)
);
CREATE OR REPLACE FUNCTION finops_pricing_change_runtime_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'FINOPS_PRICING_CHANGE_RUNTIME_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_pricing_change_runtime_acceptances_update_guard BEFORE UPDATE ON finops_pricing_change_runtime_acceptances FOR EACH ROW EXECUTE FUNCTION finops_pricing_change_runtime_immutable();
CREATE TRIGGER finops_pricing_change_runtime_acceptances_delete_guard BEFORE DELETE ON finops_pricing_change_runtime_acceptances FOR EACH ROW EXECUTE FUNCTION finops_pricing_change_runtime_immutable();
CREATE TRIGGER finops_pricing_change_runtime_failures_update_guard BEFORE UPDATE ON finops_pricing_change_runtime_failures FOR EACH ROW EXECUTE FUNCTION finops_pricing_change_runtime_immutable();
CREATE TRIGGER finops_pricing_change_runtime_failures_delete_guard BEFORE DELETE ON finops_pricing_change_runtime_failures FOR EACH ROW EXECUTE FUNCTION finops_pricing_change_runtime_immutable();
--> statement-breakpoint
REVOKE ALL ON finops_pricing_change_runtime_acceptances FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_pricing_change_runtime_failures FROM PUBLIC;

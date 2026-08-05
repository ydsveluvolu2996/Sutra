CREATE TABLE finops_config_compliance_runtime_configuration(
  org_id text NOT NULL,customer_id text NOT NULL,connection_id text NOT NULL REFERENCES aws_connections(id)ON DELETE CASCADE,
  aggregator_name text NOT NULL,aggregator_arn text NOT NULL,aws_organization_id text NOT NULL,
  accounts_evidence_id text NOT NULL,accounts_observed_at text NOT NULL,active_account_ids_json text NOT NULL,
  expected_regions_json text NOT NULL,activity_evidence_json text,cur2_evidence_json text,enabled boolean NOT NULL DEFAULT false,
  updated_at bigint NOT NULL CHECK(updated_at BETWEEN 0 AND 9007199254740991),PRIMARY KEY(org_id,customer_id,connection_id),
  CHECK(char_length(aggregator_name)BETWEEN 1 AND 256),CHECK(char_length(aggregator_arn)BETWEEN 20 AND 1024),
  CHECK(char_length(aws_organization_id)BETWEEN 12 AND 34),CHECK(char_length(accounts_evidence_id)BETWEEN 1 AND 512),
  CHECK(char_length(accounts_observed_at)=24),CHECK(octet_length(active_account_ids_json)BETWEEN 16 AND 160001),
  CHECK(octet_length(expected_regions_json)BETWEEN 4 AND 2049),
  CHECK(activity_evidence_json IS NULL OR octet_length(activity_evidence_json)BETWEEN 2 AND 67108864),
  CHECK(cur2_evidence_json IS NULL OR octet_length(cur2_evidence_json)BETWEEN 2 AND 33554432));
--> statement-breakpoint
CREATE TABLE finops_config_compliance_runtime_attempts(
  replay_key text PRIMARY KEY,job_id text NOT NULL,org_id text NOT NULL,customer_id text NOT NULL,
  connection_id text NOT NULL REFERENCES aws_connections(id)ON DELETE CASCADE,scheduled_window text NOT NULL,
  state text NOT NULL CHECK(state IN('IN_PROGRESS','SUCCEEDED','FAILED')),failure_code text,result_json text,
  result_sha256 text,lease_token text NOT NULL,lease_expires_at bigint NOT NULL,started_at bigint NOT NULL,
  completed_at bigint,updated_at bigint NOT NULL,CHECK(char_length(replay_key)BETWEEN 32 AND 1024),
  CHECK(char_length(job_id)=36),CHECK(char_length(scheduled_window)=24),CHECK(char_length(lease_token)=64),
  CHECK(result_json IS NULL OR octet_length(result_json)BETWEEN 2 AND 2048),
  CHECK((state='SUCCEEDED')=(result_json IS NOT NULL AND result_sha256 IS NOT NULL)));
--> statement-breakpoint
CREATE INDEX finops_config_compliance_runtime_status_idx ON finops_config_compliance_runtime_attempts
 (org_id,customer_id,connection_id,updated_at DESC);
--> statement-breakpoint
REVOKE ALL ON finops_config_compliance_runtime_configuration FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_config_compliance_runtime_attempts FROM PUBLIC;

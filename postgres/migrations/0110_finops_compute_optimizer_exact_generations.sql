-- PostgreSQL parity for exact, immutable, chunked Compute Optimizer evidence.
CREATE TABLE finops_co_exact_artifacts (
  artifact_id text PRIMARY KEY NOT NULL,
  record_kind text NOT NULL CHECK (record_kind IN ('ATTEMPT','GENERATION')),
  schema_version text NOT NULL,
  state text NOT NULL CHECK (state IN ('PARTIAL','ALL_REGION_COMPLETE','ALL_REGION_ACCEPTED')),
  accepted_head_eligible boolean NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE RESTRICT,
  plan_set_id text NOT NULL REFERENCES finops_co_export_plan_sets(plan_set_id) ON DELETE RESTRICT,
  plan_set_content_sha256 text NOT NULL CHECK (plan_set_content_sha256 ~ '^[a-f0-9]{64}$'),
  requester_account_id text NOT NULL CHECK (requester_account_id ~ '^[0-9]{12}$'),
  partition text NOT NULL CHECK (partition IN ('aws','aws-us-gov','aws-cn')),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  scheduled_window text NOT NULL CHECK (scheduled_window ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00[.]000Z$'),
  materialized_at text NOT NULL CHECK (materialized_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.]000Z$'),
  data_through_at text NOT NULL CHECK (data_through_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.]000Z$'),
  observed_at text NOT NULL CHECK (observed_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.]000Z$'),
  expected_target_count integer NOT NULL CHECK (expected_target_count BETWEEN 1 AND 400),
  mapped_target_count integer NOT NULL CHECK (mapped_target_count BETWEEN 0 AND expected_target_count),
  recommendation_count integer NOT NULL CHECK (recommendation_count BETWEEN 0 AND 40000000),
  rejected_row_count integer NOT NULL CHECK (rejected_row_count BETWEEN 0 AND 40000000),
  source_bytes bigint NOT NULL CHECK (source_bytes BETWEEN 0 AND 107793612800),
  total_bytes integer NOT NULL CHECK (total_bytes BETWEEN 1 AND 268435456),
  chunk_count integer NOT NULL CHECK (chunk_count BETWEEN 1 AND 274),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 8640000000000000),
  UNIQUE (org_id,customer_id,connection_id,artifact_id),
  CHECK (plan_set_id = 'copes_' || plan_set_content_sha256),
  CHECK (artifact_id = CASE record_kind
    WHEN 'ATTEMPT' THEN 'coa_' || content_sha256 ELSE 'cog_' || content_sha256 END),
  CHECK ((record_kind = 'ATTEMPT'
      AND schema_version = 'sutra.compute-optimizer-export-generation-attempt.v1'
      AND state IN ('PARTIAL','ALL_REGION_COMPLETE') AND accepted_head_eligible = false)
    OR (record_kind = 'GENERATION'
      AND schema_version = 'sutra.compute-optimizer-export-generation.v1'
      AND state = 'ALL_REGION_ACCEPTED' AND accepted_head_eligible = true))
);
--> statement-breakpoint
CREATE TABLE finops_co_exact_artifact_chunks (
  artifact_id text NOT NULL REFERENCES finops_co_exact_artifacts(artifact_id) ON DELETE RESTRICT,
  chunk_index integer NOT NULL CHECK (chunk_index BETWEEN 0 AND 273),
  byte_count integer NOT NULL CHECK (byte_count BETWEEN 1 AND 983040),
  chunk_sha256 text NOT NULL CHECK (chunk_sha256 ~ '^[a-f0-9]{64}$'),
  previous_chain_sha256 text NOT NULL CHECK (previous_chain_sha256 ~ '^[a-f0-9]{64}$'),
  chain_sha256 text NOT NULL CHECK (chain_sha256 ~ '^[a-f0-9]{64}$'),
  payload_base64url text NOT NULL CHECK (
    char_length(payload_base64url) = (byte_count / 3) * 4
      + CASE (byte_count % 3) WHEN 0 THEN 0 WHEN 1 THEN 2 ELSE 3 END
    AND char_length(payload_base64url) BETWEEN 2 AND 1310720
    AND payload_base64url ~ '^[A-Za-z0-9_-]+$'),
  PRIMARY KEY (artifact_id,chunk_index)
);
--> statement-breakpoint
CREATE TABLE finops_co_exact_artifact_manifests (
  artifact_id text PRIMARY KEY NOT NULL REFERENCES finops_co_exact_artifacts(artifact_id) ON DELETE RESTRICT,
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  final_chain_sha256 text NOT NULL CHECK (final_chain_sha256 ~ '^[a-f0-9]{64}$'),
  total_bytes integer NOT NULL CHECK (total_bytes BETWEEN 1 AND 268435456),
  chunk_count integer NOT NULL CHECK (chunk_count BETWEEN 1 AND 274),
  committed_at bigint NOT NULL CHECK (committed_at BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE TABLE finops_co_exact_generation_heads (
  org_id text NOT NULL,
  customer_id text NOT NULL,
  connection_id text NOT NULL,
  generation_id text NOT NULL UNIQUE REFERENCES finops_co_exact_artifacts(artifact_id) ON DELETE RESTRICT,
  data_through_at text NOT NULL,
  observed_at text NOT NULL,
  advanced_at bigint NOT NULL CHECK (advanced_at BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (org_id,customer_id,connection_id)
);
--> statement-breakpoint
CREATE INDEX finops_co_exact_artifacts_history_idx
  ON finops_co_exact_artifacts
  (org_id,customer_id,connection_id,data_through_at DESC,observed_at DESC);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finops_co_exact_artifact_scope_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM finops_co_export_plan_sets s
    JOIN aws_connections c ON c.id = s.connection_id
      AND c.org_id = s.org_id AND c.customer_id = s.customer_id
    JOIN organizations o ON o.id = s.org_id AND o.status = 'active'
    JOIN customers cu ON cu.id = s.customer_id AND cu.org_id = s.org_id
      AND cu.status = 'active'
    WHERE s.plan_set_id = NEW.plan_set_id AND s.finalized = true
      AND s.org_id = NEW.org_id AND s.customer_id = NEW.customer_id
      AND s.connection_id = NEW.connection_id
      AND s.content_sha256 = NEW.plan_set_content_sha256
      AND s.requester_account_id = NEW.requester_account_id
      AND s.partition = NEW.partition
      AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
      AND c.aws_account_id = NEW.requester_account_id
      AND c.partition = NEW.partition
      AND (SELECT count(*) FROM finops_co_export_plan_set_members sm
        WHERE sm.plan_set_id = s.plan_set_id) = s.plan_count
  ) THEN RAISE EXCEPTION 'FINOPS_CO_EXACT_SCOPE_REJECTED'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER finops_co_exact_artifacts_scope_guard
  BEFORE INSERT ON finops_co_exact_artifacts
  FOR EACH ROW EXECUTE FUNCTION finops_co_exact_artifact_scope_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finops_co_exact_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'FINOPS_CO_EXACT_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER finops_co_exact_artifacts_update_guard BEFORE UPDATE ON finops_co_exact_artifacts
  FOR EACH ROW EXECUTE FUNCTION finops_co_exact_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_co_exact_artifacts_delete_guard BEFORE DELETE ON finops_co_exact_artifacts
  FOR EACH ROW EXECUTE FUNCTION finops_co_exact_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_co_exact_chunks_update_guard BEFORE UPDATE ON finops_co_exact_artifact_chunks
  FOR EACH ROW EXECUTE FUNCTION finops_co_exact_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_co_exact_chunks_delete_guard BEFORE DELETE ON finops_co_exact_artifact_chunks
  FOR EACH ROW EXECUTE FUNCTION finops_co_exact_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_co_exact_manifests_update_guard BEFORE UPDATE ON finops_co_exact_artifact_manifests
  FOR EACH ROW EXECUTE FUNCTION finops_co_exact_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_co_exact_manifests_delete_guard BEFORE DELETE ON finops_co_exact_artifact_manifests
  FOR EACH ROW EXECUTE FUNCTION finops_co_exact_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_co_exact_heads_delete_guard BEFORE DELETE ON finops_co_exact_generation_heads
  FOR EACH ROW EXECUTE FUNCTION finops_co_exact_immutable();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finops_co_exact_chunk_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM finops_co_exact_artifacts a
    WHERE a.artifact_id = NEW.artifact_id AND NEW.chunk_index < a.chunk_count
      AND NOT EXISTS (SELECT 1 FROM finops_co_exact_artifact_manifests m
        WHERE m.artifact_id = NEW.artifact_id)
      AND ((NEW.chunk_index = 0 AND NEW.previous_chain_sha256 = repeat('0',64))
        OR (NEW.chunk_index > 0 AND EXISTS (
          SELECT 1 FROM finops_co_exact_artifact_chunks p
          WHERE p.artifact_id = NEW.artifact_id AND p.chunk_index = NEW.chunk_index - 1
            AND p.chain_sha256 = NEW.previous_chain_sha256)))
  ) THEN RAISE EXCEPTION 'FINOPS_CO_EXACT_CHUNK_REJECTED'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER finops_co_exact_chunks_insert_guard
  BEFORE INSERT ON finops_co_exact_artifact_chunks
  FOR EACH ROW EXECUTE FUNCTION finops_co_exact_chunk_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finops_co_exact_manifest_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM finops_co_exact_artifacts a
    WHERE a.artifact_id = NEW.artifact_id
      AND a.evidence_sha256 = NEW.evidence_sha256
      AND a.total_bytes = NEW.total_bytes AND a.chunk_count = NEW.chunk_count
      AND (SELECT count(*) FROM finops_co_exact_artifact_chunks c
        WHERE c.artifact_id = NEW.artifact_id) = a.chunk_count
      AND (SELECT sum(c.byte_count) FROM finops_co_exact_artifact_chunks c
        WHERE c.artifact_id = NEW.artifact_id) = a.total_bytes
      AND (SELECT c.chain_sha256 FROM finops_co_exact_artifact_chunks c
        WHERE c.artifact_id = NEW.artifact_id ORDER BY c.chunk_index DESC LIMIT 1)
          = NEW.final_chain_sha256
  ) THEN RAISE EXCEPTION 'FINOPS_CO_EXACT_MANIFEST_REJECTED'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER finops_co_exact_manifests_insert_guard
  BEFORE INSERT ON finops_co_exact_artifact_manifests
  FOR EACH ROW EXECUTE FUNCTION finops_co_exact_manifest_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finops_co_exact_head_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (
    OLD.org_id = NEW.org_id AND OLD.customer_id = NEW.customer_id
    AND OLD.connection_id = NEW.connection_id
    AND (NEW.data_through_at > OLD.data_through_at
      OR (NEW.data_through_at = OLD.data_through_at AND NEW.observed_at > OLD.observed_at))
  ) THEN RAISE EXCEPTION 'FINOPS_CO_EXACT_HEAD_REJECTED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM finops_co_exact_artifacts a
    JOIN finops_co_exact_artifact_manifests m ON m.artifact_id = a.artifact_id
    WHERE a.artifact_id = NEW.generation_id AND a.record_kind = 'GENERATION'
      AND a.schema_version = 'sutra.compute-optimizer-export-generation.v1'
      AND a.state = 'ALL_REGION_ACCEPTED' AND a.accepted_head_eligible = true
      AND a.org_id = NEW.org_id AND a.customer_id = NEW.customer_id
      AND a.connection_id = NEW.connection_id
      AND a.data_through_at = NEW.data_through_at AND a.observed_at = NEW.observed_at
  ) THEN RAISE EXCEPTION 'FINOPS_CO_EXACT_HEAD_REJECTED'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER finops_co_exact_heads_guard
  BEFORE INSERT OR UPDATE ON finops_co_exact_generation_heads
  FOR EACH ROW EXECUTE FUNCTION finops_co_exact_head_guard();
--> statement-breakpoint
REVOKE ALL ON finops_co_exact_generation_heads FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_co_exact_artifact_manifests FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_co_exact_artifact_chunks FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_co_exact_artifacts FROM PUBLIC;

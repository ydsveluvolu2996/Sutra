-- PostgreSQL parity for server-owned Trusted Advisor organization manifests
-- and append-only accepted evidence.
CREATE TABLE finops_ta_collection_manifests (
  manifest_id text PRIMARY KEY NOT NULL CHECK (manifest_id ~ '^tam_[a-f0-9]{64}$'),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  anchor_connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  job_id text NOT NULL CHECK (char_length(job_id) BETWEEN 1 AND 256),
  taxonomy_snapshot_id text NOT NULL CHECK (char_length(taxonomy_snapshot_id) BETWEEN 1 AND 256),
  taxonomy_sha256 text NOT NULL CHECK (taxonomy_sha256 ~ '^[a-f0-9]{64}$'),
  account_set_sha256 text NOT NULL CHECK (account_set_sha256 ~ '^[a-f0-9]{64}$'),
  expected_account_count integer NOT NULL CHECK (expected_account_count BETWEEN 1 AND 10000),
  status text NOT NULL CHECK (status IN ('pending','collecting','finalizing','complete','partial','failed')),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  started_at bigint,
  finalized_at bigint,
  UNIQUE (org_id, customer_id, anchor_connection_id, job_id),
  UNIQUE (org_id, customer_id, anchor_connection_id, manifest_id),
  CHECK (started_at IS NULL OR started_at BETWEEN created_at AND 9007199254740991),
  CHECK (finalized_at IS NULL OR (started_at IS NOT NULL AND finalized_at >= started_at)),
  CHECK ((status = 'pending' AND started_at IS NULL AND finalized_at IS NULL)
    OR (status IN ('collecting','finalizing') AND started_at IS NOT NULL AND finalized_at IS NULL)
    OR (status IN ('complete','partial','failed') AND started_at IS NOT NULL AND finalized_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX finops_ta_manifests_scope_time_idx ON finops_ta_collection_manifests
  (org_id, customer_id, anchor_connection_id, created_at DESC, manifest_id DESC);
--> statement-breakpoint

CREATE TABLE finops_ta_manifest_accounts (
  manifest_id text NOT NULL REFERENCES finops_ta_collection_manifests(manifest_id),
  org_id text NOT NULL,
  customer_id text NOT NULL,
  anchor_connection_id text NOT NULL,
  account_id text NOT NULL CHECK (account_id ~ '^[0-9]{12}$'),
  account_position integer NOT NULL CHECK (account_position BETWEEN 0 AND 9999),
  target_connection_id text REFERENCES aws_connections(id),
  status text NOT NULL CHECK (status IN ('pending','running','accepted','partial','failed','unconfigured')),
  account_snapshot_id text CHECK (account_snapshot_id IS NULL OR account_snapshot_id ~ '^tas_[a-f0-9]{64}$'),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  started_at bigint,
  finished_at bigint,
  PRIMARY KEY (manifest_id, account_id),
  UNIQUE (manifest_id, account_position),
  CHECK (target_connection_id IS NULL OR
    (char_length(target_connection_id) = 37 AND substring(target_connection_id FROM 1 FOR 5) = 'conn_')),
  CHECK (started_at IS NULL OR started_at BETWEEN 0 AND 9007199254740991),
  CHECK (finished_at IS NULL OR status = 'unconfigured'
    OR (started_at IS NOT NULL AND finished_at >= started_at)),
  CHECK ((status = 'pending' AND started_at IS NULL AND finished_at IS NULL
      AND account_snapshot_id IS NULL AND error_code IS NULL)
    OR (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL
      AND account_snapshot_id IS NULL AND error_code IS NULL)
    OR (status = 'accepted' AND started_at IS NOT NULL AND finished_at IS NOT NULL
      AND account_snapshot_id IS NOT NULL AND error_code IS NULL)
    OR (status = 'partial' AND started_at IS NOT NULL AND finished_at IS NOT NULL
      AND account_snapshot_id IS NOT NULL AND error_code IS NOT NULL)
    OR (status = 'failed' AND started_at IS NOT NULL AND finished_at IS NOT NULL
      AND account_snapshot_id IS NULL AND error_code IS NOT NULL)
    OR (status = 'unconfigured' AND started_at IS NULL AND finished_at IS NOT NULL
      AND account_snapshot_id IS NULL AND error_code IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX finops_ta_manifest_accounts_status_idx
  ON finops_ta_manifest_accounts (manifest_id, status, account_position);
--> statement-breakpoint

CREATE TABLE finops_ta_account_snapshots (
  account_snapshot_id text PRIMARY KEY NOT NULL CHECK (account_snapshot_id ~ '^tas_[a-f0-9]{64}$'),
  manifest_id text NOT NULL,
  org_id text NOT NULL,
  customer_id text NOT NULL,
  anchor_connection_id text NOT NULL,
  account_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('complete','partial')),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  collected_at text NOT NULL CHECK (char_length(collected_at) = 24),
  data_through_at text,
  check_count integer NOT NULL CHECK (check_count BETWEEN 0 AND 512),
  resource_count integer NOT NULL CHECK (resource_count BETWEEN 0 AND 25000),
  rejected_record_count integer NOT NULL CHECK (rejected_record_count BETWEEN 0 AND 25000),
  evidence_reference_ciphertext text NOT NULL CHECK (
    char_length(evidence_reference_ciphertext) BETWEEN 32 AND 8192
    AND evidence_reference_ciphertext ~ '^fsev1\.[A-Za-z0-9_-]+$'),
  evidence_reference_key_version text NOT NULL CHECK (char_length(evidence_reference_key_version) BETWEEN 1 AND 128),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (manifest_id, account_id) REFERENCES finops_ta_manifest_accounts(manifest_id, account_id),
  UNIQUE (manifest_id, account_id),
  UNIQUE (manifest_id, account_snapshot_id),
  CHECK (data_through_at IS NULL OR (char_length(data_through_at) = 24 AND data_through_at <= collected_at)),
  CHECK (status <> 'complete' OR (data_through_at IS NOT NULL AND rejected_record_count = 0))
);
--> statement-breakpoint

CREATE TABLE finops_ta_check_snapshots (
  account_snapshot_id text NOT NULL REFERENCES finops_ta_account_snapshots(account_snapshot_id),
  check_id text NOT NULL CHECK (char_length(check_id) BETWEEN 1 AND 128),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 512),
  category text NOT NULL CHECK (char_length(category) BETWEEN 1 AND 128),
  status text NOT NULL CHECK (status IN ('ok','warning','error','not_available')),
  data_through_at text CHECK (data_through_at IS NULL OR char_length(data_through_at) = 24),
  processed_count bigint NOT NULL CHECK (processed_count BETWEEN 0 AND 1000000000),
  flagged_count integer NOT NULL CHECK (flagged_count BETWEEN 0 AND 25000),
  ignored_count bigint NOT NULL CHECK (ignored_count BETWEEN 0 AND 1000000000),
  suppressed_count bigint NOT NULL CHECK (suppressed_count BETWEEN 0 AND 1000000000),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (account_snapshot_id, check_id)
);
--> statement-breakpoint

CREATE TABLE finops_ta_resource_snapshots (
  resource_key text PRIMARY KEY NOT NULL CHECK (resource_key ~ '^[a-f0-9]{64}$'),
  account_snapshot_id text NOT NULL,
  check_id text NOT NULL,
  resource_id text NOT NULL CHECK (char_length(resource_id) BETWEEN 1 AND 2048),
  region text CHECK (region IS NULL OR char_length(region) BETWEEN 1 AND 128),
  status text NOT NULL CHECK (status IN ('ok','warning','error')),
  suppressed integer NOT NULL CHECK (suppressed IN (0,1)),
  metadata_json text NOT NULL CHECK (char_length(metadata_json) BETWEEN 2 AND 1048576),
  metadata_sha256 text NOT NULL CHECK (metadata_sha256 ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY (account_snapshot_id, check_id)
    REFERENCES finops_ta_check_snapshots(account_snapshot_id, check_id),
  UNIQUE (account_snapshot_id, check_id, resource_key)
);
--> statement-breakpoint
CREATE INDEX finops_ta_resources_filter_idx ON finops_ta_resource_snapshots
  (account_snapshot_id, check_id, status, region, resource_key);
--> statement-breakpoint

CREATE TABLE finops_ta_organization_snapshots (
  generation_id text PRIMARY KEY NOT NULL CHECK (generation_id ~ '^tao_[a-f0-9]{64}$'),
  manifest_id text NOT NULL UNIQUE REFERENCES finops_ta_collection_manifests(manifest_id),
  org_id text NOT NULL,
  customer_id text NOT NULL,
  anchor_connection_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('complete','partial','failed')),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  collected_at text NOT NULL CHECK (char_length(collected_at) = 24),
  data_through_at text,
  expected_account_count integer NOT NULL CHECK (expected_account_count BETWEEN 1 AND 10000),
  accepted_account_count integer NOT NULL,
  rejected_account_count integer NOT NULL,
  check_count bigint NOT NULL CHECK (check_count BETWEEN 0 AND 5120000),
  resource_count bigint NOT NULL CHECK (resource_count BETWEEN 0 AND 250000000),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id, customer_id, anchor_connection_id, generation_id),
  CHECK (data_through_at IS NULL OR (char_length(data_through_at) = 24 AND data_through_at <= collected_at)),
  CHECK (accepted_account_count BETWEEN 0 AND expected_account_count),
  CHECK (rejected_account_count = expected_account_count - accepted_account_count),
  CHECK (status <> 'complete' OR (data_through_at IS NOT NULL
    AND accepted_account_count = expected_account_count AND rejected_account_count = 0))
);
--> statement-breakpoint
CREATE INDEX finops_ta_org_snapshots_history_idx ON finops_ta_organization_snapshots
  (org_id, customer_id, anchor_connection_id, collected_at DESC, generation_id DESC);
--> statement-breakpoint

CREATE TABLE finops_ta_organization_snapshot_heads (
  org_id text NOT NULL,
  customer_id text NOT NULL,
  anchor_connection_id text NOT NULL,
  active_generation_id text NOT NULL UNIQUE REFERENCES finops_ta_organization_snapshots(generation_id),
  advanced_at bigint NOT NULL CHECK (advanced_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (org_id, customer_id, anchor_connection_id)
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_finops_ta_manifest_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.manifest_id IS DISTINCT FROM OLD.manifest_id OR NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.anchor_connection_id IS DISTINCT FROM OLD.anchor_connection_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.taxonomy_snapshot_id IS DISTINCT FROM OLD.taxonomy_snapshot_id
    OR NEW.taxonomy_sha256 IS DISTINCT FROM OLD.taxonomy_sha256
    OR NEW.account_set_sha256 IS DISTINCT FROM OLD.account_set_sha256
    OR NEW.expected_account_count IS DISTINCT FROM OLD.expected_account_count
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NOT ((OLD.status = 'pending' AND NEW.status IN ('collecting','failed'))
      OR (OLD.status = 'collecting' AND NEW.status IN ('finalizing','partial','failed'))
      OR (OLD.status = 'finalizing' AND NEW.status IN ('complete','partial','failed'))) THEN
    RAISE EXCEPTION 'FINOPS_TA_MANIFEST_TRANSITION_REJECTED';
  END IF;
  IF NEW.status = 'complete' AND ((SELECT count(*) FROM finops_ta_manifest_accounts a
      WHERE a.manifest_id = NEW.manifest_id) <> NEW.expected_account_count
    OR EXISTS (SELECT 1 FROM finops_ta_manifest_accounts a
      WHERE a.manifest_id = NEW.manifest_id AND a.status <> 'accepted')) THEN
    RAISE EXCEPTION 'FINOPS_TA_MANIFEST_INCOMPLETE';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER finops_ta_manifest_update_guard BEFORE UPDATE ON finops_ta_collection_manifests
FOR EACH ROW EXECUTE FUNCTION guard_finops_ta_manifest_update();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_finops_ta_manifest_account_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.manifest_id IS DISTINCT FROM OLD.manifest_id OR NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.anchor_connection_id IS DISTINCT FROM OLD.anchor_connection_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.account_position IS DISTINCT FROM OLD.account_position
    OR NEW.target_connection_id IS DISTINCT FROM OLD.target_connection_id
    OR NOT ((OLD.status = 'pending' AND NEW.status IN ('running','failed','unconfigured'))
      OR (OLD.status = 'running' AND NEW.status IN ('accepted','partial','failed'))) THEN
    RAISE EXCEPTION 'FINOPS_TA_ACCOUNT_TRANSITION_REJECTED';
  END IF;
  IF NEW.status IN ('accepted','partial') AND NOT EXISTS (
    SELECT 1 FROM finops_ta_account_snapshots s
     WHERE s.manifest_id = NEW.manifest_id AND s.account_id = NEW.account_id
       AND s.account_snapshot_id = NEW.account_snapshot_id
       AND ((NEW.status = 'accepted' AND s.status = 'complete')
         OR (NEW.status = 'partial' AND s.status = 'partial'))
       AND s.check_count = (SELECT count(*) FROM finops_ta_check_snapshots c
         WHERE c.account_snapshot_id = s.account_snapshot_id)
       AND s.resource_count = (SELECT count(*) FROM finops_ta_resource_snapshots r
         WHERE r.account_snapshot_id = s.account_snapshot_id)
  ) THEN RAISE EXCEPTION 'FINOPS_TA_ACCOUNT_SNAPSHOT_NOT_ACCEPTED'; END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER finops_ta_manifest_account_update_guard BEFORE UPDATE ON finops_ta_manifest_accounts
FOR EACH ROW EXECUTE FUNCTION guard_finops_ta_manifest_account_update();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_finops_ta_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FINOPS_TA_IMMUTABLE'; END; $$;
--> statement-breakpoint
CREATE TRIGGER finops_ta_manifest_delete_guard BEFORE DELETE ON finops_ta_collection_manifests
FOR EACH ROW EXECUTE FUNCTION reject_finops_ta_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_ta_manifest_account_delete_guard BEFORE DELETE ON finops_ta_manifest_accounts
FOR EACH ROW EXECUTE FUNCTION reject_finops_ta_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_ta_account_snapshot_immutable_update BEFORE UPDATE ON finops_ta_account_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_finops_ta_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_ta_account_snapshot_immutable_delete BEFORE DELETE ON finops_ta_account_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_finops_ta_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_ta_check_snapshot_immutable_update BEFORE UPDATE ON finops_ta_check_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_finops_ta_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_ta_check_snapshot_immutable_delete BEFORE DELETE ON finops_ta_check_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_finops_ta_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_ta_resource_snapshot_immutable_update BEFORE UPDATE ON finops_ta_resource_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_finops_ta_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_ta_resource_snapshot_immutable_delete BEFORE DELETE ON finops_ta_resource_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_finops_ta_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_ta_org_snapshot_immutable_update BEFORE UPDATE ON finops_ta_organization_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_finops_ta_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_ta_org_snapshot_immutable_delete BEFORE DELETE ON finops_ta_organization_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_finops_ta_immutable();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_finops_ta_org_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'complete' AND NOT EXISTS (
    SELECT 1 FROM finops_ta_collection_manifests m
     WHERE m.manifest_id = NEW.manifest_id AND m.status = 'finalizing'
       AND m.org_id = NEW.org_id AND m.customer_id = NEW.customer_id
       AND m.anchor_connection_id = NEW.anchor_connection_id
       AND m.expected_account_count = NEW.expected_account_count
       AND NEW.accepted_account_count = m.expected_account_count
       AND NOT EXISTS (SELECT 1 FROM finops_ta_manifest_accounts a
         WHERE a.manifest_id = m.manifest_id AND a.status <> 'accepted')
  ) THEN RAISE EXCEPTION 'FINOPS_TA_ORGANIZATION_SNAPSHOT_INCOMPLETE'; END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER finops_ta_org_snapshot_complete_guard BEFORE INSERT ON finops_ta_organization_snapshots
FOR EACH ROW EXECUTE FUNCTION guard_finops_ta_org_snapshot();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_finops_ta_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE candidate_time text; candidate_collected text; active_time text; active_collected text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.anchor_connection_id IS DISTINCT FROM OLD.anchor_connection_id
    OR NEW.advanced_at < OLD.advanced_at) THEN RAISE EXCEPTION 'FINOPS_TA_HEAD_SCOPE_IMMUTABLE'; END IF;
  SELECT data_through_at, collected_at INTO candidate_time, candidate_collected
    FROM finops_ta_organization_snapshots WHERE generation_id = NEW.active_generation_id
      AND org_id = NEW.org_id AND customer_id = NEW.customer_id
      AND anchor_connection_id = NEW.anchor_connection_id AND status = 'complete'
      AND created_at <= NEW.advanced_at;
  IF candidate_time IS NULL THEN RAISE EXCEPTION 'FINOPS_TA_HEAD_SNAPSHOT_NOT_ACCEPTED'; END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT data_through_at, collected_at INTO active_time, active_collected
      FROM finops_ta_organization_snapshots WHERE generation_id = OLD.active_generation_id;
    IF NOT (candidate_time > active_time OR
      (candidate_time = active_time AND candidate_collected > active_collected)) THEN
      RAISE EXCEPTION 'FINOPS_TA_HEAD_ADVANCE_REJECTED';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER finops_ta_org_head_guard BEFORE INSERT OR UPDATE ON finops_ta_organization_snapshot_heads
FOR EACH ROW EXECUTE FUNCTION guard_finops_ta_head();
--> statement-breakpoint
CREATE TRIGGER finops_ta_org_head_delete_guard BEFORE DELETE ON finops_ta_organization_snapshot_heads
FOR EACH ROW EXECUTE FUNCTION reject_finops_ta_immutable();
--> statement-breakpoint

REVOKE ALL ON finops_ta_collection_manifests FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_ta_manifest_accounts FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_ta_account_snapshots FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_ta_check_snapshots FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_ta_resource_snapshots FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_ta_organization_snapshots FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_ta_organization_snapshot_heads FROM PUBLIC;

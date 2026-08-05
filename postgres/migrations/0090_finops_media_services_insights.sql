CREATE TABLE finops_media_services_snapshots (
  generation_id text PRIMARY KEY CHECK (generation_id ~ '^msg_[a-f0-9]{64}$'),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  account_id text NOT NULL CHECK (account_id ~ '^[0-9]{12}$'),
  partition text NOT NULL CHECK (partition IN ('aws','aws-cn','aws-us-gov')),
  region text NOT NULL CHECK (char_length(region) BETWEEN 9 AND 32),
  capture_id text NOT NULL CHECK (capture_id ~ '^media_[a-f0-9]{64}$'),
  source_state text NOT NULL CHECK (source_state IN ('configuration_required','failed','partial','empty','stale','current')),
  complete boolean NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot_json text NOT NULL CHECK (octet_length(snapshot_json) BETWEEN 2 AND 83886080),
  completed_at text NOT NULL CHECK (char_length(completed_at)=24),
  data_through_at text NOT NULL CHECK (char_length(data_through_at)=24),
  billing_generation_id text NOT NULL CHECK (billing_generation_id ~ '^fbg_[a-f0-9]{64}$'),
  billing_manifest_sha256 text NOT NULL CHECK (billing_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  provider_count bigint NOT NULL CHECK (provider_count=6),
  resource_count bigint NOT NULL CHECK (resource_count BETWEEN 0 AND 300000),
  cost_row_count bigint NOT NULL CHECK (cost_row_count BETWEEN 0 AND 500000),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id,customer_id,connection_id,account_id,partition,region,capture_id),
  CHECK (NOT complete OR source_state IN ('empty','stale','current'))
);
CREATE INDEX finops_media_services_history_idx ON finops_media_services_snapshots
  (org_id,customer_id,connection_id,completed_at DESC,generation_id DESC);
CREATE TABLE finops_media_services_heads (
  org_id text NOT NULL,
  customer_id text NOT NULL,
  connection_id text NOT NULL,
  account_id text NOT NULL,
  partition text NOT NULL,
  region text NOT NULL,
  active_generation_id text NOT NULL UNIQUE REFERENCES finops_media_services_snapshots(generation_id),
  advanced_at bigint NOT NULL CHECK (advanced_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (org_id,customer_id,connection_id,account_id,partition,region)
);
CREATE OR REPLACE FUNCTION finops_media_services_snapshot_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'FINOPS_MEDIA_SERVICES_SNAPSHOT_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_media_services_snapshots_update_guard BEFORE UPDATE ON finops_media_services_snapshots
  FOR EACH ROW EXECUTE FUNCTION finops_media_services_snapshot_immutable();
CREATE TRIGGER finops_media_services_snapshots_delete_guard BEFORE DELETE ON finops_media_services_snapshots
  FOR EACH ROW EXECUTE FUNCTION finops_media_services_snapshot_immutable();
CREATE OR REPLACE FUNCTION finops_media_services_head_guard() RETURNS trigger AS $$
DECLARE candidate finops_media_services_snapshots%ROWTYPE;
DECLARE active finops_media_services_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO candidate FROM finops_media_services_snapshots WHERE generation_id=NEW.active_generation_id;
  IF candidate.generation_id IS NULL OR NOT candidate.complete OR candidate.org_id<>NEW.org_id
    OR candidate.customer_id<>NEW.customer_id OR candidate.connection_id<>NEW.connection_id
    OR candidate.account_id<>NEW.account_id OR candidate.partition<>NEW.partition OR candidate.region<>NEW.region
    THEN RAISE EXCEPTION 'FINOPS_MEDIA_SERVICES_HEAD_REJECTED'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.org_id<>OLD.org_id OR NEW.customer_id<>OLD.customer_id OR NEW.connection_id<>OLD.connection_id
      OR NEW.account_id<>OLD.account_id OR NEW.partition<>OLD.partition OR NEW.region<>OLD.region
      THEN RAISE EXCEPTION 'FINOPS_MEDIA_SERVICES_HEAD_REJECTED'; END IF;
    SELECT * INTO active FROM finops_media_services_snapshots WHERE generation_id=OLD.active_generation_id;
    IF NOT (candidate.completed_at>active.completed_at OR
      (candidate.completed_at=active.completed_at AND candidate.generation_id>active.generation_id))
      THEN RAISE EXCEPTION 'FINOPS_MEDIA_SERVICES_HEAD_REJECTED'; END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_media_services_heads_write_guard BEFORE INSERT OR UPDATE ON finops_media_services_heads
  FOR EACH ROW EXECUTE FUNCTION finops_media_services_head_guard();
CREATE TRIGGER finops_media_services_heads_delete_guard BEFORE DELETE ON finops_media_services_heads
  FOR EACH ROW EXECUTE FUNCTION finops_media_services_snapshot_immutable();
REVOKE ALL ON finops_media_services_snapshots FROM PUBLIC;
REVOKE ALL ON finops_media_services_heads FROM PUBLIC;

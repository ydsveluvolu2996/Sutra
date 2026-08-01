CREATE TABLE finops_aws_news_feed_snapshots (
  generation_id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  capture_id text NOT NULL,
  catalog_id text NOT NULL,
  source_state text NOT NULL CHECK (source_state IN ('READY','PARTIAL','STALE','FAILED')),
  coverage text NOT NULL CHECK (coverage IN ('COMPLETE','PARTIAL','UNKNOWN')),
  content_sha256 text NOT NULL,
  snapshot_json text NOT NULL,
  observed_at text NOT NULL,
  sources_succeeded bigint NOT NULL CHECK (sources_succeeded BETWEEN 0 AND 5),
  sources_failed bigint NOT NULL CHECK (sources_failed BETWEEN 0 AND 5),
  sources_truncated bigint NOT NULL CHECK (sources_truncated BETWEEN 0 AND 5),
  accepted_item_count bigint NOT NULL CHECK (accepted_item_count BETWEEN 0 AND 2000),
  deduplicated_item_count bigint NOT NULL CHECK (deduplicated_item_count BETWEEN 0 AND 2000),
  relevant_item_count bigint NOT NULL CHECK (relevant_item_count BETWEEN 0 AND 1000),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id, customer_id, connection_id, generation_id),
  UNIQUE (org_id, customer_id, connection_id, capture_id),
  CHECK (generation_id ~ '^newsg_[a-f0-9]{64}$'),
  CHECK (capture_id ~ '^news_[a-f0-9]{64}$'),
  CHECK (catalog_id ~ '^catalog_[a-f0-9]{64}$'),
  CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (octet_length(snapshot_json) BETWEEN 2 AND 8388608),
  CHECK (char_length(observed_at) = 24),
  CHECK (sources_succeeded + sources_failed = 5),
  CHECK (sources_truncated <= sources_succeeded),
  CHECK (deduplicated_item_count <= accepted_item_count),
  CHECK (relevant_item_count <= deduplicated_item_count),
  CHECK (source_state <> 'READY' OR (
    coverage = 'COMPLETE' AND sources_succeeded = 5
    AND sources_failed = 0 AND sources_truncated = 0
  ))
);
CREATE INDEX finops_aws_news_feed_snapshots_history_idx
  ON finops_aws_news_feed_snapshots
  (org_id, customer_id, connection_id, observed_at DESC, generation_id DESC);

CREATE TABLE finops_aws_news_feed_snapshot_heads (
  org_id text NOT NULL,
  customer_id text NOT NULL,
  connection_id text NOT NULL,
  active_generation_id text NOT NULL UNIQUE REFERENCES finops_aws_news_feed_snapshots(generation_id),
  advanced_at bigint NOT NULL CHECK (advanced_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (org_id, customer_id, connection_id)
);

CREATE OR REPLACE FUNCTION finops_aws_news_feed_snapshot_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'FINOPS_AWS_NEWS_FEED_SNAPSHOT_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_aws_news_feed_snapshots_update_guard
  BEFORE UPDATE ON finops_aws_news_feed_snapshots
  FOR EACH ROW EXECUTE FUNCTION finops_aws_news_feed_snapshot_immutable();
CREATE TRIGGER finops_aws_news_feed_snapshots_delete_guard
  BEFORE DELETE ON finops_aws_news_feed_snapshots
  FOR EACH ROW EXECUTE FUNCTION finops_aws_news_feed_snapshot_immutable();

CREATE OR REPLACE FUNCTION finops_aws_news_feed_head_guard() RETURNS trigger AS $$
DECLARE candidate finops_aws_news_feed_snapshots%ROWTYPE;
DECLARE active finops_aws_news_feed_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO candidate FROM finops_aws_news_feed_snapshots
    WHERE generation_id = NEW.active_generation_id;
  IF candidate.generation_id IS NULL OR candidate.source_state <> 'READY'
    OR candidate.org_id <> NEW.org_id OR candidate.customer_id <> NEW.customer_id
    OR candidate.connection_id <> NEW.connection_id THEN
    RAISE EXCEPTION 'FINOPS_AWS_NEWS_FEED_HEAD_REJECTED';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.org_id <> OLD.org_id OR NEW.customer_id <> OLD.customer_id
      OR NEW.connection_id <> OLD.connection_id THEN
      RAISE EXCEPTION 'FINOPS_AWS_NEWS_FEED_HEAD_REJECTED';
    END IF;
    SELECT * INTO active FROM finops_aws_news_feed_snapshots
      WHERE generation_id = OLD.active_generation_id;
    IF NOT (candidate.observed_at > active.observed_at) THEN
      RAISE EXCEPTION 'FINOPS_AWS_NEWS_FEED_HEAD_REJECTED';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_aws_news_feed_heads_write_guard
  BEFORE INSERT OR UPDATE ON finops_aws_news_feed_snapshot_heads
  FOR EACH ROW EXECUTE FUNCTION finops_aws_news_feed_head_guard();
CREATE TRIGGER finops_aws_news_feed_heads_delete_guard
  BEFORE DELETE ON finops_aws_news_feed_snapshot_heads
  FOR EACH ROW EXECUTE FUNCTION finops_aws_news_feed_snapshot_immutable();
--> statement-breakpoint
REVOKE ALL ON finops_aws_news_feed_snapshots FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_aws_news_feed_snapshot_heads FROM PUBLIC;

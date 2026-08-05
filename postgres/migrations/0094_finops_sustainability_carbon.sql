CREATE TABLE finops_sustainability_snapshots (
 generation_id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE, connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
 account_id text NOT NULL, partition text NOT NULL CHECK(partition IN ('aws','aws-cn','aws-us-gov')),
 source_capture_id text NOT NULL, source_state text NOT NULL CHECK(source_state IN ('configuration_required','waiting_first_delivery','empty','partial','stale','current')),
 complete boolean NOT NULL, proxy_state text NOT NULL CHECK(proxy_state IN ('not_configured','waiting_first_delivery','empty','partial','stale','current')),
 carbon_state text NOT NULL CHECK(carbon_state IN ('not_configured','waiting_first_delivery','empty','partial','stale','current')),
 completed_at text NOT NULL, content_sha256 text NOT NULL, snapshot_json text NOT NULL,
 proxy_row_count bigint NOT NULL CHECK(proxy_row_count BETWEEN 0 AND 500000), carbon_row_count bigint NOT NULL CHECK(carbon_row_count BETWEEN 0 AND 500000),
 created_at bigint NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
 UNIQUE(org_id,customer_id,connection_id,generation_id), UNIQUE(org_id,customer_id,connection_id,source_capture_id),
 CHECK(generation_id ~ '^scg_[a-f0-9]{64}$'), CHECK(source_capture_id ~ '^sustainability_[a-f0-9]{64}$'), CHECK(account_id ~ '^[0-9]{12}$'),
 CHECK(char_length(completed_at)=24), CHECK(content_sha256 ~ '^[a-f0-9]{64}$'), CHECK(octet_length(snapshot_json) BETWEEN 2 AND 117440512),
 CHECK(NOT complete OR source_state IN ('current','empty','stale'))
);
CREATE INDEX finops_sustainability_snapshots_history_idx ON finops_sustainability_snapshots(org_id,customer_id,connection_id,completed_at DESC,generation_id DESC);
CREATE TABLE finops_sustainability_snapshot_heads(org_id text NOT NULL,customer_id text NOT NULL,connection_id text NOT NULL,active_generation_id text NOT NULL UNIQUE REFERENCES finops_sustainability_snapshots(generation_id),advanced_at bigint NOT NULL CHECK(advanced_at BETWEEN 0 AND 9007199254740991),PRIMARY KEY(org_id,customer_id,connection_id));
CREATE OR REPLACE FUNCTION finops_sustainability_snapshot_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'FINOPS_SUSTAINABILITY_SNAPSHOT_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_sustainability_snapshots_update_guard BEFORE UPDATE ON finops_sustainability_snapshots FOR EACH ROW EXECUTE FUNCTION finops_sustainability_snapshot_immutable();
CREATE TRIGGER finops_sustainability_snapshots_delete_guard BEFORE DELETE ON finops_sustainability_snapshots FOR EACH ROW EXECUTE FUNCTION finops_sustainability_snapshot_immutable();
CREATE OR REPLACE FUNCTION finops_sustainability_head_guard() RETURNS trigger AS $$ DECLARE candidate finops_sustainability_snapshots%ROWTYPE; active finops_sustainability_snapshots%ROWTYPE; BEGIN SELECT * INTO candidate FROM finops_sustainability_snapshots WHERE generation_id=NEW.active_generation_id; IF candidate.generation_id IS NULL OR NOT candidate.complete OR candidate.source_state NOT IN ('current','empty') OR candidate.org_id<>NEW.org_id OR candidate.customer_id<>NEW.customer_id OR candidate.connection_id<>NEW.connection_id THEN RAISE EXCEPTION 'FINOPS_SUSTAINABILITY_HEAD_REJECTED'; END IF; IF TG_OP='UPDATE' THEN IF NEW.org_id<>OLD.org_id OR NEW.customer_id<>OLD.customer_id OR NEW.connection_id<>OLD.connection_id THEN RAISE EXCEPTION 'FINOPS_SUSTAINABILITY_HEAD_REJECTED'; END IF; SELECT * INTO active FROM finops_sustainability_snapshots WHERE generation_id=OLD.active_generation_id; IF NOT candidate.completed_at>active.completed_at THEN RAISE EXCEPTION 'FINOPS_SUSTAINABILITY_HEAD_REJECTED'; END IF; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_sustainability_heads_write_guard BEFORE INSERT OR UPDATE ON finops_sustainability_snapshot_heads FOR EACH ROW EXECUTE FUNCTION finops_sustainability_head_guard();
CREATE TRIGGER finops_sustainability_heads_delete_guard BEFORE DELETE ON finops_sustainability_snapshot_heads FOR EACH ROW EXECUTE FUNCTION finops_sustainability_snapshot_immutable();
--> statement-breakpoint
REVOKE ALL ON finops_sustainability_snapshots FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_sustainability_snapshot_heads FROM PUBLIC;

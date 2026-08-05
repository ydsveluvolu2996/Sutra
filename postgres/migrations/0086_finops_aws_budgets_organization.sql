-- Provider AWS Budgets evidence. Never merge these rows with Sutra-authored
-- finops_budgets guardrails.
CREATE TABLE finops_aws_budget_snapshots (
  generation_id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  partition text NOT NULL CHECK (partition IN ('aws','aws-us-gov','aws-cn')),
  source_capture_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('ready','partial','configuration_required','unavailable')),
  hierarchy_state text CHECK (hierarchy_state IN ('complete','partial','configuration_required','unavailable')),
  observed_at text NOT NULL,
  data_through_at text,
  content_sha256 text NOT NULL,
  payload_json text NOT NULL,
  budget_count bigint NOT NULL CHECK (budget_count BETWEEN 0 AND 1000),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id, customer_id, connection_id, generation_id),
  UNIQUE (org_id, customer_id, connection_id, source_capture_id),
  CHECK (generation_id ~ '^abg_[a-f0-9]{64}$'),
  CHECK (source_capture_id ~ '^awsbudgets_[a-f0-9]{64}$'),
  CHECK (account_id ~ '^[0-9]{12}$'),
  CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (char_length(observed_at) = 24),
  CHECK (data_through_at IS NULL OR (char_length(data_through_at) = 24 AND data_through_at <= observed_at)),
  CHECK (octet_length(payload_json) BETWEEN 2 AND 16777216),
  CHECK (state <> 'ready' OR hierarchy_state = 'complete')
);
CREATE INDEX finops_aws_budget_snapshots_history_idx ON finops_aws_budget_snapshots
  (org_id, customer_id, connection_id, observed_at DESC, generation_id DESC);

CREATE TABLE finops_aws_budget_snapshot_heads (
  org_id text NOT NULL,
  customer_id text NOT NULL,
  connection_id text NOT NULL,
  active_generation_id text NOT NULL UNIQUE REFERENCES finops_aws_budget_snapshots(generation_id),
  advanced_at bigint NOT NULL CHECK (advanced_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (org_id, customer_id, connection_id)
);

CREATE OR REPLACE FUNCTION finops_aws_budget_snapshot_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'FINOPS_AWS_BUDGET_SNAPSHOT_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_aws_budget_snapshots_update_guard BEFORE UPDATE ON finops_aws_budget_snapshots
  FOR EACH ROW EXECUTE FUNCTION finops_aws_budget_snapshot_immutable();
CREATE TRIGGER finops_aws_budget_snapshots_delete_guard BEFORE DELETE ON finops_aws_budget_snapshots
  FOR EACH ROW EXECUTE FUNCTION finops_aws_budget_snapshot_immutable();

CREATE OR REPLACE FUNCTION finops_aws_budget_head_guard() RETURNS trigger AS $$
DECLARE candidate finops_aws_budget_snapshots%ROWTYPE; active finops_aws_budget_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO candidate FROM finops_aws_budget_snapshots WHERE generation_id = NEW.active_generation_id;
  IF candidate.generation_id IS NULL OR candidate.state <> 'ready' OR candidate.hierarchy_state <> 'complete'
    OR candidate.org_id <> NEW.org_id OR candidate.customer_id <> NEW.customer_id
    OR candidate.connection_id <> NEW.connection_id THEN
    RAISE EXCEPTION 'FINOPS_AWS_BUDGET_HEAD_REJECTED';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.org_id <> OLD.org_id OR NEW.customer_id <> OLD.customer_id
      OR NEW.connection_id <> OLD.connection_id THEN RAISE EXCEPTION 'FINOPS_AWS_BUDGET_HEAD_REJECTED'; END IF;
    SELECT * INTO active FROM finops_aws_budget_snapshots WHERE generation_id = OLD.active_generation_id;
    IF NOT (candidate.observed_at > active.observed_at OR
      (candidate.observed_at = active.observed_at AND candidate.generation_id > active.generation_id)) THEN
      RAISE EXCEPTION 'FINOPS_AWS_BUDGET_HEAD_REJECTED';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_aws_budget_heads_write_guard BEFORE INSERT OR UPDATE ON finops_aws_budget_snapshot_heads
  FOR EACH ROW EXECUTE FUNCTION finops_aws_budget_head_guard();
CREATE TRIGGER finops_aws_budget_heads_delete_guard BEFORE DELETE ON finops_aws_budget_snapshot_heads
  FOR EACH ROW EXECUTE FUNCTION finops_aws_budget_snapshot_immutable();
--> statement-breakpoint
REVOKE ALL ON finops_aws_budget_snapshots FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_aws_budget_snapshot_heads FROM PUBLIC;

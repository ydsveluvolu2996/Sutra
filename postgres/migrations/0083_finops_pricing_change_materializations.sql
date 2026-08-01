-- PostgreSQL parity for immutable Pricing Change Analysis materializations.
CREATE TABLE finops_pricing_change_materializations (
  snapshot_id text PRIMARY KEY NOT NULL CHECK (snapshot_id ~ '^pca_[a-f0-9]{64}$'),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  evidence_generation_id text NOT NULL UNIQUE CHECK (evidence_generation_id ~ '^fss_[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('ready','partial','configuration_required','stale','no_usage')),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_reference_ciphertext text NOT NULL CHECK (
    char_length(evidence_reference_ciphertext) BETWEEN 32 AND 8192
    AND evidence_reference_ciphertext ~ '^fsev1\.[A-Za-z0-9_-]+$'),
  evidence_reference_key_version text NOT NULL CHECK (char_length(evidence_reference_key_version) BETWEEN 1 AND 128),
  captured_at text NOT NULL CHECK (char_length(captured_at) = 24),
  usage_period_start_at text NOT NULL CHECK (char_length(usage_period_start_at) = 24),
  usage_period_end_at text NOT NULL CHECK (char_length(usage_period_end_at) = 24 AND usage_period_end_at > usage_period_start_at),
  baseline_effective_at text NOT NULL CHECK (char_length(baseline_effective_at) = 24),
  comparison_effective_at text NOT NULL CHECK (char_length(comparison_effective_at) = 24 AND comparison_effective_at > baseline_effective_at),
  active_cur2_generation_id text NOT NULL CHECK (active_cur2_generation_id ~ '^fbg_[a-f0-9]{64}$'),
  input_line_count integer NOT NULL CHECK (input_line_count BETWEEN 0 AND 250000),
  modeled_line_count integer NOT NULL,
  excluded_line_count integer NOT NULL,
  catalog_snapshot_count integer NOT NULL CHECK (catalog_snapshot_count BETWEEN 0 AND 20000),
  catalog_term_count integer NOT NULL CHECK (catalog_term_count BETWEEN 0 AND 500000),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id, customer_id, connection_id, snapshot_id),
  CHECK (modeled_line_count BETWEEN 0 AND input_line_count),
  CHECK (excluded_line_count = input_line_count - modeled_line_count),
  CHECK (state <> 'ready' OR (input_line_count > 0
    AND modeled_line_count = input_line_count AND excluded_line_count = 0)),
  CHECK (state <> 'no_usage' OR (input_line_count = 0
    AND modeled_line_count = 0 AND excluded_line_count = 0))
);
--> statement-breakpoint
CREATE INDEX finops_pricing_change_scope_time_idx
  ON finops_pricing_change_materializations
  (org_id, customer_id, connection_id, captured_at DESC, snapshot_id DESC);
--> statement-breakpoint

CREATE TABLE finops_pricing_change_heads (
  org_id text NOT NULL,
  customer_id text NOT NULL,
  connection_id text NOT NULL,
  active_snapshot_id text NOT NULL UNIQUE REFERENCES finops_pricing_change_materializations(snapshot_id),
  advanced_at bigint NOT NULL CHECK (advanced_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (org_id, customer_id, connection_id)
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_finops_pricing_change_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FINOPS_PRICING_CHANGE_IMMUTABLE'; END; $$;
--> statement-breakpoint
CREATE TRIGGER finops_pricing_change_immutable_update BEFORE UPDATE ON finops_pricing_change_materializations
FOR EACH ROW EXECUTE FUNCTION guard_finops_pricing_change_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_pricing_change_immutable_delete BEFORE DELETE ON finops_pricing_change_materializations
FOR EACH ROW EXECUTE FUNCTION guard_finops_pricing_change_immutable();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_finops_pricing_change_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active_time text; candidate_time text; candidate_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'FINOPS_PRICING_CHANGE_HEAD_REJECTED'; END IF;
  SELECT captured_at, state INTO candidate_time, candidate_state
    FROM finops_pricing_change_materializations
   WHERE snapshot_id = NEW.active_snapshot_id AND org_id = NEW.org_id
     AND customer_id = NEW.customer_id AND connection_id = NEW.connection_id;
  IF candidate_time IS NULL OR candidate_state NOT IN ('ready','no_usage') THEN
    RAISE EXCEPTION 'FINOPS_PRICING_CHANGE_HEAD_REJECTED';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
      OR NEW.connection_id IS DISTINCT FROM OLD.connection_id THEN
      RAISE EXCEPTION 'FINOPS_PRICING_CHANGE_HEAD_REJECTED';
    END IF;
    SELECT captured_at INTO active_time FROM finops_pricing_change_materializations
     WHERE snapshot_id = OLD.active_snapshot_id;
    IF candidate_time < active_time OR (candidate_time = active_time
      AND NEW.active_snapshot_id <= OLD.active_snapshot_id) THEN
      RAISE EXCEPTION 'FINOPS_PRICING_CHANGE_HEAD_REJECTED';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER finops_pricing_change_head_guard BEFORE INSERT OR UPDATE OR DELETE ON finops_pricing_change_heads
FOR EACH ROW EXECUTE FUNCTION guard_finops_pricing_change_head();
--> statement-breakpoint

REVOKE ALL ON finops_pricing_change_materializations FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_pricing_change_heads FROM PUBLIC;

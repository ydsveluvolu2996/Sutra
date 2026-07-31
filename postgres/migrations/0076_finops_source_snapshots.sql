-- PostgreSQL parity for immutable, tenant-scoped FinOps source generations.
-- Raw provider payloads remain in the private evidence store; only an
-- application-encrypted evidence reference is retained here.
CREATE TABLE finops_source_snapshots (
  generation_id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  job_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 100),
  status text NOT NULL CHECK (
    status IN ('ready', 'complete', 'partial', 'failed', 'stale')
  ),
  content_sha256 text NOT NULL,
  schema_version text NOT NULL,
  collected_at text NOT NULL,
  data_through_at text NOT NULL,
  coverage_assessment text NOT NULL CHECK (
    coverage_assessment IN ('complete', 'partial', 'unknown')
  ),
  coverage_expected_records bigint,
  coverage_observed_records bigint NOT NULL,
  coverage_missing_records bigint,
  reconciliation_expected_records bigint,
  reconciliation_accepted_records bigint NOT NULL,
  reconciliation_rejected_records bigint NOT NULL,
  reconciliation_outcome text NOT NULL CHECK (
    reconciliation_outcome IN ('matched', 'mismatched', 'not_run')
  ),
  evidence_reference_ciphertext text NOT NULL,
  evidence_reference_key_version text NOT NULL,
  created_at bigint NOT NULL,
  FOREIGN KEY (
    org_id, customer_id, connection_id, source_id, job_id, attempt
  ) REFERENCES finops_source_job_attempts (
    org_id, customer_id, connection_id, source_id, job_id, attempt
  ),
  UNIQUE (org_id, customer_id, connection_id, source_id, generation_id),
  UNIQUE (org_id, customer_id, connection_id, source_id, job_id, attempt),
  CHECK (generation_id ~ '^fss_[a-f0-9]{64}$'),
  CHECK (char_length(org_id) BETWEEN 1 AND 256),
  CHECK (char_length(customer_id) BETWEEN 1 AND 256),
  CHECK (char_length(connection_id) = 37 AND substring(connection_id FROM 1 FOR 5) = 'conn_'),
  CHECK (char_length(source_id) BETWEEN 1 AND 64),
  CHECK (char_length(job_id) BETWEEN 1 AND 256),
  CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (char_length(schema_version) BETWEEN 1 AND 128),
  CHECK (char_length(collected_at) = 24),
  CHECK (char_length(data_through_at) = 24),
  CHECK (data_through_at <= collected_at),
  CHECK (
    (coverage_expected_records IS NULL
      OR coverage_expected_records BETWEEN 0 AND 9007199254740991)
    AND coverage_observed_records BETWEEN 0 AND 9007199254740991
    AND (coverage_missing_records IS NULL
      OR coverage_missing_records BETWEEN 0 AND 9007199254740991)
    AND (
      (coverage_expected_records IS NULL AND coverage_missing_records IS NULL)
      OR (
        coverage_expected_records IS NOT NULL
        AND coverage_missing_records IS NOT NULL
        AND coverage_observed_records + coverage_missing_records
          = coverage_expected_records
      )
    )
    AND (coverage_assessment <> 'unknown'
      OR (coverage_expected_records IS NULL AND coverage_missing_records IS NULL))
    AND (coverage_assessment <> 'complete'
      OR COALESCE(coverage_missing_records, 0) = 0)
  ),
  CHECK (
    (reconciliation_expected_records IS NULL
      OR reconciliation_expected_records BETWEEN 0 AND 9007199254740991)
    AND reconciliation_accepted_records BETWEEN 0 AND 9007199254740991
    AND reconciliation_rejected_records BETWEEN 0 AND 9007199254740991
    AND (
      reconciliation_expected_records IS NULL
      OR reconciliation_accepted_records + reconciliation_rejected_records
        <= reconciliation_expected_records
    )
  ),
  CHECK (
    status NOT IN ('ready', 'complete')
    OR (
      coverage_assessment = 'complete'
      AND COALESCE(coverage_missing_records, 0) = 0
      AND reconciliation_outcome = 'matched'
      AND reconciliation_rejected_records = 0
      AND (reconciliation_expected_records IS NULL
        OR reconciliation_accepted_records = reconciliation_expected_records)
    )
  ),
  CHECK (
    char_length(evidence_reference_ciphertext) BETWEEN 32 AND 8192
    AND evidence_reference_ciphertext ~ '^fsev1\.[A-Za-z0-9_-]+$'
  ),
  CHECK (char_length(evidence_reference_key_version) BETWEEN 1 AND 128),
  CHECK (created_at BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE INDEX finops_source_snapshots_scope_source_time_idx
  ON finops_source_snapshots (
    org_id, customer_id, connection_id, source_id,
    data_through_at DESC, collected_at DESC, generation_id DESC
  );
--> statement-breakpoint
CREATE INDEX finops_source_snapshots_job_attempt_idx
  ON finops_source_snapshots (
    org_id, customer_id, connection_id, source_id, job_id, attempt
  );
--> statement-breakpoint

CREATE TABLE finops_source_snapshot_heads (
  org_id text NOT NULL,
  customer_id text NOT NULL,
  connection_id text NOT NULL,
  source_id text NOT NULL,
  active_generation_id text NOT NULL,
  advanced_at bigint NOT NULL,
  PRIMARY KEY (org_id, customer_id, connection_id, source_id),
  FOREIGN KEY (
    org_id, customer_id, connection_id, source_id, active_generation_id
  ) REFERENCES finops_source_snapshots (
    org_id, customer_id, connection_id, source_id, generation_id
  ),
  CHECK (advanced_at BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX finops_source_snapshot_heads_generation_uq
  ON finops_source_snapshot_heads (active_generation_id);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_finops_source_snapshot_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM finops_source_job_attempts a
     WHERE a.org_id = NEW.org_id
       AND a.customer_id = NEW.customer_id
       AND a.connection_id = NEW.connection_id
       AND a.source_id = NEW.source_id
       AND a.job_id = NEW.job_id
       AND a.attempt = NEW.attempt
       AND a.status IN ('succeeded', 'partial', 'failed', 'cancelled')
       AND (a.accepted_records IS NULL
         OR a.accepted_records = NEW.reconciliation_accepted_records)
       AND (a.rejected_records IS NULL
         OR a.rejected_records = NEW.reconciliation_rejected_records)
       AND (a.expected_records IS NULL
         OR a.expected_records = NEW.reconciliation_expected_records)
       AND (
         (NEW.status IN ('ready', 'complete')
           AND a.status = 'succeeded'
           AND a.reconciliation_outcome = 'matched')
         OR (NEW.status = 'partial' AND a.status = 'partial')
         OR (NEW.status = 'failed' AND a.status IN ('failed', 'cancelled'))
         OR (NEW.status = 'stale' AND a.status IN ('succeeded', 'partial'))
       )
  ) THEN
    RAISE EXCEPTION 'FINOPS_SOURCE_SNAPSHOT_ATTEMPT_REJECTED';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER finops_source_snapshots_attempt_guard
BEFORE INSERT ON finops_source_snapshots
FOR EACH ROW EXECUTE FUNCTION guard_finops_source_snapshot_attempt();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_finops_source_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'FINOPS_SOURCE_SNAPSHOT_IMMUTABLE';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER finops_source_snapshots_immutable_update
BEFORE UPDATE ON finops_source_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_finops_source_snapshot_mutation();
--> statement-breakpoint
CREATE TRIGGER finops_source_snapshots_immutable_delete
BEFORE DELETE ON finops_source_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_finops_source_snapshot_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_finops_source_snapshot_head()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_data_through text;
  candidate_collected text;
  active_data_through text;
  active_collected text;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.advanced_at < OLD.advanced_at
  ) THEN
    RAISE EXCEPTION 'FINOPS_SOURCE_SNAPSHOT_HEAD_SCOPE_IMMUTABLE';
  END IF;

  SELECT data_through_at, collected_at
    INTO candidate_data_through, candidate_collected
    FROM finops_source_snapshots
   WHERE org_id = NEW.org_id
     AND customer_id = NEW.customer_id
     AND connection_id = NEW.connection_id
     AND source_id = NEW.source_id
     AND generation_id = NEW.active_generation_id
     AND created_at <= NEW.advanced_at
     AND status IN ('ready', 'complete')
     AND coverage_assessment = 'complete'
     AND COALESCE(coverage_missing_records, 0) = 0
     AND reconciliation_outcome = 'matched'
     AND reconciliation_rejected_records = 0
     AND (reconciliation_expected_records IS NULL
       OR reconciliation_accepted_records = reconciliation_expected_records);
  IF candidate_data_through IS NULL THEN
    RAISE EXCEPTION 'FINOPS_SOURCE_SNAPSHOT_NOT_ACCEPTED';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT data_through_at, collected_at
      INTO active_data_through, active_collected
      FROM finops_source_snapshots
     WHERE org_id = OLD.org_id
       AND customer_id = OLD.customer_id
       AND connection_id = OLD.connection_id
       AND source_id = OLD.source_id
       AND generation_id = OLD.active_generation_id;
    IF NOT (
      candidate_data_through > active_data_through
      OR (
        candidate_data_through = active_data_through
        AND candidate_collected > active_collected
      )
    ) THEN
      RAISE EXCEPTION 'FINOPS_SOURCE_SNAPSHOT_HEAD_ADVANCE_REJECTED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER finops_source_snapshot_heads_accept_guard
BEFORE INSERT OR UPDATE ON finops_source_snapshot_heads
FOR EACH ROW EXECUTE FUNCTION guard_finops_source_snapshot_head();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_finops_source_snapshot_head_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'FINOPS_SOURCE_SNAPSHOT_HEAD_IMMUTABLE';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER finops_source_snapshot_heads_immutable_delete
BEFORE DELETE ON finops_source_snapshot_heads
FOR EACH ROW EXECUTE FUNCTION reject_finops_source_snapshot_head_delete();
--> statement-breakpoint

-- Runtime grants are applied by scripts/postgres-migrate.mjs after every owner
-- migration. Explicitly deny accidental access through PostgreSQL's PUBLIC role.
REVOKE ALL ON finops_source_snapshots FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_source_snapshot_heads FROM PUBLIC;

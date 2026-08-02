-- PostgreSQL parity for immutable encrypted, single-Region Compute Optimizer export plans.
CREATE TABLE finops_co_export_plans (
  plan_id text PRIMARY KEY NOT NULL CHECK (plan_id ~ '^cope_[a-f0-9]{64}$'),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE RESTRICT,
  discovery_run_id text NOT NULL CHECK (discovery_run_id ~ '^cor_[a-f0-9]{64}$'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  requester_account_id text NOT NULL CHECK (requester_account_id ~ '^[0-9]{12}$'),
  partition text NOT NULL CHECK (partition IN ('aws','aws-us-gov','aws-cn')),
  region text NOT NULL CHECK (region ~ '^[a-z]{2}(-gov)?-[a-z]+-[0-9]$'),
  region_count integer NOT NULL CHECK (region_count = 1),
  export_family_count integer NOT NULL CHECK (export_family_count BETWEEN 1 AND 8),
  target_count integer NOT NULL CHECK (target_count BETWEEN 1 AND 8),
  sealed_envelope_format text NOT NULL CHECK (
    sealed_envelope_format = 'sutra.compute-optimizer-export-plan-envelope.v1'
  ),
  sealed_envelope_ciphertext text NOT NULL CHECK (
    char_length(sealed_envelope_ciphertext) BETWEEN 40 AND 22369659
    AND sealed_envelope_ciphertext ~ '^[A-Za-z0-9_-]+$'
    AND (char_length(sealed_envelope_ciphertext) % 4 = 0
      OR (char_length(sealed_envelope_ciphertext) % 4 = 2
        AND right(sealed_envelope_ciphertext,1) ~ '^[AQgw]$')
      OR (char_length(sealed_envelope_ciphertext) % 4 = 3
        AND right(sealed_envelope_ciphertext,1) ~ '^[AEIMQUYcgkosw048]$'))
  ),
  sealed_envelope_key_version text NOT NULL CHECK (
    sealed_envelope_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$'
  ),
  sealed_envelope_sha256 text NOT NULL CHECK (sealed_envelope_sha256 ~ '^[a-f0-9]{64}$'),
  binding_sha256 text NOT NULL CHECK (binding_sha256 ~ '^[a-f0-9]{64}$'),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id,customer_id,connection_id,plan_id),
  UNIQUE (org_id,customer_id,connection_id,discovery_run_id,plan_id),
  FOREIGN KEY (org_id,customer_id,connection_id,discovery_run_id)
    REFERENCES finops_co_discovery_runs(org_id,customer_id,connection_id,run_id)
    ON DELETE RESTRICT,
  CHECK (plan_id = 'cope_' || content_sha256),
  CHECK ((partition = 'aws-cn' AND region LIKE 'cn-%')
    OR (partition = 'aws-us-gov' AND region LIKE 'us-gov-%')
    OR (partition = 'aws' AND region NOT LIKE 'cn-%' AND region NOT LIKE 'us-gov-%')),
  CHECK (target_count = region_count * export_family_count)
);
--> statement-breakpoint
CREATE INDEX finops_co_export_plans_history_idx
  ON finops_co_export_plans
  (org_id,customer_id,connection_id,created_at DESC,plan_id DESC);
--> statement-breakpoint
CREATE INDEX finops_co_export_plans_discovery_idx
  ON finops_co_export_plans
  (org_id,customer_id,connection_id,discovery_run_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finops_co_export_plan_scope_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM finops_co_discovery_runs d
    JOIN aws_connections c ON c.id = d.connection_id
      AND c.org_id = d.org_id AND c.customer_id = d.customer_id
    JOIN organizations o ON o.id = d.org_id AND o.status = 'active'
    JOIN customers cu ON cu.id = d.customer_id AND cu.org_id = d.org_id
      AND cu.status = 'active'
    WHERE d.org_id = NEW.org_id AND d.customer_id = NEW.customer_id
      AND d.connection_id = NEW.connection_id AND d.run_id = NEW.discovery_run_id
      AND d.account_id = NEW.requester_account_id AND d.partition = NEW.partition
      AND d.region = NEW.region
      AND d.status IN ('complete','partial') AND d.content_sha256 IS NOT NULL
      AND d.finalized_at IS NOT NULL
      AND c.aws_account_id = NEW.requester_account_id AND c.partition = NEW.partition
      AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
  ) THEN RAISE EXCEPTION 'FINOPS_CO_EXPORT_PLAN_SCOPE_REJECTED'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER finops_co_export_plans_scope_guard
  BEFORE INSERT ON finops_co_export_plans
  FOR EACH ROW EXECUTE FUNCTION finops_co_export_plan_scope_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finops_co_export_plan_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'FINOPS_CO_EXPORT_PLAN_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER finops_co_export_plans_update_guard
  BEFORE UPDATE ON finops_co_export_plans
  FOR EACH ROW EXECUTE FUNCTION finops_co_export_plan_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_co_export_plans_delete_guard
  BEFORE DELETE ON finops_co_export_plans
  FOR EACH ROW EXECUTE FUNCTION finops_co_export_plan_immutable();
--> statement-breakpoint
REVOKE ALL ON finops_co_export_plans FROM PUBLIC;

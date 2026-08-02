-- PostgreSQL parity for immutable all-Region Compute Optimizer plan sets.
CREATE TABLE finops_co_export_plan_sets (
  plan_set_id text PRIMARY KEY NOT NULL CHECK (plan_set_id ~ '^copes_[a-f0-9]{64}$'),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE RESTRICT,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  requester_account_id text NOT NULL CHECK (requester_account_id ~ '^[0-9]{12}$'),
  partition text NOT NULL CHECK (partition IN ('aws','aws-us-gov','aws-cn')),
  regions_json text NOT NULL CHECK (
    jsonb_typeof(regions_json::jsonb) = 'array' AND char_length(regions_json) BETWEEN 12 AND 1751
  ),
  export_families_json text NOT NULL CHECK (
    jsonb_typeof(export_families_json::jsonb) = 'array'
    AND char_length(export_families_json) BETWEEN 4 AND 257
  ),
  plan_ids_json text NOT NULL CHECK (
    jsonb_typeof(plan_ids_json::jsonb) = 'array' AND char_length(plan_ids_json) BETWEEN 73 AND 3651
  ),
  region_count integer NOT NULL CHECK (region_count BETWEEN 1 AND 50),
  export_family_count integer NOT NULL CHECK (export_family_count BETWEEN 1 AND 8),
  plan_count integer NOT NULL,
  binding_sha256 text NOT NULL CHECK (binding_sha256 ~ '^[a-f0-9]{64}$'),
  finalized boolean DEFAULT false NOT NULL,
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 8640000000000000),
  UNIQUE (org_id,customer_id,connection_id,plan_set_id),
  CHECK (plan_set_id = 'copes_' || content_sha256),
  CHECK (jsonb_array_length(regions_json::jsonb) = region_count),
  CHECK (jsonb_array_length(export_families_json::jsonb) = export_family_count),
  CHECK (plan_count = region_count AND jsonb_array_length(plan_ids_json::jsonb) = plan_count)
);
--> statement-breakpoint
CREATE TABLE finops_co_export_plan_set_members (
  plan_set_id text NOT NULL REFERENCES finops_co_export_plan_sets(plan_set_id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 49),
  region text NOT NULL CHECK (region ~ '^[a-z]{2}(-gov)?-[a-z]+-[0-9]$'),
  plan_id text NOT NULL REFERENCES finops_co_export_plans(plan_id) ON DELETE RESTRICT
    CHECK (plan_id ~ '^cope_[a-f0-9]{64}$'),
  PRIMARY KEY (plan_set_id,position),
  UNIQUE (plan_set_id,region),
  UNIQUE (plan_set_id,plan_id),
  UNIQUE (plan_id)
);
--> statement-breakpoint
CREATE INDEX finops_co_export_plan_sets_history_idx
  ON finops_co_export_plan_sets
  (org_id,customer_id,connection_id,created_at DESC,plan_set_id DESC);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finops_co_export_plan_set_scope_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM aws_connections c
    JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
    JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
      AND cu.status = 'active'
    WHERE c.org_id = NEW.org_id AND c.customer_id = NEW.customer_id
      AND c.id = NEW.connection_id AND c.aws_account_id = NEW.requester_account_id
      AND c.partition = NEW.partition AND c.source_kind = 'aws_trust_role'
      AND c.status = 'active'
  ) THEN RAISE EXCEPTION 'FINOPS_CO_EXPORT_PLAN_SET_SCOPE_REJECTED'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER finops_co_export_plan_sets_scope_guard
  BEFORE INSERT ON finops_co_export_plan_sets
  FOR EACH ROW EXECUTE FUNCTION finops_co_export_plan_set_scope_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finops_co_export_plan_set_member_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM finops_co_export_plan_sets s
    JOIN finops_co_export_plans p ON p.plan_id = NEW.plan_id
    WHERE s.plan_set_id = NEW.plan_set_id AND s.finalized = false
      AND NEW.position < s.plan_count
      AND s.regions_json::jsonb ->> NEW.position = NEW.region
      AND s.plan_ids_json::jsonb ->> NEW.position = NEW.plan_id
      AND p.org_id = s.org_id AND p.customer_id = s.customer_id
      AND p.connection_id = s.connection_id
      AND p.requester_account_id = s.requester_account_id
      AND p.partition = s.partition AND p.region = NEW.region
      AND p.export_family_count = s.export_family_count
  ) THEN RAISE EXCEPTION 'FINOPS_CO_EXPORT_PLAN_SET_MEMBER_REJECTED'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER finops_co_export_plan_set_members_scope_guard
  BEFORE INSERT ON finops_co_export_plan_set_members
  FOR EACH ROW EXECUTE FUNCTION finops_co_export_plan_set_member_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finops_co_export_plan_set_update_guard() RETURNS trigger AS $$
BEGIN
  IF NOT (
    OLD.finalized = false AND NEW.finalized = true
    AND OLD.plan_set_id = NEW.plan_set_id
    AND OLD.org_id = NEW.org_id AND OLD.customer_id = NEW.customer_id
    AND OLD.connection_id = NEW.connection_id
    AND OLD.content_sha256 = NEW.content_sha256
    AND OLD.requester_account_id = NEW.requester_account_id
    AND OLD.partition = NEW.partition
    AND OLD.regions_json = NEW.regions_json
    AND OLD.export_families_json = NEW.export_families_json
    AND OLD.plan_ids_json = NEW.plan_ids_json
    AND OLD.region_count = NEW.region_count
    AND OLD.export_family_count = NEW.export_family_count
    AND OLD.plan_count = NEW.plan_count
    AND OLD.binding_sha256 = NEW.binding_sha256
    AND OLD.created_at = NEW.created_at
    AND (SELECT count(*) FROM finops_co_export_plan_set_members m
      WHERE m.plan_set_id = OLD.plan_set_id) = OLD.plan_count
  ) THEN RAISE EXCEPTION 'FINOPS_CO_EXPORT_PLAN_SET_IMMUTABLE'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER finops_co_export_plan_sets_update_guard
  BEFORE UPDATE ON finops_co_export_plan_sets
  FOR EACH ROW EXECUTE FUNCTION finops_co_export_plan_set_update_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finops_co_export_plan_set_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'FINOPS_CO_EXPORT_PLAN_SET_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER finops_co_export_plan_sets_delete_guard
  BEFORE DELETE ON finops_co_export_plan_sets
  FOR EACH ROW EXECUTE FUNCTION finops_co_export_plan_set_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_co_export_plan_set_members_update_guard
  BEFORE UPDATE ON finops_co_export_plan_set_members
  FOR EACH ROW EXECUTE FUNCTION finops_co_export_plan_set_immutable();
--> statement-breakpoint
CREATE TRIGGER finops_co_export_plan_set_members_delete_guard
  BEFORE DELETE ON finops_co_export_plan_set_members
  FOR EACH ROW EXECUTE FUNCTION finops_co_export_plan_set_immutable();
--> statement-breakpoint
REVOKE ALL ON finops_co_export_plan_set_members FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON finops_co_export_plan_sets FROM PUBLIC;

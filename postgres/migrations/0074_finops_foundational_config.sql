CREATE TABLE finops_kpi_goal_versions (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  kpi_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  target_direction text NOT NULL CHECK (target_direction IN ('higher_is_better', 'lower_is_better')),
  target_basis_points integer NOT NULL CHECK (target_basis_points BETWEEN 0 AND 10000),
  effective_from text NOT NULL,
  effective_to text,
  actor_id text NOT NULL,
  audit_reference text NOT NULL,
  rbac_decision_id text NOT NULL,
  rbac_decision text NOT NULL CHECK (rbac_decision = 'allow'),
  rbac_action text NOT NULL CHECK (rbac_action = 'finops:kpi-goal:write'),
  rbac_resource text NOT NULL,
  rbac_actor_id text NOT NULL,
  rbac_decided_at text NOT NULL,
  rbac_policy_version text NOT NULL,
  rbac_evidence_reference text NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (org_id, customer_id, connection_id, kpi_id, version),
  UNIQUE (org_id, customer_id, connection_id, id),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (actor_id = rbac_actor_id)
);
--> statement-breakpoint
CREATE INDEX finops_kpi_goal_versions_scope_effective_idx
  ON finops_kpi_goal_versions
  (org_id, customer_id, connection_id, kpi_id, effective_from, effective_to, version);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_finops_kpi_goal_overlap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      NEW.org_id || ':' || NEW.customer_id || ':' || NEW.connection_id || ':' || NEW.kpi_id,
      0
    )
  );
  IF EXISTS (
    SELECT 1
      FROM finops_kpi_goal_versions existing
     WHERE existing.org_id = NEW.org_id
       AND existing.customer_id = NEW.customer_id
       AND existing.connection_id = NEW.connection_id
       AND existing.kpi_id = NEW.kpi_id
       AND existing.effective_from < COALESCE(NEW.effective_to, '9999-12-31T23:59:59.999Z')
       AND NEW.effective_from < COALESCE(existing.effective_to, '9999-12-31T23:59:59.999Z')
  ) THEN
    RAISE EXCEPTION 'FINOPS_KPI_GOAL_OVERLAP';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER finops_kpi_goal_versions_no_overlap
BEFORE INSERT ON finops_kpi_goal_versions
FOR EACH ROW EXECUTE FUNCTION reject_finops_kpi_goal_overlap();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_finops_immutable_config()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'FINOPS_FOUNDATIONAL_CONFIG_IMMUTABLE';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER finops_kpi_goal_versions_immutable
BEFORE UPDATE OR DELETE ON finops_kpi_goal_versions
FOR EACH ROW EXECUTE FUNCTION reject_finops_immutable_config();
--> statement-breakpoint

CREATE TABLE finops_taxonomy_snapshots (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  source text NOT NULL CHECK (source IN ('aws_organizations', 'operator_map', 'cmdb')),
  source_evidence_id text NOT NULL,
  observed_at text NOT NULL,
  created_by text NOT NULL,
  audit_reference text NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (org_id, customer_id, connection_id, version),
  UNIQUE (org_id, customer_id, connection_id, id)
);
--> statement-breakpoint
CREATE INDEX finops_taxonomy_snapshots_scope_time_idx
  ON finops_taxonomy_snapshots
  (org_id, customer_id, connection_id, observed_at, version);
--> statement-breakpoint

CREATE TABLE finops_taxonomy_assignments (
  snapshot_id text NOT NULL,
  org_id text NOT NULL,
  customer_id text NOT NULL,
  connection_id text NOT NULL,
  account_id text NOT NULL,
  company text,
  business_unit text,
  environment text,
  cost_center text,
  owner text,
  PRIMARY KEY (snapshot_id, account_id),
  FOREIGN KEY (org_id, customer_id, connection_id, snapshot_id)
    REFERENCES finops_taxonomy_snapshots(org_id, customer_id, connection_id, id)
    ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX finops_taxonomy_assignments_scope_account_idx
  ON finops_taxonomy_assignments
  (org_id, customer_id, connection_id, account_id, snapshot_id);
--> statement-breakpoint

CREATE TABLE finops_taxonomy_allowed_values (
  snapshot_id text NOT NULL,
  org_id text NOT NULL,
  customer_id text NOT NULL,
  connection_id text NOT NULL,
  dimension text NOT NULL CHECK (dimension IN ('company', 'business_unit', 'environment', 'cost_center', 'account')),
  value text NOT NULL,
  PRIMARY KEY (snapshot_id, dimension, value),
  FOREIGN KEY (org_id, customer_id, connection_id, snapshot_id)
    REFERENCES finops_taxonomy_snapshots(org_id, customer_id, connection_id, id)
    ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX finops_taxonomy_allowed_values_scope_dimension_idx
  ON finops_taxonomy_allowed_values
  (org_id, customer_id, connection_id, dimension, value, snapshot_id);
--> statement-breakpoint

CREATE TABLE finops_taxonomy_heads (
  org_id text NOT NULL,
  customer_id text NOT NULL,
  connection_id text NOT NULL,
  snapshot_id text NOT NULL,
  promoted_by text NOT NULL,
  promoted_at bigint NOT NULL,
  PRIMARY KEY (org_id, customer_id, connection_id),
  FOREIGN KEY (org_id, customer_id, connection_id, snapshot_id)
    REFERENCES finops_taxonomy_snapshots(org_id, customer_id, connection_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX finops_taxonomy_heads_snapshot_uq
  ON finops_taxonomy_heads (snapshot_id);
--> statement-breakpoint
CREATE TRIGGER finops_taxonomy_snapshots_immutable
BEFORE UPDATE OR DELETE ON finops_taxonomy_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_finops_immutable_config();
--> statement-breakpoint
CREATE TRIGGER finops_taxonomy_assignments_immutable
BEFORE UPDATE OR DELETE ON finops_taxonomy_assignments
FOR EACH ROW EXECUTE FUNCTION reject_finops_immutable_config();
--> statement-breakpoint
CREATE TRIGGER finops_taxonomy_allowed_values_immutable
BEFORE UPDATE OR DELETE ON finops_taxonomy_allowed_values
FOR EACH ROW EXECUTE FUNCTION reject_finops_immutable_config();

CREATE TABLE IF NOT EXISTS kubernetes_sbom_license_policy_versions (
  id text PRIMARY KEY,
  policy_id text NOT NULL,
  version integer NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  cluster_id text NOT NULL REFERENCES kubernetes_clusters(id),
  policy_name text NOT NULL,
  policy_json text NOT NULL,
  policy_sha256 text NOT NULL,
  created_by text NOT NULL,
  created_at bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS kubernetes_sbom_license_policy_version_uq
  ON kubernetes_sbom_license_policy_versions (policy_id, version);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS kubernetes_sbom_license_policy_scope_idx
  ON kubernetes_sbom_license_policy_versions
  (org_id, customer_id, cluster_id, policy_id, version);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kubernetes_sbom_license_policy_heads (
  policy_id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  cluster_id text NOT NULL REFERENCES kubernetes_clusters(id),
  policy_name text NOT NULL,
  current_version integer NOT NULL,
  current_version_id text NOT NULL REFERENCES kubernetes_sbom_license_policy_versions(id),
  updated_at bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS kubernetes_sbom_license_policy_name_uq
  ON kubernetes_sbom_license_policy_heads
  (org_id, customer_id, cluster_id, policy_name);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sutra_reject_kubernetes_sbom_license_policy_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'kubernetes SBOM license policy version is immutable'; END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS kubernetes_sbom_license_policy_version_no_update
  ON kubernetes_sbom_license_policy_versions;
--> statement-breakpoint
CREATE TRIGGER kubernetes_sbom_license_policy_version_no_update
BEFORE UPDATE ON kubernetes_sbom_license_policy_versions
FOR EACH ROW EXECUTE FUNCTION sutra_reject_kubernetes_sbom_license_policy_version_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS kubernetes_sbom_license_policy_version_no_delete
  ON kubernetes_sbom_license_policy_versions;
--> statement-breakpoint
CREATE TRIGGER kubernetes_sbom_license_policy_version_no_delete
BEFORE DELETE ON kubernetes_sbom_license_policy_versions
FOR EACH ROW EXECUTE FUNCTION sutra_reject_kubernetes_sbom_license_policy_version_mutation();

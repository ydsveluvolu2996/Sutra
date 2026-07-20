CREATE TABLE IF NOT EXISTS registry_vulnerability_findings (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  finding_key text NOT NULL,
  resource_key text NOT NULL,
  resource_kind text NOT NULL,
  image_ref text NOT NULL,
  cve_id text,
  package_name text,
  installed_version text,
  fixed_version text,
  severity text NOT NULL,
  cvss_score real,
  source text NOT NULL,
  status text DEFAULT 'open' NOT NULL,
  first_seen_at bigint NOT NULL,
  last_seen_at bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS registry_vulnerability_findings_key_idx ON registry_vulnerability_findings (connection_id, finding_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS registry_vulnerability_findings_scope_idx ON registry_vulnerability_findings (org_id, customer_id, connection_id, status);

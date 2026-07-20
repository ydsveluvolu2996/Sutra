CREATE TABLE IF NOT EXISTS finding_exceptions (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  scope_rule_id text,
  scope_resource_ref text,
  justification text NOT NULL,
  approved_by text NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  expires_at bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finding_exceptions_scope_idx ON finding_exceptions (org_id, customer_id, status);

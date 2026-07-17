CREATE TABLE IF NOT EXISTS security_source_cases (
  id text PRIMARY KEY NOT NULL,
  case_number text NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  cluster_id text NOT NULL REFERENCES kubernetes_clusters(id),
  source_type text NOT NULL,
  source_id text NOT NULL REFERENCES falco_runtime_events(id),
  evidence_sha256 text NOT NULL,
  title text NOT NULL,
  severity text NOT NULL,
  priority text NOT NULL,
  status text DEFAULT 'open' NOT NULL,
  due_at bigint NOT NULL,
  created_by_user_id text NOT NULL REFERENCES users(id),
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS security_source_cases_org_number_uq
  ON security_source_cases (org_id, case_number);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS security_source_cases_active_source_uq
  ON security_source_cases (org_id, customer_id, connection_id, cluster_id, source_type, source_id)
  WHERE status != 'closed';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS security_source_cases_scope_status_idx
  ON security_source_cases (org_id, customer_id, connection_id, cluster_id, status, updated_at);

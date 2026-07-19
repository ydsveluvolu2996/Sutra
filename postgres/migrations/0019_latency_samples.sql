CREATE TABLE IF NOT EXISTS latency_samples (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL,
  endpoint_ref text NOT NULL,
  kind text NOT NULL,
  milliseconds integer NOT NULL,
  observed_at bigint NOT NULL,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS latency_samples_scope_idx ON latency_samples (org_id, customer_id, connection_id, observed_at);

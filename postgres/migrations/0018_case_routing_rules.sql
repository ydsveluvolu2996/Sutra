CREATE TABLE IF NOT EXISTS case_routing_rules (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  priority integer NOT NULL,
  match_severity text,
  match_customer_id text,
  route_assignee text,
  route_team text,
  route_destination text,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS case_routing_rules_scope_idx ON case_routing_rules (org_id, customer_id, priority);

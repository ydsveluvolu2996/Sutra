-- Allocation rules ("virtual tags"): assign CUR/FOCUS spend to a customer /
-- product / cost-center by matching account / service / tag patterns. Additive.
CREATE TABLE IF NOT EXISTS allocation_rules (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL,
  customer_id text,
  connection_id text,
  name text NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  match_json text NOT NULL,
  target_kind text NOT NULL,
  target_value text NOT NULL,
  enabled integer NOT NULL DEFAULT 1,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS allocation_rules_org ON allocation_rules (org_id, customer_id, priority);

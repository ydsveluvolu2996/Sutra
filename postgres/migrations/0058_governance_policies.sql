-- Governance policies + their approval gate. A policy is a declarative
-- condition over cost/security state Sutra already computes, paired with a
-- governance action (open a case, notify a destination, record an accepted-risk
-- exception, generate a remediation artefact the customer applies, or fail the
-- customer's own CI scan gate). Sutra's customer role is read-only, so no
-- action stored here mutates a customer resource. Additive.
CREATE TABLE IF NOT EXISTS governance_policies (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL,
  customer_id text,
  connection_id text,
  name text NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  condition_json text NOT NULL,
  action_kind text NOT NULL,
  action_target text,
  action_expires_in_days integer,
  action_note text,
  requires_approval integer NOT NULL DEFAULT 1,
  enabled integer NOT NULL DEFAULT 1,
  created_by text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS governance_policies_org ON governance_policies (org_id, customer_id, priority);
CREATE UNIQUE INDEX IF NOT EXISTS governance_policies_scope_name ON governance_policies (org_id, customer_id, name);

-- Append-only approval ledger. A request and every decision on it are separate
-- rows sharing a request_id: history is NEVER updated in place, so an approval
-- record is immutable once written and the actor of each step is preserved.
CREATE TABLE IF NOT EXISTS governance_approvals (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL,
  customer_id text NOT NULL,
  request_id text NOT NULL,
  policy_id text NOT NULL,
  action_kind text NOT NULL,
  request_key text NOT NULL,
  target_ref text,
  decision text NOT NULL,
  reason text NOT NULL,
  actor_user_id text NOT NULL,
  evidence_json text,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS governance_approvals_request ON governance_approvals (org_id, customer_id, request_id, created_at);
CREATE INDEX IF NOT EXISTS governance_approvals_pending ON governance_approvals (org_id, customer_id, decision, created_at);
-- No unique index on request_key: a key may be requested again after its
-- previous request has been decided. "One OPEN request per key" is enforced by
-- the repository against the ledger, which never rewrites a decided row.
CREATE INDEX IF NOT EXISTS governance_approvals_key ON governance_approvals (org_id, customer_id, request_key, created_at);

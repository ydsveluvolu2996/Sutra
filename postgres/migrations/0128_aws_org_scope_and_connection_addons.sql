-- Organization-scope onboarding and per-connection add-on packs.
--
-- Scope: a connection is 'account' (today's shape), 'organization_management'
-- (assumes the management role, may enumerate members), or
-- 'organization_member' (created from a management connection; carries its
-- parent's id). The cross-column invariant -- member rows carry a management
-- connection id, others never do -- is enforced at the repository boundary,
-- which is where every other connection invariant already lives; the columns
-- carry per-column shape checks only so both dialects stay identical.
--
-- Add-ons: the base role deploys exactly the pinned pack and is never
-- recomposed. Each optional capability is a separate CloudFormation stack with
-- its own enumerated allowlist (the CUR 2.0 add-on is the precedent), and this
-- table records which add-ons a connection has attached. 'declared' means the
-- operator toggled it on and the stack is not yet proven; only 'verified' rows
-- may widen anything downstream, because missing deploy evidence is never
-- treated as deployed.
ALTER TABLE aws_connections ADD COLUMN IF NOT EXISTS org_scope text NOT NULL DEFAULT 'account'
  CHECK (org_scope IN ('account', 'organization_management', 'organization_member'));
--> statement-breakpoint
ALTER TABLE aws_connections ADD COLUMN IF NOT EXISTS management_connection_id text
  CHECK (management_connection_id IS NULL
    OR management_connection_id ~ '^conn_[a-f0-9]{32}$');
--> statement-breakpoint
ALTER TABLE aws_connections ADD COLUMN IF NOT EXISTS organization_ou_id text
  CHECK (organization_ou_id IS NULL
    OR organization_ou_id ~ '^r-[0-9a-z]{4,32}$'
    OR organization_ou_id ~ '^ou-[0-9a-z]{4,32}-[0-9a-z]{8,32}$');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS aws_connections_management_idx
  ON aws_connections (management_connection_id)
  WHERE management_connection_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS aws_connection_addons (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  addon_contract_id text NOT NULL CHECK (addon_contract_id IN (
    'foundational-cur2-export-v1',
    'foundational-focus12-export-v1')),
  status text NOT NULL DEFAULT 'declared'
    CHECK (status IN ('declared', 'verified', 'detached')),
  stack_arn text CHECK (stack_arn IS NULL OR (
    length(stack_arn) BETWEEN 20 AND 2048
    AND stack_arn LIKE 'arn:%')),
  verified_at bigint CHECK (verified_at IS NULL
    OR verified_at BETWEEN 0 AND 9007199254740991),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991),
  CHECK (id ~ '^cad_[a-f0-9]{32}$'),
  CHECK ((status = 'verified') = (verified_at IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS aws_connection_addons_connection_contract_uq
  ON aws_connection_addons (connection_id, addon_contract_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS aws_connection_addons_scope_idx
  ON aws_connection_addons (org_id, customer_id, connection_id, status);

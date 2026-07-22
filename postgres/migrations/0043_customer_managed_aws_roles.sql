ALTER TABLE aws_connections
  ADD COLUMN IF NOT EXISTS role_provisioning_mode text NOT NULL DEFAULT 'sutra_template',
  ADD COLUMN IF NOT EXISTS expected_role_path text NOT NULL DEFAULT '/sutra/',
  ADD COLUMN IF NOT EXISTS expected_role_name text NOT NULL DEFAULT 'SutraReadOnlyRole',
  ADD COLUMN IF NOT EXISTS permission_capabilities_json text;

ALTER TABLE aws_connections
  DROP CONSTRAINT IF EXISTS aws_connections_role_provisioning_mode_check;

ALTER TABLE aws_connections
  ADD CONSTRAINT aws_connections_role_provisioning_mode_check
  CHECK (role_provisioning_mode IN ('sutra_template', 'customer_managed'));

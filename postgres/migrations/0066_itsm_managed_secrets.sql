ALTER TABLE itsm_connectors
  ADD COLUMN IF NOT EXISTS secret_storage text NOT NULL DEFAULT 'local'
  CHECK (secret_storage IN ('local', 'managed'));

ALTER TABLE itsm_connectors
  ADD COLUMN IF NOT EXISTS secret_reference text;

ALTER TABLE itsm_connectors
  ADD COLUMN IF NOT EXISTS secret_preview text NOT NULL DEFAULT 'local';

CREATE INDEX IF NOT EXISTS itsm_connectors_secret_storage_idx
  ON itsm_connectors (org_id, customer_id, enabled, secret_storage);

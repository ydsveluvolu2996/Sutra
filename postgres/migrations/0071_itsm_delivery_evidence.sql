ALTER TABLE itsm_connectors
  ADD COLUMN IF NOT EXISTS last_outbound_success_at text;

ALTER TABLE itsm_connectors
  ADD COLUMN IF NOT EXISTS last_authenticated_inbound_at text;

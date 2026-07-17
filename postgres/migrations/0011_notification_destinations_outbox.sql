CREATE TABLE IF NOT EXISTS security_notification_destinations (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  channel text NOT NULL,
  display_name text NOT NULL,
  enabled integer DEFAULT 1 NOT NULL,
  secret_reference text,
  email_recipients_json text,
  email_from_address text,
  ses_region text,
  created_by text NOT NULL REFERENCES users(id),
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS security_notification_destinations_scope_channel_uq
  ON security_notification_destinations (org_id, customer_id, channel);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS security_notification_destinations_scope_enabled_idx
  ON security_notification_destinations (org_id, customer_id, enabled, channel);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS security_notification_outbox (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  destination_id text NOT NULL REFERENCES security_notification_destinations(id),
  idempotency_key text NOT NULL,
  event_json text NOT NULL,
  payload_json text NOT NULL,
  payload_sha256 text NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  attempt_count integer DEFAULT 0 NOT NULL,
  next_attempt_at bigint NOT NULL,
  lease_token text,
  lease_expires_at bigint,
  last_error_code text,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  delivered_at bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS security_notification_outbox_scope_idempotency_uq
  ON security_notification_outbox (org_id, customer_id, destination_id, idempotency_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS security_notification_outbox_due_idx
  ON security_notification_outbox (status, next_attempt_at, lease_expires_at, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS security_notification_outbox_scope_history_idx
  ON security_notification_outbox (org_id, customer_id, created_at, id);

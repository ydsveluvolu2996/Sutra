ALTER TABLE security_notification_outbox
  ADD COLUMN ses_delivery_id text;
--> statement-breakpoint
ALTER TABLE security_notification_outbox
  ADD COLUMN ses_provider_message_id text;
--> statement-breakpoint
ALTER TABLE security_notification_outbox
  ADD COLUMN ses_accepted_at bigint;
--> statement-breakpoint
ALTER TABLE security_notification_outbox
  ADD COLUMN ses_last_event_type text;
--> statement-breakpoint
ALTER TABLE security_notification_outbox
  ADD COLUMN ses_last_event_at bigint;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS security_notification_outbox_ses_delivery_uq
  ON security_notification_outbox (ses_delivery_id)
  WHERE ses_delivery_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS security_notification_ses_feedback (
  event_id text PRIMARY KEY NOT NULL,
  outbox_id text NOT NULL REFERENCES security_notification_outbox(id),
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  destination_id text NOT NULL REFERENCES security_notification_destinations(id),
  delivery_id text NOT NULL,
  provider_message_id text NOT NULL,
  event_type text NOT NULL,
  event_at bigint NOT NULL,
  payload_sha256 text NOT NULL,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  reconciled_at bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS security_notification_ses_feedback_scope_idx
  ON security_notification_ses_feedback
    (org_id, customer_id, destination_id, event_at, event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS security_notification_ses_feedback_outbox_idx
  ON security_notification_ses_feedback (outbox_id, event_at, event_id);

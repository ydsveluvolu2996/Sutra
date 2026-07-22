ALTER TABLE identity_invitations ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'not_attempted';
--> statement-breakpoint
ALTER TABLE identity_invitations ADD COLUMN IF NOT EXISTS delivery_transport text NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE identity_invitations ADD COLUMN IF NOT EXISTS delivery_provider text NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE identity_invitations ADD COLUMN IF NOT EXISTS delivery_attempts integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE identity_invitations ADD COLUMN IF NOT EXISTS delivery_last_attempted_at bigint;
--> statement-breakpoint
ALTER TABLE identity_invitations ADD COLUMN IF NOT EXISTS delivery_completed_at bigint;
--> statement-breakpoint
ALTER TABLE identity_invitations ADD COLUMN IF NOT EXISTS delivery_error_code text;
--> statement-breakpoint
ALTER TABLE identity_invitations ADD COLUMN IF NOT EXISTS delivery_http_status integer;
--> statement-breakpoint
ALTER TABLE identity_invitations ADD COLUMN IF NOT EXISTS delivery_idempotency_digest text;
--> statement-breakpoint
ALTER TABLE identity_invitations
  ADD CONSTRAINT identity_invitations_delivery_status_check
  CHECK (delivery_status IN ('not_attempted', 'sending', 'accepted', 'failed', 'unknown'));
--> statement-breakpoint
ALTER TABLE identity_invitations
  ADD CONSTRAINT identity_invitations_delivery_transport_check
  CHECK (delivery_transport IN ('none', 'email-api'));
--> statement-breakpoint
ALTER TABLE identity_invitations
  ADD CONSTRAINT identity_invitations_delivery_provider_check
  CHECK (delivery_provider IN ('none', 'resend', 'sendgrid', 'generic'));
--> statement-breakpoint
ALTER TABLE identity_invitations
  ADD CONSTRAINT identity_invitations_delivery_attempts_check CHECK (delivery_attempts >= 0);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS identity_invitations_org_delivery_idx
  ON identity_invitations (org_id, delivery_status, delivery_last_attempted_at);

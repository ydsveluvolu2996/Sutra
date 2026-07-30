ALTER TABLE identity_invitations
  DROP CONSTRAINT IF EXISTS identity_invitations_delivery_provider_check;
--> statement-breakpoint
ALTER TABLE identity_invitations
  ADD CONSTRAINT identity_invitations_delivery_provider_check
  CHECK (delivery_provider IN ('none', 'zoho', 'resend', 'sendgrid', 'generic'));
--> statement-breakpoint
ALTER TABLE identity_invitation_operations
  DROP CONSTRAINT IF EXISTS identity_invitation_operations_delivery_provider_check;
--> statement-breakpoint
ALTER TABLE identity_invitation_operations
  ADD CONSTRAINT identity_invitation_operations_delivery_provider_check
  CHECK (delivery_provider IN ('none', 'zoho', 'resend', 'sendgrid', 'generic'));

-- Organizations gain a plan: 'standard' for provisioned/invited tenants,
-- 'trial' for self-serve signups. The plan is presentation and gating state
-- (trial badge, onboarding flow, future conversion), never an authorization
-- input: memberships and scopes keep deciding what a session may do. Existing
-- rows are standard, because every org that exists today was provisioned
-- deliberately rather than born from self-serve signup.
ALTER TABLE `organizations` ADD COLUMN `plan` text NOT NULL DEFAULT 'standard'
  CHECK (`plan` IN ('trial', 'standard'));

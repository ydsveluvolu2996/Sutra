-- One live AWS account can belong to only one Sutra connection globally.
-- Disabled/offboarded rows deliberately retain the claim: moving an account
-- requires a separate, explicitly audited ownership-transfer workflow.
CREATE UNIQUE INDEX `aws_connections_global_live_account_uq`
  ON `aws_connections` (`partition`, `aws_account_id`)
  WHERE `source_kind` = 'aws_trust_role';
--> statement-breakpoint
-- Role ARNs are independently unique as defense in depth. Empty pending-role
-- markers and simulated fixtures are outside the ownership boundary.
CREATE UNIQUE INDEX `aws_connections_global_live_role_uq`
  ON `aws_connections` (`role_arn`)
  WHERE `source_kind` = 'aws_trust_role' AND `role_arn` <> '';

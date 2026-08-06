-- Static-credential AWS connections join trust-role connections inside the
-- global one-live-owner-per-account boundary. Disabled/offboarded rows still
-- retain the claim; simulated fixtures remain outside it. The role index keeps
-- the role_arn <> '' guard, so static rows (role_arn always '') never collide.
DROP INDEX IF EXISTS aws_connections_global_live_account_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS aws_connections_global_live_account_uq
  ON aws_connections (partition, aws_account_id)
  WHERE source_kind IN ('aws_trust_role', 'aws_static_credentials');
--> statement-breakpoint
DROP INDEX IF EXISTS aws_connections_global_live_role_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS aws_connections_global_live_role_uq
  ON aws_connections (role_arn)
  WHERE source_kind IN ('aws_trust_role', 'aws_static_credentials') AND role_arn <> '';

-- Non-secret pointers to the exact collector-owned Secrets Manager version.
--
-- Customer access keys and secret keys never enter this database. These three
-- columns only bind a verified connection to an opaque secret ARN, immutable
-- version id, and the already-disclosed final four characters of the access
-- key. The final CHECK keeps the reference atomic: a row carries all three
-- derivatives or none of them.
ALTER TABLE aws_connections ADD COLUMN IF NOT EXISTS credential_secret_arn text;
--> statement-breakpoint
ALTER TABLE aws_connections ADD COLUMN IF NOT EXISTS credential_secret_version_id text;
--> statement-breakpoint
ALTER TABLE aws_connections ADD COLUMN IF NOT EXISTS credential_access_key_last4 text;
--> statement-breakpoint
ALTER TABLE aws_connections
  ADD CONSTRAINT aws_connections_static_credential_reference_shape
  CHECK (
    (credential_secret_arn IS NULL
      AND credential_secret_version_id IS NULL
      AND credential_access_key_last4 IS NULL)
    OR
    (credential_secret_arn IS NOT NULL
      AND credential_secret_version_id IS NOT NULL
      AND credential_access_key_last4 IS NOT NULL
      AND source_kind = 'aws_static_credentials'
      AND credential_secret_arn ~ '^arn:aws:secretsmanager:[a-z]{2}(-[a-z0-9]+)+-[0-9]:[0-9]{12}:secret:sutra/customer-aws-credentials/v1/[a-f0-9]{64}/[a-f0-9]{64}-[A-Za-z0-9]{6}$'
      AND credential_secret_version_id ~ '^[A-Za-z0-9-]{32,64}$'
      AND credential_access_key_last4 ~ '^[A-Z0-9]{4}$')
  );

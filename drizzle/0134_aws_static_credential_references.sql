-- Non-secret pointers to the exact collector-owned Secrets Manager version.
--
-- Customer access keys and secret keys never enter this database. These three
-- columns only bind a verified connection to an opaque secret ARN, immutable
-- version id, and the already-disclosed final four characters of the access
-- key. The final CHECK keeps the reference atomic: a row carries all three
-- derivatives or none of them.
ALTER TABLE `aws_connections` ADD `credential_secret_arn` text
  CHECK (`credential_secret_arn` IS NULL OR (
    length(`credential_secret_arn`) BETWEEN 128 AND 2048
    AND substr(`credential_secret_arn`, 1, 23) = 'arn:aws:secretsmanager:'
    AND instr(`credential_secret_arn`, ':secret:sutra/customer-aws-credentials/v1/') > 23
  ));
--> statement-breakpoint
ALTER TABLE `aws_connections` ADD `credential_secret_version_id` text
  CHECK (`credential_secret_version_id` IS NULL OR (
    length(`credential_secret_version_id`) BETWEEN 32 AND 64
    AND `credential_secret_version_id` NOT GLOB '*[^A-Za-z0-9-]*'
  ));
--> statement-breakpoint
ALTER TABLE `aws_connections` ADD `credential_access_key_last4` text
  CHECK (
    (`credential_secret_arn` IS NULL
      AND `credential_secret_version_id` IS NULL
      AND `credential_access_key_last4` IS NULL)
    OR
    (`credential_secret_arn` IS NOT NULL
      AND `credential_secret_version_id` IS NOT NULL
      AND `credential_access_key_last4` IS NOT NULL
      AND `source_kind` = 'aws_static_credentials'
      AND length(`credential_access_key_last4`) = 4
      AND `credential_access_key_last4` NOT GLOB '*[^A-Z0-9]*')
  );

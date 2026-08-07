-- Hosted at-rest contract for customer-supplied AWS access keys.
--
-- `encrypted_state` is sealed with the single application registry key. That is
-- an adequate contract for connection metadata, but not for customer key
-- material: one key protecting every tenant's credentials, with no rotation
-- story and no audit trail on individual reads.
--
-- Credential material therefore never enters `encrypted_state`. It lives in its
-- own envelope, sealed under a per-connection AES-256 data key that KMS issues
-- and wraps. Only the wrapped key is stored here, so reading these rows without
-- a live kms:Decrypt yields nothing, and every unwrap is a CloudTrail event.
--
-- `credential_key_arn` is recorded alongside the envelope so a re-key can find
-- exactly which rows are still sealed under a retired CMK.
ALTER TABLE hosted_broker_connections
  ADD COLUMN IF NOT EXISTS credential_envelope text;
--> statement-breakpoint
ALTER TABLE hosted_broker_connections
  ADD COLUMN IF NOT EXISTS credential_key_arn text;
--> statement-breakpoint
-- The envelope and the CMK that sealed it are meaningful only together: an
-- envelope with no recorded key cannot be rotated or audited, and a recorded key
-- with no envelope describes material that is not there. A tombstoned row must
-- carry neither, so offboarding removes the credential with the connection
-- rather than leaving sealed material behind.
ALTER TABLE hosted_broker_connections
  ADD CONSTRAINT hosted_broker_credential_envelope_complete
  CHECK (
    (credential_envelope IS NULL AND credential_key_arn IS NULL)
    OR (
      credential_envelope IS NOT NULL
      AND credential_key_arn IS NOT NULL
      AND tombstoned_at IS NULL
    )
  );
--> statement-breakpoint
-- Supports the re-key sweep: find every live connection still sealed under a
-- given CMK. Partial, because rows without credentials are the common case.
CREATE INDEX IF NOT EXISTS hosted_broker_connections_credential_key_arn_idx
  ON hosted_broker_connections (credential_key_arn)
  WHERE credential_envelope IS NOT NULL;

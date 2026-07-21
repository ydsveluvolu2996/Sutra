-- Durable, atomic per-source rate-limit counter for the hosted SELF-SERVE
-- org-creation path (INFO-2). Each row is a fixed-window bucket keyed by an
-- OPAQUE hash of the source (a SHA-256 of the trusted edge IP, or a single shared
-- "unattributed" bucket when no trusted IP is present) combined with the window
-- start. Incrementing is a single conditional INSERT ... ON CONFLICT DO UPDATE
-- executed by the database, which is what makes the count atomic across worker
-- instances and process restarts. This is SYSTEM/platform state, not tenant data:
-- the key carries no readable IP and no foreign key into any tenant-gated table,
-- and expired buckets are swept on every reservation.
--
-- Like the hosted-broker replay-nonce store, this table ships as migration files
-- (drizzle 0048 / postgres 0042) that the PARENT registers. Until it is
-- registered, the self-serve counter throws and provisioning fails CLOSED — the
-- self-serve path never opens on a missing counter, never open.
CREATE TABLE IF NOT EXISTS hosted_signup_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  attempts BIGINT NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS hosted_signup_rate_limits_expiry_idx ON hosted_signup_rate_limits (expires_at);

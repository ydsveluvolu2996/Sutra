CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  token_digest TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT,
  consumed_nonce TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'not_attempted'
    CHECK (delivery_status IN ('not_attempted', 'accepted', 'failed', 'unknown')),
  delivery_error_code TEXT,
  requested_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_digest_uq ON password_reset_tokens (token_digest);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_expiry_idx ON password_reset_tokens (user_id, expires_at, consumed_at);

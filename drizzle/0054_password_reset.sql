CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  token_digest TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_nonce TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'not_attempted',
  delivery_error_code TEXT,
  requested_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_digest_uq ON password_reset_tokens (token_digest);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_expiry_idx ON password_reset_tokens (user_id, expires_at, consumed_at);

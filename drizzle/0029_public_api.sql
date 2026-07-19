CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_sha256 TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_hash ON api_tokens (token_sha256);
CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_name ON api_tokens (org_id, name);
CREATE TABLE IF NOT EXISTS api_token_usage (
  token_id TEXT NOT NULL,
  minute_bucket TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token_id, minute_bucket)
);
CREATE TABLE IF NOT EXISTS api_idempotency_keys (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS api_idempotency_identity ON api_idempotency_keys (token_id, idempotency_key);

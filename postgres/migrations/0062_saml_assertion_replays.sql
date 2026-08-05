-- SAML assertions are bearer credentials. Reserve each signed assertion ID
-- atomically until its validity window ends so a captured POST cannot be replayed
-- across worker instances or process restarts.
CREATE TABLE IF NOT EXISTS saml_assertion_replays (
  identity_issuer TEXT NOT NULL,
  assertion_id TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (identity_issuer, assertion_id)
);
CREATE INDEX IF NOT EXISTS saml_assertion_replays_expiry_idx ON saml_assertion_replays (expires_at);

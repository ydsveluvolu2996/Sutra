-- Durable, atomic replay-nonce store for the hosted broker → app ingestion
-- endpoint. Each row reserves one (tenant, key, nonce) hash until it expires, so
-- a signed broker request can never be replayed across worker instances or
-- process restarts. This is SYSTEM/platform state, not tenant data: the nonce
-- key is an opaque SHA-256 hash and carries no readable tenant identifier and no
-- foreign key into any tenant-gated table. Reservation is a conditional INSERT
-- executed by the database, which is what makes the replay check atomic.
CREATE TABLE IF NOT EXISTS hosted_broker_replay_nonces (
  nonce_key TEXT PRIMARY KEY,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS hosted_broker_replay_nonces_expiry_idx ON hosted_broker_replay_nonces (expires_at);

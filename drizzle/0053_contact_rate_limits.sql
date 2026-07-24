-- Durable fixed-window counters for the public contact form. The source key is
-- a SHA-256 digest of the trusted proxy's client IP plus the window start; raw
-- addresses are not duplicated in this system table. Source and global rows are
-- conditionally reserved in one INSERT ... ON CONFLICT statement so concurrent
-- app instances cannot oversubscribe either cap.
CREATE TABLE IF NOT EXISTS contact_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_rate_limits_expiry_idx ON contact_rate_limits (expires_at);

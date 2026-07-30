-- Legacy audit hashes did not cover actor_type. Preserve them as hash_version 1
-- for verification; every new writer emits v2 with actor_type in the digest.
ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS hash_version smallint NOT NULL DEFAULT 1
  CHECK (hash_version IN (1, 2));

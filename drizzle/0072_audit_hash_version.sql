-- Legacy audit hashes did not cover actor_type. Preserve them as hash_version 1
-- for verification; every new writer emits v2 with actor_type in the digest.
ALTER TABLE `audit_events` ADD `hash_version` integer DEFAULT 1 NOT NULL
  CHECK (`hash_version` IN (1, 2));

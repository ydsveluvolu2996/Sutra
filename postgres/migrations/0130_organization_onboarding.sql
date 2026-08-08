-- Guided-onboarding progress, one row per organization.
--
-- Two facts are stored because only these two are facts about choices: the
-- goals the operator selected and when the workspace was named. The third step
-- -- "connect your infrastructure" -- is always DERIVED from whether a real
-- (non-fixture) connection exists, never stored, so the progress strip cannot
-- claim a connection that was later deleted or fail to notice one that exists.
-- Goal ids are validated at the repository boundary (a JSON list is opaque to
-- portable SQL CHECKs); the column checks bound shape only.
CREATE TABLE IF NOT EXISTS organization_onboarding (
  org_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  goals_json text NOT NULL DEFAULT '[]'
    CHECK (length(goals_json) BETWEEN 2 AND 256),
  name_shared_at bigint CHECK (name_shared_at IS NULL
    OR name_shared_at BETWEEN 0 AND 9007199254740991),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991)
);

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// These assert the storage contract around the envelope: which column customer
// key material may occupy, when the broker refuses static credentials outright,
// and that offboarding destroys sealed material rather than leaving it behind.
//
// They read the source rather than driving a live PostgreSQL, because the
// property under test is *where the bytes go*. A behavioural test that wrote and
// read a connection back would pass just as happily if credentials were also
// duplicated into `encrypted_state`, which is the exact mistake this contract
// exists to prevent. The engine-level behaviour is covered separately by the
// PostgreSQL suite.

const state = await readFile(
  new URL("../../src/hosted-postgres-state.ts", import.meta.url),
  "utf8",
);
const migration = await readFile(
  new URL("../../../../postgres/migrations/0127_hosted_credential_envelope.sql", import.meta.url),
  "utf8",
);

test("customer key material is stripped before the application-key envelope", () => {
  const start = state.indexOf("private encrypt(connection: RegisteredAwsConnection)");
  assert.ok(start > 0);
  const body = state.slice(start, state.indexOf("\n  private ", start + 1));
  assert.match(
    body,
    /const \{ staticCredentials: _sealed, \.\.\.persistable \} = connection;/u,
    "encrypt() must remove staticCredentials before serializing state",
  );
  assert.match(body, /JSON\.stringify\(persistable\)/u);
  assert.doesNotMatch(
    body,
    /JSON\.stringify\(connection\)/u,
    "the whole connection must never be serialized into encrypted_state",
  );
});

test("the broker still refuses static credentials without a customer CMK", () => {
  const start = state.indexOf("public async upsert(input: RegisterAwsConnectionInput)");
  assert.ok(start > 0);
  const body = state.slice(start, state.indexOf("\n  public ", start + 1));
  assert.match(
    body,
    /if \(this\.credentialKms === null \|\| this\.credentialKeyArn === null\) \{\s*\n\s*throw new RegistryStateError\(\);/u,
    "a deployment with no CMK must fail closed rather than fall back to the registry key",
  );
  assert.match(body, /sealStaticCredentials\(/u);
});

test("a half-configured credential CMK is rejected at construction", () => {
  assert.match(
    state,
    /\(this\.credentialKms === null\) !== \(this\.credentialKeyArn === null\)/u,
    "a client without an ARN, or an ARN without a client, must not look enabled",
  );
});

test("offboarding destroys the sealed credential", () => {
  assert.match(
    state,
    /credential_envelope = NULL, credential_key_arn = NULL/u,
    "a tombstoned row must not retain customer key material",
  );
  assert.match(
    migration,
    /tombstoned_at IS NULL/u,
    "the CHECK constraint must forbid an envelope on a tombstoned row",
  );
});

test("an unrelated metadata write preserves the stored credential", () => {
  assert.match(
    state,
    /credential_envelope = COALESCE\(\s*\n?\s*EXCLUDED\.credential_envelope, hosted_broker_connections\.credential_envelope\)/u,
    "a write carrying no new envelope must keep the existing one",
  );
});

test("reads fail closed when the envelope is missing or unreadable", () => {
  const start = state.indexOf("private async hydrateCredentials(");
  assert.ok(start > 0);
  const body = state.slice(start, state.indexOf("\n  private ", start + 1));
  assert.match(body, /throw new RegistryIntegrityError\(\)/u);
  assert.match(body, /openStaticCredentials\(/u);
  // The scope handed to the unwrap must come from the row, not from the
  // decrypted state, so a tampered state cannot redirect the unwrap.
  assert.match(
    body,
    /tenantId: row\.tenant_id, connectionId: row\.connection_id/u,
  );
});

test("the migration keeps the envelope and its CMK inseparable", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS credential_envelope text/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS credential_key_arn text/u);
  assert.match(
    migration,
    /\(credential_envelope IS NULL AND credential_key_arn IS NULL\)/u,
    "neither column is meaningful without the other",
  );
});

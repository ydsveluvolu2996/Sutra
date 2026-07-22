import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const [sqlite, postgres, sqliteLedger, postgresLedger, sqliteRuntime, postgresRuntime, migrator, schema, compose, setup] = await Promise.all([
  readFile(resolve(root, "drizzle/0050_invitation_delivery.sql"), "utf8"),
  readFile(resolve(root, "postgres/migrations/0044_invitation_delivery.sql"), "utf8"),
  readFile(resolve(root, "drizzle/0051_invitation_operation_ledger.sql"), "utf8"),
  readFile(resolve(root, "postgres/migrations/0045_invitation_operation_ledger.sql"), "utf8"),
  readFile(resolve(root, "db/runtime-migrations.ts"), "utf8"),
  readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8"),
  readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8"),
  readFile(resolve(root, "db/schema.ts"), "utf8"),
  readFile(resolve(root, "deploy/ec2/compose.prod.yaml"), "utf8"),
  readFile(resolve(root, "scripts/setup-local-pilot.mjs"), "utf8"),
]);

test("invitation delivery state is migrated in SQLite and PostgreSQL", () => {
  for (const source of [sqlite, postgres]) {
    assert.match(source, /delivery_status/u);
    assert.match(source, /delivery_attempts/u);
    assert.match(source, /delivery_idempotency_digest/u);
    assert.match(source, /identity_invitations_org_delivery_idx/u);
    assert.match(source, /delivery_status[\s\S]*CHECK[\s\S]*not_attempted/u);
    assert.match(source, /delivery_attempts[\s\S]*CHECK[\s\S]*delivery_attempts[^;]*>= 0/u);
    assert.doesNotMatch(source, /token_plaintext|activation_url/u);
  }
  assert.match(sqliteRuntime, /0050_invitation_delivery/u);
  assert.match(postgresRuntime, /0044_invitation_delivery/u);
});

test("invitation operation ledger is durable, replay-safe, and registered in every schema path", () => {
  for (const source of [sqliteLedger, postgresLedger]) {
    assert.match(source, /identity_invitation_operations/u);
    assert.match(source, /operation_kind/u);
    assert.match(source, /idempotency_scope_id/u);
    assert.match(source, /request_fingerprint/u);
    assert.match(source, /outcome_status/u);
    assert.match(source, /delivery_revision/u);
    assert.match(source, /identity_invitation_events_previous_hash_uq/u);
    assert.match(source, /identity_invitation_operations_invitation_key_uq/u);
    assert.doesNotMatch(source, /token_plaintext|activation_url|idempotency_key[^_]/u);
  }
  assert.match(sqliteRuntime, /0051_invitation_operation_ledger/u);
  assert.match(postgresRuntime, /0045_invitation_operation_ledger/u);
  assert.match(migrator, /0045_invitation_operation_ledger\.sql/u);
  assert.match(schema, /identityInvitationOperations/u);
  assert.match(schema, /identity_invitation_events_previous_hash_uq/u);
});

test("hosted and generated Worker runtime receive the dedicated invitation transport", () => {
  for (const name of [
    "SUTRA_INVITATION_FROM",
    "SUTRA_INVITATION_EMAIL_PROVIDER",
    "SUTRA_INVITATION_EMAIL_API_URL",
    "SUTRA_INVITATION_EMAIL_API_KEY",
  ]) {
    assert.match(compose, new RegExp(name, "u"));
    assert.match(setup, new RegExp(name, "u"));
  }
});

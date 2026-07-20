import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const [schema, repository, route, callback, postgres] = await Promise.all([
  readFile(resolve(root, "drizzle/0011_blushing_logan.sql"), "utf8"),
  readFile(resolve(root, "db/identity-invitation-repository.ts"), "utf8"),
  readFile(resolve(root, "app/api/v1/invitations/route.ts"), "utf8"),
  readFile(resolve(root, "app/api/auth/oidc/callback/route.ts"), "utf8"),
  readFile(resolve(root, "postgres/migrations/0005_hosted_identity_lifecycle.sql"), "utf8"),
]);

test("identity invitations persist only token digests and enforce one active email invitation", () => {
  assert.match(schema, /token_digest/u);
  assert.match(schema, /identity_invitations_active_email_uq/u);
  assert.doesNotMatch(schema, /token_plaintext|invitation_token\s/u);
  assert.match(repository, /digestSessionToken\(token\)/u);
  assert.match(repository, /scope_mode, customer_id, token_digest, invited_by/u);
  assert.match(repository, /input\.scopeMode,\s+customerId,\s+tokenDigest,/u);
});

test("invitation creation and revocation require centralized authorization and recent MFA", () => {
  assert.match(route, /authorizeMembershipManagementRequest\(request\)/u);
  assert.match(route, /requireRecentMfa\(actor\.authenticated\)/u);
  assert.match(route, /assertAuthMutation\(request\)/u);
  assert.match(route, /activationUrlShownOnce: true/u);
});

test("acceptance is exact-email, single-use, expiry-bound, and creates membership atomically", () => {
  assert.match(repository, /i\.token_digest = \? AND i\.email = \?/u);
  assert.match(repository, /i\.expires_at > \?/u);
  assert.match(repository, /accepted_at IS NULL/u);
  assert.match(repository, /db\.batch\(\[/u);
  assert.match(repository, /INSERT INTO users/u);
  assert.match(repository, /INSERT INTO memberships/u);
  assert.match(callback, /acceptIdentityInvitation\(identity, transaction\.invitationToken\)/u);
});

test("invitation activity is immutable in both D1 and PostgreSQL", () => {
  for (const source of [schema, postgres]) {
    assert.match(source, /identity_invitation_events_no_update/u);
    assert.match(source, /identity_invitation_events_no_delete/u);
    assert.match(source, /identity invitation activity is immutable/u);
  }
});

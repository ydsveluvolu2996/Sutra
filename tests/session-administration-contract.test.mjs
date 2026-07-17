import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repository = await readFile(new URL("../db/session-administration-repository.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/v1/sessions/route.ts", import.meta.url), "utf8");

test("session reads and revocations are constrained to the authenticated organization", () => {
  assert.match(repository, /WHERE s\.selected_org_id = \?/u);
  assert.match(repository, /s\.id = \? AND s\.selected_org_id = \?/u);
  assert.match(repository, /canAdministerSession\(actor, row\.user_id\)/u);
  assert.doesNotMatch(repository, /token_digest/u);
});

test("revocation and hash-chained audit evidence share one fail-closed batch", () => {
  assert.match(repository, /await db\.batch\(\[/u);
  assert.match(repository, /UPDATE local_sessions SET revoked_at/u);
  assert.match(repository, /INSERT INTO audit_events/u);
  assert.match(repository, /chain_guard/u);
  assert.match(repository, /mutation_guard/u);
  assert.match(repository, /auth\.session\.revoked/u);
  assert.match(repository, /SELECT NULL, NULL/u);
});

test("session mutation API requires same-origin authentication and recent MFA", () => {
  assert.match(route, /assertAuthMutation\(request\)/u);
  assert.match(route, /requireRecentMfa\(actor\.authenticated\)/u);
  assert.match(route, /REVOKE OTHER SESSIONS/u);
  assert.match(route, /expiredSessionCookie\(request\)/u);
});

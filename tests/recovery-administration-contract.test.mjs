import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repository = await readFile(new URL("../db/recovery-administration-repository.ts", import.meta.url), "utf8");
const recoveryRoute = await readFile(new URL("../app/api/v1/access/recovery/route.ts", import.meta.url), "utf8");
const platformRoute = await readFile(new URL("../app/api/v1/access/platform-recovery/route.ts", import.meta.url), "utf8");

test("the owner recovery route enforces capability, same-origin mutation, and recent MFA", () => {
  assert.match(recoveryRoute, /assertAuthMutation\(request\)/u);
  assert.match(recoveryRoute, /authorizePilotRequest\(request, "membership:manage"\)/u);
  assert.match(recoveryRoute, /requireRecentMfa\(actor\.authenticated\)/u);
  assert.match(recoveryRoute, /exactInputObject\(/u);
  assert.match(recoveryRoute, /reset_member_mfa/u);
  assert.match(recoveryRoute, /provision_owner/u);
  assert.match(recoveryRoute, /transfer_owner/u);
  assert.match(recoveryRoute, /export const dynamic = "force-dynamic"/u);
});

test("the platform cold path is loopback + bootstrap-token gated", () => {
  assert.match(platformRoute, /isLoopbackHostname\(url\.hostname\)/u);
  assert.match(platformRoute, /assertBootstrapToken\(request\)/u);
  assert.match(platformRoute, /exactInputObject\(/u);
  assert.match(platformRoute, /platformRecoverOwnerMfa\(/u);
  assert.match(platformRoute, /export const dynamic = "force-dynamic"/u);
});

test("recovery is owner-only and never authenticates or bypasses MFA", () => {
  assert.match(repository, /canAdministerRecovery/u);
  // The credential reset only removes MFA + revokes sessions + clears lockout.
  assert.match(repository, /DELETE FROM totp_credentials WHERE user_id = \?/u);
  assert.match(repository, /UPDATE local_sessions SET revoked_at = \?/u);
  assert.match(repository, /failed_attempts = 0, locked_until = NULL/u);
  // It must never mint a session or stamp an MFA verification for anyone.
  assert.doesNotMatch(repository, /INSERT INTO local_sessions/u);
  assert.doesNotMatch(repository, /mfa_verified_at/u);
});

test("every recovery mutation is committed with hash-linked audit evidence and a guard", () => {
  assert.match(repository, /commitAuditedStatements\(/u);
  assert.match(repository, /mutationGuard:/u);
  assert.match(repository, /auth\.recovery\.mfa_reset/u);
  assert.match(repository, /auth\.recovery\.owner_provisioned/u);
  assert.match(repository, /auth\.recovery\.owner_transferred/u);
  assert.match(repository, /auth\.recovery\.platform_mfa_reset/u);
});

test("targets are org-scoped to the local identity issuer", () => {
  assert.match(repository, /u\.issuer = \?/u);
  assert.match(repository, /LOCAL_IDENTITY_ISSUER/u);
  assert.match(repository, /m\.org_id = \?/u);
});

test("the platform recovery is attributed to the system actor", () => {
  assert.match(repository, /actorType: "system"/u);
  assert.match(repository, /system_platform_recovery/u);
});

test("the last-owner invariant is enforced in SQL as defense-in-depth", () => {
  assert.match(repository, /Cannot remove the last organization owner without a replacement/u);
  assert.match(
    repository,
    /EXISTS \(\s*SELECT 1 FROM memberships\s*WHERE org_id = \? AND status = 'active' AND role = 'org_owner' AND id != \?/u,
  );
});

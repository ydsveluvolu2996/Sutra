import assert from "node:assert/strict";
import test from "node:test";

import { authorize, effectiveCapabilities, type AuthorizationSubject } from "../lib/auth-policy.ts";
import {
  digestSessionToken,
  generateSessionToken,
  hashPassword,
  matchTotpCode,
  openTotpSecret,
  sealTotpSecret,
  validatePassword,
  verifyPassword,
} from "../lib/local-auth-crypto.ts";

const assignedAnalyst: AuthorizationSubject = {
  userId: "user_org_a",
  orgId: "org_a",
  membershipId: "member_org_a",
  role: "analyst",
  scopeMode: "assigned_customers",
  grants: [{ customerId: "customer_a", role: "analyst" }],
};

test("password credentials use a salted, costed digest and never persist plaintext", async () => {
  const password = "correct horse battery staple!";
  assert.equal(validatePassword(password, "owner@example.test"), password);
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.equal(first.algorithm, "pbkdf2-sha256");
  assert.equal(first.iterations, 600_000);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  assert.equal(first.hash.includes(password), false);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("wrong password that is long enough", first), false);
});

test("session storage uses only an irreversible digest of a high-entropy token", async () => {
  const first = generateSessionToken();
  const second = generateSessionToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(first, second);
  const digest = await digestSessionToken(first);
  assert.match(digest, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(digest, first);
});

test("TOTP verification accepts RFC 6238 timing and rejects replayed steps", async () => {
  const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(await matchTotpCode(rfcSecret, "287082", 59_000), 1);
  assert.equal(await matchTotpCode(rfcSecret, "287082", 59_000, 1), null);
  assert.equal(await matchTotpCode(rfcSecret, "000000", 59_000), null);
});

test("TOTP secrets are encrypted and bound to the user and key version", async () => {
  const key = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
  const sealed = await sealTotpSecret("JBSWY3DPEHPK3PXP", key, "auth-v1", "user_a");
  assert.equal(sealed.ciphertext.includes("JBSWY3DPEHPK3PXP"), false);
  assert.equal(await openTotpSecret(sealed, key, "user_a"), "JBSWY3DPEHPK3PXP");
  await assert.rejects(openTotpSecret(sealed, key, "user_b"));
});

test("authorization denies organization and customer ID swapping", () => {
  assert.deepEqual(authorize(assignedAnalyst, {
    orgId: "org_a", customerId: "customer_a", capability: "sync:run",
  }), { allowed: true });
  assert.deepEqual(authorize(assignedAnalyst, {
    orgId: "org_b", customerId: "customer_a", capability: "sync:run",
  }), { allowed: false, reason: "CROSS_ORG" });
  assert.deepEqual(authorize(assignedAnalyst, {
    orgId: "org_a", customerId: "customer_b", capability: "sync:run",
  }), { allowed: false, reason: "CUSTOMER_SCOPE" });
});

test("customer grants cannot escalate the organization membership role", () => {
  const readOnlySubject: AuthorizationSubject = {
    ...assignedAnalyst,
    role: "viewer",
    grants: [{ customerId: "customer_a", role: "customer_admin" }],
  };
  assert.deepEqual(authorize(readOnlySubject, {
    orgId: "org_a", customerId: "customer_a", capability: "finding:manage",
  }), { allowed: false, reason: "ROLE" });
  assert.deepEqual(authorize(readOnlySubject, {
    orgId: "org_a", customerId: "customer_a", capability: "export:read",
  }), { allowed: true });
  assert.equal(effectiveCapabilities(readOnlySubject).includes("customer:create"), false);
});

test("all-customer owners remain bound to their authenticated organization", () => {
  const owner: AuthorizationSubject = {
    ...assignedAnalyst,
    role: "org_owner",
    scopeMode: "all_customers",
    grants: [],
  };
  assert.deepEqual(authorize(owner, {
    orgId: "org_a", customerId: "customer_unassigned", capability: "connection:manage",
  }), { allowed: true });
  assert.deepEqual(authorize(owner, {
    orgId: "org_attacker", customerId: "customer_unassigned", capability: "connection:manage",
  }), { allowed: false, reason: "CROSS_ORG" });
});

import assert from "node:assert/strict";
import test from "node:test";
import "./browser-session-lifecycle.test.ts";
import type { AuthenticatedLocalSession } from "../db/auth-repository.ts";
import {
  canAdministerSession,
  canViewOrganizationSessions,
  sessionStatus,
} from "../lib/session-administration.ts";

function actor(role: AuthenticatedLocalSession["subject"]["role"]): AuthenticatedLocalSession {
  return {
    tokenDigest: "digest",
    mfaVerifiedAt: 1,
    subject: {
      userId: "user_actor",
      orgId: "org_a",
      membershipId: "member_a",
      role,
      scopeMode: "all_customers",
      grants: [],
    },
    session: {
      id: `sess_${"a".repeat(32)}`,
      user: { id: "user_actor", email: "actor@example.test", displayName: "Actor" },
      organization: { id: "org_a", slug: "org-a", name: "Org A" },
      membership: { id: "member_a", role, scopeMode: "all_customers" },
      capabilities: ["workspace:read"],
      mfa: { enrolled: true, verified: true },
      expiresAt: "2026-07-18T00:00:00.000Z",
    },
  };
}

test("users can revoke their own sessions but not another user's sessions", () => {
  const viewer = actor("viewer");
  assert.equal(canAdministerSession(viewer, "user_actor"), true);
  assert.equal(canAdministerSession(viewer, "user_other"), false);
  assert.equal(canViewOrganizationSessions(viewer), false);
});

test("organization owners and admins can administer organization sessions", () => {
  assert.equal(canAdministerSession(actor("org_owner"), "user_other"), true);
  assert.equal(canAdministerSession(actor("org_admin"), "user_other"), true);
  assert.equal(canViewOrganizationSessions(actor("org_admin")), true);
  assert.equal(canAdministerSession(actor("analyst"), "user_other"), false);
});

test("revocation wins over expiry and active status is time bounded", () => {
  assert.equal(sessionStatus(2_000, 900, null, 1_000), "active");
  assert.equal(sessionStatus(1_000, 900, null, 1_000), "expired");
  assert.equal(sessionStatus(2_000, 900, 900, 1_000), "revoked");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  canAdministerRecovery,
  isOrganizationOwner,
  type AuthorizationSubject,
  type OrgRole,
} from "../lib/auth-policy.ts";

function subject(role: OrgRole): AuthorizationSubject {
  return {
    userId: "user_actor",
    orgId: "org_a",
    membershipId: "member_a",
    role,
    scopeMode: "all_customers",
    grants: [],
  };
}

const ROLES: readonly OrgRole[] = [
  "org_owner",
  "org_admin",
  "analyst",
  "viewer",
  "customer_admin",
  "customer_viewer",
];

test("isOrganizationOwner is true only for org_owner", () => {
  for (const role of ROLES) {
    assert.equal(isOrganizationOwner(subject(role)), role === "org_owner");
  }
});

test("canAdministerRecovery is true only for org_owner", () => {
  assert.equal(canAdministerRecovery(subject("org_owner")), true);
  for (const role of ["org_admin", "analyst", "viewer", "customer_admin", "customer_viewer"] as const) {
    assert.equal(canAdministerRecovery(subject(role)), false);
  }
});

test("org_admin carries membership:manage yet is still refused recovery", () => {
  // The second conjunct (role === "org_owner") is load-bearing: org_admin has
  // the capability but must never administer recovery.
  assert.equal(canAdministerRecovery(subject("org_admin")), false);
});

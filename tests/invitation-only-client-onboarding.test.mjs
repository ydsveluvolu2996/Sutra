import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [
  compose,
  callback,
  navigation,
  stateRoute,
  handoffRoute,
  onboarding,
  policy,
  invitations,
] = await Promise.all([
  readFile(new URL("../deploy/ec2/compose.prod.yaml", import.meta.url), "utf8"),
  readFile(new URL("../app/api/auth/oidc/callback/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/components/navigation-config.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/pilot/state/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/pilot/connections/handoff/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/onboard/onboard-account.tsx", import.meta.url), "utf8"),
  readFile(new URL("../lib/auth-policy.ts", import.meta.url), "utf8"),
  readFile(new URL("../db/identity-invitation-repository.ts", import.meta.url), "utf8"),
]);

test("production organization creation is invitation-only", () => {
  assert.match(compose, /SUTRA_HOSTED_SELF_SERVE_SIGNUP: "false"/u);
  assert.match(callback, /Default \(invite-only\) behaviour is unchanged/u);
  assert.match(callback, /isHostedSelfServeSignupEnabled\(\)/u);
  assert.match(invitations, /token_digest = \? AND i\.email = \?/u);
  assert.match(invitations, /accepted_at IS NULL[\s\S]*revoked_at IS NULL[\s\S]*expires_at > \?/u);
});

test("an approved customer administrator can finish only an assigned AWS onboarding", () => {
  assert.match(
    navigation,
    /key: "onboard", label: "Manage AWS account", href: "\/onboard", capabilities: \["connection:manage"\]/u,
  );
  assert.match(onboarding, /capabilities\.has\("customer:create"\)[\s\S]*capabilities\.has\("connection:manage"\)/u);
  assert.match(onboarding, /\/api\/pilot\/connections\/handoff/u);
  assert.match(handoffRoute, /getStoredConnectionSecretForOrg\(actor\.orgId, connectionId\)/u);
  assert.match(handoffRoute, /assertSessionCapability\(actor\.authenticated, "connection:manage", stored\.customerId\)/u);
  assert.match(handoffRoute, /stored\.status !== "pending" \|\| stored\.roleArn !== ""/u);
  assert.ok(
    handoffRoute.indexOf("await appendAuditEvent(") < handoffRoute.indexOf("const respond ="),
    "the audit event must commit before the handoff response can expose the ExternalId",
  );
  assert.match(policy, /customer_admin: new Set\(\[[\s\S]*"membership:manage:customer"[\s\S]*"connection:manage"/u);
});

test("the default workspace selects only a connection authorized by the persisted customer grant", () => {
  const listing = stateRoute.indexOf("listConnectionsForOrg(actor.orgId)");
  const authorization = stateRoute.indexOf("authorize(actor.authenticated.subject");
  const stateRead = stateRoute.indexOf("getPilotStateForOrg(actor.orgId, selectedConnectionId)");
  assert.ok(listing >= 0 && authorization > listing && stateRead > authorization);
  assert.match(stateRoute, /capability: "connection:read"[\s\S]*customerId: connection\.customerId/u);
  assert.match(stateRoute, /selectedConnectionId === null[\s\S]*emptyState\(\)/u);
});

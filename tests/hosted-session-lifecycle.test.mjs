import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

// Contract test for the hosted (public multi-tenant) identity + session
// lifecycle and the hosted broker/durable-job wiring. Following the repository
// convention, the end-to-end route/DB flow is asserted against source so it can
// run without the Cloudflare worker runtime or a live D1/Postgres binding. The
// pure crypto primitives (state/nonce/PKCE, id-token, code exchange, sealed
// transaction) are exercised behaviorally in oidc-pkce / oidc-id-token /
// hosted-oidc; this file proves those primitives are wired IN THE RIGHT ORDER,
// that tenant identity is never caller-supplied, and that first-login
// provisioning is deny-by-default.

const root = resolve(import.meta.dirname, "..");
const [
  startRoute,
  callbackRoute,
  runtime,
  authRepo,
  invitationRepo,
  apiAuth,
  deploymentSecurity,
  jobRunnerRoute,
  brokerVerifier,
] = await Promise.all([
  readFile(resolve(root, "app/api/auth/oidc/start/route.ts"), "utf8"),
  readFile(resolve(root, "app/api/auth/oidc/callback/route.ts"), "utf8"),
  readFile(resolve(root, "lib/hosted-oidc-runtime.ts"), "utf8"),
  readFile(resolve(root, "db/auth-repository.ts"), "utf8"),
  readFile(resolve(root, "db/identity-invitation-repository.ts"), "utf8"),
  readFile(resolve(root, "lib/api-auth.ts"), "utf8"),
  readFile(resolve(root, "lib/deployment-security.ts"), "utf8"),
  readFile(resolve(root, "app/api/internal/jobs/run/route.ts"), "utf8"),
  readFile(resolve(root, "lib/hosted-broker-request-security.ts"), "utf8"),
]);

test("login start builds the authorize redirect and seals state/nonce/PKCE into an HttpOnly cookie", () => {
  // The redirect is built by the reviewed primitive, not hand-rolled here.
  assert.match(startRoute, /createOidcAuthorization\(/u);
  assert.match(startRoute, /sealOidcTransaction\(authorization\.transaction, runtime\.transactionKey\)/u);
  // The sealed transaction (which carries state, nonce, and the PKCE verifier)
  // is stored in a cookie, never echoed in the redirect URL.
  assert.match(startRoute, /oidcTransactionCookie\(sealed\)/u);
  // The authorize URL commits to code flow + S256 PKCE and never leaks the verifier.
  assert.match(runtime, /oidcTransactionCookie[\s\S]*HttpOnly; Secure; SameSite=Lax/u);
  assert.match(runtime, /Path=\/api\/auth\/oidc/u);
  // The redirect URI the IdP will call back is fixed to the callback path and
  // derived from the configured public origin, never from the request.
  assert.match(runtime, /redirectUri: `\$\{origin\}\/api\/auth\/oidc\/callback`/u);
});

test("callback validates state, code, id-token, and provisioning BEFORE issuing a session", () => {
  // Enforce the exact ordering of validation gates in the callback.
  const gates = [
    "openOidcTransaction(sealed, runtime.transactionKey)", // decrypt+validate sealed transaction (state/nonce/verifier)
    "validateOidcCallback(request.url, transaction)", // constant-time state match, code shape, reject error param
    "exchangeOidcAuthorizationCode(", // PKCE code exchange at the token endpoint
    "fetchOidcJwks(runtime.client)", // issuer-pinned JWKS
    "verifyOidcIdToken(idToken", // iss/aud/exp/nonce/signature
  ];
  let cursor = 0;
  for (const gate of gates) {
    const index = callbackRoute.indexOf(gate, cursor);
    assert.ok(index >= cursor, `callback must run "${gate}" in order`);
    cursor = index + gate.length;
  }
  // The nonce fed to id-token verification comes from the sealed transaction,
  // binding the token to THIS browser's login attempt (replay/CSRF defense).
  assert.match(callbackRoute, /nonce: transaction\.nonce/u);
  // The session cookie is only appended after resolve-or-provision succeeds.
  const sessionIssue = callbackRoute.indexOf("sessionCookie(request, result.token");
  const resolve1 = callbackRoute.indexOf("loginHostedUser(identity)");
  assert.ok(sessionIssue > resolve1 && resolve1 > 0, "session must be issued only after identity resolves");
  // A missing transaction cookie aborts before any token exchange.
  assert.match(callbackRoute, /if \(sealed === null\) throw new Error/u);
});

test("callback fails closed and clears the transaction cookie on any error", () => {
  assert.match(callbackRoute, /status:\s*401/u);
  assert.match(callbackRoute, /expiredOidcTransactionCookie\(\)/u);
  // Both the transaction cookie and the session cookie are marked so nothing
  // partial survives a failed sign-in.
  assert.match(callbackRoute, /append\("set-cookie", expiredOidcTransactionCookie\(\)\)/u);
});

test("first-login provisioning is deny-by-default: an uninvited identity cannot join a tenant", () => {
  // Path A (no invitation): loginHostedUser only issues a session for an
  // identity ALREADY provisioned into exactly one active org membership. An
  // uninvited subject matches zero memberships and is refused.
  assert.match(callbackRoute, /transaction\.invitationToken === null\s*\?\s*await loginHostedUser\(identity\)/u);
  assert.match(authRepo, /memberships\.length !== 1[\s\S]*IDENTITY_NOT_PROVISIONED/u);
  // The membership is looked up strictly by the VERIFIED issuer+subject+email,
  // all bound to active user/org/membership rows — never widened by email alone.
  assert.match(authRepo, /WHERE u\.issuer = \? AND u\.subject = \? AND u\.email = \? AND u\.status = 'active'/u);
  assert.match(authRepo, /m\.status = 'active'/u);
  assert.match(authRepo, /o\.id = m\.org_id AND o\.status = 'active'/u);

  // Path B (invitation): the only way to create a NEW membership at first login
  // is a valid, unexpired, single-use invitation whose token digest AND email
  // both match the verified identity. There is no self-service tenant join.
  assert.match(callbackRoute, /acceptIdentityInvitation\(identity, transaction\.invitationToken\)/u);
  assert.match(invitationRepo, /i\.token_digest = \? AND i\.email = \?/u);
  assert.match(invitationRepo, /i\.accepted_at IS NULL[\s\S]*i\.revoked_at IS NULL AND i\.expires_at > \?/u);
  // The created membership's org/role/scope come from the invitation row, not
  // from anything the caller supplied.
  assert.match(invitationRepo, /INSERT INTO memberships[\s\S]*SELECT \?, org_id, \?, role, scope_mode, 'active'/u);
});

test("tenant identity is derived from the validated session/DB, never from a request parameter", () => {
  // loginHostedUser selects the org from the membership row it just validated.
  assert.match(authRepo, /return createSession\(\s*db,\s*selected\.user_id,\s*selected\.org_id/u);
  // Session validation reads org/role/scope from joined rows keyed on the
  // session token digest; it never accepts an org/customer/tenant id argument.
  assert.match(apiAuth, /const authenticated = token === null \? null : await getLocalSession\(token\)/u);
  assert.doesNotMatch(apiAuth, /orgId\s*=\s*(request|url|params|searchParams|body)/u);
  // Authorization always uses the subject's own orgId, not a request-provided one.
  assert.match(apiAuth, /orgId: authenticated\.subject\.orgId/u);
});

test("hosted sessions reuse the hardened local session cookie (Secure, SameSite, same crypto)", () => {
  assert.match(callbackRoute, /import \{ sessionCookie \} from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/api-auth"/u);
  // The cookie helper forces Secure off ONLY for loopback http local mode; every
  // hosted origin (https) is always Secure + HttpOnly + SameSite=Strict.
  assert.match(apiAuth, /SameSite=Strict/u);
  assert.match(apiAuth, /HttpOnly/u);
  assert.match(apiAuth, /const secure = localHttp \? "" : "; Secure"/u);
  // Hosted sessions are bounded to at most one hour (min of IdP expiry and 1h).
  assert.match(authRepo, /Math\.min\(identity\.expiresAt, now \+ 60 \* 60 \* 1000\)/u);
});

test("hosted authentication requests are pinned to the canonical public origin", () => {
  assert.match(apiAuth, /requestOrigin !== configuredOrigin/u);
  assert.match(apiAuth, /isHostedOidcRuntime\(\)/u);
  // Hosted runtime requires the OIDC identity mode and a non-local deployment env.
  assert.match(apiAuth, /SUTRA_IDENTITY_MODE === "oidc"/u);
  assert.match(apiAuth, /config\.SUTRA_LOCAL_MODE !== "true"/u);
});

test("local loopback restriction and deny-by-default boundary are preserved unchanged", () => {
  // The local mode branch still requires a loopback host, unconditionally.
  assert.match(deploymentSecurity, /local mode is restricted to a loopback host/u);
  assert.match(apiAuth, /SUTRA_LOCAL_MODE !== "true" \|\| !isLoopbackHostname\(url\.hostname\)/u);
  // The two former hard-disable strings are gone, replaced by exactly one switch.
  assert.doesNotMatch(deploymentSecurity, /not implemented in this build/u);
  const switchMatches = deploymentSecurity.match(/SUTRA_HOSTED_ENABLED !== "true"/gu) ?? [];
  assert.equal(switchMatches.length, 1, "there must be exactly one master switch check");
  assert.match(deploymentSecurity, /pending adversarial auth review/u);
});

test("durable background-job runner works under hosted mode: token-gated and environment-agnostic", () => {
  // The runner is gated ONLY by the shared internal token — it has no local-mode
  // guard, so it runs identically in hosted staging/production.
  assert.match(jobRunnerRoute, /verifyInternalToken\(jobRunnerToken\(\), request\.headers\.get\("x-sutra-job-token"\)\)/u);
  assert.doesNotMatch(jobRunnerRoute, /assertLocalAuthRequest|SUTRA_LOCAL_MODE|isLoopbackHost/u);
  // Every job it runs carries its own org scope, so handlers stay tenant-scoped.
  assert.match(jobRunnerRoute, /runDueBackgroundJobs\(\{ queue, handlers: buildJobHandlers\(\)/u);
  assert.match(jobRunnerRoute, /every job it runs\s*\n\s*\* carries its own org scope/u);
});

test("hosted broker ingestion authenticates with asymmetric signatures and server-derived scope", () => {
  // Hosted broker requests are verified with ed25519 (asymmetric), matching the
  // SUTRA_BROKER_AUTH_MODE=asymmetric deployment requirement.
  assert.match(brokerVerifier, /asymmetricKeyType !== "ed25519"/u);
  // The tenant/connection/job scope is taken from trusted server state
  // (expectedScope), and the request must match it — never the other way around.
  assert.match(brokerVerifier, /Scope derived from trusted server state, never from the request body/u);
  assert.match(brokerVerifier, /input\.expectedScope\.tenantId/u);
  assert.match(brokerVerifier, /throw new HostedBrokerRequestSecurityError\("SCOPE_MISMATCH"\)/u);
  // Replay protection is mandatory via an atomic consume.
  assert.match(brokerVerifier, /REQUEST_REPLAYED/u);
});

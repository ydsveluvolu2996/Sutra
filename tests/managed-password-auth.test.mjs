import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const {
  assertLocalAuthRequest,
  expiredSessionCookie,
  isManagedPasswordRuntime,
  sessionCookie,
} = await import("../lib/api-auth.ts");
const { clientSourceKey } = await import("../lib/auth-http.ts");

// Managed-password identity is the network-reachable form of the local
// email+password+TOTP stack. `assertLocalAuthRequest` is the single request gate
// shared by bootstrap/login/session; these tests pin its two accept paths
// (loopback-local and origin-pinned managed-password) and prove every managed
// requirement is load-bearing.

const ORIGIN = "https://app.sutra.example";
const FULL_MANAGED = {
  SUTRA_DEPLOYMENT_ENV: "production",
  SUTRA_LOCAL_MODE: "false",
  SUTRA_IDENTITY_MODE: "password",
  SUTRA_PUBLIC_ORIGIN: ORIGIN,
  SUTRA_PASSWORD_MFA_REQUIRED: "true",
  SUTRA_PASSWORD_IDENTITY_ENABLED: "true",
};
const FULL_PRIVATE_BETA = {
  SUTRA_DEPLOYMENT_ENV: "staging",
  SUTRA_LOCAL_MODE: "false",
  SUTRA_IDENTITY_MODE: "password",
  SUTRA_PUBLIC_ORIGIN: ORIGIN,
  SUTRA_PASSWORD_MFA_REQUIRED: "true",
  SUTRA_PRIVATE_BETA_PASSWORD_ENABLED: "true",
};

const ALL_KEYS = [
  "SUTRA_DEPLOYMENT_ENV",
  "SUTRA_LOCAL_MODE",
  "SUTRA_IDENTITY_MODE",
  "SUTRA_PUBLIC_ORIGIN",
  "SUTRA_PASSWORD_MFA_REQUIRED",
  "SUTRA_PASSWORD_IDENTITY_ENABLED",
  "SUTRA_PRIVATE_BETA_PASSWORD_ENABLED",
];

function applyEnv(overrides) {
  for (const key of ALL_KEYS) delete cloudflare.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) cloudflare.env[key] = value;
  }
}

function req(url) {
  return new Request(url);
}

test("loopback local mode is unchanged: 127.0.0.1 accepted, public host rejected", () => {
  applyEnv({ SUTRA_LOCAL_MODE: "true" });
  assert.doesNotThrow(() => assertLocalAuthRequest(req("http://127.0.0.1:3000/api/auth/login")));
  assert.doesNotThrow(() => assertLocalAuthRequest(req("http://localhost:3000/api/auth/login")));
  assert.throws(() => assertLocalAuthRequest(req("https://app.sutra.example/api/auth/login")));
  assert.equal(isManagedPasswordRuntime(), false);
});

test("managed-password runtime accepts credential auth on the canonical origin", () => {
  applyEnv(FULL_MANAGED);
  assert.equal(isManagedPasswordRuntime(), true);
  assert.doesNotThrow(() => assertLocalAuthRequest(req(`${ORIGIN}/api/auth/login`)));
  assert.doesNotThrow(() => assertLocalAuthRequest(req(`${ORIGIN}/api/auth/bootstrap`)));
});

test("managed-password runtime pins the origin: a mismatched host is rejected", () => {
  applyEnv(FULL_MANAGED);
  assert.throws(() => assertLocalAuthRequest(req("https://evil.example/api/auth/login")));
  // A loopback host is NOT a shortcut around the public-origin pin in this mode.
  assert.throws(() => assertLocalAuthRequest(req("http://127.0.0.1:3000/api/auth/login")));
});

test("private-beta password runtime is staging-only and uses its own opt-in", () => {
  applyEnv(FULL_PRIVATE_BETA);
  assert.equal(isManagedPasswordRuntime(), true);
  assert.doesNotThrow(() => assertLocalAuthRequest(req(`${ORIGIN}/api/auth/login`)));

  applyEnv({ ...FULL_PRIVATE_BETA, SUTRA_PRIVATE_BETA_PASSWORD_ENABLED: "false" });
  assert.equal(isManagedPasswordRuntime(), false);
  assert.throws(() => assertLocalAuthRequest(req(`${ORIGIN}/api/auth/login`)));

  applyEnv({ ...FULL_PRIVATE_BETA, SUTRA_PASSWORD_IDENTITY_ENABLED: "true", SUTRA_PRIVATE_BETA_PASSWORD_ENABLED: "false" });
  assert.equal(isManagedPasswordRuntime(), false, "the production switch must not enable staging");

  applyEnv({ ...FULL_MANAGED, SUTRA_PRIVATE_BETA_PASSWORD_ENABLED: "true", SUTRA_PASSWORD_IDENTITY_ENABLED: "false" });
  assert.equal(isManagedPasswordRuntime(), false, "the private-beta switch must not enable production");

  applyEnv({ ...FULL_PRIVATE_BETA, SUTRA_LOCAL_MODE: undefined });
  assert.equal(isManagedPasswordRuntime(), false, "staging must explicitly disable local mode");

  applyEnv({ ...FULL_PRIVATE_BETA, SUTRA_PASSWORD_MFA_REQUIRED: "false" });
  assert.equal(isManagedPasswordRuntime(), false, "staging must explicitly require MFA");
});

test("canonical Host plus trusted TLS scheme preserves public same-origin without rewriting Origin", () => {
  applyEnv(FULL_PRIVATE_BETA);
  const privateHop = new Request("http://app.sutra.example/api/auth/login", {
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "attacker.invalid",
    },
  });
  assert.doesNotThrow(() => assertLocalAuthRequest(privateHop));

  const wrongHost = new Request("http://internal.invalid/api/auth/login", {
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "app.sutra.example",
    },
  });
  assert.throws(() => assertLocalAuthRequest(wrongHost));
});

test("rate-limit source key trusts the right-most X-Forwarded-For hop, not a spoofed left value", () => {
  // The trusted edge appends (or pins) the real client to the right; a client
  // that prepends a bogus left value must NOT change the resolved source.
  const spoofed = clientSourceKey(new Request("https://app.sutra.example/x", {
    headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.7" },
  }));
  assert.equal(spoofed, "203.0.113.7", "must use the right-most (edge-appended) hop");

  const single = clientSourceKey(new Request("https://app.sutra.example/x", {
    headers: { "x-forwarded-for": "203.0.113.7" },
  }));
  assert.equal(single, "203.0.113.7");

  // No forwarded chain (direct loopback dev) -> unattributed (null).
  assert.equal(clientSourceKey(new Request("http://127.0.0.1:3000/x")), null);
});

test("session cookie is Secure behind a TLS edge; relaxed only on genuine loopback http", () => {
  applyEnv({ SUTRA_LOCAL_MODE: "true" });
  // Genuine local dev: loopback http, no forwarded-proto -> Secure relaxed so
  // http://127.0.0.1 login still works.
  const dev = sessionCookie(new Request("http://127.0.0.1:3000/x"), "t".repeat(43));
  assert.ok(!/;\s*Secure/u.test(dev), "loopback http dev cookie must not be Secure");
  assert.match(dev, /HttpOnly/u);
  assert.match(dev, /SameSite=Strict/u);
  assert.doesNotMatch(dev, /Max-Age|Expires=/u, "human login must issue a non-persistent session cookie");

  // Same loopback host, but a TLS edge (Caddy) served the public request over
  // HTTPS -> the cookie MUST be Secure even though the internal hop is http.
  const proxied = sessionCookie(
    new Request("http://127.0.0.1:3000/x", { headers: { "x-forwarded-proto": "https" } }),
    "t".repeat(43),
  );
  assert.match(proxied, /;\s*Secure/u, "cookie must be Secure when the edge served HTTPS");

  // Non-local (managed-password / hosted) is always Secure.
  applyEnv(FULL_MANAGED);
  const hosted = sessionCookie(new Request(`${ORIGIN}/x`), "t".repeat(43));
  assert.match(hosted, /;\s*Secure/u);
  assert.doesNotMatch(hosted, /Max-Age|Expires=/u);

  const expired = expiredSessionCookie(new Request(`${ORIGIN}/x`));
  assert.match(expired, /Max-Age=0/u);
  assert.match(expired, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/u);
});

test("every managed-password precondition is load-bearing for the request gate", () => {
  // Master switch off.
  applyEnv({ ...FULL_MANAGED, SUTRA_PASSWORD_IDENTITY_ENABLED: "false" });
  assert.equal(isManagedPasswordRuntime(), false);
  assert.throws(() => assertLocalAuthRequest(req(`${ORIGIN}/api/auth/login`)));

  // Only the exact string "true" enables it.
  for (const value of ["TRUE", "1", "yes", " true", ""]) {
    applyEnv({ ...FULL_MANAGED, SUTRA_PASSWORD_IDENTITY_ENABLED: value });
    assert.equal(isManagedPasswordRuntime(), false, `enable=${JSON.stringify(value)}`);
  }

  // Wrong identity mode.
  applyEnv({ ...FULL_MANAGED, SUTRA_IDENTITY_MODE: "oidc" });
  assert.equal(isManagedPasswordRuntime(), false);
  assert.throws(() => assertLocalAuthRequest(req(`${ORIGIN}/api/auth/login`)));

  // Local mode must be off.
  applyEnv({ ...FULL_MANAGED, SUTRA_LOCAL_MODE: "true" });
  assert.equal(isManagedPasswordRuntime(), false);

  // Non-network environment.
  applyEnv({ ...FULL_MANAGED, SUTRA_DEPLOYMENT_ENV: "preview" });
  assert.equal(isManagedPasswordRuntime(), false);
  assert.throws(() => assertLocalAuthRequest(req(`${ORIGIN}/api/auth/login`)));
});

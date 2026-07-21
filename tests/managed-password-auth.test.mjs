import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const { assertLocalAuthRequest, isManagedPasswordRuntime } = await import("../lib/api-auth.ts");

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
  SUTRA_PASSWORD_IDENTITY_ENABLED: "true",
};

const ALL_KEYS = [
  "SUTRA_DEPLOYMENT_ENV",
  "SUTRA_LOCAL_MODE",
  "SUTRA_IDENTITY_MODE",
  "SUTRA_PUBLIC_ORIGIN",
  "SUTRA_PASSWORD_IDENTITY_ENABLED",
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

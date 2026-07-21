import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const {
  hostedOidcProviderIds,
  hostedOidcTransactionKey,
  resolveHostedOidcProvider,
} = await import("../lib/hosted-oidc-runtime.ts");

// INFO-1 (defense in depth): the hosted OIDC runtime gate must re-check the
// SUTRA_HOSTED_ENABLED master switch, mirroring lib/hosted-broker-ingest-runtime.
// Even with a FULLY hosted-configured deployment (env, origin, providers, and a
// valid transaction key all present), the OIDC start/callback + self-serve
// provisioning path must be INERT unless the master switch is exactly "true", so
// it fails closed if the deployment boundary is ever bypassed.

const ORIGIN = "https://app.sutra.example";
const TRANSACTION_KEY = "A".repeat(43); // matches /^[A-Za-z0-9_-]{43}$/
const PROVIDERS = JSON.stringify([
  {
    id: "google",
    issuer: "https://accounts.google.com",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
    clientId: "sutra-google.apps.googleusercontent.com",
  },
]);

const HOSTED_CONFIG_WITHOUT_SWITCH = {
  SUTRA_DEPLOYMENT_ENV: "production",
  SUTRA_LOCAL_MODE: "false",
  SUTRA_IDENTITY_MODE: "oidc",
  SUTRA_PUBLIC_ORIGIN: ORIGIN,
  SUTRA_OIDC_PROVIDERS: PROVIDERS,
  SUTRA_OIDC_TRANSACTION_KEY: TRANSACTION_KEY,
};

const KEYS = [...Object.keys(HOSTED_CONFIG_WITHOUT_SWITCH), "SUTRA_HOSTED_ENABLED"];

function applyEnv(overrides) {
  for (const key of KEYS) delete cloudflare.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) cloudflare.env[key] = value;
  }
}

function request() {
  return new Request(`${ORIGIN}/api/auth/oidc/start`);
}

test("the OIDC path is INERT when the master switch is unset, even with full hosted config", () => {
  // Every value that keeps the switch OFF must keep the whole OIDC surface closed.
  for (const value of [undefined, "", "false", "TRUE", "1", "yes", " true", "true "]) {
    applyEnv({ ...HOSTED_CONFIG_WITHOUT_SWITCH, SUTRA_HOSTED_ENABLED: value });
    const label = `SUTRA_HOSTED_ENABLED=${JSON.stringify(value)}`;
    assert.throws(() => hostedOidcProviderIds(request()), /not configured/iu, `providerIds must fail closed (${label})`);
    assert.throws(() => hostedOidcTransactionKey(request()), /not configured/iu, `transactionKey must fail closed (${label})`);
    assert.throws(
      () => resolveHostedOidcProvider(request(), "google"),
      /not configured/iu,
      `resolveProvider must fail closed (${label})`,
    );
  }
});

test("the OIDC path resolves only when the master switch is exactly \"true\"", () => {
  applyEnv({ ...HOSTED_CONFIG_WITHOUT_SWITCH, SUTRA_HOSTED_ENABLED: "true" });
  assert.deepEqual(hostedOidcProviderIds(request()), ["google"]);
  assert.equal(hostedOidcTransactionKey(request()), TRANSACTION_KEY);
  const resolved = resolveHostedOidcProvider(request(), "google");
  assert.equal(resolved.providerId, "google");
  assert.equal(resolved.client.issuer, "https://accounts.google.com");
  applyEnv({}); // leave the shared env clean for other files
});

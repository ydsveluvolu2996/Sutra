import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateDeploymentBoundary,
  generateScriptNonce,
  hostedConfigurationIssues,
  responseSecurityHeaders,
} from "../lib/deployment-security.ts";

const hostedShape = {
  SUTRA_DEPLOYMENT_ENV: "production",
  SUTRA_PUBLIC_ORIGIN: "https://app.sutra.example",
  SUTRA_LOCAL_MODE: "false",
  SUTRA_IDENTITY_MODE: "oidc",
  SUTRA_OIDC_PROVIDERS: JSON.stringify([
    {
      id: "google",
      issuer: "https://accounts.google.com",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
      clientId: "sutra-google.apps.googleusercontent.com",
    },
    {
      id: "entra",
      issuer: "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0",
      authorizationEndpoint: "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/authorize",
      tokenEndpoint: "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/token",
      jwksUri: "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/discovery/v2.0/keys",
      clientId: "00000000-0000-0000-0000-000000000000",
    },
  ]),
  SUTRA_OIDC_TRANSACTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  SUTRA_BROKER_URL: "https://broker.sutra.example",
  SUTRA_BROKER_AUTH_MODE: "asymmetric",
  SUTRA_DATABASE_MODE: "d1",
  SUTRA_SECRET_STORE: "managed",
  SUTRA_ENVIRONMENT_KEY_SCOPE: "isolated",
} as const;

test("local runtime is loopback-only", () => {
  assert.equal(evaluateDeploymentBoundary("http://127.0.0.1:3000/dashboard", {}).allowed, true);
  const publicRequest = evaluateDeploymentBoundary("https://app.sutra.example/dashboard", {});
  assert.equal(publicRequest.allowed, false);
  assert.equal(publicRequest.status, 503);
});

test("preview mode exposes only public marketing assets", () => {
  const runtime = { SUTRA_DEPLOYMENT_ENV: "preview", SUTRA_PUBLIC_ORIGIN: "https://preview.sutra.example" };
  assert.equal(evaluateDeploymentBoundary("https://preview.sutra.example/", runtime).allowed, true);
  assert.equal(evaluateDeploymentBoundary("https://preview.sutra.example/about", runtime).allowed, true);
  assert.equal(evaluateDeploymentBoundary("https://preview.sutra.example/contact", runtime).allowed, true);
  assert.equal(evaluateDeploymentBoundary("https://preview.sutra.example/api/contact", runtime).allowed, true);
  assert.equal(evaluateDeploymentBoundary("https://preview.sutra.example/assets/app.js", runtime).allowed, true);
  for (const legalPath of ["/privacy", "/terms", "/security", "/status"]) {
    assert.equal(
      evaluateDeploymentBoundary(`https://preview.sutra.example${legalPath}`, runtime).allowed,
      true,
      `${legalPath} should be a public marketing path`,
    );
  }
  const protectedRequest = evaluateDeploymentBoundary("https://preview.sutra.example/dashboard", runtime);
  assert.equal(protectedRequest.allowed, false);
  assert.equal(protectedRequest.code, "PREVIEW_MARKETING_ONLY");
});

test("canonical origin mismatch fails before application routing", () => {
  const decision = evaluateDeploymentBoundary("https://host-header.example/", {
    SUTRA_DEPLOYMENT_ENV: "preview",
    SUTRA_PUBLIC_ORIGIN: "https://preview.sutra.example",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.status, 421);
});

test("production stays disabled behind the SUTRA_HOSTED_ENABLED master switch (default OFF)", () => {
  // With every hosted configuration requirement satisfied but the master switch
  // unset, the ONLY remaining issue is the explicit release hold — proving the
  // identity/session and broker/jobs adapters no longer hard-block, and that the
  // switch is the single, deliberate final gate.
  assert.deepEqual(hostedConfigurationIssues(hostedShape), [
    "hosted deployment is disabled pending adversarial auth review (set SUTRA_HOSTED_ENABLED=true only after sign-off)",
  ]);
  const decision = evaluateDeploymentBoundary("https://app.sutra.example/dashboard", hostedShape);
  assert.equal(decision.allowed, false);
  assert.equal(decision.status, 503);

  // The switch is deny-by-default: only the exact string "true" clears the hold.
  for (const value of ["false", "TRUE", "1", "yes", " true", "true ", ""]) {
    assert.deepEqual(
      hostedConfigurationIssues({ ...hostedShape, SUTRA_HOSTED_ENABLED: value }),
      ["hosted deployment is disabled pending adversarial auth review (set SUTRA_HOSTED_ENABLED=true only after sign-off)"],
      `SUTRA_HOSTED_ENABLED=${JSON.stringify(value)} must not enable hosted mode`,
    );
  }
});

test("flipping the master switch clears the hold only when every other requirement passes", () => {
  // With the switch on AND all config valid, hosted production is allowed.
  const enabled = { ...hostedShape, SUTRA_HOSTED_ENABLED: "true" };
  assert.deepEqual(hostedConfigurationIssues(enabled), []);
  const allowed = evaluateDeploymentBoundary("https://app.sutra.example/dashboard", enabled);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.status, 200);

  // The switch never bypasses the other gates: each config requirement still
  // fails closed on its own even with the switch on.
  for (const [key, value] of [
    ["SUTRA_PUBLIC_ORIGIN", "http://app.sutra.example"],
    ["SUTRA_IDENTITY_MODE", "password"],
    ["SUTRA_OIDC_PROVIDERS", "[]"],
    ["SUTRA_OIDC_PROVIDERS", "not-json"],
    ["SUTRA_BROKER_URL", "http://broker.sutra.example"],
    ["SUTRA_BROKER_AUTH_MODE", "shared-secret"],
    ["SUTRA_DATABASE_MODE", "sqlite"],
    ["SUTRA_SECRET_STORE", "env"],
    ["SUTRA_ENVIRONMENT_KEY_SCOPE", "shared"],
    ["SUTRA_LOCAL_MODE", "true"],
  ] as const) {
    const broken = { ...enabled, [key]: value };
    assert.ok(
      hostedConfigurationIssues(broken).length >= 1,
      `${key}=${value} must still block hosted mode even with the master switch on`,
    );
    assert.equal(
      evaluateDeploymentBoundary("https://app.sutra.example/dashboard", broken).allowed,
      false,
    );
  }
});

test("security headers protect framing, MIME handling, capabilities, and HTTPS transport", () => {
  const headers = responseSecurityHeaders("https://app.sutra.example/dashboard", "production");
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.match(headers["Content-Security-Policy"], /frame-ancestors 'none'/u);
  assert.match(headers["Strict-Transport-Security"], /includeSubDomains/u);
  assert.equal(headers["X-Robots-Tag"], "noindex, nofollow");
  assert.equal(responseSecurityHeaders("http://127.0.0.1:3000/", "local")["Strict-Transport-Security"], undefined);
});

test("script-src drops 'unsafe-inline' and allowlists inline scripts via a per-request nonce", () => {
  // A fresh nonce is high-entropy base64 and differs each call.
  const nonce = generateScriptNonce();
  assert.match(nonce, /^[A-Za-z0-9+/=]{16,}$/u);
  assert.notEqual(generateScriptNonce(), generateScriptNonce());

  const withNonce = responseSecurityHeaders("https://app.sutra.example/", "production", nonce)["Content-Security-Policy"];
  assert.ok(withNonce.includes(`script-src 'self' 'nonce-${nonce}'`), withNonce);
  // 'unsafe-inline' must be gone from script-src (style-src may still use it).
  assert.doesNotMatch(withNonce, /script-src[^;]*'unsafe-inline'/u);

  // Responses with no inline scripts (API/image/boundary) fall back to 'self'.
  const noNonce = responseSecurityHeaders("https://app.sutra.example/api/v1/cases", "production")["Content-Security-Policy"];
  assert.match(noNonce, /script-src 'self'; connect-src/u);
  assert.doesNotMatch(noNonce, /script-src[^;]*'unsafe-inline'/u);

  // A malformed nonce is ignored rather than injected into the header.
  const bogus = responseSecurityHeaders("https://app.sutra.example/", "production", "short")["Content-Security-Policy"];
  assert.match(bogus, /script-src 'self'; connect-src/u);
});

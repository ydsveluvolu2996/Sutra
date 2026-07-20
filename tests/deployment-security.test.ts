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
  SUTRA_OIDC_ISSUER: "https://identity.sutra.example",
  SUTRA_OIDC_CLIENT_ID: "sutra-production",
  SUTRA_OIDC_AUTHORIZATION_ENDPOINT: "https://login.sutra.example/oauth2/authorize",
  SUTRA_OIDC_TOKEN_ENDPOINT: "https://login.sutra.example/oauth2/token",
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

test("production remains hard-blocked until hosted identity and broker adapters land", () => {
  assert.deepEqual(hostedConfigurationIssues(hostedShape), [
    "hosted identity and session lifecycle are not implemented in this build",
    "hosted broker ingestion and durable jobs are not implemented in this build",
  ]);
  const decision = evaluateDeploymentBoundary("https://app.sutra.example/dashboard", hostedShape);
  assert.equal(decision.allowed, false);
  assert.equal(decision.status, 503);
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

import assert from "node:assert/strict";
import test from "node:test";

import {
  exchangeOidcAuthorizationCode,
  fetchOidcJwks,
  validateHostedOidcConfiguration,
} from "../lib/hosted-oidc.ts";

const configuration = {
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example",
  authorizationEndpoint: "https://sutra-production.auth.us-east-1.amazoncognito.com/oauth2/authorize",
  tokenEndpoint: "https://sutra-production.auth.us-east-1.amazoncognito.com/oauth2/token",
  clientId: "sutra-production-client",
  redirectUri: "https://app.sutracmdb.com/api/auth/oidc/callback",
  jwksUrl: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example/.well-known/jwks.json",
} as const;

test("hosted OIDC accepts an operator-configured HTTPS JWKS endpoint on any host", () => {
  assert.doesNotThrow(() => validateHostedOidcConfiguration(configuration));
  // A federated provider may publish its signing keys on a different host than
  // its issuer (Google's keys live on www.googleapis.com, not accounts.google.com).
  // The JWKS URI is an operator-trusted configuration value, so a differently
  // hosted HTTPS endpoint is accepted; the identity binding is enforced at token
  // verification (issuer + audience + signature), not by the key transport host.
  assert.doesNotThrow(() => validateHostedOidcConfiguration({
    ...configuration,
    issuer: "https://accounts.google.com",
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
  }));
  // Credentials, a query string, a fragment, or non-HTTPS are still rejected so a
  // JWKS URI can never smuggle an open-redirect or embedded credential.
  for (const jwksUrl of [
    `${configuration.jwksUrl}?redirect=https://attacker.example`,
    "http://cognito-idp.us-east-1.amazonaws.com/us-east-1_example/.well-known/jwks.json",
    "https://user:pass@cognito-idp.us-east-1.amazonaws.com/us-east-1_example/.well-known/jwks.json",
    "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example/.well-known/jwks.json#fragment",
  ]) {
    assert.throws(() => validateHostedOidcConfiguration({ ...configuration, jwksUrl }));
  }
});

test("code exchange uses PKCE form data and returns only the bounded ID token", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const token = "header.payload.signature-value-that-is-long-enough";
  const result = await exchangeOidcAuthorizationCode(
    configuration,
    "valid-code-value",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    async (input, init) => {
      calls.push({ input: String(input), init });
      return Response.json({ id_token: token, access_token: "must-not-be-returned" });
    },
  );
  assert.equal(result, token);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, configuration.tokenEndpoint);
  assert.equal(calls[0]?.init?.redirect, "error");
  const body = new URLSearchParams(String(calls[0]?.init?.body));
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code_verifier"), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
});

test("confidential OIDC clients send the secret only to the pinned token endpoint", async () => {
  const confidential = { ...configuration, clientSecret: "test-client-secret-not-real" };
  const bodies: URLSearchParams[] = [];
  await exchangeOidcAuthorizationCode(
    confidential,
    "valid-code-value",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    async (_input, init) => {
      bodies.push(new URLSearchParams(String(init?.body)));
      return Response.json({ id_token: "header.payload.signature-value-that-is-long-enough" });
    },
  );
  assert.equal(bodies[0]?.get("client_secret"), confidential.clientSecret);
});

test("token and signing-key responses fail closed on status, content type, shape, and size", async () => {
  await assert.rejects(exchangeOidcAuthorizationCode(
    configuration,
    "valid-code-value",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    async () => new Response("denied", { status: 401, headers: { "content-type": "text/plain" } }),
  ));
  await assert.rejects(exchangeOidcAuthorizationCode(
    configuration,
    "valid-code-value",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    async () => Response.json({ access_token: "not-an-id-token" }),
  ));
  await assert.rejects(fetchOidcJwks(
    configuration,
    async () => new Response("<html />", { headers: { "content-type": "text/html" } }),
  ));
  await assert.rejects(fetchOidcJwks(
    configuration,
    async () => Response.json({ keys: [] }),
  ));
  await assert.rejects(fetchOidcJwks(
    configuration,
    async () => new Response(JSON.stringify({ keys: [{}] }), {
      headers: {
        "content-type": "application/json",
        "content-length": String(128 * 1024 + 1),
      },
    }),
  ));
});

test("JWKS fetch disables redirects and preserves only a bounded key set", async () => {
  let redirect: RequestRedirect | undefined;
  const result = await fetchOidcJwks(configuration, async (_input, init) => {
    redirect = init?.redirect;
    return Response.json({ keys: [{ kty: "RSA", kid: "key-1", use: "sig", alg: "RS256", n: "abc", e: "AQAB" }] });
  });
  assert.equal(redirect, "error");
  assert.equal(result.keys.length, 1);
  assert.equal(result.keys[0]?.kid, "key-1");
});

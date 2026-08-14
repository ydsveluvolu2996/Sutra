import assert from "node:assert/strict";
import test from "node:test";

import {
  hostedOidcProviderIssues,
  parseHostedOidcProviders,
} from "../lib/hosted-oidc-providers.ts";

const google = {
  id: "google",
  issuer: "https://accounts.google.com",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
  clientId: "sutra-google.apps.googleusercontent.com",
  authorizationPrompt: "select_account",
};
const entra = {
  id: "entra",
  issuer: "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0",
  authorizationEndpoint: "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/authorize",
  tokenEndpoint: "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/token",
  jwksUri: "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/discovery/v2.0/keys",
  clientId: "00000000-0000-0000-0000-000000000000",
};
const zoho = {
  id: "zoho",
  issuer: "https://accounts.zoho.in",
  authorizationEndpoint: "https://accounts.zoho.in/oauth/v2/auth",
  tokenEndpoint: "https://accounts.zoho.in/oauth/v2/token",
  jwksUri: "https://accounts.zoho.in/oauth/v2/keys",
  clientId: "1000.SUTRA_TEST_CLIENT",
  clientSecret: "test-client-secret-not-real",
};

test("a well-formed multi-provider list validates and preserves every provider", () => {
  const result = parseHostedOidcProviders(JSON.stringify([google, entra, zoho]));
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.providers.map((provider) => provider.id), ["google", "entra", "zoho"]);
  // The Entra tenant-scoped issuer path is preserved exactly.
  assert.equal(result.providers[1]?.issuer, entra.issuer);
  assert.equal(result.providers[2]?.clientSecret, zoho.clientSecret);
  assert.deepEqual(hostedOidcProviderIssues(JSON.stringify([google, entra, zoho])), []);
});

test("an absent, non-JSON, or empty provider list is refused", () => {
  for (const raw of [undefined, "", "   ", "not-json", "{}", "[]", "123"]) {
    assert.ok(hostedOidcProviderIssues(raw).length >= 1, `${JSON.stringify(raw)} must be refused`);
  }
});

test("each provider is validated independently and a single bad entry fails closed", () => {
  const cases = [
    { ...google, issuer: "http://accounts.google.com" }, // non-HTTPS issuer
    { ...google, issuer: "https://127.0.0.1/issuer" }, // loopback issuer
    { ...google, issuer: "https://accounts.google.com/?x=1" }, // issuer with a query
    { ...google, tokenEndpoint: "http://oauth2.googleapis.com/token" }, // non-HTTPS endpoint
    { ...google, jwksUri: "https://user:pass@www.googleapis.com/certs" }, // credentials in JWKS
    { ...google, clientId: "" }, // empty client id
    { ...google, id: "Google" }, // non-slug id
    { ...google, extra: "nope" }, // unexpected key
    { ...zoho, clientSecret: "short" }, // malformed confidential-client secret
    { ...google, authorizationPrompt: "login" }, // arbitrary prompt injection
    { ...google, authorizationPrompt: undefined }, // Google must always show its chooser
    { ...entra, authorizationPrompt: "select_account" }, // prompt must not leak to other providers
  ];
  for (const bad of cases) {
    const result = parseHostedOidcProviders(JSON.stringify([bad]));
    assert.ok(result.issues.length >= 1, `${JSON.stringify(bad)} must produce an issue`);
    assert.equal(result.providers.length, 0, "a provider with any issue is never returned");
  }
});

test("duplicate provider ids and oversized lists are refused", () => {
  assert.ok(parseHostedOidcProviders(JSON.stringify([google, { ...entra, id: "google" }])).issues.length >= 1);
  const many = Array.from({ length: 9 }, (_, index) => ({ ...google, id: `p${index}` }));
  assert.ok(parseHostedOidcProviders(JSON.stringify(many)).issues.length >= 1);
});

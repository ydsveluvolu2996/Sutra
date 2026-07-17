import assert from "node:assert/strict";
import test from "node:test";

import {
  createOidcAuthorization,
  oidcTokenRequestBody,
  openOidcTransaction,
  safeOidcReturnTo,
  sealOidcTransaction,
  validateOidcCallback,
} from "../lib/oidc-pkce.ts";

const configuration = {
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example",
  authorizationEndpoint: "https://sutra-staging.auth.us-east-1.amazoncognito.com/oauth2/authorize",
  tokenEndpoint: "https://sutra-staging.auth.us-east-1.amazoncognito.com/oauth2/token",
  clientId: "sutra-staging-client",
  redirectUri: "https://staging.sutra.example/api/auth/oidc/callback",
} as const;
const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("authorization request binds code flow, PKCE, nonce, state, and safe return path", async () => {
  const created = await createOidcAuthorization(configuration, "/cmdb?region=us-east-1", 1_000_000);
  const url = new URL(created.url);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), created.transaction.state);
  assert.equal(url.searchParams.get("nonce"), created.transaction.nonce);
  assert.match(url.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(created.transaction.returnTo, "/cmdb?region=us-east-1");
  assert.equal(url.toString().includes(created.transaction.codeVerifier), false);
});

test("encrypted transaction round-trips and rejects tampering, wrong keys, and expiry", async () => {
  const { transaction } = await createOidcAuthorization(configuration, "/dashboard", 2_000_000);
  const sealed = await sealOidcTransaction(transaction, key);
  assert.deepEqual(await openOidcTransaction(sealed, key, 2_001_000), transaction);
  await assert.rejects(openOidcTransaction(`${sealed.slice(0, -1)}A`, key, 2_001_000));
  await assert.rejects(openOidcTransaction(sealed, "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", 2_001_000));
  await assert.rejects(openOidcTransaction(sealed, key, transaction.expiresAt));
});

test("callback requires exact state and creates a bounded token request", async () => {
  const { transaction } = await createOidcAuthorization(configuration, "/dashboard", 3_000_000);
  const callback = new URL(configuration.redirectUri);
  callback.searchParams.set("code", "valid-code-value");
  callback.searchParams.set("state", transaction.state);
  const code = validateOidcCallback(callback.toString(), transaction);
  const body = oidcTokenRequestBody(configuration, code, transaction.codeVerifier);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code_verifier"), transaction.codeVerifier);
  callback.searchParams.set("state", `${transaction.state.slice(0, -1)}A`);
  assert.throws(() => validateOidcCallback(callback.toString(), transaction));
});

test("return paths reject external and authentication-loop targets", () => {
  assert.equal(safeOidcReturnTo("https://attacker.example/"), "/dashboard");
  assert.equal(safeOidcReturnTo("//attacker.example/"), "/dashboard");
  assert.equal(safeOidcReturnTo("/api/auth/oidc/start"), "/dashboard");
  assert.equal(safeOidcReturnTo("/login"), "/dashboard");
  assert.equal(safeOidcReturnTo("/findings?severity=high"), "/findings?severity=high");
});

test("a valid invitation is sealed into the transaction and malformed values are discarded", async () => {
  const token = "IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII";
  const invited = await createOidcAuthorization(configuration, "/dashboard", 4_000_000, token);
  assert.equal(invited.transaction.invitationToken, token);
  const malformed = await createOidcAuthorization(configuration, "/dashboard", 4_000_000, "not-a-token");
  assert.equal(malformed.transaction.invitationToken, null);
});

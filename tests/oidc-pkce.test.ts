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
  const created = await createOidcAuthorization(configuration, "google", "/cmdb?region=us-east-1", 1_000_000);
  const url = new URL(created.url);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), created.transaction.state);
  assert.equal(url.searchParams.get("nonce"), created.transaction.nonce);
  assert.match(url.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(created.transaction.returnTo, "/cmdb?region=us-east-1");
  assert.equal(created.transaction.provider, "google");
  assert.equal(url.toString().includes(created.transaction.codeVerifier), false);
});

test("authorization prompt is provider-scoped and limited to the reviewed account chooser", async () => {
  const google = await createOidcAuthorization(
    { ...configuration, authorizationPrompt: "select_account" },
    "google",
    "/dashboard",
    1_100_000,
  );
  assert.equal(new URL(google.url).searchParams.get("prompt"), "select_account");
  const otherProvider = await createOidcAuthorization(configuration, "entra", "/dashboard", 1_100_001);
  assert.equal(new URL(otherProvider.url).searchParams.has("prompt"), false);
  await assert.rejects(createOidcAuthorization(
    { ...configuration, authorizationPrompt: "login" as "select_account" },
    "google",
    "/dashboard",
    1_100_002,
  ));
});

test("encrypted transaction round-trips and rejects tampering, wrong keys, and expiry", async () => {
  const { transaction } = await createOidcAuthorization(configuration, "google", "/dashboard", 2_000_000);
  const sealed = await sealOidcTransaction(transaction, key);
  assert.deepEqual(await openOidcTransaction(sealed, key, 2_001_000), transaction);
  const replacement = sealed.endsWith("A") ? "B" : "A";
  await assert.rejects(openOidcTransaction(`${sealed.slice(0, -1)}${replacement}`, key, 2_001_000));
  await assert.rejects(openOidcTransaction(sealed, "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", 2_001_000));
  await assert.rejects(openOidcTransaction(sealed, key, transaction.expiresAt));
});

test("callback requires exact state and creates a bounded token request", async () => {
  const { transaction } = await createOidcAuthorization(configuration, "google", "/dashboard", 3_000_000);
  const callback = new URL(configuration.redirectUri);
  callback.searchParams.set("code", "valid-code-value");
  callback.searchParams.set("state", transaction.state);
  const code = validateOidcCallback(callback.toString(), transaction);
  const body = oidcTokenRequestBody(configuration, code, transaction.codeVerifier);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code_verifier"), transaction.codeVerifier);
  const replacement = transaction.state.endsWith("A") ? "B" : "A";
  callback.searchParams.set("state", `${transaction.state.slice(0, -1)}${replacement}`);
  assert.throws(() => validateOidcCallback(callback.toString(), transaction));
});

test("callback rejects a missing state, a missing/malformed code, and an IdP error", async () => {
  const { transaction } = await createOidcAuthorization(configuration, "google", "/dashboard", 3_500_000);
  // A code with no state (or a blank state) can never satisfy the constant-time
  // state comparison, so the callback is refused before any code exchange.
  const noState = new URL(configuration.redirectUri);
  noState.searchParams.set("code", "valid-code-value");
  assert.throws(() => validateOidcCallback(noState.toString(), transaction));
  // A matching state but absent/short code is rejected on the code shape guard.
  const noCode = new URL(configuration.redirectUri);
  noCode.searchParams.set("state", transaction.state);
  assert.throws(() => validateOidcCallback(noCode.toString(), transaction));
  noCode.searchParams.set("code", "x");
  assert.throws(() => validateOidcCallback(noCode.toString(), transaction));
  // An IdP-reported error aborts even when a state is echoed back.
  const errored = new URL(configuration.redirectUri);
  errored.searchParams.set("error", "access_denied");
  errored.searchParams.set("state", transaction.state);
  assert.throws(() => validateOidcCallback(errored.toString(), transaction));
});

test("a sealed transaction cannot be replayed past its TTL or under a foreign key", async () => {
  const { transaction } = await createOidcAuthorization(configuration, "google", "/dashboard", 5_000_000);
  const sealed = await sealOidcTransaction(transaction, key);
  // Valid within the TTL window.
  assert.deepEqual(await openOidcTransaction(sealed, key, 5_100_000), transaction);
  // Replayed after expiry (createdAt + TTL) is refused — a stale login attempt
  // cannot be resurrected.
  await assert.rejects(openOidcTransaction(sealed, key, transaction.expiresAt + 1));
  // A cookie sealed under a different transaction key never opens.
  await assert.rejects(openOidcTransaction(sealed, "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", 5_100_000));
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
  const invited = await createOidcAuthorization(configuration, "entra", "/dashboard", 4_000_000, token);
  assert.equal(invited.transaction.invitationToken, token);
  assert.equal(invited.transaction.provider, "entra");
  const malformed = await createOidcAuthorization(configuration, "entra", "/dashboard", 4_000_000, "not-a-token");
  assert.equal(malformed.transaction.invitationToken, null);
});

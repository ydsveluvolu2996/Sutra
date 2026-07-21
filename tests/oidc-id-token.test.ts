import assert from "node:assert/strict";
import test from "node:test";

import { verifyOidcIdToken } from "../lib/oidc-id-token.ts";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function fixture() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const now = 1_800_000_000_000;
  const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example";
  const clientId = "sutra-production-client";
  const nonce = "nonce-value-bound-to-the-encrypted-transaction";
  async function sign(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", typ: "JWT", kid: "sutra-key-1" }) {
    const signingInput = `${encode(header)}.${encode(payload)}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(signingInput));
    return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
  }
  const payload = {
    iss: issuer,
    aud: clientId,
    sub: "cognito-user-subject",
    nonce,
    token_use: "id",
    email: "Owner@Sutra.Example",
    email_verified: true,
    name: "Sutra Owner",
    auth_time: now / 1000 - 30,
    iat: now / 1000 - 10,
    exp: now / 1000 + 890,
  };
  return {
    payload,
    verification: { issuer, clientId, nonce, jwks: { keys: [{ ...publicJwk, kid: "sutra-key-1", use: "sig", alg: "RS256" }] }, now },
    sign,
  };
}

test("verifies an RS256 identity token and returns bounded identity claims", async () => {
  const subject = await fixture();
  const identity = await verifyOidcIdToken(await subject.sign(subject.payload), subject.verification);
  assert.deepEqual(identity, {
    issuer: subject.verification.issuer,
    subject: "cognito-user-subject",
    email: "owner@sutra.example",
    displayName: "Sutra Owner",
    authenticatedAt: subject.payload.auth_time * 1000,
    expiresAt: subject.payload.exp * 1000,
  });
});

test("rejects tampering, algorithm substitution, and ambiguous signing keys", async () => {
  const subject = await fixture();
  const token = await subject.sign(subject.payload);
  const [header, payload, signature] = token.split(".");
  const tamperedPayload = `${payload?.startsWith("A") ? "B" : "A"}${payload?.slice(1)}`;
  await assert.rejects(verifyOidcIdToken(`${header}.${tamperedPayload}.${signature}`, subject.verification));
  await assert.rejects(verifyOidcIdToken(await subject.sign(subject.payload, { alg: "none", kid: "sutra-key-1" }), subject.verification));
  await assert.rejects(verifyOidcIdToken(token, {
    ...subject.verification,
    jwks: { keys: [...subject.verification.jwks.keys, subject.verification.jwks.keys[0]] },
  }));
});

test("rejects wrong issuer, audience, nonce, token use, and unverified email", async () => {
  const subject = await fixture();
  for (const patch of [
    { iss: "https://attacker.example" },
    { aud: "other-client" },
    { nonce: "other-nonce" },
    { token_use: "access" },
    { email_verified: false },
  ]) {
    await assert.rejects(verifyOidcIdToken(await subject.sign({ ...subject.payload, ...patch }), subject.verification));
  }
});

test("rejects a token whose signature was produced by a foreign key", async () => {
  const subject = await fixture();
  // Sign a well-formed payload with an attacker key while presenting a header
  // kid that matches the legitimate JWKS entry. The signature must not verify
  // against the published public key.
  const foreign = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const header = { alg: "RS256", typ: "JWT", kid: "sutra-key-1" };
  const signingInput = `${encode(header)}.${encode(subject.payload)}`;
  const forgedSignature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    foreign.privateKey,
    new TextEncoder().encode(signingInput),
  );
  const forged = `${signingInput}.${Buffer.from(forgedSignature).toString("base64url")}`;
  await assert.rejects(verifyOidcIdToken(forged, subject.verification), /signature is invalid/u);
});

test("rejects expired, future, and overlong token lifetimes", async () => {
  const subject = await fixture();
  const nowSeconds = subject.verification.now / 1000;
  for (const patch of [
    { iat: nowSeconds - 4000, exp: nowSeconds - 120 },
    { iat: nowSeconds + 120, exp: nowSeconds + 900 },
    { iat: nowSeconds - 10, exp: nowSeconds + 4000 },
  ]) {
    await assert.rejects(verifyOidcIdToken(await subject.sign({ ...subject.payload, ...patch }), subject.verification));
  }
});

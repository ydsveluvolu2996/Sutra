import assert from "node:assert/strict";
import test from "node:test";

import { verifyOidcIdToken } from "../lib/oidc-id-token.ts";

// Multi-provider federation: Google and Microsoft Entra side by side. Each token
// is verified STRICTLY against the sealed provider's pinned issuer/audience/keys.
// A token minted by one provider must never validate under another.

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function makeKey(kid: string) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { ...publicJwk, kid, use: "sig", alg: "RS256" } };
}

async function sign(privateKey: CryptoKey, kid: string, payload: Record<string, unknown>): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid };
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
}

const now = 1_800_000_000_000;
const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_CLIENT = "sutra-google.apps.googleusercontent.com";
const ENTRA_ISSUER = "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0";
const ENTRA_CLIENT = "00000000-0000-0000-0000-000000000000";

function claims(issuer: string, clientId: string, subject: string): Record<string, unknown> {
  return {
    iss: issuer,
    aud: clientId,
    sub: subject,
    nonce: "nonce-bound-to-the-sealed-transaction",
    token_use: "id",
    email: "person@example.com",
    email_verified: true,
    name: "Federated Person",
    auth_time: now / 1000 - 30,
    iat: now / 1000 - 10,
    exp: now / 1000 + 500,
  };
}

test("a Google token validates ONLY under the Google provider, never under Entra", async () => {
  const key = await makeKey("google-key-1");
  const token = await sign(key.privateKey, key.kid, claims(GOOGLE_ISSUER, GOOGLE_CLIENT, "google-subject-1"));
  const googleVerification = { issuer: GOOGLE_ISSUER, clientId: GOOGLE_CLIENT, nonce: "nonce-bound-to-the-sealed-transaction", jwks: { keys: [key.jwk] }, now };
  const identity = await verifyOidcIdToken(token, googleVerification);
  assert.equal(identity.issuer, GOOGLE_ISSUER);
  assert.equal(identity.subject, "google-subject-1");
  // Cross-provider substitution: the SAME Google token, verified with the Entra
  // provider's pinned issuer/client/keys, must be rejected.
  await assert.rejects(verifyOidcIdToken(token, {
    issuer: ENTRA_ISSUER,
    clientId: ENTRA_CLIENT,
    nonce: "nonce-bound-to-the-sealed-transaction",
    jwks: { keys: [key.jwk] },
    now,
  }));
});

test("an Entra tenant-scoped token validates ONLY under the Entra provider", async () => {
  const key = await makeKey("entra-key-1");
  const token = await sign(key.privateKey, key.kid, claims(ENTRA_ISSUER, ENTRA_CLIENT, "entra-subject-1"));
  const identity = await verifyOidcIdToken(token, {
    issuer: ENTRA_ISSUER,
    clientId: ENTRA_CLIENT,
    nonce: "nonce-bound-to-the-sealed-transaction",
    jwks: { keys: [key.jwk] },
    now,
  });
  assert.equal(identity.issuer, ENTRA_ISSUER);
  // Presented to the Google provider it is rejected (issuer + audience mismatch).
  await assert.rejects(verifyOidcIdToken(token, {
    issuer: GOOGLE_ISSUER,
    clientId: GOOGLE_CLIENT,
    nonce: "nonce-bound-to-the-sealed-transaction",
    jwks: { keys: [key.jwk] },
    now,
  }));
});

test("a token whose issuer matches NEITHER configured provider is rejected by both", async () => {
  const key = await makeKey("rogue-key-1");
  const token = await sign(key.privateKey, key.kid, claims("https://accounts.google.com.attacker.example", GOOGLE_CLIENT, "rogue"));
  for (const issuer of [GOOGLE_ISSUER, ENTRA_ISSUER]) {
    await assert.rejects(verifyOidcIdToken(token, {
      issuer,
      clientId: GOOGLE_CLIENT,
      nonce: "nonce-bound-to-the-sealed-transaction",
      jwks: { keys: [key.jwk] },
      now,
    }));
  }
});

test("multi-key JWKS selects the signing key by kid (rotation-safe)", async () => {
  const [keyA, keyB] = await Promise.all([makeKey("entra-key-a"), makeKey("entra-key-b")]);
  // Sign with key B; the JWKS publishes BOTH keys (a rotation window). The
  // verifier must pick key B by its kid and succeed.
  const token = await sign(keyB.privateKey, keyB.kid, claims(ENTRA_ISSUER, ENTRA_CLIENT, "entra-subject-2"));
  const identity = await verifyOidcIdToken(token, {
    issuer: ENTRA_ISSUER,
    clientId: ENTRA_CLIENT,
    nonce: "nonce-bound-to-the-sealed-transaction",
    jwks: { keys: [keyA.jwk, keyB.jwk] },
    now,
  });
  assert.equal(identity.subject, "entra-subject-2");
  // A token whose header kid is not in the published set cannot be verified.
  const orphan = await sign(keyB.privateKey, "unpublished-kid", claims(ENTRA_ISSUER, ENTRA_CLIENT, "entra-subject-3"));
  await assert.rejects(verifyOidcIdToken(orphan, {
    issuer: ENTRA_ISSUER,
    clientId: ENTRA_CLIENT,
    nonce: "nonce-bound-to-the-sealed-transaction",
    jwks: { keys: [keyA.jwk, keyB.jwk] },
    now,
  }));
});

import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  canonicalFalcoRequest,
  FalcoRequestSecurityError,
  FalcoRequestVerifier,
  type FalcoReplayStore,
} from "../lib/falco-request-security.ts";

const clusterId = `kcluster_${"b".repeat(48)}`;
const keyId = "current";
const secret = randomBytes(32);
const now = 1_752_735_000_000;
const path = `/api/v1/kubernetes/runtime-events/${clusterId}`;
const body = Buffer.from('{"priority":"Warning"}');

function signedHeaders(nonce = "abcdefghijklmnopqrstuv"): Headers {
  const timestamp = String(now);
  const bodySha256 = createHash("sha256").update(body).digest("hex");
  const digest = createHmac("sha256", secret).update(canonicalFalcoRequest({
    method: "POST",
    path,
    timestamp,
    nonce,
    keyId,
    clusterId,
    bodySha256,
  })).digest("base64url");
  return new Headers({
    "x-sutra-falco-timestamp": timestamp,
    "x-sutra-falco-nonce": nonce,
    "x-sutra-falco-key-id": keyId,
    "x-sutra-falco-signature": digest,
  });
}

function verifier(replayStore: FalcoReplayStore): FalcoRequestVerifier {
  return new FalcoRequestVerifier({
    now: () => now,
    credentials: {
      async resolve(input) {
        return input.clusterId === clusterId && input.keyId === keyId ? secret : null;
      },
    },
    replayStore,
  });
}

test("verifies a cluster-bound signed request and reserves its nonce", async () => {
  const consumed: string[] = [];
  const result = await verifier({
    async consume(input) {
      consumed.push(`${input.clusterId}:${input.keyId}:${input.nonceSha256}`);
      return true;
    },
  }).verify({
    path,
    headers: signedHeaders(),
    body,
    expectedClusterId: clusterId,
  });
  assert.match(result.bodySha256, /^[a-f0-9]{64}$/u);
  assert.equal(consumed.length, 1);
});

test("rejects replay and signatures scoped to a different cluster", async () => {
  await assert.rejects(
    verifier({ async consume() { return false; } }).verify({
      path,
      headers: signedHeaders(),
      body,
      expectedClusterId: clusterId,
    }),
    (error: unknown) =>
      error instanceof FalcoRequestSecurityError && error.code === "REQUEST_REPLAYED",
  );
  const otherCluster = `kcluster_${"c".repeat(48)}`;
  await assert.rejects(
    verifier({ async consume() { return true; } }).verify({
      path,
      headers: signedHeaders(),
      body,
      expectedClusterId: otherCluster,
    }),
    (error: unknown) =>
      error instanceof FalcoRequestSecurityError && error.code === "AUTHENTICATION_FAILED",
  );
});

test("authenticates the exact body and allows key-id rotation", async () => {
  await assert.rejects(
    verifier({ async consume() { return true; } }).verify({
      path,
      headers: signedHeaders(),
      body: Buffer.from('{"priority":"Critical"}'),
      expectedClusterId: clusterId,
    }),
    (error: unknown) =>
      error instanceof FalcoRequestSecurityError && error.code === "AUTHENTICATION_FAILED",
  );
  const previousSecret = randomBytes(32);
  const rotating = new FalcoRequestVerifier({
    now: () => now,
    credentials: {
      async resolve(input) {
        if (input.keyId === "current") return secret;
        if (input.keyId === "previous") return previousSecret;
        return null;
      },
    },
    replayStore: { async consume() { return true; } },
  });
  assert.equal((await rotating.verify({
    path,
    headers: signedHeaders(),
    body,
    expectedClusterId: clusterId,
  })).keyId, "current");
});

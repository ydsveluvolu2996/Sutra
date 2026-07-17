import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import test from "node:test";

import {
  canonicalHostedBrokerRequest,
  HostedBrokerRequestSecurityError,
  HostedBrokerRequestVerifier,
  InMemoryHostedBrokerReplayStore,
  type HostedBrokerRequestHeaders,
  type HostedBrokerRequestScope,
} from "../lib/hosted-broker-request-security.ts";

const now = 1_800_000_000_000;
const scope: HostedBrokerRequestScope = {
  tenantId: "tenant_customer_01",
  connectionId: `conn_${"a".repeat(32)}`,
  jobId: `job_${"b".repeat(48)}`,
};
const method = "POST";
const path = `/v1/tenants/${scope.tenantId}/connections/${scope.connectionId}/jobs/${scope.jobId}`;
const keyId = "broker-key-2026-07";
const nonce = "nonce_1234567890abcdef";
const body = Buffer.from(JSON.stringify({
  tenantId: scope.tenantId,
  connectionId: scope.connectionId,
  jobId: scope.jobId,
  operation: "inventory",
}), "utf8");
const pair = generateKeyPairSync("ed25519");

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function signedHeaders(overrides: {
  timestamp?: string;
  nonce?: string;
  keyId?: string;
  scope?: HostedBrokerRequestScope;
  method?: string;
  path?: string;
  body?: Uint8Array;
  privateKey?: KeyObject;
} = {}): HostedBrokerRequestHeaders {
  const requestScope = overrides.scope ?? scope;
  const timestamp = overrides.timestamp ?? String(now);
  const requestNonce = overrides.nonce ?? nonce;
  const requestKeyId = overrides.keyId ?? keyId;
  const requestBody = overrides.body ?? body;
  const signature = sign(null, canonicalHostedBrokerRequest({
    method: overrides.method ?? method,
    path: overrides.path ?? path,
    timestamp,
    nonce: requestNonce,
    keyId: requestKeyId,
    scope: requestScope,
    bodySha256: sha256(requestBody),
  }), overrides.privateKey ?? pair.privateKey).toString("base64url");
  return {
    "x-sutra-timestamp": timestamp,
    "x-sutra-nonce": requestNonce,
    "x-sutra-key-id": requestKeyId,
    "x-sutra-tenant-id": requestScope.tenantId,
    "x-sutra-connection-id": requestScope.connectionId,
    "x-sutra-job-id": requestScope.jobId,
    "x-sutra-signature": signature,
  };
}

function verifier(options: {
  publicKey?: KeyObject | null;
  maximumBodyBytes?: number;
  maximumClockSkewMs?: number;
  replayStore?: InMemoryHostedBrokerReplayStore;
} = {}) {
  return new HostedBrokerRequestVerifier({
    now: () => now,
    maximumBodyBytes: options.maximumBodyBytes,
    maximumClockSkewMs: options.maximumClockSkewMs,
    publicKeys: {
      async resolve(input) {
        assert.equal(input.tenantId, scope.tenantId);
        return input.keyId === keyId ? options.publicKey ?? pair.publicKey : null;
      },
    },
    replayStore: options.replayStore ?? new InMemoryHostedBrokerReplayStore(() => now),
  });
}

function code(expected: HostedBrokerRequestSecurityError["code"]) {
  return (error: unknown) =>
    error instanceof HostedBrokerRequestSecurityError &&
    error.code === expected &&
    error.message === "Hosted broker request rejected";
}

test("verifies an Ed25519 request bound to the exact trusted tenant, connection and job", async () => {
  const verified = await verifier().verify({
    method,
    path,
    headers: signedHeaders(),
    body,
    expectedScope: scope,
  });
  assert.deepEqual(verified, {
    ...scope,
    keyId,
    nonce,
    timestamp: now,
    bodySha256: sha256(body),
  });
});

test("rejects body, method, path and signature tampering", async (t) => {
  const headers = signedHeaders();
  const attempts = [
    { name: "body", input: { method, path, headers, body: Buffer.from("{}"), expectedScope: scope } },
    { name: "method", input: { method: "DELETE", path, headers, body, expectedScope: scope } },
    { name: "path", input: { method, path: `${path}?other=true`, headers, body, expectedScope: scope } },
    {
      name: "signature",
      input: {
        method, path, body, expectedScope: scope,
        headers: { ...headers, "x-sutra-signature": `${"A".repeat(85)}B` },
      },
    },
  ];
  for (const attempt of attempts) {
    await t.test(attempt.name, async () => {
      await assert.rejects(verifier().verify(attempt.input), code("AUTHENTICATION_FAILED"));
    });
  }
});

test("rejects any tenant, connection or job mismatch before accepting the signed operation", async (t) => {
  const headers = signedHeaders();
  for (const [name, expectedScope] of [
    ["tenant", { ...scope, tenantId: "tenant_customer_02" }],
    ["connection", { ...scope, connectionId: `conn_${"c".repeat(32)}` }],
    ["job", { ...scope, jobId: `job_${"d".repeat(48)}` }],
  ] as const) {
    await t.test(name, async () => {
      await assert.rejects(
        verifier().verify({ method, path, headers, body, expectedScope }),
        code("SCOPE_MISMATCH"),
      );
    });
  }
});

test("rejects stale and future timestamps and a duplicate nonce", async () => {
  await assert.rejects(verifier().verify({
    method, path, body, expectedScope: scope,
    headers: signedHeaders({ timestamp: String(now - 60_001) }),
  }), code("AUTHENTICATION_FAILED"));
  await assert.rejects(verifier().verify({
    method, path, body, expectedScope: scope,
    headers: signedHeaders({ timestamp: String(now + 60_001) }),
  }), code("AUTHENTICATION_FAILED"));

  const subject = verifier();
  const request = { method, path, body, expectedScope: scope, headers: signedHeaders() };
  await subject.verify(request);
  await assert.rejects(subject.verify(request), code("REQUEST_REPLAYED"));
});

test("replay reservation is atomic under concurrent verification", async () => {
  const subject = verifier();
  const request = { method, path, body, expectedScope: scope, headers: signedHeaders() };
  const results = await Promise.allSettled([subject.verify(request), subject.verify(request)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected?.status, "rejected");
  if (rejected?.status === "rejected") assert.ok(code("REQUEST_REPLAYED")(rejected.reason));
});

test("rejects oversized bodies before key resolution or replay reservation", async () => {
  let keyLookups = 0;
  let replayWrites = 0;
  const subject = new HostedBrokerRequestVerifier({
    now: () => now,
    maximumBodyBytes: 8,
    publicKeys: {
      async resolve() {
        keyLookups += 1;
        return pair.publicKey;
      },
    },
    replayStore: {
      async consume() {
        replayWrites += 1;
        return true;
      },
    },
  });
  await assert.rejects(subject.verify({
    method, path, headers: signedHeaders(), body, expectedScope: scope,
  }), code("BODY_TOO_LARGE"));
  assert.equal(keyLookups, 0);
  assert.equal(replayWrites, 0);
});

test("rejects unknown key ids, non-Ed25519 keys and malformed multi-value headers", async () => {
  await assert.rejects(verifier().verify({
    method, path, body, expectedScope: scope,
    headers: signedHeaders({ keyId: "unknown-key" }),
  }), code("AUTHENTICATION_FAILED"));

  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await assert.rejects(verifier({ publicKey: rsa.publicKey }).verify({
    method, path, body, expectedScope: scope,
    headers: signedHeaders({ privateKey: rsa.privateKey }),
  }), code("AUTHENTICATION_FAILED"));

  await assert.rejects(verifier().verify({
    method, path, body, expectedScope: scope,
    headers: { ...signedHeaders(), "x-sutra-nonce": [nonce, "other_nonce_1234567890"] },
  }), code("AUTHENTICATION_FAILED"));
});

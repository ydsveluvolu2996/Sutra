import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import test from "node:test";

import {
  HostedRequestAuthenticationError,
  HostedRequestAuthenticator,
  type HostedRequestReplayStore,
} from "../src/hosted-request-auth.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requestCanonical(input: {
  method: string; path: string; timestamp: string; nonce: string; keyId: string; body: string;
}): Buffer {
  return Buffer.from([
    "SUTRA-APP-BROKER-V1",
    input.method,
    input.path,
    input.timestamp,
    input.nonce,
    input.keyId,
    sha256(input.body),
  ].join("\n"), "utf8");
}

function headers(input: {
  method: string; path: string; timestamp: string; nonce: string; keyId: string; body: string;
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
}): Record<string, string> {
  return {
    "x-sutra-timestamp": input.timestamp,
    "x-sutra-nonce": input.nonce,
    "x-sutra-key-id": input.keyId,
    "x-sutra-signature": sign(null, requestCanonical(input), input.privateKey).toString("base64url"),
  };
}

class SharedReplayStore implements HostedRequestReplayStore {
  public readonly keys = new Map<string, number>();
  public now = 0;
  public async consume(key: string, expiresAt: number): Promise<boolean> {
    const existing = this.keys.get(key);
    if (existing !== undefined && existing > this.now) return false;
    this.keys.set(key, expiresAt);
    return true;
  }
}

const app = generateKeyPairSync("ed25519");
const broker = generateKeyPairSync("ed25519");
const appPublic = app.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const brokerPrivate = broker.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
const keyId = "app-production-1";
const now = 1_900_000_000_000;

function authenticator(store: SharedReplayStore): HostedRequestAuthenticator {
  return new HostedRequestAuthenticator({
    clientPublicKeys: { [keyId]: appPublic },
    brokerKeyId: "broker-production-1",
    brokerPrivateKey: brokerPrivate,
    replayStore: store,
    now: () => now,
  });
}

test("asymmetric request is path/body bound and response is broker signed", async () => {
  const store = new SharedReplayStore();
  store.now = now;
  const auth = authenticator(store);
  const input = {
    method: "POST",
    path: "/v1/connections/conn_1/sync",
    timestamp: String(now),
    nonce: "nonce_0000000000000000000001",
    keyId,
    body: '{"tenantId":"org_1"}',
    privateKey: app.privateKey,
  };
  const verified = await auth.verify({
    method: input.method,
    path: input.path,
    body: input.body,
    headers: headers(input),
  });
  assert.equal(verified.nonce, input.nonce);

  const responseBody = '{"ok":true}';
  const signed = await auth.responseSignature(200, input.path, input.nonce, responseBody);
  assert.equal(signed.keyId, "broker-production-1");
  const responseCanonical = Buffer.from([
    "SUTRA-BROKER-APP-V1",
    "200",
    input.path,
    input.nonce,
    signed.keyId,
    sha256(responseBody),
  ].join("\n"), "utf8");
  assert.equal(
    verify(null, responseCanonical, broker.publicKey, Buffer.from(signed.signature, "base64url")),
    true,
  );
});

test("shared replay state rejects the same nonce across broker replicas and restart", async () => {
  const store = new SharedReplayStore();
  store.now = now;
  const firstReplica = authenticator(store);
  const restartedReplica = authenticator(store);
  const input = {
    method: "GET",
    path: "/v1/health",
    timestamp: String(now),
    nonce: "nonce_0000000000000000000002",
    keyId,
    body: "",
    privateKey: app.privateKey,
  };
  const signedHeaders = headers(input);
  await firstReplica.verify({ method: input.method, path: input.path, body: input.body, headers: signedHeaders });
  await assert.rejects(
    restartedReplica.verify({ method: input.method, path: input.path, body: input.body, headers: signedHeaders }),
    (error) => error instanceof HostedRequestAuthenticationError && error.code === "REQUEST_REPLAYED",
  );
});

test("signature cannot cross path or body scope", async () => {
  const store = new SharedReplayStore();
  store.now = now;
  const auth = authenticator(store);
  const input = {
    method: "POST",
    path: "/v1/connections/conn_a/sync",
    timestamp: String(now),
    nonce: "nonce_0000000000000000000003",
    keyId,
    body: '{"tenantId":"org_a"}',
    privateKey: app.privateKey,
  };
  const signedHeaders = headers(input);
  for (const mutation of [
    { path: "/v1/connections/conn_b/sync", body: input.body },
    { path: input.path, body: '{"tenantId":"org_b"}' },
  ]) {
    await assert.rejects(
      auth.verify({ method: input.method, path: mutation.path, body: mutation.body, headers: signedHeaders }),
      (error) => error instanceof HostedRequestAuthenticationError &&
        error.code === "AUTHENTICATION_FAILED",
    );
  }
});

test("configuration fails closed for empty keys and non-Ed25519 keys", () => {
  assert.throws(() => new HostedRequestAuthenticator({
    clientPublicKeys: {},
    brokerKeyId: "broker-production-1",
    brokerPrivateKey: brokerPrivate,
    replayStore: new SharedReplayStore(),
  }));
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => new HostedRequestAuthenticator({
    clientPublicKeys: {
      [keyId]: rsa.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    },
    brokerKeyId: "broker-production-1",
    brokerPrivateKey: brokerPrivate,
    replayStore: new SharedReplayStore(),
  }));
});

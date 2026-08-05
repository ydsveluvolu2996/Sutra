import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import test from "node:test";

const {
  HostedBrokerClientSecurityError,
  signHostedBrokerRequest,
  verifyHostedBrokerResponse,
} = await import("../lib/hosted-broker-client-security.ts");

const app = generateKeyPairSync("ed25519");
const broker = generateKeyPairSync("ed25519");
const config = {
  clientKeyId: "app-production-1",
  clientPrivateKey: app.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
  brokerKeyId: "broker-production-1",
  brokerPublicKey: broker.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("hosted app signs a request the broker can verify", async () => {
  const input = {
    method: "POST",
    path: "/v1/connections/conn_1/sync",
    body: '{"tenantId":"org_1"}',
    now: 1_900_000_000_000,
    nonce: "nonce_0000000000000000000001",
    config,
  };
  const signed = await signHostedBrokerRequest(input);
  const canonical = Buffer.from([
    "SUTRA-APP-BROKER-V1",
    input.method,
    input.path,
    signed.headers["x-sutra-timestamp"],
    input.nonce,
    config.clientKeyId,
    sha256(input.body),
  ].join("\n"), "utf8");
  assert.equal(
    verify(
      null,
      canonical,
      app.publicKey,
      Buffer.from(signed.headers["x-sutra-signature"], "base64url"),
    ),
    true,
  );
});

test("app accepts only a response bound to status, path, nonce, body and broker key", async () => {
  const status = 200;
  const path = "/v1/health";
  const nonce = "nonce_0000000000000000000002";
  const body = '{"ok":true}';
  const canonical = Buffer.from([
    "SUTRA-BROKER-APP-V1",
    String(status),
    path,
    nonce,
    config.brokerKeyId,
    sha256(body),
  ].join("\n"), "utf8");
  const headers = new Headers({
    "x-sutra-key-id": config.brokerKeyId,
    "x-sutra-signature": sign(null, canonical, broker.privateKey).toString("base64url"),
  });
  await verifyHostedBrokerResponse({ status, path, nonce, body, headers, config });
  await assert.rejects(
    verifyHostedBrokerResponse({ status, path, nonce, body: '{"ok":false}', headers, config }),
    (error) => error instanceof HostedBrokerClientSecurityError,
  );
  await assert.rejects(
    verifyHostedBrokerResponse({ status, path: "/v1/other", nonce, body, headers, config }),
    (error) => error instanceof HostedBrokerClientSecurityError,
  );
});

test("hosted signing configuration fails closed", async () => {
  await assert.rejects(
    signHostedBrokerRequest({
      method: "GET",
      path: "/v1/health",
      body: "",
      now: Date.now(),
      nonce: "nonce_0000000000000000000003",
      config: { ...config, clientPrivateKey: "not-a-key" },
    }),
    (error) => error instanceof HostedBrokerClientSecurityError,
  );
});

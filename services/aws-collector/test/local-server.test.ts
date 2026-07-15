import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createLocalCollectorServer } from "../src/local-server.js";

const NOW = new Date("2026-07-15T10:00:00.000Z");
const TENANT_ID = "org_local_sutra";
const CONNECTION_ID = "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("signed loopback fixture API completes register, trust verification, and sync", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-server-"));
  const sharedSecret = randomBytes(32).toString("base64url");
  const server = createLocalCollectorServer({
    sharedSecret,
    registryEncryptionKey: randomBytes(32).toString("base64url"),
    registryPath: join(directory, "registry.enc"),
    mode: "fixture",
    now: () => NOW,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const health = await signedRequest(baseUrl, sharedSecret, "GET", "/v1/health");
    assert.equal(health.status, 200);
    assert.deepEqual(health.value, {
      ok: true,
      mode: "fixture",
      version: "0.2.0-pilot",
      principalArn: "arn:aws:iam::999988887777:role/SutraLocalCollector",
      sourceAccountId: "999988887777",
      message: "Fixture collector ready; no AWS API calls will be made.",
    });

    const registration = await signedRequest(
      baseUrl,
      sharedSecret,
      "PUT",
      `/v1/connections/${CONNECTION_ID}`,
      {
        tenantId: TENANT_ID,
        connectionId: CONNECTION_ID,
        accountId: "123456789012",
        partition: "aws",
        roleArn: "arn:aws:iam::123456789012:role/mspcmdb/SutraReadOnlyRole",
        externalId: "sutra_external_id_1234567890abcd",
        enabledRegions: ["us-east-1", "ap-south-1"],
      },
    );
    assert.equal(registration.status, 200);
    assert.deepEqual(registration.value, { registered: true });

    const verification = await signedRequest(
      baseUrl,
      sharedSecret,
      "POST",
      `/v1/connections/${CONNECTION_ID}/verify`,
      {
        tenantId: TENANT_ID,
        connectionId: CONNECTION_ID,
        jobId: "verify_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    );
    assert.equal(verification.status, 200);
    const verificationValue = verification.value as Record<string, unknown>;
    assert.equal(verificationValue.verified, true);
    assert.equal(verificationValue.accountId, "123456789012");
    assert.equal(verificationValue.missingExternalIdDenied, true);
    assert.equal(verificationValue.wrongExternalIdDenied, true);

    const sync = await signedRequest(
      baseUrl,
      sharedSecret,
      "POST",
      `/v1/connections/${CONNECTION_ID}/sync`,
      {
        tenantId: TENANT_ID,
        connectionId: CONNECTION_ID,
        jobId: "sync_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    );
    assert.equal(sync.status, 200);
    const snapshot = sync.value as Record<string, unknown>;
    assert.equal(snapshot.schemaVersion, "sutra.inventory.v1");
    assert.equal(snapshot.coverageState, "complete");
    assert.equal((snapshot.resources as unknown[]).length, 13);
    assert.equal((snapshot.findings as unknown[]).length, 11);
    assert.match(snapshot.snapshotSha256 as string, /^[a-f0-9]{64}$/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixture API rejects unknown fields after authenticating the request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-server-"));
  const sharedSecret = randomBytes(32).toString("base64url");
  const server = createLocalCollectorServer({
    sharedSecret,
    registryEncryptionKey: randomBytes(32).toString("base64url"),
    registryPath: join(directory, "registry.enc"),
    mode: "fixture",
    now: () => NOW,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await signedRequest(
      `http://127.0.0.1:${port}`,
      sharedSecret,
      "POST",
      `/v1/connections/${CONNECTION_ID}/sync`,
      {
        tenantId: TENANT_ID,
        connectionId: CONNECTION_ID,
        jobId: "sync_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        externalId: "must-not-be-accepted",
      },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(response.value, {
      code: "INVALID_REQUEST",
      message: "The collector request is invalid",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

async function signedRequest(
  baseUrl: string,
  sharedSecret: string,
  method: "GET" | "PUT" | "POST",
  path: string,
  payload?: unknown,
): Promise<{ readonly status: number; readonly value: unknown }> {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const timestamp = NOW.getTime().toString();
  const nonce = `nonce_${randomBytes(18).toString("base64url")}`;
  const signature = hmac(
    sharedSecret,
    `${method}\n${path}\n${timestamp}\n${nonce}\n${sha256(body)}`,
  );
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "x-sutra-timestamp": timestamp,
      "x-sutra-nonce": nonce,
      "x-sutra-signature": signature,
      ...(body.length === 0 ? {} : { "content-type": "application/json" }),
    },
    ...(body.length === 0 ? {} : { body }),
  });
  const responseText = await response.text();
  assert.equal(
    response.headers.get("x-sutra-response-signature"),
    hmac(sharedSecret, `${response.status}\n${path}\n${nonce}\n${sha256(responseText)}`),
  );
  return { status: response.status, value: JSON.parse(responseText) as unknown };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(secret: string, value: string): string {
  return createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(value, "utf8")
    .digest("hex");
}

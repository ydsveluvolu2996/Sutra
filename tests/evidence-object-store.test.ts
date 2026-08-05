import assert from "node:assert/strict";
import test from "node:test";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  createRuntimeEvidenceObjectStore,
  EvidenceObjectStoreError,
  MAX_EVIDENCE_OBJECT_BYTES,
  S3EvidenceObjectStore,
} from "../lib/evidence-object-store.ts";

const KEY = `evidence/v1/${"a".repeat(64)}`;
const KMS = "arn:aws:kms:ap-south-1:123456789012:key/12345678-1234-1234-1234-123456789abc";

async function sha256Hex(body: Uint8Array): Promise<string> {
  const exact = new Uint8Array(body.byteLength);
  exact.set(body);
  return Buffer.from(await crypto.subtle.digest("SHA-256", exact.buffer)).toString("hex");
}

test("S3 evidence writes are immutable, checksummed, and SSE-KMS encrypted", async () => {
  const body = new TextEncoder().encode('{"evidence":true}');
  const digest = await sha256Hex(body);
  let command: unknown;
  const store = new S3EvidenceObjectStore({
    bucket: "sutra-private-evidence",
    kmsKeyArn: KMS,
    client: { async send(value) { command = value; return {}; } },
  });
  await store.putImmutable({
    objectKey: KEY,
    body,
    contentType: "application/json",
    contentSha256: digest,
  });
  assert.ok(command instanceof PutObjectCommand);
  assert.equal(command.input.Key, KEY);
  assert.equal(command.input.IfNoneMatch, "*");
  assert.equal(command.input.ServerSideEncryption, "aws:kms");
  assert.equal(command.input.SSEKMSKeyId, KMS);
  assert.equal(command.input.ChecksumAlgorithm, "SHA256");
  assert.equal(command.input.ChecksumSHA256, Buffer.from(digest, "hex").toString("base64"));
  assert.equal(command.input.Metadata?.["sutra-content-sha256"], digest);
});

test("S3 evidence verifies the locally computed returned-body digest", async () => {
  const expected = new TextEncoder().encode("expected");
  const tampered = new TextEncoder().encode("tampered");
  const digest = await sha256Hex(expected);
  const store = new S3EvidenceObjectStore({
    bucket: "sutra-private-evidence",
    kmsKeyArn: KMS,
    client: {
      async send(command) {
        assert.ok(command instanceof GetObjectCommand);
        return {
          Body: { async transformToByteArray() { return tampered; } },
          ContentLength: expected.byteLength,
          ContentType: "application/json",
          // A dishonest or stale S3 header must not be trusted over bytes.
          ChecksumSHA256: Buffer.from(digest, "hex").toString("base64"),
        };
      },
    },
  });
  await assert.rejects(
    store.getVerified({
      objectKey: KEY,
      contentType: "application/json",
      contentSha256: digest,
      byteSize: expected.byteLength,
    }),
    (error) => error instanceof EvidenceObjectStoreError && error.code === "OBJECT_CONFLICT",
  );
});

test("managed runtime fails closed and evidence size matches the signed broker ceiling", () => {
  assert.equal(MAX_EVIDENCE_OBJECT_BYTES, 12 * 1024 * 1024);
  assert.equal(createRuntimeEvidenceObjectStore({
    SUTRA_DEPLOYMENT_ENV: "local",
    SUTRA_EVIDENCE_BACKEND: "local",
  }), null);
  assert.throws(
    () => createRuntimeEvidenceObjectStore({
      SUTRA_DEPLOYMENT_ENV: "production",
      SUTRA_HOSTED_ENABLED: "true",
    }),
    (error) => error instanceof EvidenceObjectStoreError &&
      error.code === "INVALID_CONFIGURATION",
  );
});

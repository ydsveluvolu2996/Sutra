import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  GetObjectCommand,
  GetObjectCommandOutput,
} from "@aws-sdk/client-s3";

import {
  FINOPS_EXPORT_CHUNK_MAX_BYTES,
  FinopsExportChunkError,
  parseFinopsExportChunkRequest,
  readFinopsExportChunk,
  type FinopsExportChunkClient,
  type FinopsExportChunkRequest,
} from "../src/finops-export-chunk.js";
import type { AwsTemporaryCredentials } from "../src/types.js";

const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const VALID = {
  tenantId: "org_finops",
  connectionId: CONNECTION_ID,
  jobId: "job_finops_1",
  contractId: "foundational-cur2-export-v1",
  exportName: "foundational",
  region: "us-east-1",
  bucket: "customer-billing-export",
  prefix: "sutra/cur2/foundational/",
  key: "sutra/cur2/foundational/data/BILLING_PERIOD=2026-07/part.csv.gz",
  offset: 0,
  maximumBytes: 8,
  versionId: null,
  ifMatch: null,
} as const;

const CREDENTIALS: AwsTemporaryCredentials = {
  accessKeyId: "ASIAFINOPS",
  secretAccessKey: "must-not-escape",
  sessionToken: "must-not-escape-either",
  expiration: new Date("2099-01-01T00:00:00.000Z"),
};

function body(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function output(
  value: Omit<GetObjectCommandOutput, "Body"> & { readonly Body: unknown },
): GetObjectCommandOutput {
  return value as unknown as GetObjectCommandOutput;
}

class Client implements FinopsExportChunkClient {
  public readonly inputs: GetObjectCommand["input"][] = [];
  public readonly signals: AbortSignal[] = [];

  public constructor(private readonly output: GetObjectCommandOutput) {}

  public async send(
    command: GetObjectCommand,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<GetObjectCommandOutput> {
    this.inputs.push(command.input);
    this.signals.push(options.abortSignal);
    return this.output;
  }
}

function parsed(overrides: Partial<FinopsExportChunkRequest> = {}) {
  const candidate = { ...VALID, ...overrides };
  return parseFinopsExportChunkRequest(
    JSON.stringify(candidate),
    CONNECTION_ID,
  );
}

test("the broker reads only one exact range and returns hashed safe bytes", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const client = new Client(output({
    $metadata: {},
    ContentRange: "bytes 0-4/5",
    ContentLength: 5,
    ETag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    VersionId: "version-1",
    Body: body([bytes.slice(0, 2), bytes.slice(2)]),
  }));
  const result = await readFinopsExportChunk(
    parsed(),
    CREDENTIALS,
    () => client,
  );
  assert.deepEqual(client.inputs, [{
    Bucket: VALID.bucket,
    Key: VALID.key,
    Range: "bytes=0-7",
  }]);
  assert.equal(result.totalBytes, 5);
  assert.equal(result.bytesRead, 5);
  assert.equal(result.complete, true);
  assert.equal(result.bodyBase64, Buffer.from(bytes).toString("base64"));
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(CREDENTIALS.accessKeyId), false);
  assert.equal(serialized.includes(CREDENTIALS.secretAccessKey), false);
  assert.equal(serialized.includes(CREDENTIALS.sessionToken), false);
});

test("subsequent ranges are pinned to one immutable S3 identity", async () => {
  const client = new Client(output({
    $metadata: {},
    ContentRange: "bytes 4-7/12",
    ContentLength: 4,
    ETag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    Body: body([new Uint8Array([5, 6, 7, 8])]),
  }));
  await readFinopsExportChunk(
    parsed({
      offset: 4,
      maximumBytes: 4,
      ifMatch: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    }),
    CREDENTIALS,
    () => client,
  );
  assert.deepEqual(client.inputs[0], {
    Bucket: VALID.bucket,
    Key: VALID.key,
    Range: "bytes=4-7",
    IfMatch: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
  });
});

test("malformed scope, traversal, extra fields, and oversized ranges fail before S3", () => {
  const candidates = [
    { ...VALID, tenantId: "bad tenant" },
    { ...VALID, connectionId: `conn_${"b".repeat(32)}` },
    { ...VALID, key: `${VALID.prefix}../secret` },
    { ...VALID, key: `${VALID.prefix}%2e%2e/secret` },
    { ...VALID, maximumBytes: FINOPS_EXPORT_CHUNK_MAX_BYTES + 1 },
    { ...VALID, versionId: "version-1", ifMatch: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' },
    { ...VALID, credential: "attacker" },
  ];
  for (const candidate of candidates) {
    assert.throws(
      () => parseFinopsExportChunkRequest(
        JSON.stringify(candidate),
        CONNECTION_ID,
      ),
      (error: unknown) =>
        error instanceof FinopsExportChunkError
        && error.code === "INVALID_REQUEST",
    );
  }
});

test("declared and streamed range overruns are rejected and aborted", async () => {
  const declared = new Client(output({
    $metadata: {},
    ContentRange: "bytes 0-8/20",
    ContentLength: 9,
    ETag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    Body: body([new Uint8Array(9)]),
  }));
  await assert.rejects(
    readFinopsExportChunk(parsed(), CREDENTIALS, () => declared),
    (error: unknown) =>
      error instanceof FinopsExportChunkError
      && error.code === "OBJECT_RESPONSE_INVALID",
  );
  assert.equal(declared.signals[0]?.aborted, true);

  const streamed = new Client(output({
    $metadata: {},
    ContentRange: "bytes 0-7/20",
    ContentLength: 8,
    ETag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    Body: body([new Uint8Array(5), new Uint8Array(5)]),
  }));
  await assert.rejects(
    readFinopsExportChunk(parsed(), CREDENTIALS, () => streamed),
    (error: unknown) =>
      error instanceof FinopsExportChunkError
      && error.code === "OBJECT_RANGE_LIMIT_EXCEEDED",
  );
  assert.equal(streamed.signals[0]?.aborted, true);
});

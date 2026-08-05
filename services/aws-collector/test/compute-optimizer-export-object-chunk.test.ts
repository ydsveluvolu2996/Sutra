import assert from "node:assert/strict";
import { test } from "node:test";
import type { GetObjectCommand, GetObjectCommandOutput } from "@aws-sdk/client-s3";

import {
  COMPUTE_OPTIMIZER_EXPORT_OBJECT_CHUNK_MAX_BYTES,
  ComputeOptimizerExportObjectChunkError,
  parseComputeOptimizerExportObjectChunkRequest,
  readComputeOptimizerExportObjectChunk,
  type ComputeOptimizerExportObjectChunkClient,
  type ComputeOptimizerExportObjectChunkRequest,
} from "../src/compute-optimizer-export-object-chunk.js";
import type { AwsTemporaryCredentials } from "../src/types.js";

const REQUEST = {
  tenantId: "tenant-object",
  connectionId: `conn_${"a".repeat(32)}`,
  jobId: "materialize-job",
  contractId: "co-object-use1-ec2",
  plannedJobId: "12345678-abcd-4321-aaaa-123456789012",
  region: "us-east-1",
  bucket: "customer-compute-optimizer-use1",
  key: "ec2-instance-recommendations/compute-optimizer/123456789012/" +
    "us-east-1-2026-08-02T000000Z-12345678-abcd-4321-aaaa-123456789012.csv",
  offset: 0,
  maximumBytes: 8,
  versionId: null,
  ifMatch: null,
} as const;

const CREDENTIALS: AwsTemporaryCredentials = {
  accessKeyId: "ASIAOBJECT",
  secretAccessKey: "never-return-this-secret",
  sessionToken: "never-return-this-token",
  expiration: new Date("2099-01-01T00:00:00.000Z"),
};

function stream(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  return { async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } };
}

function output(value: Omit<GetObjectCommandOutput, "Body"> & {
  readonly Body: unknown;
}): GetObjectCommandOutput {
  return value as unknown as GetObjectCommandOutput;
}

class Client implements ComputeOptimizerExportObjectChunkClient {
  public readonly inputs: GetObjectCommand["input"][] = [];
  public readonly signals: AbortSignal[] = [];
  public constructor(private readonly response: GetObjectCommandOutput | Error) {}
  public async send(
    command: GetObjectCommand,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<GetObjectCommandOutput> {
    this.inputs.push(command.input);
    this.signals.push(options.abortSignal);
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
}

function parsed(overrides: Partial<ComputeOptimizerExportObjectChunkRequest> = {}) {
  const candidate = { ...REQUEST, ...overrides };
  return parseComputeOptimizerExportObjectChunkRequest(
    JSON.stringify(candidate),
    REQUEST.connectionId,
  );
}

test("first range is current-only and returns a version-pinned exact identity", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const client = new Client(output({
    $metadata: {},
    ContentRange: "bytes 0-4/5",
    ContentLength: 5,
    ETag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    VersionId: "version-1",
    Body: stream([bytes.slice(0, 2), bytes.slice(2)]),
  }));
  const result = await readComputeOptimizerExportObjectChunk(
    parsed(), CREDENTIALS, () => client,
  );
  assert.deepEqual(client.inputs, [{
    Bucket: REQUEST.bucket,
    Key: REQUEST.key,
    Range: "bytes=0-7",
  }]);
  assert.deepEqual(result.identity, {
    kind: "VERSION",
    versionId: "version-1",
    eTag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
  });
  assert.equal(result.complete, true);
  assert.equal(result.bodyBase64, Buffer.from(bytes).toString("base64"));
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(CREDENTIALS.accessKeyId), false);
  assert.equal(serialized.includes(CREDENTIALS.secretAccessKey), false);
  assert.equal(serialized.includes(CREDENTIALS.sessionToken), false);
});

test("later ranges use exactly the returned version or nonversioned ETag", async () => {
  const versioned = new Client(output({
    $metadata: {}, ContentRange: "bytes 4-7/12", ContentLength: 4,
    VersionId: "version-1", ETag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    Body: stream([new Uint8Array([5, 6, 7, 8])]),
  }));
  await readComputeOptimizerExportObjectChunk(parsed({
    offset: 4, maximumBytes: 4, versionId: "version-1",
  }), CREDENTIALS, () => versioned);
  assert.deepEqual(versioned.inputs[0], {
    Bucket: REQUEST.bucket,
    Key: REQUEST.key,
    Range: "bytes=4-7",
    VersionId: "version-1",
  });

  const etag = '"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"';
  const nonversioned = new Client(output({
    $metadata: {}, ContentRange: "bytes 4-7/12", ContentLength: 4,
    ETag: etag, Body: stream([new Uint8Array([5, 6, 7, 8])]),
  }));
  const result = await readComputeOptimizerExportObjectChunk(parsed({
    offset: 4, maximumBytes: 4, ifMatch: etag,
  }), CREDENTIALS, () => nonversioned);
  assert.equal(nonversioned.inputs[0]?.IfMatch, etag);
  assert.deepEqual(result.identity, { kind: "ETAG", versionId: null, eTag: etag });
});

test("parser rejects substitution, ambiguous identity, traversal and range widening", () => {
  for (const candidate of [
    { ...REQUEST, connectionId: "other-connection" },
    { ...REQUEST, connectionId: `conn_${"g".repeat(32)}` },
    { ...REQUEST, plannedJobId: "bad/job" },
    { ...REQUEST, key: `${REQUEST.key}/../neighbor` },
    { ...REQUEST, key: REQUEST.key.replace("compute-optimizer", "compute%2foptimizer") },
    { ...REQUEST, offset: 0, versionId: "version-1" },
    { ...REQUEST, offset: 1, versionId: null, ifMatch: null },
    { ...REQUEST, offset: 1, versionId: "version-1", ifMatch: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' },
    { ...REQUEST, maximumBytes: COMPUTE_OPTIMIZER_EXPORT_OBJECT_CHUNK_MAX_BYTES + 1 },
    { ...REQUEST, credentials: CREDENTIALS },
  ]) assert.throws(
    () => parseComputeOptimizerExportObjectChunkRequest(
      JSON.stringify(candidate), REQUEST.connectionId,
    ),
    (error: unknown) => error instanceof ComputeOptimizerExportObjectChunkError &&
      error.code === "INVALID_REQUEST",
  );
});

test("detects provider mutation, version substitution and malformed response identity", async () => {
  const changed = Object.assign(new Error("changed"), { name: "PreconditionFailed" });
  await assert.rejects(
    readComputeOptimizerExportObjectChunk(parsed({
      offset: 4,
      maximumBytes: 4,
      ifMatch: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    }), CREDENTIALS, () => new Client(changed)),
    (error: unknown) => error instanceof ComputeOptimizerExportObjectChunkError &&
      error.code === "OBJECT_CHANGED",
  );
  const substituted = new Client(output({
    $metadata: {}, ContentRange: "bytes 4-7/12", ContentLength: 4,
    VersionId: "other-version", Body: stream([new Uint8Array(4)]),
  }));
  await assert.rejects(
    readComputeOptimizerExportObjectChunk(parsed({
      offset: 4, maximumBytes: 4, versionId: "version-1",
    }), CREDENTIALS, () => substituted),
    (error: unknown) => error instanceof ComputeOptimizerExportObjectChunkError &&
      error.code === "OBJECT_CHANGED",
  );
  const malformedIdentity = new Client(output({
    $metadata: {}, ContentRange: "bytes 0-3/8", ContentLength: 4,
    VersionId: "bad version", ETag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    Body: stream([new Uint8Array(4)]),
  }));
  await assert.rejects(
    readComputeOptimizerExportObjectChunk(parsed({ maximumBytes: 4 }),
      CREDENTIALS, () => malformedIdentity),
    (error: unknown) => error instanceof ComputeOptimizerExportObjectChunkError &&
      error.code === "OBJECT_RESPONSE_INVALID",
  );
});

test("aborts streamed overrun and hard-times an uncooperative S3 read", async () => {
  const overrun = new Client(output({
    $metadata: {}, ContentRange: "bytes 0-7/20", ContentLength: 8,
    ETag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    Body: stream([new Uint8Array(5), new Uint8Array(5)]),
  }));
  await assert.rejects(
    readComputeOptimizerExportObjectChunk(parsed(), CREDENTIALS, () => overrun),
    (error: unknown) => error instanceof ComputeOptimizerExportObjectChunkError &&
      error.code === "OBJECT_RANGE_LIMIT_EXCEEDED",
  );
  assert.equal(overrun.signals[0]?.aborted, true);

  let timeoutSignal: AbortSignal | undefined;
  const stalled: ComputeOptimizerExportObjectChunkClient = {
    send: async (_command, options) => {
      void _command;
      timeoutSignal = options.abortSignal;
      return new Promise<GetObjectCommandOutput>(() => undefined);
    },
  };
  await assert.rejects(
    readComputeOptimizerExportObjectChunk(parsed(), CREDENTIALS, () => stalled, 5),
    (error: unknown) => error instanceof ComputeOptimizerExportObjectChunkError &&
      error.code === "OBJECT_READ_TIMEOUT",
  );
  assert.equal(timeoutSignal?.aborted, true);
});

test("parser accepts AWS, China, and GovCloud regional forms", () => {
  for (const region of ["us-east-1", "cn-north-1", "us-gov-west-1"]) {
    assert.equal(parsed({ region }).region, region);
  }
});

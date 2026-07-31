import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { describe, it } from "node:test";
import {
  GetObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  createFinopsGzipDecompressor,
  createFinopsS3ObjectReader,
  createFinopsS3Runtime,
  FinopsS3RuntimeError,
  type FinopsS3GetObjectClient,
  type FinopsS3GetObjectOutput,
} from "../lib/finops-s3-runtime.ts";

const SCOPE = {
  orgId: "org_runtime",
  customerId: "customer_runtime",
  connectionId: `conn_${"a".repeat(32)}`,
} as const;
const BUCKET = "sutra-customer-billing";
const PREFIX = "exports/aws-cur/data/";
const KEY = `${PREFIX}BILLING_PERIOD=2026-07/part-00001.csv.gz`;
const SDK_CLIENT_IS_STRUCTURALLY_COMPATIBLE:
  S3Client extends FinopsS3GetObjectClient ? true : false = true;

interface ClientCall {
  readonly command: GetObjectCommand;
  readonly signal: AbortSignal;
}

class FakeS3Client implements FinopsS3GetObjectClient {
  public readonly calls: ClientCall[] = [];
  private readonly output: () => Promise<FinopsS3GetObjectOutput>;

  public constructor(
    output: () => Promise<FinopsS3GetObjectOutput>,
  ) {
    this.output = output;
  }

  public async send(
    command: GetObjectCommand,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<FinopsS3GetObjectOutput> {
    this.calls.push({ command, signal: options.abortSignal });
    return this.output();
  }
}

function asyncBody(
  chunks: readonly unknown[],
  controls: {
    returned?: boolean;
    throwAt?: number;
  } = {},
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next(): Promise<IteratorResult<unknown>> {
          if (controls.throwAt === index) throw new Error("stream failed");
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = chunks[index];
          index += 1;
          return { done: false, value };
        },
        async return(): Promise<IteratorResult<unknown>> {
          controls.returned = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function runtimeFailure(code: FinopsS3RuntimeError["code"]) {
  return (error: unknown): boolean =>
    error instanceof FinopsS3RuntimeError && error.code === code;
}

function readRequest(maximumCompressedBytes = 1_024) {
  return {
    scope: SCOPE,
    bucket: BUCKET,
    key: KEY,
    maximumCompressedBytes,
  };
}

describe("production FinOps S3 runtime", () => {
  it("reads the exact GetObject address and decompresses valid gzip incrementally", async () => {
    assert.equal(SDK_CLIENT_IS_STRUCTURALLY_COMPATIBLE, true);
    const plaintext = new TextEncoder().encode("canonical billing evidence");
    const compressed = new Uint8Array(gzipSync(plaintext));
    const midpoint = Math.floor(compressed.byteLength / 2);
    const client = new FakeS3Client(async () => ({
      ContentLength: compressed.byteLength,
      Body: asyncBody([
        compressed.slice(0, midpoint),
        compressed.slice(midpoint),
      ]),
    }));
    const runtime = createFinopsS3Runtime({
      client,
      scope: SCOPE,
      bucket: BUCKET,
      prefix: PREFIX,
    });

    const read = await runtime.readObject(
      readRequest(compressed.byteLength),
    );
    assert.deepEqual(read, compressed);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0]?.command instanceof GetObjectCommand, true);
    assert.deepEqual(client.calls[0]?.command.input, {
      Bucket: BUCKET,
      Key: KEY,
    });
    assert.deepEqual(
      Object.keys(client.calls[0]?.command.input ?? {}).sort(),
      ["Bucket", "Key"],
    );
    assert.equal(client.calls[0]?.signal.aborted, false);

    const uncompressed = await runtime.decompressGzip({
      scope: SCOPE,
      object: { bucket: BUCKET, key: KEY },
      compressed: read,
      maximumOutputBytes: plaintext.byteLength,
    });
    assert.deepEqual(uncompressed, plaintext);
  });

  it("rejects wrong scope, bucket, and exact-prefix addresses before S3", async () => {
    const client = new FakeS3Client(async () => ({
      Body: asyncBody([new Uint8Array([1])]),
    }));
    const reader = createFinopsS3ObjectReader({
      client,
      scope: SCOPE,
      bucket: BUCKET,
      prefix: PREFIX,
    });
    await assert.rejects(
      reader({
        ...readRequest(),
        scope: { ...SCOPE, customerId: "customer_attacker" },
      }),
      runtimeFailure("REQUEST_SCOPE_MISMATCH"),
    );
    await assert.rejects(
      reader({ ...readRequest(), bucket: "attacker-bucket" }),
      runtimeFailure("REQUEST_BUCKET_MISMATCH"),
    );
    await assert.rejects(
      reader({
        ...readRequest(),
        key: "exports/aws-cur/data-archive/part.csv.gz",
      }),
      runtimeFailure("REQUEST_PREFIX_MISMATCH"),
    );
    await assert.rejects(
      reader({ ...readRequest(), key: PREFIX }),
      runtimeFailure("REQUEST_PREFIX_MISMATCH"),
    );
    await assert.rejects(
      reader({ ...readRequest(), key: `${PREFIX}../attacker.csv.gz` }),
      runtimeFailure("REQUEST_PREFIX_MISMATCH"),
    );
    await assert.rejects(
      reader({ ...readRequest(), key: `${PREFIX}nested\\attacker.csv.gz` }),
      runtimeFailure("REQUEST_PREFIX_MISMATCH"),
    );
    assert.equal(client.calls.length, 0);

    const decompressor = createFinopsGzipDecompressor({
      scope: SCOPE,
      bucket: BUCKET,
      prefix: PREFIX,
    });
    await assert.rejects(
      decompressor({
        scope: { ...SCOPE, orgId: "org_attacker" },
        object: { bucket: BUCKET, key: KEY },
        compressed: new Uint8Array([0x1f, 0x8b]),
        maximumOutputBytes: 10,
      }),
      runtimeFailure("REQUEST_SCOPE_MISMATCH"),
    );
  });

  it("rejects unsafe runtime bucket and prefix configuration", () => {
    const client = new FakeS3Client(async () => ({
      Body: asyncBody([new Uint8Array([1])]),
    }));
    for (const configuration of [
      { bucket: "192.168.0.1", prefix: PREFIX },
      { bucket: "invalid..bucket", prefix: PREFIX },
      { bucket: BUCKET, prefix: "exports/aws-cur/../attacker/" },
      { bucket: BUCKET, prefix: "exports\\aws-cur\\data/" },
      { bucket: BUCKET, prefix: "exports/aws-cur/data" },
    ]) {
      assert.throws(
        () => createFinopsS3ObjectReader({
          client,
          scope: SCOPE,
          ...configuration,
        }),
        runtimeFailure("INVALID_CONFIGURATION"),
      );
    }
  });

  it("aborts oversized S3 bodies before appending beyond the ceiling", async () => {
    const controls: { returned?: boolean } = {};
    const client = new FakeS3Client(async () => ({
      Body: asyncBody([
        new Uint8Array([1, 2, 3, 4, 5]),
        new Uint8Array([6, 7, 8, 9, 10]),
      ], controls),
    }));
    const reader = createFinopsS3ObjectReader({
      client,
      scope: SCOPE,
      bucket: BUCKET,
      prefix: PREFIX,
    });
    await assert.rejects(
      reader(readRequest(8)),
      runtimeFailure("COMPRESSED_LIMIT_EXCEEDED"),
    );
    assert.equal(client.calls[0]?.signal.aborted, true);
    assert.equal(controls.returned, true);

    const declared = new FakeS3Client(async () => ({
      ContentLength: 9,
      Body: asyncBody([new Uint8Array(9)]),
    }));
    const declaredReader = createFinopsS3ObjectReader({
      client: declared,
      scope: SCOPE,
      bucket: BUCKET,
      prefix: PREFIX,
    });
    await assert.rejects(
      declaredReader(readRequest(8)),
      runtimeFailure("COMPRESSED_LIMIT_EXCEEDED"),
    );
    assert.equal(declared.calls[0]?.signal.aborted, true);
  });

  it("rejects missing, non-stream, malformed-chunk, and failing S3 bodies", async () => {
    const cases: readonly {
      readonly output: () => Promise<FinopsS3GetObjectOutput>;
      readonly code: FinopsS3RuntimeError["code"];
    }[] = [
      {
        output: async () => ({}),
        code: "MISSING_STREAM_BODY",
      },
      {
        output: async () => ({ Body: new Uint8Array([1, 2]) }),
        code: "INVALID_STREAM_BODY",
      },
      {
        output: async () => ({ Body: asyncBody(["not-bytes"]) }),
        code: "INVALID_STREAM_BODY",
      },
      {
        output: async () => ({
          Body: asyncBody([new Uint8Array([1])], { throwAt: 1 }),
        }),
        code: "COMPRESSED_STREAM_FAILED",
      },
    ];
    for (const entry of cases) {
      const client = new FakeS3Client(entry.output);
      const reader = createFinopsS3ObjectReader({
        client,
        scope: SCOPE,
        bucket: BUCKET,
        prefix: PREFIX,
      });
      await assert.rejects(
        reader(readRequest()),
        runtimeFailure(entry.code),
        entry.code,
      );
    }
  });

  it("stops gzip bombs and rejects invalid or corrupt gzip evidence", async () => {
    const decompressor = createFinopsGzipDecompressor({
      scope: SCOPE,
      bucket: BUCKET,
      prefix: PREFIX,
    });
    const bomb = new Uint8Array(gzipSync("a".repeat(50_000)));
    await assert.rejects(
      decompressor({
        scope: SCOPE,
        object: { bucket: BUCKET, key: KEY },
        compressed: bomb,
        maximumOutputBytes: 100,
      }),
      runtimeFailure("UNCOMPRESSED_LIMIT_EXCEEDED"),
    );
    await assert.rejects(
      decompressor({
        scope: SCOPE,
        object: { bucket: BUCKET, key: KEY },
        compressed: new Uint8Array([1, 2, 3]),
        maximumOutputBytes: 100,
      }),
      runtimeFailure("INVALID_GZIP"),
    );
    await assert.rejects(
      decompressor({
        scope: SCOPE,
        object: { bucket: BUCKET, key: KEY },
        compressed: new Uint8Array([0x1f, 0x8b, 0, 0, 0, 0]),
        maximumOutputBytes: 100,
      }),
      runtimeFailure("DECOMPRESSION_FAILED"),
    );
  });
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  ComputeOptimizerExportObjectReaderError,
  createComputeOptimizerExportObjectReader,
  type ComputeOptimizerExportObjectBoundary,
  type ComputeOptimizerExportObjectChunkTransport,
} from "../lib/finops-compute-optimizer-export-object-reader.ts";
import type {
  ComputeOptimizerExportObjectChunkRequest,
} from "../services/aws-collector/src/compute-optimizer-export-object-chunk.ts";

const CHUNK_BYTES = 4 * 1_024 * 1_024;
const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const ETAG = '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"';
const CSV_KEY = "ec2-instance-recommendations/compute-optimizer/123456789012/" +
  "us-east-1-2026-08-02T000000Z-12345678-abcd-4321-aaaa-123456789012.csv";
const METADATA_KEY = CSV_KEY.replace(/\.csv$/u, "-metadata.json");

function boundary(key: string): ComputeOptimizerExportObjectBoundary {
  return {
    tenantId: "tenant-object-reader",
    connectionId: CONNECTION_ID,
    jobId: "materialize-job",
    contractId: "co-object-use1-ec2",
    plannedJobId: "12345678-abcd-4321-aaaa-123456789012",
    region: "us-east-1",
    bucket: "customer-compute-optimizer-use1",
    key,
  };
}

function response(
  request: ComputeOptimizerExportObjectChunkRequest,
  bytes: Uint8Array,
  input: {
    readonly totalBytes: number;
    readonly complete: boolean;
    readonly versionId?: string | null;
    readonly eTag?: string;
  },
): Record<string, unknown> {
  return {
    schema: "sutra.compute-optimizer-export-object-chunk.v1",
    tenantId: request.tenantId,
    connectionId: request.connectionId,
    jobId: request.jobId,
    contractId: request.contractId,
    plannedJobId: request.plannedJobId,
    region: request.region,
    bucket: request.bucket,
    key: request.key,
    offset: request.offset,
    totalBytes: input.totalBytes,
    bytesRead: bytes.byteLength,
    complete: input.complete,
    identity: input.versionId === null
      ? { kind: "ETAG", versionId: null, eTag: input.eTag ?? ETAG }
      : {
          kind: "VERSION",
          versionId: input.versionId ?? "version-1",
          eTag: input.eTag ?? ETAG,
        },
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bodyBase64: Buffer.from(bytes).toString("base64"),
  };
}

class Transport implements ComputeOptimizerExportObjectChunkTransport {
  public readonly requests: ComputeOptimizerExportObjectChunkRequest[] = [];
  public readonly contexts: Array<{ readonly signal: AbortSignal; readonly deadlineAtMs: number }> = [];
  private readonly handler: (
    request: ComputeOptimizerExportObjectChunkRequest,
    index: number,
    signal: AbortSignal,
  ) => Promise<unknown> | unknown;

  public constructor(handler: (
    request: ComputeOptimizerExportObjectChunkRequest,
    index: number,
    signal: AbortSignal,
  ) => Promise<unknown> | unknown) {
    this.handler = handler;
  }

  public async readChunk(
    request: ComputeOptimizerExportObjectChunkRequest,
    context: { readonly signal: AbortSignal; readonly deadlineAtMs: number },
  ): Promise<unknown> {
    const index = this.requests.length;
    this.requests.push(request);
    this.contexts.push(context);
    return this.handler(request, index, context.signal);
  }
}

function failure(code: ComputeOptimizerExportObjectReaderError["code"]) {
  return (error: unknown): boolean =>
    error instanceof ComputeOptimizerExportObjectReaderError && error.code === code;
}

function read(
  reader: ReturnType<typeof createComputeOptimizerExportObjectReader>,
  key: string,
  maximumBytes: number,
  signal = new AbortController().signal,
) {
  return reader("us-east-1", "customer-compute-optimizer-use1", key, maximumBytes, signal);
}

describe("Compute Optimizer exact-object broker reader", () => {
  it("assembles exact CSV and metadata keys and pins VersionId or ETag after CURRENT", async () => {
    const csvTail = new Uint8Array([7, 8]);
    const metadata = new TextEncoder().encode('{"@context":"http://www.w3.org/ns/csvw"}');
    const transport = new Transport((request) => {
      if (request.key === CSV_KEY) {
        return request.offset === 0
          ? response(request, new Uint8Array(CHUNK_BYTES).fill(6), {
              totalBytes: CHUNK_BYTES + csvTail.byteLength,
              complete: false,
            })
          : response(request, csvTail, {
              totalBytes: CHUNK_BYTES + csvTail.byteLength,
              complete: true,
            });
      }
      return response(request, metadata, {
        totalBytes: metadata.byteLength,
        complete: true,
        versionId: null,
      });
    });
    const reader = createComputeOptimizerExportObjectReader(
      [boundary(CSV_KEY), boundary(METADATA_KEY)], transport,
    );
    const csv = await read(reader, CSV_KEY, CHUNK_BYTES + 16);
    const csvRequests = transport.requests.filter((request) => request.key === CSV_KEY);
    assert.equal(csv.bytes.byteLength, CHUNK_BYTES + 2);
    assert.deepEqual(csv.bytes.slice(-2), csvTail);
    assert.equal(csv.versionId, "version-1");
    assert.equal(csv.eTag, ETAG);
    assert.deepEqual(
      csvRequests.map(({ offset, versionId, ifMatch }) => ({ offset, versionId, ifMatch })),
      [
        { offset: 0, versionId: null, ifMatch: null },
        { offset: CHUNK_BYTES, versionId: "version-1", ifMatch: null },
      ],
    );

    const meta = await read(reader, METADATA_KEY, 1_024 * 1_024);
    assert.deepEqual(meta.bytes, metadata);
    assert.equal(meta.versionId, null);
    assert.equal(meta.eTag, ETAG);
    const metaRequest = transport.requests.find((request) => request.key === METADATA_KEY);
    assert.equal(metaRequest?.versionId, null);
    assert.equal(metaRequest?.ifMatch, null);
  });

  it("rejects unbound addresses and a non-canonical connection before transport", async () => {
    const transport = new Transport(() => { throw new Error("must not run"); });
    const reader = createComputeOptimizerExportObjectReader([boundary(CSV_KEY)], transport);
    await assert.rejects(
      read(reader, METADATA_KEY, 32),
      failure("ADDRESS_NOT_BOUND"),
    );
    assert.throws(
      () => createComputeOptimizerExportObjectReader([
        { ...boundary(CSV_KEY), connectionId: "conn-object" },
      ], transport),
      failure("INVALID_CONFIGURATION"),
    );
    assert.equal(transport.requests.length, 0);
  });

  it("rejects forged scope, extra/missing fields, offset, hash, and base64", async () => {
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => { value.tenantId = "tenant-attacker"; },
      (value) => { value.extra = true; },
      (value) => { delete value.contractId; },
      (value) => { value.offset = 1; },
      (value) => { value.sha256 = "0".repeat(64); },
      (value) => { value.bodyBase64 = "not_base64"; },
      (value) => { value.bytesRead = 0; value.bodyBase64 = ""; },
      (value) => { value.complete = false; },
    ];
    for (const mutate of mutations) {
      const transport = new Transport((request) => {
        const value = response(request, new Uint8Array([1]), {
          totalBytes: 1,
          complete: true,
        });
        mutate(value);
        return value;
      });
      const reader = createComputeOptimizerExportObjectReader([boundary(CSV_KEY)], transport);
      await assert.rejects(read(reader, CSV_KEY, 32), failure("BROKER_RESPONSE_INVALID"));
    }
  });

  it("rejects VersionId and ETag changes across otherwise valid chunks", async () => {
    for (const mutateSecond of [
      { versionId: "version-2", eTag: ETAG },
      { versionId: "version-1", eTag: '"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' },
    ]) {
      const transport = new Transport((request, index) => response(
        request,
        index === 0 ? new Uint8Array(CHUNK_BYTES) : new Uint8Array([1]),
        {
          totalBytes: CHUNK_BYTES + 1,
          complete: index === 1,
          ...(index === 1 ? mutateSecond : {}),
        },
      ));
      await assert.rejects(
        read(
          createComputeOptimizerExportObjectReader([boundary(CSV_KEY)], transport),
          CSV_KEY,
          CHUNK_BYTES + 1,
        ),
        failure("OBJECT_CHANGED"),
      );
    }
  });

  it("rejects declared objects over the caller's whole-object cap", async () => {
    const transport = new Transport((request) => response(request, new Uint8Array([1]), {
      totalBytes: 33,
      complete: false,
    }));
    await assert.rejects(
      read(
        createComputeOptimizerExportObjectReader([boundary(CSV_KEY)], transport),
        CSV_KEY,
        32,
      ),
      failure("BROKER_RESPONSE_INVALID"),
    );
  });

  it("hard-races an uncooperative transport on deadline and external abort", async () => {
    let deadlineSignal: AbortSignal | undefined;
    const stalled = new Transport((_request, _index, signal) => {
      deadlineSignal = signal;
      return new Promise(() => undefined);
    });
    const deadlineReader = createComputeOptimizerExportObjectReader(
      [boundary(CSV_KEY)], stalled, { deadlineAtMs: Date.now() + 10 },
    );
    await assert.rejects(read(deadlineReader, CSV_KEY, 32), failure("DEADLINE_EXCEEDED"));
    assert.equal(deadlineSignal?.aborted, true);

    let abortSignal: AbortSignal | undefined;
    const blocked = new Transport((_request, _index, signal) => {
      abortSignal = signal;
      return new Promise(() => undefined);
    });
    const controller = new AbortController();
    const pending = read(
      createComputeOptimizerExportObjectReader([boundary(CSV_KEY)], blocked),
      CSV_KEY,
      32,
      controller.signal,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, failure("ABORTED"));
    assert.equal(abortSignal?.aborted, true);
  });

  it("returns isolated bytes across repeated reads", async () => {
    const source = new Uint8Array([1, 2, 3]);
    const transport = new Transport((request) => response(request, source, {
      totalBytes: source.byteLength,
      complete: true,
      versionId: null,
    }));
    const reader = createComputeOptimizerExportObjectReader([boundary(CSV_KEY)], transport);
    const first = await read(reader, CSV_KEY, 32);
    first.bytes[0] = 99;
    const second = await read(reader, CSV_KEY, 32);
    assert.deepEqual(second.bytes, source);
    assert.notEqual(first.bytes.buffer, second.bytes.buffer);
  });
});

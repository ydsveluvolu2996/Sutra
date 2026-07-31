import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  createFinopsBrokerObjectReader,
  FinopsBrokerObjectReaderError,
  type FinopsBrokerChunkTransport,
} from "../lib/finops-broker-object-reader.ts";
import type { FinopsExportChunkRequest } from "../services/aws-collector/src/finops-export-chunk.ts";

const SCOPE = {
  orgId: "org_reader",
  customerId: "customer_reader",
  connectionId: `conn_${"a".repeat(32)}`,
} as const;
const BOUNDARY = {
  scope: SCOPE,
  jobId: `job_${"b".repeat(32)}`,
  contractId: "foundational-cur2-export-v1",
  exportName: "foundational",
  region: "us-east-1",
  bucket: "customer-billing-export",
  prefix: "sutra/cur2/foundational/",
} as const;
const KEY = `${BOUNDARY.prefix}data/BILLING_PERIOD=2026-07/part.csv.gz`;
const ETAG = '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"';

function response(
  request: FinopsExportChunkRequest,
  bytes: Uint8Array,
  input: {
    totalBytes: number;
    complete: boolean;
    eTag?: string | null;
    versionId?: string | null;
    sha256?: string;
  },
) {
  return {
    schema: "sutra.finops-export-chunk.v1",
    jobId: request.jobId,
    connectionId: request.connectionId,
    region: request.region,
    bucket: request.bucket,
    key: request.key,
    offset: request.offset,
    totalBytes: input.totalBytes,
    bytesRead: bytes.byteLength,
    complete: input.complete,
    eTag: input.eTag === undefined ? ETAG : input.eTag,
    versionId: input.versionId ?? null,
    sha256: input.sha256
      ?? createHash("sha256").update(bytes).digest("hex"),
    bodyBase64: Buffer.from(bytes).toString("base64"),
  };
}

class Transport implements FinopsBrokerChunkTransport {
  public readonly requests: FinopsExportChunkRequest[] = [];
  private readonly handler: (
    request: FinopsExportChunkRequest,
    index: number,
  ) => Promise<unknown> | unknown;

  public constructor(
    handler: (
      request: FinopsExportChunkRequest,
      index: number,
    ) => Promise<unknown> | unknown,
  ) {
    this.handler = handler;
  }

  public async readChunk(request: FinopsExportChunkRequest): Promise<unknown> {
    const index = this.requests.length;
    this.requests.push(request);
    return this.handler(request, index);
  }
}

function readRequest(overrides = {}) {
  return {
    scope: SCOPE,
    bucket: BOUNDARY.bucket,
    key: KEY,
    maximumCompressedBytes: 32,
    ...overrides,
  };
}

function failure(code: FinopsBrokerObjectReaderError["code"]) {
  return (error: unknown): boolean =>
    error instanceof FinopsBrokerObjectReaderError && error.code === code;
}

describe("authenticated broker FinOps object assembly", () => {
  it("assembles bounded hashed chunks and pins all later reads to the first ETag", async () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
    ];
    const transport = new Transport((request, index) =>
      response(request, chunks[index]!, {
        totalBytes: 5,
        complete: index === 1,
      }));
    const reader = createFinopsBrokerObjectReader(BOUNDARY, transport);
    const result = await reader(readRequest());
    assert.deepEqual(result.bytes, new Uint8Array([1, 2, 3, 4, 5]));
    assert.equal(result.totalBytes, 5);
    assert.equal(result.eTag, ETAG);
    assert.equal(transport.requests.length, 2);
    assert.equal(transport.requests[0]?.versionId, null);
    assert.equal(transport.requests[0]?.ifMatch, null);
    assert.equal(transport.requests[1]?.offset, 3);
    assert.equal(transport.requests[1]?.ifMatch, ETAG);
    assert.equal(transport.requests[1]?.versionId, null);
  });

  it("uses VersionId instead of ETag when S3 supplies one", async () => {
    const transport = new Transport((request, index) =>
      response(
        request,
        index === 0
          ? new Uint8Array([1, 2])
          : new Uint8Array([3]),
        {
          totalBytes: 3,
          complete: index === 1,
          eTag: ETAG,
          versionId: "version-1",
        },
      ));
    const reader = createFinopsBrokerObjectReader(BOUNDARY, transport);
    await reader(readRequest());
    assert.equal(transport.requests[1]?.versionId, "version-1");
    assert.equal(transport.requests[1]?.ifMatch, null);
  });

  it("rejects cross-tenant or out-of-prefix reads before transport", async () => {
    const transport = new Transport(() => {
      throw new Error("must not run");
    });
    const reader = createFinopsBrokerObjectReader(BOUNDARY, transport);
    await assert.rejects(
      reader(readRequest({
        scope: { ...SCOPE, customerId: "customer_attacker" },
      })),
      failure("REQUEST_SCOPE_MISMATCH"),
    );
    await assert.rejects(
      reader(readRequest({
        key: "sutra/cur2/attacker/part.csv.gz",
      })),
      failure("REQUEST_ADDRESS_MISMATCH"),
    );
    assert.equal(transport.requests.length, 0);
  });

  it("rejects oversized declarations, hash mismatch, and object identity drift", async () => {
    const oversized = new Transport((request) =>
      response(request, new Uint8Array([1]), {
        totalBytes: 33,
        complete: true,
      }));
    await assert.rejects(
      createFinopsBrokerObjectReader(BOUNDARY, oversized)(readRequest()),
      failure("BROKER_RESPONSE_INVALID"),
    );

    const badHash = new Transport((request) =>
      response(request, new Uint8Array([1]), {
        totalBytes: 1,
        complete: true,
        sha256: "0".repeat(64),
      }));
    await assert.rejects(
      createFinopsBrokerObjectReader(BOUNDARY, badHash)(readRequest()),
      failure("BROKER_RESPONSE_INVALID"),
    );

    const drift = new Transport((request, index) =>
      response(
        request,
        index === 0 ? new Uint8Array([1]) : new Uint8Array([2]),
        {
          totalBytes: 2,
          complete: index === 1,
          eTag: index === 0
            ? ETAG
            : '"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"',
        },
      ));
    await assert.rejects(
      createFinopsBrokerObjectReader(BOUNDARY, drift)(readRequest()),
      failure("OBJECT_CHANGED"),
    );
  });
});

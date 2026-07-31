/**
 * Authenticated app-side assembler for the broker's bounded FinOps S3 ranges.
 *
 * Each broker response is independently signed by the existing broker client
 * boundary before this module sees it. This layer additionally validates exact
 * scope/address/range identity, per-range SHA-256, stable object identity, and
 * the caller's whole-object byte ceiling.
 */
import { Buffer } from "node:buffer";
import type {
  FinopsExportChunkRequest,
  FinopsExportChunkResponse,
} from "../services/aws-collector/src/finops-export-chunk.ts";
import type {
  FoundationalFinopsContractId,
} from "../services/aws-collector/src/types.ts";
import type { FinopsBillingScope } from "../db/finops-billing-engine-repository.ts";
import type { FinopsS3ObjectReadRequest } from "./finops-s3-ingestion.ts";

const SHA256 = /^[a-f0-9]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/u;
const BUCKET =
  /^(?!\d+\.\d+\.\d+\.\d+$)(?!.*\.\.)(?=.{3,63}$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/u;
const MAX_OBJECT_BYTES = 2_147_483_647;
// Must remain <= the broker's exported FINOPS_EXPORT_CHUNK_MAX_BYTES. The
// collector contract test pins both values to 4 MiB.
const FINOPS_EXPORT_CHUNK_MAX_BYTES = 4 * 1_024 * 1_024;

export interface FinopsBrokerObjectBoundary {
  readonly scope: Readonly<FinopsBillingScope>;
  readonly jobId: string;
  readonly contractId: FoundationalFinopsContractId;
  readonly exportName: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
}

export interface FinopsBrokerObject {
  readonly bytes: Uint8Array;
  readonly eTag: string | null;
  readonly versionId: string | null;
  readonly totalBytes: number;
}

export interface FinopsBrokerChunkTransport {
  readChunk(
    request: FinopsExportChunkRequest,
  ): Promise<unknown>;
}

export class FinopsBrokerObjectReaderError extends Error {
  public readonly code:
    | "INVALID_CONFIGURATION"
    | "REQUEST_SCOPE_MISMATCH"
    | "REQUEST_ADDRESS_MISMATCH"
    | "INVALID_BYTE_LIMIT"
    | "BROKER_RESPONSE_INVALID"
    | "OBJECT_CHANGED"
    | "OBJECT_LIMIT_EXCEEDED";

  public constructor(code: FinopsBrokerObjectReaderError["code"]) {
    super("FinOps broker object read rejected");
    this.name = "FinopsBrokerObjectReaderError";
    this.code = code;
  }
}

function reject(code: FinopsBrokerObjectReaderError["code"]): never {
  throw new FinopsBrokerObjectReaderError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameScope(
  left: Readonly<FinopsBillingScope>,
  right: Readonly<FinopsBillingScope>,
): boolean {
  return left.orgId === right.orgId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId;
}

function validKey(value: unknown, trailingSlash = false): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 1_024
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("%")
    || value.includes("\0")
    || (trailingSlash && !value.endsWith("/"))
  ) return false;
  const parts = value.split("/");
  if (trailingSlash) parts.pop();
  return parts.length > 0
    && !parts.some((part) => part.length === 0 || part === "." || part === "..");
}

function validBoundary(value: FinopsBrokerObjectBoundary): boolean {
  return (
    isRecord(value)
    && isRecord(value.scope)
    && typeof value.scope.orgId === "string"
    && value.scope.orgId.length > 0
    && typeof value.scope.customerId === "string"
    && value.scope.customerId.length > 0
    && typeof value.scope.connectionId === "string"
    && /^conn_[a-f0-9]{32}$/u.test(value.scope.connectionId)
    && typeof value.jobId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u.test(value.jobId)
    && value.contractId === "foundational-cur2-export-v1"
    && typeof value.exportName === "string"
    && /^[0-9A-Za-z_-]{1,128}$/u.test(value.exportName)
    && REGION.test(value.region)
    && typeof value.bucket === "string"
    && BUCKET.test(value.bucket)
    && validKey(value.prefix, true)
    && value.prefix.endsWith(`/${value.exportName}/`)
  );
}

function exactResponse(value: unknown): value is FinopsExportChunkResponse {
  if (!isRecord(value)) return false;
  const expected = [
    "schema",
    "jobId",
    "connectionId",
    "region",
    "bucket",
    "key",
    "offset",
    "totalBytes",
    "bytesRead",
    "complete",
    "eTag",
    "versionId",
    "sha256",
    "bodyBase64",
  ].sort();
  return Object.keys(value).sort().every((key, index) => key === expected[index])
    && Object.keys(value).length === expected.length;
}

function decodeBase64(value: string): Uint8Array {
  if (!BASE64.test(value)) reject("BROKER_RESPONSE_INVALID");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) reject("BROKER_RESPONSE_INVALID");
  return new Uint8Array(decoded);
}

async function sha256(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function append(
  destination: Uint8Array,
  offset: number,
  source: Uint8Array,
): void {
  if (source.byteLength > destination.byteLength - offset) {
    reject("OBJECT_LIMIT_EXCEEDED");
  }
  destination.set(source, offset);
}

export function createFinopsBrokerObjectReader(
  boundary: FinopsBrokerObjectBoundary,
  transport: FinopsBrokerChunkTransport,
): (
  request: FinopsS3ObjectReadRequest,
) => Promise<FinopsBrokerObject> {
  if (
    !validBoundary(boundary)
    || !isRecord(transport)
    || typeof transport.readChunk !== "function"
  ) reject("INVALID_CONFIGURATION");
  const fixed = {
    scope: { ...boundary.scope },
    jobId: boundary.jobId,
    contractId: boundary.contractId,
    exportName: boundary.exportName,
    region: boundary.region,
    bucket: boundary.bucket,
    prefix: boundary.prefix,
  } as const;
  return async (request) => {
    if (!sameScope(fixed.scope, request.scope)) {
      reject("REQUEST_SCOPE_MISMATCH");
    }
    if (
      request.bucket !== fixed.bucket
      || !validKey(request.key)
      || request.key === fixed.prefix
      || !request.key.startsWith(fixed.prefix)
    ) reject("REQUEST_ADDRESS_MISMATCH");
    if (
      !Number.isSafeInteger(request.maximumCompressedBytes)
      || request.maximumCompressedBytes < 1
      || request.maximumCompressedBytes > MAX_OBJECT_BYTES
    ) reject("INVALID_BYTE_LIMIT");

    let offset = 0;
    let totalBytes: number | null = null;
    let eTag: string | null = null;
    let versionId: string | null = null;
    let destination: Uint8Array | null = null;
    const maximumChunks =
      Math.ceil(request.maximumCompressedBytes / FINOPS_EXPORT_CHUNK_MAX_BYTES) + 1;
    for (let index = 0; index < maximumChunks; index += 1) {
      const remaining = request.maximumCompressedBytes - offset;
      if (remaining <= 0) reject("OBJECT_LIMIT_EXCEEDED");
      const response = await transport.readChunk({
        tenantId: fixed.scope.orgId,
        connectionId: fixed.scope.connectionId,
        jobId: fixed.jobId,
        contractId: fixed.contractId,
        exportName: fixed.exportName,
        region: fixed.region,
        bucket: fixed.bucket,
        prefix: fixed.prefix,
        key: request.key,
        offset,
        maximumBytes: Math.min(
          FINOPS_EXPORT_CHUNK_MAX_BYTES,
          remaining,
        ),
        versionId,
        ifMatch: versionId === null ? eTag : null,
      });
      if (!exactResponse(response)) reject("BROKER_RESPONSE_INVALID");
      if (
        response.schema !== "sutra.finops-export-chunk.v1"
        || response.jobId !== fixed.jobId
        || response.connectionId !== fixed.scope.connectionId
        || response.region !== fixed.region
        || response.bucket !== fixed.bucket
        || response.key !== request.key
        || response.offset !== offset
        || !Number.isSafeInteger(response.totalBytes)
        || response.totalBytes < 1
        || response.totalBytes > request.maximumCompressedBytes
        || !Number.isSafeInteger(response.bytesRead)
        || response.bytesRead < 1
        || response.bytesRead > FINOPS_EXPORT_CHUNK_MAX_BYTES
        || typeof response.complete !== "boolean"
        || typeof response.sha256 !== "string"
        || !SHA256.test(response.sha256)
        || typeof response.bodyBase64 !== "string"
      ) reject("BROKER_RESPONSE_INVALID");
      if (totalBytes === null) {
        if (response.eTag === null && response.versionId === null) {
          reject("BROKER_RESPONSE_INVALID");
        }
        totalBytes = response.totalBytes;
        eTag = response.eTag;
        versionId = response.versionId;
        destination = new Uint8Array(totalBytes);
      } else if (
        response.totalBytes !== totalBytes
        || response.eTag !== eTag
        || response.versionId !== versionId
      ) reject("OBJECT_CHANGED");
      const bytes = decodeBase64(response.bodyBase64);
      if (
        bytes.byteLength !== response.bytesRead
        || await sha256(bytes) !== response.sha256
      ) reject("BROKER_RESPONSE_INVALID");
      append(destination!, offset, bytes);
      offset += bytes.byteLength;
      if (response.complete) {
        if (offset !== totalBytes) reject("BROKER_RESPONSE_INVALID");
        return {
          bytes: destination!,
          eTag,
          versionId,
          totalBytes,
        };
      }
      if (offset >= totalBytes) reject("BROKER_RESPONSE_INVALID");
    }
    reject("OBJECT_LIMIT_EXCEEDED");
  };
}

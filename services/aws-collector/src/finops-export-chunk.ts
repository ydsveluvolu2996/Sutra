/**
 * Broker-private, bounded S3 range reader for canonical AWS Data Exports.
 *
 * Temporary credentials enter only through the injected S3 client and never
 * appear in the response. The caller receives at most one small, hashed range;
 * larger objects must be assembled by the authenticated app client under its
 * own object-wide byte ceiling.
 */
import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";

import { workloadIdentityAwsClientConfig } from "./role-broker.js";
import type {
  AwsTemporaryCredentials,
  FoundationalFinopsContractId,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const BUCKET =
  /^(?!\d+\.\d+\.\d+\.\d+$)(?!.*\.\.)(?=.{3,63}$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/u;
const ETAG = /^(?:"[A-Fa-f0-9]{32,128}(?:-\d{1,8})?"|[A-Fa-f0-9]{32,128}(?:-\d{1,8})?)$/u;
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/u;
const EXPORT_NAME = /^[0-9A-Za-z_-]{1,128}$/u;
const MAX_KEY_BYTES = 1_024;
const MAX_VERSION_ID_BYTES = 1_024;
const MAX_OBJECT_OFFSET = 2_147_483_647;

/** Base64 keeps this comfortably below the broker's 12 MiB signed response cap. */
export const FINOPS_EXPORT_CHUNK_MAX_BYTES = 4 * 1_024 * 1_024;

export interface FinopsExportChunkRequest {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly jobId: string;
  readonly contractId: FoundationalFinopsContractId;
  readonly exportName: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly key: string;
  readonly offset: number;
  readonly maximumBytes: number;
  readonly versionId: string | null;
  readonly ifMatch: string | null;
}

export interface FinopsExportChunkResponse {
  readonly schema: "sutra.finops-export-chunk.v1";
  readonly jobId: string;
  readonly connectionId: string;
  readonly region: string;
  readonly bucket: string;
  readonly key: string;
  readonly offset: number;
  readonly totalBytes: number;
  readonly bytesRead: number;
  readonly complete: boolean;
  readonly eTag: string | null;
  readonly versionId: string | null;
  readonly sha256: string;
  readonly bodyBase64: string;
}

export interface FinopsExportChunkClient {
  send(
    command: GetObjectCommand,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<GetObjectCommandOutput>;
}

export type FinopsExportChunkClientFactory = (
  region: string,
  credentials: AwsTemporaryCredentials,
) => FinopsExportChunkClient;

export class FinopsExportChunkError extends Error {
  public readonly code:
    | "INVALID_REQUEST"
    | "OBJECT_READ_FAILED"
    | "OBJECT_CHANGED"
    | "OBJECT_RESPONSE_INVALID"
    | "OBJECT_RANGE_LIMIT_EXCEEDED";

  public constructor(code: FinopsExportChunkError["code"]) {
    super("FinOps export chunk request rejected");
    this.name = "FinopsExportChunkError";
    this.code = code;
  }
}

function reject(code: FinopsExportChunkError["code"]): never {
  throw new FinopsExportChunkError(code);
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maximum
    && !value.includes("\0");
}

function validKey(value: unknown, trailingSlash = false): value is string {
  if (
    !validText(value, MAX_KEY_BYTES)
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("%")
    || (trailingSlash && !value.endsWith("/"))
  ) return false;
  const parts = value.split("/");
  if (trailingSlash) parts.pop();
  return parts.length > 0
    && !parts.some((part) => part.length === 0 || part === "." || part === "..");
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

export function parseFinopsExportChunkRequest(
  body: string,
  pathConnectionId: string,
): FinopsExportChunkRequest {
  let candidate: unknown;
  try {
    candidate = JSON.parse(body) as unknown;
  } catch {
    return reject("INVALID_REQUEST");
  }
  const keys = [
    "tenantId",
    "connectionId",
    "jobId",
    "contractId",
    "exportName",
    "region",
    "bucket",
    "prefix",
    "key",
    "offset",
    "maximumBytes",
    "versionId",
    "ifMatch",
  ] as const;
  if (!exactRecord(candidate, keys)) reject("INVALID_REQUEST");
  const request = candidate;
  if (
    typeof request.tenantId !== "string"
    || !IDENTIFIER.test(request.tenantId)
    || typeof request.connectionId !== "string"
    || !CONNECTION_ID.test(request.connectionId)
    || request.connectionId !== pathConnectionId
    || typeof request.jobId !== "string"
    || !IDENTIFIER.test(request.jobId)
    || (
      request.contractId !== "foundational-cur2-export-v1"
      && request.contractId !== "foundational-focus12-export-v1"
    )
    || typeof request.exportName !== "string"
    || !EXPORT_NAME.test(request.exportName)
    || typeof request.region !== "string"
    || !REGION.test(request.region)
    || typeof request.bucket !== "string"
    || !BUCKET.test(request.bucket)
    || !validKey(request.prefix, true)
    || !request.prefix.endsWith(`/${request.exportName}/`)
    || !validKey(request.key)
    || !request.key.startsWith(request.prefix)
    || request.key.length === request.prefix.length
    || !Number.isSafeInteger(request.offset)
    || (request.offset as number) < 0
    || (request.offset as number) > MAX_OBJECT_OFFSET
    || !Number.isSafeInteger(request.maximumBytes)
    || (request.maximumBytes as number) < 1
    || (request.maximumBytes as number) > FINOPS_EXPORT_CHUNK_MAX_BYTES
    || (
      request.versionId !== null
      && !validText(request.versionId, MAX_VERSION_ID_BYTES)
    )
    || (
      request.ifMatch !== null
      && (typeof request.ifMatch !== "string" || !ETAG.test(request.ifMatch))
    )
    || (request.versionId !== null && request.ifMatch !== null)
  ) reject("INVALID_REQUEST");
  return request as unknown as FinopsExportChunkRequest;
}

function asByteChunk(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

async function readBoundedBody(
  body: unknown,
  maximumBytes: number,
  controller: AbortController,
): Promise<Uint8Array> {
  if (
    (typeof body !== "object" && typeof body !== "function")
    || body === null
    || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function"
  ) reject("OBJECT_RESPONSE_INVALID");
  const iterator = (body as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const current = await iterator.next();
      if (current.done) break;
      const chunk = asByteChunk(current.value);
      if (chunk === null) reject("OBJECT_RESPONSE_INVALID");
      if (chunk.byteLength > maximumBytes - total) {
        controller.abort();
        try {
          await iterator.return?.();
        } catch {
          // Preserve the deterministic limit rejection.
        }
        reject("OBJECT_RANGE_LIMIT_EXCEEDED");
      }
      const copy = new Uint8Array(chunk.byteLength);
      copy.set(chunk);
      chunks.push(copy);
      total += copy.byteLength;
    }
  } catch (error) {
    controller.abort();
    try {
      await iterator.return?.();
    } catch {
      // Preserve the primary read failure.
    }
    if (error instanceof FinopsExportChunkError) throw error;
    reject("OBJECT_READ_FAILED");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseContentRange(
  value: string | undefined,
): { readonly start: number; readonly end: number; readonly total: number } | null {
  if (value === undefined) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value);
  if (match === null) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || !Number.isSafeInteger(total)
    || start < 0
    || end < start
    || total < 1
    || end >= total
  ) return null;
  return { start, end, total };
}

function normalizedEtag(value: string | undefined): string | null {
  return value !== undefined && ETAG.test(value) ? value : null;
}

function normalizedVersionId(value: string | undefined): string | null {
  return value !== undefined && validText(value, MAX_VERSION_ID_BYTES)
    ? value
    : null;
}

export async function readFinopsExportChunk(
  request: FinopsExportChunkRequest,
  credentials: AwsTemporaryCredentials,
  clientFactory: FinopsExportChunkClientFactory,
): Promise<FinopsExportChunkResponse> {
  // Re-validate even when the caller used parseFinopsExportChunkRequest.
  const reparsed = parseFinopsExportChunkRequest(
    JSON.stringify(request),
    request.connectionId,
  );
  const end = reparsed.offset + reparsed.maximumBytes - 1;
  if (!Number.isSafeInteger(end) || end > MAX_OBJECT_OFFSET) {
    reject("INVALID_REQUEST");
  }
  const client = clientFactory(reparsed.region, credentials);
  const controller = new AbortController();
  let output: GetObjectCommandOutput;
  try {
    output = await client.send(
      new GetObjectCommand({
        Bucket: reparsed.bucket,
        Key: reparsed.key,
        Range: `bytes=${reparsed.offset}-${end}`,
        ...(reparsed.versionId === null
          ? {}
          : { VersionId: reparsed.versionId }),
        ...(reparsed.ifMatch === null ? {} : { IfMatch: reparsed.ifMatch }),
      }),
      { abortSignal: controller.signal },
    );
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (
      name === "PreconditionFailed"
      || name === "NoSuchVersion"
      || name === "InvalidObjectState"
    ) reject("OBJECT_CHANGED");
    reject("OBJECT_READ_FAILED");
  }
  const range = parseContentRange(output.ContentRange);
  const contentLength = output.ContentLength;
  if (
    range === null
    || range.start !== reparsed.offset
    || typeof contentLength !== "number"
    || !Number.isSafeInteger(contentLength)
    || contentLength < 1
    || contentLength > reparsed.maximumBytes
    || range.end - range.start + 1 !== contentLength
  ) {
    controller.abort();
    reject("OBJECT_RESPONSE_INVALID");
  }
  const bytes = await readBoundedBody(
    output.Body,
    reparsed.maximumBytes,
    controller,
  );
  if (bytes.byteLength !== contentLength) reject("OBJECT_RESPONSE_INVALID");
  const eTag = normalizedEtag(output.ETag);
  const versionId = normalizedVersionId(output.VersionId);
  if (reparsed.versionId !== null && versionId !== reparsed.versionId) {
    reject("OBJECT_CHANGED");
  }
  if (
    reparsed.ifMatch !== null
    && (eTag === null || eTag.replaceAll('"', "") !== reparsed.ifMatch.replaceAll('"', ""))
  ) reject("OBJECT_CHANGED");
  return {
    schema: "sutra.finops-export-chunk.v1",
    jobId: reparsed.jobId,
    connectionId: reparsed.connectionId,
    region: reparsed.region,
    bucket: reparsed.bucket,
    key: reparsed.key,
    offset: reparsed.offset,
    totalBytes: range.total,
    bytesRead: bytes.byteLength,
    complete: range.end + 1 === range.total,
    eTag,
    versionId,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bodyBase64: Buffer.from(bytes).toString("base64"),
  };
}

export function createAwsFinopsExportChunkClient(
  region: string,
  credentials: AwsTemporaryCredentials,
): FinopsExportChunkClient {
  return new S3Client({
    ...workloadIdentityAwsClientConfig(region),
    credentials,
  });
}

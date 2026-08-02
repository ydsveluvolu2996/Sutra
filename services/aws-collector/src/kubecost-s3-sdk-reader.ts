/** Concrete, version-pinned S3 reader for the ADD-06 provider adapter. */
import { createHash } from "node:crypto";
import {
  GetBucketLocationCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import type { AwsPartition, AwsTemporaryCredentials } from "./types.js";
import {
  KUBECOST_CCA_DATASET_COLUMNS,
  KubecostProviderAdapterError,
  type KubecostProviderReader,
} from "./kubecost-versioned-export-provider-adapter.js";

export interface KubecostParquetDecoder {
  decode(input: Uint8Array): Promise<{
    readonly columns: readonly string[];
    readonly rows: readonly Readonly<Record<string, unknown>>[];
  }>;
}
type S3Sender = Pick<S3Client, "send">;
const invalid = (): never => { throw new KubecostProviderAdapterError("PROVIDER_RESPONSE_INVALID"); };
function text(value: unknown): string { if (typeof value !== "string" || value.length < 1 || /[\u0000-\u001f\u007f]/u.test(value)) invalid(); return value as string; }
function integer(value: unknown): number { const result = Number(value); if (!Number.isSafeInteger(result) || result < 0) invalid(); return result; }
function iso(value: unknown): string { const milliseconds = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN; if (!Number.isFinite(milliseconds)) invalid(); return new Date(milliseconds).toISOString(); }
function bucketRegion(value: unknown): string { if (value === undefined || value === null || value === "") return "us-east-1"; if (value === "EU") return "eu-west-1"; return text(value); }

export function createKubecostS3SdkReader(input: {
  readonly credentials: AwsTemporaryCredentials;
  readonly partition: AwsPartition;
  readonly region: string;
  readonly decoder: KubecostParquetDecoder;
  readonly client?: S3Sender;
}): KubecostProviderReader {
  const regionMatchesPartition = input.partition === "aws-cn" ? /^cn-[a-z]+-\d$/u.test(input.region)
    : input.partition === "aws-us-gov" ? /^us-gov-[a-z]+-\d$/u.test(input.region)
      : /^(?!cn-|us-gov-)[a-z]{2}-[a-z]+-\d$/u.test(input.region);
  if (!regionMatchesPartition) invalid();
  const client = input.client ?? new S3Client({ region: input.region, credentials: input.credentials });
  const reader: KubecostProviderReader = {
    async getBucketLocation(request, signal) {
      const output = await client.send(new GetBucketLocationCommand({ Bucket: request.bucket, ExpectedBucketOwner: request.expectedBucketOwner }), { abortSignal: signal });
      return bucketRegion(output.LocationConstraint);
    },
    async listObjects(request, signal) {
      const output = await client.send(new ListObjectsV2Command({ Bucket: request.bucket, Prefix: request.prefix, ExpectedBucketOwner: request.expectedBucketOwner, ContinuationToken: request.continuationToken ?? undefined, MaxKeys: 1_000 }), { abortSignal: signal });
      const contents = output.Contents ?? [];
      if (!Array.isArray(contents) || contents.length > 1_000) invalid();
      const objects = contents.map((item) => ({ key: text(item.Key), eTag: text(item.ETag), sizeBytes: integer(item.Size), lastModifiedIso: iso(item.LastModified) }));
      if (output.IsTruncated === true && typeof output.NextContinuationToken !== "string") invalid();
      if (output.IsTruncated !== true && output.NextContinuationToken !== undefined) invalid();
      return Object.freeze({ objects, nextContinuationToken: output.IsTruncated === true ? text(output.NextContinuationToken) : null });
    },
    async readVersionedParquet(request, signal) {
      const head = await client.send(new HeadObjectCommand({ Bucket: request.bucket, Key: request.key, ExpectedBucketOwner: request.expectedBucketOwner }), { abortSignal: signal });
      const versionId = text(head.VersionId); const sizeBytes = integer(head.ContentLength);
      if (sizeBytes !== request.maximumBytes) invalid();
      const output = await client.send(new GetObjectCommand({ Bucket: request.bucket, Key: request.key, VersionId: versionId, ExpectedBucketOwner: request.expectedBucketOwner }), { abortSignal: signal });
      const body = output.Body;
      if (output.VersionId !== versionId || integer(output.ContentLength) !== sizeBytes || body === undefined || typeof body.transformToByteArray !== "function") invalid();
      const safeBody = body as NonNullable<typeof body>;
      const bytes = await safeBody.transformToByteArray();
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== sizeBytes) invalid();
      const decoded = await input.decoder.decode(bytes);
      if (JSON.stringify(decoded.columns) !== JSON.stringify(KUBECOST_CCA_DATASET_COLUMNS) || !Array.isArray(decoded.rows)) invalid();
      return Object.freeze({
        key: request.key, eTag: text(output.ETag), sizeBytes, lastModifiedIso: iso(output.LastModified ?? head.LastModified),
        versionId, contentSha256: createHash("sha256").update(bytes).digest("hex"), columns: decoded.columns, rows: decoded.rows,
      });
    },
  };
  return Object.freeze(reader);
}

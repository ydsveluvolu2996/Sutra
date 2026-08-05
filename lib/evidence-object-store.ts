import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

// Match the authenticated collector response ceiling. A response accepted by
// the broker boundary must never become unarchivable immediately afterwards.
export const MAX_EVIDENCE_OBJECT_BYTES = 12 * 1024 * 1024;

const BUCKET = /^(?!\d{1,3}(?:\.\d{1,3}){3}$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const KMS_KEY_ARN =
  /^arn:aws(?:-[a-z]+)*:kms:[a-z0-9-]+:[0-9]{12}:key\/[0-9a-f-]{36}$/u;
const OBJECT_KEY = /^evidence\/v1\/[a-f0-9]{64}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

interface S3Like {
  send(command: unknown): Promise<unknown>;
  destroy?(): void;
}

export interface EvidenceStoredObject {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly contentSha256: string;
}

export interface EvidenceObjectStore {
  readonly storageKind: "s3";
  putImmutable(input: {
    readonly objectKey: string;
    readonly body: Uint8Array;
    readonly contentType: string;
    readonly contentSha256: string;
  }): Promise<void>;
  getVerified(input: {
    readonly objectKey: string;
    readonly contentType: string;
    readonly contentSha256: string;
    readonly byteSize: number;
  }): Promise<EvidenceStoredObject>;
}

export class EvidenceObjectStoreError extends Error {
  public readonly code:
    | "INVALID_CONFIGURATION"
    | "INVALID_OBJECT"
    | "OBJECT_CONFLICT"
    | "STORAGE_UNAVAILABLE";

  public constructor(code: EvidenceObjectStoreError["code"]) {
    super("Managed evidence storage operation rejected");
    this.name = "EvidenceObjectStoreError";
    this.code = code;
  }
}

function reject(code: EvidenceObjectStoreError["code"]): never {
  throw new EvidenceObjectStoreError(code);
}

function sha256Base64(hex: string): string {
  if (!SHA256_HEX.test(hex)) reject("INVALID_OBJECT");
  const bytes = new Uint8Array(hex.match(/../gu)!.map((byte) => Number.parseInt(byte, 16)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function named(error: unknown, names: readonly string[]): boolean {
  return typeof error === "object" && error !== null && "name" in error &&
    typeof error.name === "string" && names.includes(error.name);
}

export class S3EvidenceObjectStore implements EvidenceObjectStore {
  public readonly storageKind = "s3" as const;
  private readonly client: S3Like;
  private readonly bucket: string;
  private readonly kmsKeyArn: string;

  public constructor(input: {
    readonly bucket: string;
    readonly kmsKeyArn: string;
    readonly client?: S3Like;
    readonly clientConfig?: S3ClientConfig;
  }) {
    if (!BUCKET.test(input.bucket) || !KMS_KEY_ARN.test(input.kmsKeyArn)) {
      reject("INVALID_CONFIGURATION");
    }
    this.bucket = input.bucket;
    this.kmsKeyArn = input.kmsKeyArn;
    this.client = input.client ?? new S3Client(input.clientConfig ?? {});
  }

  private validate(input: {
    readonly objectKey: string;
    readonly body?: Uint8Array;
    readonly contentType: string;
    readonly contentSha256: string;
    readonly byteSize?: number;
  }): void {
    const byteSize = input.body?.byteLength ?? input.byteSize ?? 0;
    if (
      !OBJECT_KEY.test(input.objectKey) ||
      !SHA256_HEX.test(input.contentSha256) ||
      input.contentType.length < 3 ||
      input.contentType.length > 128 ||
      /[\r\n\u0000]/u.test(input.contentType) ||
      byteSize < 1 ||
      byteSize > MAX_EVIDENCE_OBJECT_BYTES
    ) reject("INVALID_OBJECT");
  }

  private async verifyExisting(input: {
    readonly objectKey: string;
    readonly contentSha256: string;
    readonly byteSize: number;
  }): Promise<void> {
    let head: { readonly ContentLength?: number; readonly ChecksumSHA256?: string };
    try {
      head = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: input.objectKey,
        ChecksumMode: "ENABLED",
      })) as typeof head;
    } catch {
      return reject("STORAGE_UNAVAILABLE");
    }
    if (
      head.ContentLength !== input.byteSize ||
      head.ChecksumSHA256 !== sha256Base64(input.contentSha256)
    ) reject("OBJECT_CONFLICT");
  }

  public async putImmutable(input: {
    readonly objectKey: string;
    readonly body: Uint8Array;
    readonly contentType: string;
    readonly contentSha256: string;
  }): Promise<void> {
    this.validate(input);
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.objectKey,
        Body: input.body,
        ContentLength: input.body.byteLength,
        ContentType: input.contentType,
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: this.kmsKeyArn,
        ChecksumAlgorithm: "SHA256",
        ChecksumSHA256: sha256Base64(input.contentSha256),
        IfNoneMatch: "*",
        Metadata: {
          "sutra-content-sha256": input.contentSha256,
          "sutra-immutable": "true",
        },
      }));
    } catch (error) {
      if (named(error, ["PreconditionFailed", "ConditionalRequestConflict"])) {
        await this.verifyExisting({
          objectKey: input.objectKey,
          contentSha256: input.contentSha256,
          byteSize: input.body.byteLength,
        });
        return;
      }
      throw new EvidenceObjectStoreError("STORAGE_UNAVAILABLE");
    }
  }

  public async getVerified(input: {
    readonly objectKey: string;
    readonly contentType: string;
    readonly contentSha256: string;
    readonly byteSize: number;
  }): Promise<EvidenceStoredObject> {
    this.validate(input);
    let result: {
      readonly Body?: { transformToByteArray(): Promise<Uint8Array> };
      readonly ContentLength?: number;
      readonly ContentType?: string;
      readonly ChecksumSHA256?: string;
    };
    try {
      result = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.objectKey,
        ChecksumMode: "ENABLED",
      })) as typeof result;
    } catch {
      return reject("STORAGE_UNAVAILABLE");
    }
    if (
      result.Body === undefined ||
      result.ContentLength !== input.byteSize ||
      result.ContentType !== input.contentType ||
      result.ChecksumSHA256 !== sha256Base64(input.contentSha256)
    ) reject("OBJECT_CONFLICT");
    const body = await result.Body.transformToByteArray();
    if (
      body.byteLength !== input.byteSize ||
      await sha256Hex(body) !== input.contentSha256
    ) reject("OBJECT_CONFLICT");
    return {
      body,
      contentType: input.contentType,
      contentSha256: input.contentSha256,
    };
  }

  public destroy(): void {
    this.client.destroy?.();
  }
}

export function createRuntimeEvidenceObjectStore(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): EvidenceObjectStore | null {
  const deployment = environment.SUTRA_DEPLOYMENT_ENV?.trim() || "local";
  const hosted = environment.SUTRA_HOSTED_ENABLED === "true";
  if (!hosted && (deployment === "local" || deployment === "development" || deployment === "test")) {
    return null;
  }
  if (
    environment.SUTRA_EVIDENCE_BACKEND !== "s3" ||
    environment.SUTRA_EVIDENCE_BUCKET === undefined ||
    environment.SUTRA_EVIDENCE_KMS_KEY_ARN === undefined
  ) reject("INVALID_CONFIGURATION");
  return new S3EvidenceObjectStore({
    bucket: environment.SUTRA_EVIDENCE_BUCKET,
    kmsKeyArn: environment.SUTRA_EVIDENCE_KMS_KEY_ARN,
  });
}

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const NONCE = /^[A-Za-z0-9_-]{22,128}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/u;
const TIMESTAMP = /^\d{13}$/u;
const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;
const DEFAULT_CLOCK_SKEW_MS = 60_000;
const DEFAULT_NONCE_TTL_MS = 10 * 60_000;

export interface FalcoCredentialResolver {
  resolve(input: {
    readonly clusterId: string;
    readonly keyId: string;
  }): Promise<Uint8Array | null>;
}

export interface FalcoReplayStore {
  consume(input: {
    readonly clusterId: string;
    readonly keyId: string;
    readonly nonceSha256: string;
    readonly expiresAt: number;
  }): Promise<boolean>;
}

export class FalcoRequestSecurityError extends Error {
  public readonly code:
    | "INVALID_REQUEST"
    | "BODY_TOO_LARGE"
    | "AUTHENTICATION_FAILED"
    | "REQUEST_REPLAYED";

  public constructor(code: FalcoRequestSecurityError["code"]) {
    super("Falco ingestion request rejected");
    this.name = "FalcoRequestSecurityError";
    this.code = code;
  }
}

function header(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  return value === null || value.includes(",") ? null : value;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalFalcoRequest(input: {
  readonly method: "POST";
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly keyId: string;
  readonly clusterId: string;
  readonly bodySha256: string;
}): Buffer {
  return Buffer.from([
    "SUTRA-FALCO-HMAC-SHA256-V1",
    input.method,
    input.path,
    input.timestamp,
    input.nonce,
    input.keyId,
    input.clusterId,
    input.bodySha256,
  ].join("\n"), "utf8");
}

export class FalcoRequestVerifier {
  private readonly options: {
    readonly credentials: FalcoCredentialResolver;
    readonly replayStore: FalcoReplayStore;
    readonly now?: () => number;
    readonly maximumBodyBytes?: number;
    readonly maximumClockSkewMs?: number;
    readonly nonceTtlMs?: number;
  };

  public constructor(
    options: {
      readonly credentials: FalcoCredentialResolver;
      readonly replayStore: FalcoReplayStore;
      readonly now?: () => number;
      readonly maximumBodyBytes?: number;
      readonly maximumClockSkewMs?: number;
      readonly nonceTtlMs?: number;
    },
  ) {
    this.options = options;
  }

  public async verify(input: {
    readonly path: string;
    readonly headers: Headers;
    readonly body: Uint8Array;
    readonly expectedClusterId: string;
  }): Promise<{ readonly keyId: string; readonly bodySha256: string }> {
    const maximumBodyBytes = this.options.maximumBodyBytes ?? 256 * 1024;
    if (!(input.body instanceof Uint8Array) || input.body.byteLength > maximumBodyBytes) {
      throw new FalcoRequestSecurityError(
        input.body instanceof Uint8Array ? "BODY_TOO_LARGE" : "INVALID_REQUEST",
      );
    }
    if (
      !CLUSTER_ID.test(input.expectedClusterId) ||
      !input.path.startsWith("/") ||
      input.path.length > 2_048 ||
      /[\r\n#]/u.test(input.path)
    ) throw new FalcoRequestSecurityError("INVALID_REQUEST");

    const timestamp = header(input.headers, "x-sutra-falco-timestamp");
    const nonce = header(input.headers, "x-sutra-falco-nonce");
    const keyId = header(input.headers, "x-sutra-falco-key-id");
    const signature = header(input.headers, "x-sutra-falco-signature");
    if (
      timestamp === null || !TIMESTAMP.test(timestamp) ||
      nonce === null || !NONCE.test(nonce) ||
      keyId === null || !KEY_ID.test(keyId) ||
      signature === null || !SIGNATURE.test(signature)
    ) throw new FalcoRequestSecurityError("AUTHENTICATION_FAILED");

    const requestTime = Number(timestamp);
    const now = (this.options.now ?? Date.now)();
    if (
      !Number.isSafeInteger(requestTime) ||
      Math.abs(now - requestTime) > (this.options.maximumClockSkewMs ?? DEFAULT_CLOCK_SKEW_MS)
    ) throw new FalcoRequestSecurityError("AUTHENTICATION_FAILED");
    const secret = await this.options.credentials.resolve({
      clusterId: input.expectedClusterId,
      keyId,
    });
    if (secret === null || secret.byteLength < 32) {
      throw new FalcoRequestSecurityError("AUTHENTICATION_FAILED");
    }
    const bodySha256 = sha256(input.body);
    const expected = createHmac("sha256", secret).update(canonicalFalcoRequest({
      method: "POST",
      path: input.path,
      timestamp,
      nonce,
      keyId,
      clusterId: input.expectedClusterId,
      bodySha256,
    })).digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(signature, "base64url");
    } catch {
      throw new FalcoRequestSecurityError("AUTHENTICATION_FAILED");
    }
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
      throw new FalcoRequestSecurityError("AUTHENTICATION_FAILED");
    }
    const consumed = await this.options.replayStore.consume({
      clusterId: input.expectedClusterId,
      keyId,
      nonceSha256: sha256(nonce),
      expiresAt: now + (this.options.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS),
    });
    if (!consumed) throw new FalcoRequestSecurityError("REQUEST_REPLAYED");
    return { keyId, bodySha256 };
  }
}

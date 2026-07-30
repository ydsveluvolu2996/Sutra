import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const NONCE = /^[A-Za-z0-9_-]{22,128}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const TIMESTAMP = /^\d{13}$/u;
const DEFAULT_MAXIMUM_CLOCK_SKEW_MS = 60_000;
const DEFAULT_NONCE_TTL_MS = 10 * 60_000;

export interface HostedRequestReplayStore {
  consume(key: string, expiresAt: number): Promise<boolean>;
}

export interface HostedRequestAuthenticatorOptions {
  readonly clientPublicKeys: Readonly<Record<string, string>>;
  readonly brokerKeyId: string;
  /** Base64url-encoded Ed25519 PKCS#8 DER. */
  readonly brokerPrivateKey: string;
  readonly replayStore: HostedRequestReplayStore;
  readonly now?: () => number;
  readonly maximumClockSkewMs?: number;
  readonly nonceTtlMs?: number;
}

export class HostedRequestAuthenticationError extends Error {
  public readonly code: "AUTHENTICATION_FAILED" | "REQUEST_REPLAYED";

  public constructor(code: "AUTHENTICATION_FAILED" | "REQUEST_REPLAYED") {
    super("Hosted collector request authentication failed");
    this.name = "HostedRequestAuthenticationError";
    this.code = code;
  }
}

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  return typeof value === "string" && !value.includes(",") ? value : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parsePublicKey(value: string): KeyObject {
  try {
    const key = createPublicKey({
      key: Buffer.from(value, "base64url"),
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw new HostedRequestAuthenticationError("AUTHENTICATION_FAILED");
  }
}

function parsePrivateKey(value: string): KeyObject {
  try {
    const key = createPrivateKey({
      key: Buffer.from(value, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw new Error("SUTRA_BROKER_RESPONSE_PRIVATE_KEY must be an Ed25519 PKCS#8 DER base64url value");
  }
}

function requestCanonical(input: {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly keyId: string;
  readonly bodySha256: string;
}): Buffer {
  return Buffer.from([
    "SUTRA-APP-BROKER-V1",
    input.method,
    input.path,
    input.timestamp,
    input.nonce,
    input.keyId,
    input.bodySha256,
  ].join("\n"), "utf8");
}

function responseCanonical(input: {
  readonly status: number;
  readonly path: string;
  readonly nonce: string;
  readonly keyId: string;
  readonly bodySha256: string;
}): Buffer {
  return Buffer.from([
    "SUTRA-BROKER-APP-V1",
    String(input.status),
    input.path,
    input.nonce,
    input.keyId,
    input.bodySha256,
  ].join("\n"), "utf8");
}

export class HostedRequestAuthenticator {
  private readonly publicKeys: ReadonlyMap<string, KeyObject>;
  private readonly brokerKeyId: string;
  private readonly privateKey: KeyObject;
  private readonly replayStore: HostedRequestReplayStore;
  private readonly now: () => number;
  private readonly maximumClockSkewMs: number;
  private readonly nonceTtlMs: number;

  public constructor(options: HostedRequestAuthenticatorOptions) {
    if (!KEY_ID.test(options.brokerKeyId)) throw new Error("SUTRA_BROKER_RESPONSE_KEY_ID is invalid");
    const keys = Object.entries(options.clientPublicKeys);
    if (keys.length === 0 || keys.length > 16) throw new Error("At least one bounded app public key is required");
    this.publicKeys = new Map(keys.map(([keyId, value]) => {
      if (!KEY_ID.test(keyId)) throw new Error("SUTRA_APP_PUBLIC_KEYS contains an invalid key id");
      return [keyId, parsePublicKey(value)] as const;
    }));
    this.brokerKeyId = options.brokerKeyId;
    this.privateKey = parsePrivateKey(options.brokerPrivateKey);
    this.replayStore = options.replayStore;
    this.now = options.now ?? Date.now;
    this.maximumClockSkewMs = options.maximumClockSkewMs ?? DEFAULT_MAXIMUM_CLOCK_SKEW_MS;
    this.nonceTtlMs = options.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS;
  }

  public async verify(input: {
    readonly method: string;
    readonly path: string;
    readonly headers: IncomingHttpHeaders;
    readonly body: string;
  }): Promise<{ readonly nonce: string; readonly timestamp: number }> {
    const timestampText = header(input.headers, "x-sutra-timestamp");
    const nonce = header(input.headers, "x-sutra-nonce");
    const keyId = header(input.headers, "x-sutra-key-id");
    const signatureText = header(input.headers, "x-sutra-signature");
    if (
      timestampText === null || !TIMESTAMP.test(timestampText) ||
      nonce === null || !NONCE.test(nonce) ||
      keyId === null || !KEY_ID.test(keyId) ||
      signatureText === null || !SIGNATURE.test(signatureText)
    ) {
      throw new HostedRequestAuthenticationError("AUTHENTICATION_FAILED");
    }
    const timestamp = Number(timestampText);
    const now = this.now();
    if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > this.maximumClockSkewMs) {
      throw new HostedRequestAuthenticationError("AUTHENTICATION_FAILED");
    }
    const publicKey = this.publicKeys.get(keyId);
    if (publicKey === undefined) throw new HostedRequestAuthenticationError("AUTHENTICATION_FAILED");
    const signature = Buffer.from(signatureText, "base64url");
    const valid = signature.byteLength === 64 && verify(null, requestCanonical({
      method: input.method.toUpperCase(),
      path: input.path,
      timestamp: timestampText,
      nonce,
      keyId,
      bodySha256: sha256(input.body),
    }), publicKey, signature);
    if (!valid) throw new HostedRequestAuthenticationError("AUTHENTICATION_FAILED");

    const replayKey = sha256(`${keyId}\0${nonce}`);
    if (!await this.replayStore.consume(replayKey, now + this.nonceTtlMs)) {
      throw new HostedRequestAuthenticationError("REQUEST_REPLAYED");
    }
    return { nonce, timestamp };
  }

  public async responseSignature(
    status: number,
    path: string,
    nonce: string,
    body: string,
  ): Promise<{ readonly keyId: string; readonly signature: string }> {
    if (!NONCE.test(nonce)) {
      // An unauthenticated request can omit its nonce. Use a non-secret random
      // response binding so even error responses carry a structurally valid
      // signature without reflecting malformed attacker-controlled bytes.
      nonce = randomBytes(24).toString("base64url");
    }
    return {
      keyId: this.brokerKeyId,
      signature: sign(null, responseCanonical({
        status,
        path,
        nonce,
        keyId: this.brokerKeyId,
        bodySha256: sha256(body),
      }), this.privateKey).toString("base64url"),
    };
  }
}

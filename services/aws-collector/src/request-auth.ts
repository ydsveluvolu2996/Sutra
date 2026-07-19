import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const SIGNATURE = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const DEFAULT_SKEW_MS = 60_000;
const DEFAULT_NONCE_TTL_MS = 10 * 60_000;

export class RequestAuthenticationError extends Error {
  public readonly code: "AUTHENTICATION_FAILED" | "REQUEST_REPLAYED";

  public constructor(code: "AUTHENTICATION_FAILED" | "REQUEST_REPLAYED") {
    super("Collector request authentication failed");
    this.name = "RequestAuthenticationError";
    this.code = code;
  }
}
export interface RequestAuthenticatorOptions {
  readonly sharedSecret: string;
  readonly now?: () => number;
  readonly maximumClockSkewMs?: number;
  readonly nonceTtlMs?: number;
}

export interface VerifiedRequest {
  readonly nonce: string;
  readonly timestamp: number;
}

function decodeSecret(value: string): Buffer {
  if (value.length < 43 || value.length > 88 || /\s/u.test(value)) {
    throw new Error("SUTRA_BROKER_SHARED_SECRET must be a base64 value with at least 256 bits");
  }
  const decoded = Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
  if (decoded.byteLength < 32) {
    throw new Error("SUTRA_BROKER_SHARED_SECRET must contain at least 256 bits");
  }
  return decoded;
}

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  return typeof value === "string" ? value : null;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmacHex(secret: Buffer, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

function secureEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export class RequestAuthenticator {
  private readonly secret: Buffer;
  private readonly now: () => number;
  private readonly maximumClockSkewMs: number;
  private readonly nonceTtlMs: number;
  private readonly seenNonces = new Map<string, number>();

  public constructor(options: RequestAuthenticatorOptions) {
    this.secret = decodeSecret(options.sharedSecret);
    this.now = options.now ?? Date.now;
    this.maximumClockSkewMs = options.maximumClockSkewMs ?? DEFAULT_SKEW_MS;
    this.nonceTtlMs = options.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS;
  }

  public verify(input: {
    readonly method: string;
    readonly path: string;
    readonly headers: IncomingHttpHeaders;
    readonly body: string;
  }): VerifiedRequest {
    const timestampText = header(input.headers, "x-sutra-timestamp");
    const nonce = header(input.headers, "x-sutra-nonce");
    const signature = header(input.headers, "x-sutra-signature");
    if (
      timestampText === null || !/^\d{13}$/u.test(timestampText) ||
      nonce === null || !NONCE.test(nonce) ||
      signature === null || !SIGNATURE.test(signature)
    ) {
      throw new RequestAuthenticationError("AUTHENTICATION_FAILED");
    }

    const timestamp = Number(timestampText);
    const now = this.now();
    if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > this.maximumClockSkewMs) {
      throw new RequestAuthenticationError("AUTHENTICATION_FAILED");
    }
    this.removeExpiredNonces(now);
    if (this.seenNonces.has(nonce)) {
      throw new RequestAuthenticationError("REQUEST_REPLAYED");
    }

    const expected = hmacHex(
      this.secret,
      `${input.method.toUpperCase()}\n${input.path}\n${timestampText}\n${nonce}\n${sha256Hex(input.body)}`,
    );
    if (!secureEqual(signature, expected)) {
      throw new RequestAuthenticationError("AUTHENTICATION_FAILED");
    }
    this.seenNonces.set(nonce, now + this.nonceTtlMs);
    return { nonce, timestamp };
  }

  public responseSignature(status: number, path: string, nonce: string, body: string): string {
    return hmacHex(this.secret, `${status}\n${path}\n${nonce}\n${sha256Hex(body)}`);
  }

  private removeExpiredNonces(now: number): void {
    for (const [nonce, expiresAt] of this.seenNonces) {
      if (expiresAt <= now) this.seenNonces.delete(nonce);
    }
  }
}

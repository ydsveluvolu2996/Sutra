import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const NONCE = /^[A-Za-z0-9_-]{22,128}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const METHOD = /^[A-Z]{3,12}$/u;
const TIMESTAMP = /^\d{13}$/u;
const DEFAULT_MAXIMUM_BODY_BYTES = 256 * 1024;
const DEFAULT_MAXIMUM_CLOCK_SKEW_MS = 60_000;
const DEFAULT_NONCE_TTL_MS = 10 * 60_000;

export interface HostedBrokerRequestScope {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly jobId: string;
}

export interface HostedBrokerRequestHeaders {
  readonly [name: string]: string | readonly string[] | undefined;
}

export interface HostedBrokerReplayStore {
  /**
   * Atomically reserve a nonce. Implementations shared by multiple broker
   * instances must use a conditional insert (or equivalent), never get-then-set.
   */
  consume(key: string, expiresAt: number): Promise<boolean>;
}

export interface HostedBrokerPublicKeyResolver {
  resolve(input: {
    readonly tenantId: string;
    readonly keyId: string;
  }): Promise<string | Buffer | KeyObject | null>;
}

export interface HostedBrokerRequestVerifierOptions {
  readonly publicKeys: HostedBrokerPublicKeyResolver;
  readonly replayStore: HostedBrokerReplayStore;
  readonly now?: () => number;
  readonly maximumBodyBytes?: number;
  readonly maximumClockSkewMs?: number;
  readonly nonceTtlMs?: number;
}

export interface VerifyHostedBrokerRequestInput {
  readonly method: string;
  /** Exact origin-form path, including its query string when one is present. */
  readonly path: string;
  readonly headers: HostedBrokerRequestHeaders | Headers;
  readonly body: Uint8Array;
  /** Scope derived from trusted server state, never from the request body. */
  readonly expectedScope: HostedBrokerRequestScope;
}

export interface VerifiedHostedBrokerRequest extends HostedBrokerRequestScope {
  readonly keyId: string;
  readonly nonce: string;
  readonly timestamp: number;
  readonly bodySha256: string;
}

export class HostedBrokerRequestSecurityError extends Error {
  public readonly code:
    | "INVALID_REQUEST"
    | "BODY_TOO_LARGE"
    | "AUTHENTICATION_FAILED"
    | "SCOPE_MISMATCH"
    | "REQUEST_REPLAYED";

  public constructor(
    code:
      | "INVALID_REQUEST"
      | "BODY_TOO_LARGE"
      | "AUTHENTICATION_FAILED"
      | "SCOPE_MISMATCH"
      | "REQUEST_REPLAYED",
  ) {
    super("Hosted broker request rejected");
    this.name = "HostedBrokerRequestSecurityError";
    this.code = code;
  }
}

function singleHeader(
  headers: HostedBrokerRequestHeaders | Headers,
  name: string,
): string | null {
  if (headers instanceof Headers) {
    const value = headers.get(name);
    return value === null || value.includes(",") ? null : value;
  }
  const direct = headers[name] ?? headers[name.toLowerCase()];
  return typeof direct === "string" ? direct : null;
}

function assertScope(scope: HostedBrokerRequestScope): void {
  if (
    !IDENTIFIER.test(scope.tenantId) ||
    !IDENTIFIER.test(scope.connectionId) ||
    !IDENTIFIER.test(scope.jobId)
  ) {
    throw new HostedBrokerRequestSecurityError("INVALID_REQUEST");
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalHostedBrokerRequest(input: {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly keyId: string;
  readonly scope: HostedBrokerRequestScope;
  readonly bodySha256: string;
}): Buffer {
  return Buffer.from([
    "SUTRA-HOSTED-BROKER-V1",
    input.method,
    input.path,
    input.timestamp,
    input.nonce,
    input.keyId,
    input.scope.tenantId,
    input.scope.connectionId,
    input.scope.jobId,
    input.bodySha256,
  ].join("\n"), "utf8");
}

function parseEd25519PublicKey(value: string | Buffer | KeyObject): KeyObject {
  let key: KeyObject;
  try {
    key = typeof value === "string" || Buffer.isBuffer(value)
      ? createPublicKey(value)
      : value;
  } catch {
    throw new HostedBrokerRequestSecurityError("AUTHENTICATION_FAILED");
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new HostedBrokerRequestSecurityError("AUTHENTICATION_FAILED");
  }
  return key;
}

function strictPositiveInteger(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new Error("Hosted broker security limits must be positive safe integers");
  }
  return selected;
}

export class HostedBrokerRequestVerifier {
  private readonly options: HostedBrokerRequestVerifierOptions;
  private readonly now: () => number;
  private readonly maximumBodyBytes: number;
  private readonly maximumClockSkewMs: number;
  private readonly nonceTtlMs: number;

  public constructor(options: HostedBrokerRequestVerifierOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.maximumBodyBytes = strictPositiveInteger(
      options.maximumBodyBytes,
      DEFAULT_MAXIMUM_BODY_BYTES,
    );
    this.maximumClockSkewMs = strictPositiveInteger(
      options.maximumClockSkewMs,
      DEFAULT_MAXIMUM_CLOCK_SKEW_MS,
    );
    this.nonceTtlMs = strictPositiveInteger(options.nonceTtlMs, DEFAULT_NONCE_TTL_MS);
  }

  public async verify(
    input: VerifyHostedBrokerRequestInput,
  ): Promise<VerifiedHostedBrokerRequest> {
    assertScope(input.expectedScope);
    if (
      !(input.body instanceof Uint8Array) ||
      input.body.byteLength > this.maximumBodyBytes
    ) {
      throw new HostedBrokerRequestSecurityError(
        input.body instanceof Uint8Array ? "BODY_TOO_LARGE" : "INVALID_REQUEST",
      );
    }

    const method = input.method.toUpperCase();
    if (
      input.method !== method ||
      !METHOD.test(method) ||
      !input.path.startsWith("/") ||
      input.path.length > 2_048 ||
      /[\r\n#]/u.test(input.path)
    ) {
      throw new HostedBrokerRequestSecurityError("INVALID_REQUEST");
    }

    const timestampText = singleHeader(input.headers, "x-sutra-timestamp");
    const nonce = singleHeader(input.headers, "x-sutra-nonce");
    const keyId = singleHeader(input.headers, "x-sutra-key-id");
    const tenantId = singleHeader(input.headers, "x-sutra-tenant-id");
    const connectionId = singleHeader(input.headers, "x-sutra-connection-id");
    const jobId = singleHeader(input.headers, "x-sutra-job-id");
    const signatureText = singleHeader(input.headers, "x-sutra-signature");
    if (
      timestampText === null || !TIMESTAMP.test(timestampText) ||
      nonce === null || !NONCE.test(nonce) ||
      keyId === null || !KEY_ID.test(keyId) ||
      tenantId === null || !IDENTIFIER.test(tenantId) ||
      connectionId === null || !IDENTIFIER.test(connectionId) ||
      jobId === null || !IDENTIFIER.test(jobId) ||
      signatureText === null || !SIGNATURE.test(signatureText)
    ) {
      throw new HostedBrokerRequestSecurityError("AUTHENTICATION_FAILED");
    }

    if (
      tenantId !== input.expectedScope.tenantId ||
      connectionId !== input.expectedScope.connectionId ||
      jobId !== input.expectedScope.jobId
    ) {
      throw new HostedBrokerRequestSecurityError("SCOPE_MISMATCH");
    }

    const timestamp = Number(timestampText);
    const now = this.now();
    if (
      !Number.isSafeInteger(timestamp) ||
      Math.abs(now - timestamp) > this.maximumClockSkewMs
    ) {
      throw new HostedBrokerRequestSecurityError("AUTHENTICATION_FAILED");
    }

    const publicKeyValue = await this.options.publicKeys.resolve({ tenantId, keyId });
    if (publicKeyValue === null) {
      throw new HostedBrokerRequestSecurityError("AUTHENTICATION_FAILED");
    }
    const publicKey = parseEd25519PublicKey(publicKeyValue);
    const signature = Buffer.from(signatureText, "base64url");
    if (signature.byteLength !== 64) {
      throw new HostedBrokerRequestSecurityError("AUTHENTICATION_FAILED");
    }
    const bodySha256 = sha256(input.body);
    const canonical = canonicalHostedBrokerRequest({
      method,
      path: input.path,
      timestamp: timestampText,
      nonce,
      keyId,
      scope: input.expectedScope,
      bodySha256,
    });
    if (!verifySignature(null, canonical, publicKey, signature)) {
      throw new HostedBrokerRequestSecurityError("AUTHENTICATION_FAILED");
    }

    const replayKey = sha256(Buffer.from(`${tenantId}\0${keyId}\0${nonce}`, "utf8"));
    const consumed = await this.options.replayStore.consume(
      replayKey,
      now + this.nonceTtlMs,
    );
    if (!consumed) {
      throw new HostedBrokerRequestSecurityError("REQUEST_REPLAYED");
    }

    return {
      tenantId,
      connectionId,
      jobId,
      keyId,
      nonce,
      timestamp,
      bodySha256,
    };
  }
}

/**
 * Test/single-process adapter. Hosted deployments must use a shared atomic store
 * so replays cannot cross broker instances or survive a process restart.
 */
export class InMemoryHostedBrokerReplayStore implements HostedBrokerReplayStore {
  private readonly entries = new Map<string, number>();
  private readonly now: () => number;

  public constructor(now: () => number = Date.now) {
    this.now = now;
  }

  public async consume(key: string, expiresAt: number): Promise<boolean> {
    const now = this.now();
    for (const [candidate, expiry] of this.entries) {
      if (expiry <= now) this.entries.delete(candidate);
    }
    if (this.entries.has(key)) return false;
    this.entries.set(key, expiresAt);
    return true;
  }
}

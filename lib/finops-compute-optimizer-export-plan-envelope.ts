/**
 * Application-level envelope for a verified Compute Optimizer export plan.
 *
 * The configured FinOps evidence-reference key is only root key material. A
 * component-specific AES-256-GCM key is derived with HKDF-SHA-256 so this
 * envelope cannot be confused with, or substituted for, another encrypted
 * FinOps artifact. The complete persisted discovery and plan identity is
 * authenticated as AAD and is never recovered from the ciphertext.
 */
import {
  verifyComputeOptimizerExportPlan,
  type ComputeOptimizerExportPlan,
} from "./finops-compute-optimizer-export-plan.ts";

// Match the persisted organization/customer identifier contract exactly.
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const DISCOVERY_RUN_ID = /^cor_[a-f0-9]{64}$/u;
const PLAN_ID = /^cope_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const BASE64URL_KEY = /^[A-Za-z0-9_-]{43}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

const IV_BYTES = 12;
const TAG_BYTES = 16;
const ROOT_KEY_BYTES = 32;
const HKDF_SALT = new TextEncoder().encode(
  "sutra.finops.application-key-derivation.salt.v1",
);
const HKDF_INFO = new TextEncoder().encode(
  "sutra.compute-optimizer-export-plan-envelope.aes-256-gcm.v1",
);

export const COMPUTE_OPTIMIZER_EXPORT_PLAN_ENVELOPE_FORMAT =
  "sutra.compute-optimizer-export-plan-envelope.v1" as const;

export const COMPUTE_OPTIMIZER_EXPORT_PLAN_ENVELOPE_BOUNDS = Object.freeze({
  maximumPlaintextBytes: 16 * 1_024 * 1_024,
  maximumCiphertextBytes: 16 * 1_024 * 1_024 + IV_BYTES + TAG_BYTES,
} as const);

const MAXIMUM_CIPHERTEXT_CHARACTERS = Math.ceil(
  COMPUTE_OPTIMIZER_EXPORT_PLAN_ENVELOPE_BOUNDS.maximumCiphertextBytes * 4 / 3,
);

export interface ComputeOptimizerExportPlanEnvelopeContext {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly discoveryRunId: string;
  readonly planId: string;
  readonly contentSha256: string;
}

export interface SealedComputeOptimizerExportPlan {
  readonly format: typeof COMPUTE_OPTIMIZER_EXPORT_PLAN_ENVELOPE_FORMAT;
  readonly keyVersion: string;
  readonly ciphertext: string;
}

/** Every rejection is intentionally indistinguishable at the trust boundary. */
export class ComputeOptimizerExportPlanEnvelopeError extends Error {
  public constructor() {
    super("Compute Optimizer export plan envelope rejected");
    this.name = "ComputeOptimizerExportPlanEnvelopeError";
  }
}

function reject(): never {
  throw new ComputeOptimizerExportPlanEnvelopeError();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function assertContext(
  value: unknown,
): asserts value is ComputeOptimizerExportPlanEnvelopeContext {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "orgId",
      "customerId",
      "connectionId",
      "discoveryRunId",
      "planId",
      "contentSha256",
    ])
    || typeof value.orgId !== "string" || !IDENTIFIER.test(value.orgId)
    || typeof value.customerId !== "string" || !IDENTIFIER.test(value.customerId)
    || typeof value.connectionId !== "string" || !CONNECTION_ID.test(value.connectionId)
    || typeof value.discoveryRunId !== "string" || !DISCOVERY_RUN_ID.test(value.discoveryRunId)
    || typeof value.planId !== "string" || !PLAN_ID.test(value.planId)
    || typeof value.contentSha256 !== "string" || !SHA256.test(value.contentSha256)
  ) reject();
}

function assertEnvelope(
  value: unknown,
): asserts value is SealedComputeOptimizerExportPlan {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["format", "keyVersion", "ciphertext"])
    || value.format !== COMPUTE_OPTIMIZER_EXPORT_PLAN_ENVELOPE_FORMAT
    || typeof value.keyVersion !== "string" || !KEY_VERSION.test(value.keyVersion)
    || typeof value.ciphertext !== "string"
    || value.ciphertext.length < 1
    || value.ciphertext.length > MAXIMUM_CIPHERTEXT_CHARACTERS
    || !BASE64URL.test(value.ciphertext)
  ) reject();
}

function copiedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  const chunkBytes = 32 * 1_024;
  for (let offset = 0; offset < value.byteLength; offset += chunkBytes) {
    const chunk = value.subarray(offset, Math.min(value.byteLength, offset + chunkBytes));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string, maximumBytes: number): Uint8Array {
  if (
    !BASE64URL.test(value)
    || value.length > Math.ceil(maximumBytes * 4 / 3)
  ) reject();
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    if (binary.length > maximumBytes) reject();
    const decoded = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      decoded[index] = binary.charCodeAt(index);
    }
    if (encodeBase64Url(decoded) !== value) reject();
    return decoded;
  } catch (error) {
    if (error instanceof ComputeOptimizerExportPlanEnvelopeError) throw error;
    reject();
  }
}

function decodeRootKey(value: string): Uint8Array {
  if (!BASE64URL_KEY.test(value)) reject();
  const decoded = decodeBase64Url(value, ROOT_KEY_BYTES);
  if (decoded.byteLength !== ROOT_KEY_BYTES) reject();
  return decoded;
}

function associatedData(
  context: ComputeOptimizerExportPlanEnvelopeContext,
): Uint8Array {
  assertContext(context);
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: "sutra.compute-optimizer-export-plan-envelope-aad.v1",
    orgId: context.orgId,
    customerId: context.customerId,
    connectionId: context.connectionId,
    discoveryRunId: context.discoveryRunId,
    planId: context.planId,
    contentSha256: context.contentSha256,
  }));
}

function assertPlanContext(
  plan: ComputeOptimizerExportPlan,
  context: ComputeOptimizerExportPlanEnvelopeContext,
): void {
  if (
    plan.scope.orgId !== context.orgId
    || plan.scope.customerId !== context.customerId
    || plan.scope.connectionId !== context.connectionId
    || plan.planId !== context.planId
    || plan.contentSha256 !== context.contentSha256
  ) reject();
}

async function deriveEnvelopeKey(
  rootKey: Uint8Array,
  provider: Crypto,
): Promise<CryptoKey> {
  try {
    const source = await provider.subtle.importKey(
      "raw",
      copiedBuffer(rootKey),
      "HKDF",
      false,
      ["deriveKey"],
    );
    return await provider.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: copiedBuffer(HKDF_SALT),
        info: copiedBuffer(HKDF_INFO),
      },
      source,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } catch {
    reject();
  }
}

export class ComputeOptimizerExportPlanEnvelope {
  private constructor(
    private readonly key: CryptoKey,
    public readonly keyVersion: string,
    private readonly provider: Crypto,
  ) {}

  public static async fromRawRootKey(input: {
    readonly rootKey: Uint8Array;
    readonly keyVersion: string;
    readonly provider?: Crypto;
  }): Promise<ComputeOptimizerExportPlanEnvelope> {
    try {
      if (
        !isRecord(input)
        || !hasExactKeys(input, input.provider === undefined
          ? ["rootKey", "keyVersion"]
          : ["rootKey", "keyVersion", "provider"])
        || !(input.rootKey instanceof Uint8Array)
        || input.rootKey.byteLength !== ROOT_KEY_BYTES
        || !KEY_VERSION.test(input.keyVersion)
      ) reject();
      const provider = input.provider ?? globalThis.crypto;
      const key = await deriveEnvelopeKey(input.rootKey, provider);
      return new ComputeOptimizerExportPlanEnvelope(key, input.keyVersion, provider);
    } catch (error) {
      if (error instanceof ComputeOptimizerExportPlanEnvelopeError) throw error;
      reject();
    }
  }

  public static async fromEnvironment(
    environment: Readonly<Record<string, string | undefined>> = process.env,
    provider: Crypto = globalThis.crypto,
  ): Promise<ComputeOptimizerExportPlanEnvelope> {
    try {
      const configured = environment.SUTRA_FINOPS_EVIDENCE_REFERENCE_KEY;
      const keyVersion = environment.SUTRA_FINOPS_EVIDENCE_REFERENCE_KEY_VERSION;
      if (
        configured === undefined
        || configured !== configured.trim()
        || keyVersion === undefined
        || keyVersion !== keyVersion.trim()
        || !KEY_VERSION.test(keyVersion)
      ) reject();
      return await ComputeOptimizerExportPlanEnvelope.fromRawRootKey({
        rootKey: decodeRootKey(configured),
        keyVersion,
        provider,
      });
    } catch (error) {
      if (error instanceof ComputeOptimizerExportPlanEnvelopeError) throw error;
      reject();
    }
  }

  public async seal(
    candidate: unknown,
    context: ComputeOptimizerExportPlanEnvelopeContext,
  ): Promise<SealedComputeOptimizerExportPlan> {
    try {
      assertContext(context);
      const plan = await verifyComputeOptimizerExportPlan(candidate);
      assertPlanContext(plan, context);
      const plaintext = new TextEncoder().encode(JSON.stringify(plan));
      if (
        plaintext.byteLength < 2
        || plaintext.byteLength
          > COMPUTE_OPTIMIZER_EXPORT_PLAN_ENVELOPE_BOUNDS.maximumPlaintextBytes
      ) reject();
      const iv = this.provider.getRandomValues(new Uint8Array(IV_BYTES));
      const encrypted = new Uint8Array(await this.provider.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: copiedBuffer(iv),
          additionalData: copiedBuffer(associatedData(context)),
          tagLength: TAG_BYTES * 8,
        },
        this.key,
        copiedBuffer(plaintext),
      ));
      const sealed = new Uint8Array(iv.byteLength + encrypted.byteLength);
      sealed.set(iv);
      sealed.set(encrypted, iv.byteLength);
      if (
        sealed.byteLength
          > COMPUTE_OPTIMIZER_EXPORT_PLAN_ENVELOPE_BOUNDS.maximumCiphertextBytes
      ) reject();
      return Object.freeze({
        format: COMPUTE_OPTIMIZER_EXPORT_PLAN_ENVELOPE_FORMAT,
        keyVersion: this.keyVersion,
        ciphertext: encodeBase64Url(sealed),
      });
    } catch (error) {
      if (error instanceof ComputeOptimizerExportPlanEnvelopeError) throw error;
      reject();
    }
  }

  public async open(
    candidate: unknown,
    context: ComputeOptimizerExportPlanEnvelopeContext,
  ): Promise<ComputeOptimizerExportPlan> {
    try {
      assertContext(context);
      assertEnvelope(candidate);
      if (candidate.keyVersion !== this.keyVersion) reject();
      const sealed = decodeBase64Url(
        candidate.ciphertext,
        COMPUTE_OPTIMIZER_EXPORT_PLAN_ENVELOPE_BOUNDS.maximumCiphertextBytes,
      );
      if (sealed.byteLength < IV_BYTES + TAG_BYTES + 2) reject();
      const iv = sealed.subarray(0, IV_BYTES);
      const encrypted = sealed.subarray(IV_BYTES);
      const plaintext = new Uint8Array(await this.provider.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: copiedBuffer(iv),
          additionalData: copiedBuffer(associatedData(context)),
          tagLength: TAG_BYTES * 8,
        },
        this.key,
        copiedBuffer(encrypted),
      ));
      if (
        plaintext.byteLength < 2
        || plaintext.byteLength
          > COMPUTE_OPTIMIZER_EXPORT_PLAN_ENVELOPE_BOUNDS.maximumPlaintextBytes
      ) reject();
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      const parsed = JSON.parse(decoded) as unknown;
      const plan = await verifyComputeOptimizerExportPlan(parsed);
      assertPlanContext(plan, context);
      return plan;
    } catch (error) {
      if (error instanceof ComputeOptimizerExportPlanEnvelopeError) throw error;
      reject();
    }
  }
}

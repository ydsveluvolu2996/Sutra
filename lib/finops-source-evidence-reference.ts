/**
 * Application-level encryption for private FinOps evidence object references.
 *
 * This key is deliberately independent from AWS ExternalId encryption. The
 * ciphertext authenticates the complete tenant/source/generation binding as
 * AES-GCM associated data, so copying it to another snapshot cannot redirect a
 * read. Only the opaque EvidenceRepository object id is encrypted; storage
 * bucket names, URIs, and object keys never enter this boundary.
 */
import type { EncryptedFinopsEvidenceReference } from "../db/finops-source-snapshot-repository.ts";
import type { FinopsSourceId } from "./finops-source-health.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const OBJECT_ID = /^eobj_[a-f0-9]{32}$/u;
const GENERATION_ID = /^fss_[a-f0-9]{64}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const SEALED_REFERENCE = /^fsev1\.[A-Za-z0-9_-]{26,8186}$/u;
const FORMAT = "fsev1";

export interface FinopsEvidenceReferenceContext {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly sourceId: FinopsSourceId;
  readonly generationId: string;
}

export class FinopsEvidenceReferenceError extends Error {
  public readonly code: "INVALID_INPUT" | "KEY_UNAVAILABLE" | "REFERENCE_INVALID";

  public constructor(code: FinopsEvidenceReferenceError["code"]) {
    super("FinOps evidence reference operation rejected");
    this.name = "FinopsEvidenceReferenceError";
    this.code = code;
  }
}

function reject(code: FinopsEvidenceReferenceError["code"]): never {
  throw new FinopsEvidenceReferenceError(code);
}

function assertContext(context: FinopsEvidenceReferenceContext): void {
  if (
    !IDENTIFIER.test(context.organizationId) ||
    !IDENTIFIER.test(context.customerId) ||
    !CONNECTION_ID.test(context.connectionId) ||
    !IDENTIFIER.test(context.sourceId) ||
    !GENERATION_ID.test(context.generationId)
  ) reject("INVALID_INPUT");
}

function associatedData(context: FinopsEvidenceReferenceContext): Uint8Array {
  assertContext(context);
  return new TextEncoder().encode([
    "sutra.finops-evidence-reference.v1",
    context.organizationId,
    context.customerId,
    context.connectionId,
    context.sourceId,
    context.generationId,
  ].join("\0"));
}

function copiedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) reject("REFERENCE_INVALID");
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    reject("REFERENCE_INVALID");
  }
}

function decodeConfiguredKey(value: string): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64Url(value);
  } catch {
    return reject("KEY_UNAVAILABLE");
  }
  if (decoded.byteLength !== 32) reject("KEY_UNAVAILABLE");
  return decoded;
}

export class FinopsEvidenceReferenceSealer {
  private readonly key: CryptoKey;
  public readonly keyVersion: string;
  private readonly provider: Crypto;

  private constructor(
    key: CryptoKey,
    keyVersion: string,
    provider: Crypto,
  ) {
    this.key = key;
    this.keyVersion = keyVersion;
    this.provider = provider;
  }

  public static async fromRawKey(input: {
    readonly rawKey: Uint8Array;
    readonly keyVersion: string;
    readonly provider?: Crypto;
  }): Promise<FinopsEvidenceReferenceSealer> {
    if (
      !(input.rawKey instanceof Uint8Array) ||
      input.rawKey.byteLength !== 32 ||
      !KEY_VERSION.test(input.keyVersion)
    ) reject("KEY_UNAVAILABLE");
    const provider = input.provider ?? globalThis.crypto;
    let key: CryptoKey;
    try {
      key = await provider.subtle.importKey(
        "raw",
        copiedBuffer(input.rawKey),
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"],
      );
    } catch {
      reject("KEY_UNAVAILABLE");
    }
    return new FinopsEvidenceReferenceSealer(key, input.keyVersion, provider);
  }

  public static fromEnvironment(
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<FinopsEvidenceReferenceSealer> {
    const configuredKey = environment.SUTRA_FINOPS_EVIDENCE_REFERENCE_KEY?.trim();
    const keyVersion = environment.SUTRA_FINOPS_EVIDENCE_REFERENCE_KEY_VERSION?.trim();
    if (configuredKey === undefined || keyVersion === undefined) {
      return Promise.reject(new FinopsEvidenceReferenceError("KEY_UNAVAILABLE"));
    }
    return FinopsEvidenceReferenceSealer.fromRawKey({
      rawKey: decodeConfiguredKey(configuredKey),
      keyVersion,
    });
  }

  public async seal(
    objectId: string,
    context: FinopsEvidenceReferenceContext,
  ): Promise<EncryptedFinopsEvidenceReference> {
    if (!OBJECT_ID.test(objectId)) reject("INVALID_INPUT");
    const iv = this.provider.getRandomValues(new Uint8Array(12));
    let encrypted: ArrayBuffer;
    try {
      encrypted = await this.provider.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: copiedBuffer(iv),
          additionalData: copiedBuffer(associatedData(context)),
          tagLength: 128,
        },
        this.key,
        copiedBuffer(new TextEncoder().encode(objectId)),
      );
    } catch {
      reject("KEY_UNAVAILABLE");
    }
    const ciphertext = new Uint8Array(iv.byteLength + encrypted.byteLength);
    ciphertext.set(iv);
    ciphertext.set(new Uint8Array(encrypted), iv.byteLength);
    return {
      ciphertext: `${FORMAT}.${encodeBase64Url(ciphertext)}`,
      keyVersion: this.keyVersion,
    };
  }

  public async open(
    reference: EncryptedFinopsEvidenceReference,
    context: FinopsEvidenceReferenceContext,
  ): Promise<string> {
    if (
      reference.keyVersion !== this.keyVersion ||
      !SEALED_REFERENCE.test(reference.ciphertext)
    ) reject("REFERENCE_INVALID");
    const encoded = reference.ciphertext.slice(`${FORMAT}.`.length);
    const sealed = decodeBase64Url(encoded);
    if (sealed.byteLength < 12 + 16 + 1) reject("REFERENCE_INVALID");
    const iv = sealed.subarray(0, 12);
    const encrypted = sealed.subarray(12);
    try {
      const plaintext = await this.provider.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: copiedBuffer(iv),
          additionalData: copiedBuffer(associatedData(context)),
          tagLength: 128,
        },
        this.key,
        copiedBuffer(encrypted),
      );
      const objectId = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      if (!OBJECT_ID.test(objectId)) reject("REFERENCE_INVALID");
      return objectId;
    } catch (error) {
      if (error instanceof FinopsEvidenceReferenceError) throw error;
      reject("REFERENCE_INVALID");
    }
  }
}

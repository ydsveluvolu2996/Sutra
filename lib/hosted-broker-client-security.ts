const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const DER = /^[A-Za-z0-9_-]{40,8192}$/u;

export interface HostedBrokerClientSigningConfiguration {
  readonly clientKeyId: string;
  /** Base64url-encoded Ed25519 PKCS#8 DER. */
  readonly clientPrivateKey: string;
  readonly brokerKeyId: string;
  /** Base64url-encoded Ed25519 SPKI DER. */
  readonly brokerPublicKey: string;
}

export interface HostedBrokerSignedRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly nonce: string;
}

export class HostedBrokerClientSecurityError extends Error {
  public constructor() {
    super("Hosted broker asymmetric authentication failed");
    this.name = "HostedBrokerClientSecurityError";
  }
}

function decodeBase64Url(value: string): Uint8Array {
  if (!DER.test(value)) throw new HostedBrokerClientSecurityError();
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new HostedBrokerClientSecurityError();
  }
}

function encodeBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function toHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return toHex(await crypto.subtle.digest(
    "SHA-256",
    exactArrayBuffer(bytes),
  ));
}

function requestCanonical(input: {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly keyId: string;
  readonly bodySha256: string;
}): ArrayBuffer {
  return exactArrayBuffer(new TextEncoder().encode([
    "SUTRA-APP-BROKER-V1",
    input.method,
    input.path,
    input.timestamp,
    input.nonce,
    input.keyId,
    input.bodySha256,
  ].join("\n")));
}

function responseCanonical(input: {
  readonly status: number;
  readonly path: string;
  readonly nonce: string;
  readonly keyId: string;
  readonly bodySha256: string;
}): ArrayBuffer {
  return exactArrayBuffer(new TextEncoder().encode([
    "SUTRA-BROKER-APP-V1",
    String(input.status),
    input.path,
    input.nonce,
    input.keyId,
    input.bodySha256,
  ].join("\n")));
}

async function importPrivateKey(value: string): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      exactArrayBuffer(decodeBase64Url(value)),
      { name: "Ed25519" },
      false,
      ["sign"],
    );
  } catch {
    throw new HostedBrokerClientSecurityError();
  }
}

async function importPublicKey(value: string): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      "spki",
      exactArrayBuffer(decodeBase64Url(value)),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    throw new HostedBrokerClientSecurityError();
  }
}

function validConfiguration(config: HostedBrokerClientSigningConfiguration): boolean {
  return (
    KEY_ID.test(config.clientKeyId) &&
    KEY_ID.test(config.brokerKeyId) &&
    DER.test(config.clientPrivateKey) &&
    DER.test(config.brokerPublicKey)
  );
}

export async function signHostedBrokerRequest(input: {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly now: number;
  readonly nonce: string;
  readonly config: HostedBrokerClientSigningConfiguration;
}): Promise<HostedBrokerSignedRequest> {
  if (
    !validConfiguration(input.config) ||
    !/^[A-Z]{3,12}$/u.test(input.method) ||
    !input.path.startsWith("/") ||
    /[\r\n#]/u.test(input.path) ||
    !/^[A-Za-z0-9_-]{22,128}$/u.test(input.nonce) ||
    !Number.isSafeInteger(input.now)
  ) {
    throw new HostedBrokerClientSecurityError();
  }
  const timestamp = String(input.now);
  const bodySha256 = await sha256(input.body);
  const signature = await crypto.subtle.sign(
    "Ed25519",
    await importPrivateKey(input.config.clientPrivateKey),
    requestCanonical({
      method: input.method,
      path: input.path,
      timestamp,
      nonce: input.nonce,
      keyId: input.config.clientKeyId,
      bodySha256,
    }),
  );
  return {
    nonce: input.nonce,
    headers: {
      "x-sutra-timestamp": timestamp,
      "x-sutra-nonce": input.nonce,
      "x-sutra-key-id": input.config.clientKeyId,
      "x-sutra-signature": encodeBase64Url(signature),
    },
  };
}

export async function verifyHostedBrokerResponse(input: {
  readonly status: number;
  readonly path: string;
  readonly nonce: string;
  readonly body: string | Uint8Array;
  readonly headers: Headers;
  readonly config: HostedBrokerClientSigningConfiguration;
}): Promise<void> {
  if (!validConfiguration(input.config)) throw new HostedBrokerClientSecurityError();
  const keyId = input.headers.get("x-sutra-key-id");
  const signatureText = input.headers.get("x-sutra-signature");
  if (
    keyId !== input.config.brokerKeyId ||
    signatureText === null ||
    !SIGNATURE.test(signatureText)
  ) {
    throw new HostedBrokerClientSecurityError();
  }
  const signature = decodeBase64Url(signatureText);
  if (signature.byteLength !== 64) throw new HostedBrokerClientSecurityError();
  const verified = await crypto.subtle.verify(
    "Ed25519",
    await importPublicKey(input.config.brokerPublicKey),
    exactArrayBuffer(signature),
    responseCanonical({
      status: input.status,
      path: input.path,
      nonce: input.nonce,
      keyId,
      bodySha256: await sha256(input.body),
    }),
  );
  if (!verified) throw new HostedBrokerClientSecurityError();
}

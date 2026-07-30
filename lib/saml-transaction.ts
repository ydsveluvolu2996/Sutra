import { safeOidcReturnTo } from "./oidc-pkce.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TRANSACTION_TTL_MS = 5 * 60 * 1000;
const VERSION = "sutra.saml.transaction.v1";
const PROVIDER_ID = /^[a-z][a-z0-9_-]{1,31}$/u;

export interface SamlTransaction {
  readonly version: typeof VERSION;
  readonly provider: string;
  readonly requestId: string;
  readonly relayState: string;
  readonly returnTo: string;
  readonly invitationToken: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}

function randomBase64Url(bytesLength: number): string {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("SAML transaction is invalid");
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function encoded(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function key(encodedKey: string, usage: KeyUsage[]): Promise<CryptoKey> {
  const bytes = base64UrlDecode(encodedKey);
  if (bytes.length !== 32) throw new Error("SAML transaction key must contain 32 bytes");
  return crypto.subtle.importKey("raw", ownedBuffer(bytes), "AES-GCM", false, usage);
}

export function createSamlTransaction(
  provider: string,
  returnTo: string | null | undefined,
  invitationToken: string | null | undefined,
  now = Date.now(),
): SamlTransaction {
  if (!PROVIDER_ID.test(provider)) throw new Error("SAML provider id is invalid");
  return {
    version: VERSION,
    provider,
    requestId: `_${randomBase64Url(32)}`,
    relayState: randomBase64Url(32),
    returnTo: safeOidcReturnTo(returnTo),
    invitationToken: invitationToken && /^[A-Za-z0-9_-]{43}$/u.test(invitationToken) ? invitationToken : null,
    createdAt: now,
    expiresAt: now + TRANSACTION_TTL_MS,
  };
}

export async function sealSamlTransaction(transaction: SamlTransaction, encodedKey: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ownedBuffer(iv), additionalData: encoder.encode(VERSION), tagLength: 128 },
    await key(encodedKey, ["encrypt"]),
    encoder.encode(JSON.stringify(transaction)),
  );
  return `${encoded(iv)}.${encoded(new Uint8Array(ciphertext))}`;
}

function parseTransaction(value: unknown, now: number): SamlTransaction {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("SAML transaction is invalid");
  const candidate = value as Record<string, unknown>;
  const keys = ["createdAt", "expiresAt", "invitationToken", "provider", "relayState", "requestId", "returnTo", "version"];
  if (Object.keys(candidate).sort().join("\0") !== keys.join("\0")) throw new Error("SAML transaction is invalid");
  if (
    candidate.version !== VERSION
    || typeof candidate.provider !== "string" || !PROVIDER_ID.test(candidate.provider)
    || typeof candidate.requestId !== "string" || !/^_[A-Za-z0-9_-]{43}$/u.test(candidate.requestId)
    || typeof candidate.relayState !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(candidate.relayState)
    || typeof candidate.returnTo !== "string" || safeOidcReturnTo(candidate.returnTo) !== candidate.returnTo
    || (candidate.invitationToken !== null && (typeof candidate.invitationToken !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(candidate.invitationToken)))
    || typeof candidate.createdAt !== "number" || !Number.isSafeInteger(candidate.createdAt)
    || typeof candidate.expiresAt !== "number" || !Number.isSafeInteger(candidate.expiresAt)
    || candidate.expiresAt - candidate.createdAt !== TRANSACTION_TTL_MS
    || candidate.createdAt > now + 60_000
    || candidate.expiresAt <= now
  ) throw new Error("SAML transaction is invalid or expired");
  return candidate as unknown as SamlTransaction;
}

export async function openSamlTransaction(
  sealed: string,
  encodedKey: string,
  now = Date.now(),
): Promise<SamlTransaction> {
  if (sealed.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(sealed)) {
    throw new Error("SAML transaction cookie is invalid");
  }
  const [ivValue = "", ciphertextValue = ""] = sealed.split(".");
  const iv = base64UrlDecode(ivValue);
  if (iv.length !== 12) throw new Error("SAML transaction cookie is invalid");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ownedBuffer(iv), additionalData: encoder.encode(VERSION), tagLength: 128 },
    await key(encodedKey, ["decrypt"]),
    ownedBuffer(base64UrlDecode(ciphertextValue)),
  );
  return parseTransaction(JSON.parse(decoder.decode(plaintext)), now);
}

export function constantTimeSamlValue(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export const PASSWORD_ALGORITHM = "pbkdf2-sha256" as const;
export const PASSWORD_ITERATIONS = 600_000;
export const SESSION_TOKEN_BYTES = 32;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

const encoder = new TextEncoder();
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export interface PasswordDigest {
  readonly algorithm: typeof PASSWORD_ALGORITHM;
  readonly iterations: number;
  readonly salt: string;
  readonly hash: string;
}

export interface SealedTotpSecret {
  readonly ciphertext: string;
  readonly keyVersion: string;
}

function randomBytes(length: number): Uint8Array {
  const result = new Uint8Array(length);
  crypto.getRandomValues(result);
  return result;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url value");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function derivePassword(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: ownedBuffer(salt), iterations },
    material,
    256,
  );
  return new Uint8Array(bits);
}

export function validatePassword(password: unknown, email?: string): string {
  if (typeof password !== "string") throw new Error("Password must be a string");
  const byteLength = encoder.encode(password).byteLength;
  if (password.length < 14 || password.length > 128 || byteLength > 512) {
    throw new Error("Password must be between 14 and 128 characters");
  }
  if (/\p{Cc}/u.test(password)) throw new Error("Password contains unsupported control characters");
  if (email && password.toLocaleLowerCase("en-US").includes(email.toLocaleLowerCase("en-US"))) {
    throw new Error("Password must not contain the email address");
  }
  return password;
}

export async function hashPassword(password: string): Promise<PasswordDigest> {
  const salt = randomBytes(16);
  const hash = await derivePassword(password, salt, PASSWORD_ITERATIONS);
  return {
    algorithm: PASSWORD_ALGORITHM,
    iterations: PASSWORD_ITERATIONS,
    salt: base64UrlEncode(salt),
    hash: base64UrlEncode(hash),
  };
}

export async function verifyPassword(password: string, digest: PasswordDigest): Promise<boolean> {
  if (
    digest.algorithm !== PASSWORD_ALGORITHM ||
    !Number.isSafeInteger(digest.iterations) ||
    digest.iterations < PASSWORD_ITERATIONS ||
    digest.iterations > 2_000_000
  ) {
    return false;
  }
  try {
    const actual = await derivePassword(password, base64UrlDecode(digest.salt), digest.iterations);
    return constantTimeEqual(actual, base64UrlDecode(digest.hash));
  } catch {
    return false;
  }
}

export function generateSessionToken(): string {
  return base64UrlEncode(randomBytes(SESSION_TOKEN_BYTES));
}

export async function digestSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return base64UrlEncode(new Uint8Array(digest));
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(value: string): Uint8Array {
  const normalized = value.toUpperCase().replaceAll("=", "");
  if (!/^[A-Z2-7]+$/u.test(normalized)) throw new Error("Invalid TOTP secret");
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

async function totpAtStep(secret: string, step: number): Promise<string> {
  const counter = new Uint8Array(8);
  let remaining = step;
  for (let index = 7; index >= 0; index -= 1) {
    counter[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    ownedBuffer(base32Decode(secret)),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = (signature.at(-1) ?? 0) & 0x0f;
  const binary =
    ((signature[offset] ?? 0) & 0x7f) * 0x1000000 +
    (signature[offset + 1] ?? 0) * 0x10000 +
    (signature[offset + 2] ?? 0) * 0x100 +
    (signature[offset + 3] ?? 0);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export async function matchTotpCode(
  secret: string,
  code: unknown,
  nowMs = Date.now(),
  lastUsedStep: number | null = null,
): Promise<number | null> {
  if (typeof code !== "string" || !/^\d{6}$/u.test(code)) return null;
  const currentStep = Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
  for (const offset of [-1, 0, 1]) {
    const step = currentStep + offset;
    if (step <= (lastUsedStep ?? -1)) continue;
    const expected = await totpAtStep(secret, step);
    if (constantTimeEqual(encoder.encode(code), encoder.encode(expected))) return step;
  }
  return null;
}

export function totpUri(secret: string, email: string, issuer = "Sutra"): string {
  const label = `${issuer}:${email}`;
  const parameters = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${parameters.toString()}`;
}

function encryptionKey(value: string): Uint8Array {
  const decoded = base64UrlDecode(value);
  if (decoded.byteLength !== 32) throw new Error("The local authentication encryption key is invalid");
  return decoded;
}

export async function sealTotpSecret(
  secret: string,
  base64Key: string,
  keyVersion: string,
  userId: string,
): Promise<SealedTotpSecret> {
  const iv = randomBytes(12);
  const key = await crypto.subtle.importKey("raw", ownedBuffer(encryptionKey(base64Key)), "AES-GCM", false, ["encrypt"]);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ownedBuffer(iv), additionalData: encoder.encode(`sutra-totp\0${keyVersion}\0${userId}`) },
    key,
    encoder.encode(secret),
  );
  return {
    ciphertext: `totp1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(encrypted))}`,
    keyVersion,
  };
}

export async function openTotpSecret(
  sealed: SealedTotpSecret,
  base64Key: string,
  userId: string,
): Promise<string> {
  const parts = sealed.ciphertext.split(".");
  if (parts.length !== 3 || parts[0] !== "totp1") throw new Error("The stored TOTP secret is invalid");
  const key = await crypto.subtle.importKey("raw", ownedBuffer(encryptionKey(base64Key)), "AES-GCM", false, ["decrypt"]);
  const cleartext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: ownedBuffer(base64UrlDecode(parts[1] ?? "")),
      additionalData: encoder.encode(`sutra-totp\0${sealed.keyVersion}\0${userId}`),
    },
    key,
    ownedBuffer(base64UrlDecode(parts[2] ?? "")),
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(cleartext);
}

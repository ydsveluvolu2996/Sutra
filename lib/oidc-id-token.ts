const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_BYTES = 16 * 1024;

export interface OidcIdTokenVerification {
  readonly issuer: string;
  readonly clientId: string;
  readonly nonce: string;
  readonly jwks: { readonly keys: readonly OidcJsonWebKey[] };
  readonly now?: number;
}

export interface OidcJsonWebKey extends JsonWebKey {
  readonly kid?: string;
  readonly use?: string;
  readonly alg?: string;
}

export interface VerifiedOidcIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  readonly displayName: string;
  readonly authenticatedAt: number;
  readonly expiresAt: number;
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("OIDC token is malformed");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function parseObject(segment: string, label: string): Record<string, unknown> {
  const bytes = base64UrlDecode(segment);
  if (bytes.length === 0 || bytes.length > MAX_TOKEN_BYTES) throw new Error(`${label} is malformed`);
  const value: unknown = JSON.parse(decoder.decode(bytes));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  return value as Record<string, unknown>;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return difference === 0;
}

function boundedClaim(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} claim is invalid`);
  }
  return value;
}

function integerClaim(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} claim is invalid`);
  return value;
}

function validateAudience(payload: Record<string, unknown>, clientId: string): void {
  const audience = payload.aud;
  if (typeof audience === "string") {
    if (!constantTimeEqual(audience, clientId)) throw new Error("OIDC audience is invalid");
    return;
  }
  if (!Array.isArray(audience) || audience.length === 0 || audience.length > 8 || audience.some((entry) => typeof entry !== "string")) {
    throw new Error("OIDC audience is invalid");
  }
  if (!audience.some((entry) => constantTimeEqual(entry as string, clientId))) throw new Error("OIDC audience is invalid");
  if (audience.length > 1 && (typeof payload.azp !== "string" || !constantTimeEqual(payload.azp, clientId))) {
    throw new Error("OIDC authorized party is invalid");
  }
}

export async function verifyOidcIdToken(
  token: string,
  verification: OidcIdTokenVerification,
): Promise<VerifiedOidcIdentity> {
  if (token.length > MAX_TOKEN_BYTES || /\s/u.test(token)) throw new Error("OIDC token is malformed");
  const segments = token.split(".");
  if (segments.length !== 3) throw new Error("OIDC token is malformed");
  const [encodedHeader = "", encodedPayload = "", encodedSignature = ""] = segments;
  const header = parseObject(encodedHeader, "OIDC token header");
  const payload = parseObject(encodedPayload, "OIDC token payload");
  if (header.alg !== "RS256" || (header.typ !== undefined && header.typ !== "JWT")) throw new Error("OIDC signing algorithm is not allowed");
  const kid = boundedClaim(header.kid, "OIDC key identifier", 256);
  const candidates = verification.jwks.keys.filter((key) =>
    key.kid === kid && key.kty === "RSA" && (key.use === undefined || key.use === "sig") && (key.alg === undefined || key.alg === "RS256"),
  );
  if (candidates.length !== 1) throw new Error("OIDC signing key is unavailable or ambiguous");
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    candidates[0] as JsonWebKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const validSignature = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    ownedBuffer(base64UrlDecode(encodedSignature)),
    encoder.encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!validSignature) throw new Error("OIDC token signature is invalid");

  const issuer = boundedClaim(payload.iss, "OIDC issuer", 2048);
  if (!constantTimeEqual(issuer, verification.issuer)) throw new Error("OIDC issuer is invalid");
  validateAudience(payload, verification.clientId);
  const nonce = boundedClaim(payload.nonce, "OIDC nonce", 256);
  if (!constantTimeEqual(nonce, verification.nonce)) throw new Error("OIDC nonce is invalid");
  if (payload.token_use !== undefined && payload.token_use !== "id") throw new Error("OIDC token use is invalid");

  const nowSeconds = Math.floor((verification.now ?? Date.now()) / 1000);
  const issuedAt = integerClaim(payload.iat, "OIDC issued-at");
  const expiresAt = integerClaim(payload.exp, "OIDC expiry");
  const authenticatedAt = payload.auth_time === undefined ? issuedAt : integerClaim(payload.auth_time, "OIDC authentication time");
  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS || authenticatedAt > nowSeconds + CLOCK_SKEW_SECONDS) throw new Error("OIDC token was issued in the future");
  if (expiresAt <= nowSeconds - CLOCK_SKEW_SECONDS || expiresAt <= issuedAt || expiresAt - issuedAt > 60 * 60) throw new Error("OIDC token is expired or has an invalid lifetime");

  const subject = boundedClaim(payload.sub, "OIDC subject", 255);
  const email = boundedClaim(payload.email, "OIDC email", 254).toLocaleLowerCase("en-US");
  if (payload.email_verified !== true || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email)) throw new Error("OIDC email is not verified");
  const displayName = payload.name === undefined ? email : boundedClaim(payload.name, "OIDC display name", 100);
  return {
    issuer,
    subject,
    email,
    displayName,
    authenticatedAt: authenticatedAt * 1000,
    expiresAt: expiresAt * 1000,
  };
}

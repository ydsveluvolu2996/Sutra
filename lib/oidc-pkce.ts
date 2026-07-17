const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TRANSACTION_TTL_MS = 5 * 60 * 1000;
const TRANSACTION_VERSION = "sutra.oidc.transaction.v1";

export interface OidcClientConfiguration {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
}

export interface OidcAuthorizationTransaction {
  readonly version: typeof TRANSACTION_VERSION;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly returnTo: string;
  readonly invitationToken: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url value");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function boundedHttpsUrl(value: string, label: string): URL {
  if (value.length > 2048 || /[\r\n]/u.test(value)) throw new Error(`${label} is invalid`);
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error(`${label} must use HTTPS`);
  return parsed;
}

export function validateOidcClientConfiguration(configuration: OidcClientConfiguration): void {
  const issuer = boundedHttpsUrl(configuration.issuer, "OIDC issuer");
  if (issuer.search) throw new Error("OIDC issuer must not contain a query");
  boundedHttpsUrl(configuration.authorizationEndpoint, "OIDC authorization endpoint");
  boundedHttpsUrl(configuration.tokenEndpoint, "OIDC token endpoint");
  const redirect = boundedHttpsUrl(configuration.redirectUri, "OIDC redirect URI");
  if (redirect.search) throw new Error("OIDC redirect URI must not contain a query");
  if (!/^[A-Za-z0-9._:-]{3,256}$/u.test(configuration.clientId)) throw new Error("OIDC client identifier is invalid");
}

export function safeOidcReturnTo(value: string | null | undefined): string {
  if (!value || value.length > 1024 || !value.startsWith("/") || value.startsWith("//") || /[\r\n]/u.test(value)) return "/dashboard";
  const parsed = new URL(value, "https://sutra.invalid");
  if (parsed.origin !== "https://sutra.invalid" || parsed.pathname.startsWith("/api/auth/") || parsed.pathname === "/login") return "/dashboard";
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

async function codeChallenge(verifier: string): Promise<string> {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
}

export async function createOidcAuthorization(
  configuration: OidcClientConfiguration,
  returnTo: string | null | undefined,
  now = Date.now(),
  invitationToken?: string | null,
): Promise<{ readonly url: string; readonly transaction: OidcAuthorizationTransaction }> {
  validateOidcClientConfiguration(configuration);
  const transaction: OidcAuthorizationTransaction = {
    version: TRANSACTION_VERSION,
    state: base64UrlEncode(randomBytes(32)),
    nonce: base64UrlEncode(randomBytes(32)),
    codeVerifier: base64UrlEncode(randomBytes(32)),
    returnTo: safeOidcReturnTo(returnTo),
    invitationToken: invitationToken && /^[A-Za-z0-9_-]{43}$/u.test(invitationToken)
      ? invitationToken
      : null,
    createdAt: now,
    expiresAt: now + TRANSACTION_TTL_MS,
  };
  const url = new URL(configuration.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: configuration.clientId,
    redirect_uri: configuration.redirectUri,
    scope: "openid email profile",
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge: await codeChallenge(transaction.codeVerifier),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), transaction };
}

async function transactionKey(encoded: string, usage: KeyUsage[]): Promise<CryptoKey> {
  const bytes = base64UrlDecode(encoded);
  if (bytes.length !== 32) throw new Error("OIDC transaction key must contain 32 bytes");
  return crypto.subtle.importKey("raw", ownedBuffer(bytes), "AES-GCM", false, usage);
}

export async function sealOidcTransaction(
  transaction: OidcAuthorizationTransaction,
  encodedKey: string,
): Promise<string> {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ownedBuffer(iv), additionalData: encoder.encode(TRANSACTION_VERSION), tagLength: 128 },
    await transactionKey(encodedKey, ["encrypt"]),
    encoder.encode(JSON.stringify(transaction)),
  );
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

function parsedTransaction(value: unknown, now: number): OidcAuthorizationTransaction {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("OIDC transaction is invalid");
  const candidate = value as Record<string, unknown>;
  const exactKeys = ["version", "state", "nonce", "codeVerifier", "returnTo", "invitationToken", "createdAt", "expiresAt"];
  if (Object.keys(candidate).sort().join("\0") !== exactKeys.sort().join("\0")) throw new Error("OIDC transaction shape is invalid");
  if (
    candidate.version !== TRANSACTION_VERSION ||
    typeof candidate.state !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(candidate.state) ||
    typeof candidate.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(candidate.nonce) ||
    typeof candidate.codeVerifier !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(candidate.codeVerifier) ||
    typeof candidate.returnTo !== "string" || safeOidcReturnTo(candidate.returnTo) !== candidate.returnTo ||
    (candidate.invitationToken !== null &&
      (typeof candidate.invitationToken !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(candidate.invitationToken))) ||
    typeof candidate.createdAt !== "number" || !Number.isSafeInteger(candidate.createdAt) ||
    typeof candidate.expiresAt !== "number" || !Number.isSafeInteger(candidate.expiresAt) ||
    candidate.expiresAt - candidate.createdAt !== TRANSACTION_TTL_MS ||
    candidate.createdAt > now + 60_000 || candidate.expiresAt <= now
  ) throw new Error("OIDC transaction is invalid or expired");
  return candidate as unknown as OidcAuthorizationTransaction;
}

export async function openOidcTransaction(
  sealed: string,
  encodedKey: string,
  now = Date.now(),
): Promise<OidcAuthorizationTransaction> {
  if (sealed.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(sealed)) throw new Error("OIDC transaction cookie is invalid");
  const [encodedIv = "", encodedCiphertext = ""] = sealed.split(".");
  const iv = base64UrlDecode(encodedIv);
  if (iv.length !== 12) throw new Error("OIDC transaction cookie is invalid");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ownedBuffer(iv), additionalData: encoder.encode(TRANSACTION_VERSION), tagLength: 128 },
    await transactionKey(encodedKey, ["decrypt"]),
    ownedBuffer(base64UrlDecode(encodedCiphertext)),
  );
  return parsedTransaction(JSON.parse(decoder.decode(plaintext)), now);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return difference === 0;
}

export function validateOidcCallback(
  callbackUrl: string,
  transaction: OidcAuthorizationTransaction,
): string {
  const url = new URL(callbackUrl);
  if (url.searchParams.has("error")) throw new Error("The identity provider rejected the sign-in request");
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!constantTimeEqual(state, transaction.state)) throw new Error("OIDC callback state is invalid");
  if (!/^[A-Za-z0-9._~-]{8,2048}$/u.test(code)) throw new Error("OIDC authorization code is invalid");
  return code;
}

export function oidcTokenRequestBody(
  configuration: OidcClientConfiguration,
  code: string,
  codeVerifier: string,
): URLSearchParams {
  validateOidcClientConfiguration(configuration);
  if (!/^[A-Za-z0-9._~-]{8,2048}$/u.test(code)) throw new Error("OIDC authorization code is invalid");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(codeVerifier)) throw new Error("OIDC PKCE verifier is invalid");
  return new URLSearchParams({
    grant_type: "authorization_code",
    client_id: configuration.clientId,
    code,
    redirect_uri: configuration.redirectUri,
    code_verifier: codeVerifier,
  });
}

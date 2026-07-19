import type { ApiTokenRepository, AuthenticatedToken, PublicApiScope } from "../db/api-token-repository.ts";

/**
 * Shared contract for the public API (/api/public/v1):
 * - Bearer token auth against hashed service-account tokens; failures map to
 *   401 (missing/unknown/expired/revoked), 403 (scope), or 429 (quota) with a
 *   stable JSON error envelope — the reason is stated, never leaked beyond
 *   what the caller is entitled to know.
 * - Cursor pagination with an opaque base64url cursor. Page size is capped;
 *   the envelope always says whether more data exists.
 * - Responses are versioned by path (v1) and never cache.
 */

export const PUBLIC_API_MAX_PAGE_SIZE = 100;
export const PUBLIC_API_DEFAULT_PAGE_SIZE = 50;

export class PublicApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "PublicApiError";
    this.status = status;
    this.code = code;
  }
}

export function publicJson(data: unknown, init?: { status?: number; nextCursor?: string | null }): Response {
  const body: Record<string, unknown> = { data };
  if (init?.nextCursor !== undefined) body.page = { next: init.nextCursor };
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export function publicError(error: unknown): Response {
  const status = error instanceof PublicApiError ? error.status : 500;
  const code = error instanceof PublicApiError ? error.code : "INTERNAL_ERROR";
  const message = error instanceof PublicApiError ? error.message : "The request could not be processed";
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (status === 401) headers["www-authenticate"] = 'Bearer realm="sutra-public-api"';
  if (status === 429) headers["retry-after"] = "60";
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers });
}

/** Extract the bearer token string from an Authorization header. Pure. */
export function extractBearerToken(authorizationHeader: string | null): string | null {
  if (authorizationHeader === null) return null;
  const match = /^Bearer\s+(\S+)$/u.exec(authorizationHeader.trim());
  return match === null ? null : match[1];
}

export async function authenticatePublicRequest(
  request: Request,
  requiredScope: PublicApiScope,
  repository: ApiTokenRepository,
): Promise<AuthenticatedToken> {
  const bearer = extractBearerToken(request.headers.get("authorization"));
  if (bearer === null) {
    throw new PublicApiError(401, "AUTHENTICATION_REQUIRED", "Provide a service-account token as 'Authorization: Bearer <token>'");
  }
  const verification = await repository.verify(bearer);
  if (!verification.ok) {
    if (verification.reason === "rate-limited") {
      throw new PublicApiError(429, "RATE_LIMITED", "The token exceeded its request quota; retry after the current minute");
    }
    // Malformed, unknown, revoked and expired all read as an invalid credential.
    throw new PublicApiError(401, "INVALID_TOKEN", "The service-account token is not valid");
  }
  if (!verification.token.scopes.includes(requiredScope)) {
    throw new PublicApiError(403, "SCOPE_DENIED", `The token does not carry the '${requiredScope}' scope`);
  }
  return verification.token;
}

function toBase64Url(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

/** Opaque offset cursor. Pure and total: any malformed cursor is a 400. */
export function encodeCursor(offset: number): string {
  return toBase64Url(JSON.stringify({ o: offset }));
}

export function decodeCursor(cursor: string | null): number {
  if (cursor === null || cursor === "") return 0;
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(cursor));
    if (typeof parsed === "object" && parsed !== null && Number.isSafeInteger((parsed as { o?: unknown }).o) && ((parsed as { o: number }).o) >= 0) {
      return (parsed as { o: number }).o;
    }
  } catch {
    /* fall through to the typed error */
  }
  throw new PublicApiError(400, "INVALID_CURSOR", "The cursor is not valid; restart from the first page");
}

export function parsePageSize(raw: string | null): number {
  if (raw === null) return PUBLIC_API_DEFAULT_PAGE_SIZE;
  if (!/^\d{1,3}$/u.test(raw)) throw new PublicApiError(400, "INVALID_LIMIT", "limit must be a positive integer");
  const value = Number(raw);
  if (value < 1 || value > PUBLIC_API_MAX_PAGE_SIZE) {
    throw new PublicApiError(400, "INVALID_LIMIT", `limit must be between 1 and ${PUBLIC_API_MAX_PAGE_SIZE}`);
  }
  return value;
}

/** Slice a full result set into a page + next cursor. Pure. */
export function paginate<T>(items: readonly T[], offset: number, limit: number): { page: readonly T[]; nextCursor: string | null } {
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return { page, nextCursor: nextOffset < items.length ? encodeCursor(nextOffset) : null };
}

export async function sha256HexOf(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Service-account tokens for the public API. The token secret is shown ONCE
// at mint time and only its SHA-256 is stored — there is no way to read a
// token back. Verification is a hash lookup (no secret comparison in
// application code), scoped strictly to the token's organization+customer.
// Quotas are per-token sliding minute buckets; idempotency records pin a key
// to the exact request hash so a replayed key with a different body is a
// conflict, never a silent re-execution.

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const TOKEN_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._:/-]{0,63}$/u;
const TOKEN_ID = /^pat_[a-f0-9]{32}$/u;
const TOKEN_VALUE = /^sutra_pat_[a-f0-9]{64}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

export const PUBLIC_API_SCOPES = [
  "read:resources",
  "read:findings",
  "read:cases",
  "read:snapshots",
  "read:compliance",
  "read:vulnerabilities",
  "write:cases",
] as const;
export type PublicApiScope = (typeof PUBLIC_API_SCOPES)[number];

export const PUBLIC_API_RATE_LIMIT_PER_MINUTE = 120;
const MAX_TOKENS_PER_ORG = 25;

export interface ApiTokenScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface MintedToken {
  readonly id: string;
  readonly name: string;
  /** The full secret — returned exactly once, never stored. */
  readonly token: string;
  readonly tokenPrefix: string;
  readonly scopes: readonly PublicApiScope[];
  readonly expiresAt: string | null;
}

export interface ApiTokenSummary {
  readonly id: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly scopes: readonly PublicApiScope[];
  readonly expiresAt: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export interface AuthenticatedToken {
  readonly id: string;
  readonly orgId: string;
  readonly customerId: string;
  readonly scopes: readonly PublicApiScope[];
  /** The user who minted the token — public-API writes attribute to them. */
  readonly createdBy: string;
}

export type TokenVerification =
  | { readonly ok: true; readonly token: AuthenticatedToken }
  | { readonly ok: false; readonly reason: "malformed" | "unknown" | "revoked" | "expired" | "rate-limited" };

export class ApiTokenRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "LIMIT_EXCEEDED";

  public constructor(code: ApiTokenRepositoryError["code"]) {
    super("API token operation rejected");
    this.name = "ApiTokenRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new ApiTokenRepositoryError("INVALID_INPUT");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseScopes(json: string): PublicApiScope[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((scope): scope is PublicApiScope => PUBLIC_API_SCOPES.includes(scope as PublicApiScope));
  } catch {
    return [];
  }
}

export class ApiTokenRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  public async mint(
    scope: ApiTokenScope,
    name: string,
    scopes: readonly string[],
    expiresAt: string | null,
    createdBy: string,
    now = Date.now(),
  ): Promise<MintedToken> {
    if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId) || !TOKEN_NAME.test(name) || !IDENTIFIER.test(createdBy)) invalid();
    const validScopes = [...new Set(scopes)].filter((entry): entry is PublicApiScope =>
      PUBLIC_API_SCOPES.includes(entry as PublicApiScope));
    if (validScopes.length === 0 || validScopes.length !== new Set(scopes).size) invalid();
    if (expiresAt !== null) {
      const expiryMs = Date.parse(expiresAt);
      if (!Number.isFinite(expiryMs) || expiryMs <= now) invalid();
    }
    const db = await this.ready();
    const countRow = await db.prepare(
      `SELECT COUNT(*) AS total FROM api_tokens WHERE org_id = ? AND revoked_at IS NULL`,
    ).bind(scope.orgId).first<{ total: number }>();
    if (Number(countRow?.total ?? 0) >= MAX_TOKENS_PER_ORG) throw new ApiTokenRepositoryError("LIMIT_EXCEEDED");
    const id = `pat_${randomHex(16)}`;
    const token = `sutra_pat_${randomHex(32)}`;
    const tokenPrefix = token.slice(0, 16);
    const tokenSha256 = await sha256Hex(token);
    const timestamp = new Date(now).toISOString();
    const result = await db.prepare(
      `INSERT INTO api_tokens (id, org_id, customer_id, name, token_prefix, token_sha256, scopes_json, expires_at, created_by, created_at)
       SELECT ?, c.org_id, c.id, ?, ?, ?, ?, ?, ?, ?
         FROM customers c
        WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')`,
    ).bind(
      id, name, tokenPrefix, tokenSha256, JSON.stringify(validScopes), expiresAt, createdBy, timestamp,
      scope.customerId, scope.orgId,
    ).run();
    if (Number(result.meta?.changes ?? 0) === 0) throw new ApiTokenRepositoryError("SCOPE_NOT_FOUND");
    return { id, name, token, tokenPrefix, scopes: validScopes, expiresAt };
  }

  public async list(scope: ApiTokenScope): Promise<readonly ApiTokenSummary[]> {
    if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)) invalid();
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT id, name, token_prefix, scopes_json, expires_at, created_by, created_at, last_used_at, revoked_at
         FROM api_tokens WHERE org_id = ? AND customer_id = ? ORDER BY created_at DESC`,
    ).bind(scope.orgId, scope.customerId).all<{
      id: string; name: string; token_prefix: string; scopes_json: string; expires_at: string | null;
      created_by: string; created_at: string; last_used_at: string | null; revoked_at: string | null;
    }>();
    return (rows.results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      tokenPrefix: row.token_prefix,
      scopes: parseScopes(row.scopes_json),
      expiresAt: row.expires_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    }));
  }

  public async revoke(scope: ApiTokenScope, id: string, now = Date.now()): Promise<boolean> {
    if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId) || !TOKEN_ID.test(id)) invalid();
    const db = await this.ready();
    const result = await db.prepare(
      `UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND org_id = ? AND customer_id = ? AND revoked_at IS NULL`,
    ).bind(new Date(now).toISOString(), id, scope.orgId, scope.customerId).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  /** Verify a bearer token, enforce the per-minute quota, and touch last-used. */
  public async verify(tokenValue: string, now = Date.now()): Promise<TokenVerification> {
    if (typeof tokenValue !== "string" || !TOKEN_VALUE.test(tokenValue)) return { ok: false, reason: "malformed" };
    const db = await this.ready();
    const tokenSha256 = await sha256Hex(tokenValue);
    const row = await db.prepare(
      `SELECT id, org_id, customer_id, scopes_json, expires_at, revoked_at, created_by FROM api_tokens WHERE token_sha256 = ?`,
    ).bind(tokenSha256).first<{
      id: string; org_id: string; customer_id: string; scopes_json: string; expires_at: string | null; revoked_at: string | null; created_by: string;
    }>();
    if (row === null || row === undefined) return { ok: false, reason: "unknown" };
    if (row.revoked_at !== null) return { ok: false, reason: "revoked" };
    if (row.expires_at !== null && Date.parse(row.expires_at) <= now) return { ok: false, reason: "expired" };
    // Sliding minute-bucket quota: increment first, then check — the request
    // that crosses the limit is itself rejected.
    const bucket = new Date(now).toISOString().slice(0, 16);
    await db.prepare(
      `INSERT INTO api_token_usage (token_id, minute_bucket, request_count) VALUES (?, ?, 1)
       ON CONFLICT (token_id, minute_bucket) DO UPDATE SET request_count = api_token_usage.request_count + 1`,
    ).bind(row.id, bucket).run();
    const usage = await db.prepare(
      `SELECT request_count FROM api_token_usage WHERE token_id = ? AND minute_bucket = ?`,
    ).bind(row.id, bucket).first<{ request_count: number }>();
    if (Number(usage?.request_count ?? 0) > PUBLIC_API_RATE_LIMIT_PER_MINUTE) {
      return { ok: false, reason: "rate-limited" };
    }
    await db.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`)
      .bind(new Date(now).toISOString(), row.id).run();
    return {
      ok: true,
      token: { id: row.id, orgId: row.org_id, customerId: row.customer_id, scopes: parseScopes(row.scopes_json), createdBy: row.created_by },
    };
  }

  /** Returns the stored response for a replayed key, "conflict" when the key
   * was used with a different request, or null when the key is new. */
  public async findIdempotentReplay(
    token: AuthenticatedToken,
    key: string,
    requestSha256: string,
  ): Promise<{ status: number; body: string } | "conflict" | null> {
    if (!IDEMPOTENCY_KEY.test(key) || !SHA256_HEX.test(requestSha256)) invalid();
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT request_sha256, response_status, response_json FROM api_idempotency_keys WHERE token_id = ? AND idempotency_key = ?`,
    ).bind(token.id, key).first<{ request_sha256: string; response_status: number; response_json: string }>();
    if (row === null || row === undefined) return null;
    if (row.request_sha256 !== requestSha256) return "conflict";
    return { status: Number(row.response_status), body: row.response_json };
  }

  public async storeIdempotentResponse(
    token: AuthenticatedToken,
    key: string,
    requestSha256: string,
    status: number,
    body: string,
    now = Date.now(),
  ): Promise<void> {
    if (!IDEMPOTENCY_KEY.test(key) || !SHA256_HEX.test(requestSha256)) invalid();
    const db = await this.ready();
    await db.prepare(
      `INSERT INTO api_idempotency_keys (id, org_id, token_id, idempotency_key, request_sha256, response_status, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (token_id, idempotency_key) DO NOTHING`,
    ).bind(
      `idk_${randomHex(16)}`, token.orgId, token.id, key, requestSha256, status, body, new Date(now).toISOString(),
    ).run();
  }
}

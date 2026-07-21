import { LocalAuthError } from "../db/auth-repository";
import { assertSameOrigin, readBoundedJson } from "./aws-pilot-security";
import { assertAuthenticationRequest, assertLocalAuthRequest } from "./api-auth";
import { jsonResponse } from "./pilot-server";

const PUBLIC_AUTH_CODES = new Set([
  "AUTHENTICATION_REQUIRED",
  "BOOTSTRAP_ALREADY_COMPLETED",
  "IDENTITY_NOT_PROVISIONED",
  "INVALID_CREDENTIALS",
  "INVALID_INPUT",
  "MFA_ALREADY_ENROLLED",
  "MFA_CODE_INVALID",
  "MFA_ENROLLMENT_REQUIRED",
  "MFA_REQUIRED",
  "MFA_RECENT_REQUIRED",
  "LOGIN_RATE_LIMITED",
  "PERSISTENCE_FAILED",
]);

/**
 * Resolves the caller's client IP for per-source rate limiting. Uses the
 * RIGHT-MOST entry of `X-Forwarded-For` — the hop appended by the trusted edge
 * proxy (the EC2 Caddy front door), which also pins `X-Forwarded-For` to its own
 * observed peer. A client-supplied left-most value is therefore NOT honored: it
 * cannot be used to mint unlimited independent throttle buckets. This mirrors
 * the rest of the auth code, which never trusts a client-supplied
 * `x-forwarded-for`. Returns null when no forwarded chain is present (e.g. a
 * direct loopback dev request), in which case the limiter buckets it as
 * unattributed. Used ONLY for throttling, never for authorization.
 */
export function clientSourceKey(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",");
    const trusted = hops[hops.length - 1]?.trim();
    if (trusted && trusted.length <= 64) return trusted;
  }
  return null;
}

export function assertLocalAuthMutation(request: Request): void {
  assertLocalAuthRequest(request);
  assertSameOrigin(request);
}

export function assertAuthMutation(request: Request): void {
  assertAuthenticationRequest(request);
  assertSameOrigin(request);
}

export function exactInputObject(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LocalAuthError(400, "INVALID_INPUT", "The authentication request is invalid");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    requiredKeys.some((key) => !(key in record))
  ) {
    throw new LocalAuthError(400, "INVALID_INPUT", "The authentication request is invalid");
  }
  return record;
}

export function boundedInputString(
  value: unknown,
  options: {
    readonly label: string;
    readonly minimum?: number;
    readonly maximum: number;
    readonly trim?: boolean;
  },
): string {
  if (typeof value !== "string") {
    throw new LocalAuthError(400, "INVALID_INPUT", `Enter a valid ${options.label}`);
  }
  const result = options.trim === false ? value : value.trim();
  if (
    result.length < (options.minimum ?? 1) ||
    result.length > options.maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)
  ) {
    throw new LocalAuthError(400, "INVALID_INPUT", `Enter a valid ${options.label}`);
  }
  return result;
}

export async function readAuthJson(request: Request, maximumBytes: number): Promise<unknown> {
  return readBoundedJson(request, maximumBytes);
}

export function authErrorResponse(error: unknown): Response {
  if (error instanceof LocalAuthError && PUBLIC_AUTH_CODES.has(error.code)) {
    return jsonResponse(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  const candidate = error as { readonly code?: unknown } | null;
  if (candidate?.code === "INVALID_INPUT") {
    return jsonResponse(
      { error: { code: "INVALID_INPUT", message: "The authentication request is invalid" } },
      { status: 400 },
    );
  }
  return jsonResponse(
    { error: { code: "AUTH_REQUEST_FAILED", message: "Sutra could not complete the authentication request" } },
    { status: 500 },
  );
}

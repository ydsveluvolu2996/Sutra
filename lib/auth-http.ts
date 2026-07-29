import { LocalAuthError } from "../db/auth-repository";
import { assertSameOrigin, readBoundedJson } from "./aws-pilot-security";
import { assertAuthenticationRequest, assertLocalAuthRequest, configuredPublicOrigin } from "./api-auth";
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
  "TURNSTILE_CONFIGURATION_INVALID",
  "TURNSTILE_REJECTED",
  "TURNSTILE_REQUIRED",
  "TURNSTILE_UNAVAILABLE",
]);

/**
 * Resolves the caller's client IP for per-source rate limiting. Uses the
 * RIGHT-MOST entry of `X-Forwarded-For`. In production, the unexposed Caddy
 * front door replaces that header with Cloudflare's canonical
 * `CF-Connecting-IP` value before forwarding and then removes the competing
 * source headers. A client-supplied left-most value is therefore NOT honored:
 * it cannot mint unlimited independent throttle buckets. Returns null when no
 * forwarded chain is present (for example a direct loopback development
 * request), in which case the limiter uses its shared unattributed bucket.
 * Used ONLY for throttling, never for authorization.
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

/**
 * Same-origin enforcement for auth mutations, anchored to the CONFIGURED origin.
 *
 * WHY THE EXPECTED ORIGIN IS NOT DERIVED FROM THE REQUEST. `assertSameOrigin(request)` with no
 * second argument compares the browser's Origin against an origin it computes from
 * the request itself. Under wrangler 4.114 / miniflare 4.20260722 that computed
 * value is the LISTENING SOCKET (https://127.0.0.1:3000) no matter what the reverse
 * proxy sets, because the runtime rewrites Host on the way in — verified through the
 * real Caddy chain, where only an Origin of the socket address matched. Every browser
 * write therefore failed with "The request origin is invalid".
 *
 * Reading the Host header instead does NOT fix it; the header is already rewritten by
 * then. The only value that survives the runtime is the one we configured ourselves,
 * so the comparison is anchored to SUTRA_PUBLIC_ORIGIN and no longer depends on how a
 * runtime version reconstructs a URL.
 *
 * Absent stays permissive-to-self (local dev has no canonical origin), and the
 * cross-origin rejection is unaffected either way: a foreign Origin never equals the
 * configured one.
 */
export function assertLocalAuthMutation(
  request: Request,
  publicOrigin: string | undefined = configuredPublicOrigin(),
): void {
  assertLocalAuthRequest(request);
  assertSameOrigin(request, normalizedPublicOrigin(publicOrigin));
}

export function assertAuthMutation(
  request: Request,
  publicOrigin: string | undefined = configuredPublicOrigin(),
): void {
  assertAuthenticationRequest(request);
  assertSameOrigin(request, normalizedPublicOrigin(publicOrigin));
}

/**
 * Blank is treated as absent so an unset-but-present binding (compose renders
 * `SUTRA_PUBLIC_ORIGIN: ""` when the variable is empty) does not reach
 * canonicalOrigin as the empty string and get reported as an invalid origin —
 * which would turn a missing configuration into the same opaque rejection this
 * whole change exists to remove.
 */
function normalizedPublicOrigin(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
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
  if (
    candidate !== null &&
    typeof candidate.code === "string" &&
    PUBLIC_AUTH_CODES.has(candidate.code)
  ) {
    const turnstile = error as {
      readonly code: string;
      readonly message?: unknown;
      readonly status?: unknown;
    };
    const status =
      turnstile.status === 400 || turnstile.status === 503
        ? turnstile.status
        : 500;
    const message =
      typeof turnstile.message === "string"
        ? turnstile.message
        : "Sutra could not complete the security check";
    return jsonResponse(
      { error: { code: turnstile.code, message } },
      { status },
    );
  }
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

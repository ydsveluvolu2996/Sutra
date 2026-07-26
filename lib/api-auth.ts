import { env } from "cloudflare:workers";
import {
  LocalAuthError,
  getLocalSession,
  requireMfa,
  type AuthenticatedLocalSession,
  type LocalAuthSecrets,
} from "../db/auth-repository";
import {
  authorize,
  resolveMembershipManagementScope,
  type Capability,
  type MembershipManagementScope,
} from "./auth-policy";
import { requestMatchesCanonicalOrigin } from "./request-origin";

export const LOCAL_SESSION_COOKIE = "sutra_session";

interface LocalAuthRuntimeEnv {
  readonly SUTRA_DEPLOYMENT_ENV?: string;
  readonly SUTRA_LOCAL_MODE?: string;
  readonly SUTRA_IDENTITY_MODE?: string;
  readonly SUTRA_PUBLIC_ORIGIN?: string;
  readonly SUTRA_AUTH_ENCRYPTION_KEY?: string;
  readonly SUTRA_AUTH_KEY_VERSION?: string;
  readonly SUTRA_LOCAL_BOOTSTRAP_TOKEN?: string;
  readonly SUTRA_PASSWORD_MFA_REQUIRED?: string;
  readonly SUTRA_PASSWORD_IDENTITY_ENABLED?: string;
  readonly SUTRA_PRIVATE_BETA_PASSWORD_ENABLED?: string;
}

export interface AuthorizedPilotActor {
  readonly id: string;
  readonly email: string;
  readonly local: boolean;
  readonly orgId: string;
  readonly authenticated: AuthenticatedLocalSession;
}

function runtimeEnv(): LocalAuthRuntimeEnv {
  return env as unknown as LocalAuthRuntimeEnv;
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * Managed-password identity is the network-reachable form of the local
 * email + password + TOTP stack. It reuses the SAME vetted credential
 * verification, mandatory-MFA gate (`requireMfa`), per-account throttling and
 * sealed-cookie sessions as loopback local mode — the ONLY differences are that
 * requests arrive on the canonical HTTPS public origin instead of a loopback
 * host. Production stays disabled behind `SUTRA_PASSWORD_IDENTITY_ENABLED`
 * until an adversarial auth review signs off. Approved staging pilots use the
 * separate `SUTRA_PRIVATE_BETA_PASSWORD_ENABLED` switch; that switch can never
 * enable production.
 */
export function isManagedPasswordRuntime(): boolean {
  const config = runtimeEnv();
  const environmentGate = config.SUTRA_DEPLOYMENT_ENV === "staging"
    ? config.SUTRA_PRIVATE_BETA_PASSWORD_ENABLED === "true"
    : config.SUTRA_DEPLOYMENT_ENV === "production" && config.SUTRA_PASSWORD_IDENTITY_ENABLED === "true";
  const localModeDisabled = config.SUTRA_DEPLOYMENT_ENV === "staging"
    ? config.SUTRA_LOCAL_MODE === "false"
    : config.SUTRA_LOCAL_MODE !== "true";
  return (
    environmentGate &&
    localModeDisabled &&
    config.SUTRA_IDENTITY_MODE === "password" &&
    config.SUTRA_PASSWORD_MFA_REQUIRED === "true"
  );
}

export function assertLocalAuthRequest(request: Request): void {
  const url = new URL(request.url);
  const config = runtimeEnv();
  // Loopback local mode: email/password over http on 127.0.0.1/localhost/::1.
  const loopbackLocal = config.SUTRA_LOCAL_MODE === "true" && isLoopbackHostname(url.hostname);
  // Managed-password network mode: the same credential stack, pinned to the
  // canonical HTTPS public origin. Origin pinning here is defense-in-depth on
  // top of the deployment boundary (which already 421s an origin mismatch) and
  // the per-mutation same-origin assertion.
  const managedPassword =
    isManagedPasswordRuntime() && requestMatchesCanonicalOrigin(request, config.SUTRA_PUBLIC_ORIGIN);
  if (!loopbackLocal && !managedPassword) {
    throw new LocalAuthError(404, "AUTHENTICATION_REQUIRED", "Local authentication is unavailable");
  }
}

export function isHostedOidcRuntime(): boolean {
  const config = runtimeEnv();
  return (
    (config.SUTRA_DEPLOYMENT_ENV === "staging" || config.SUTRA_DEPLOYMENT_ENV === "production") &&
    config.SUTRA_LOCAL_MODE !== "true" &&
    config.SUTRA_IDENTITY_MODE === "oidc"
  );
}

export function assertAuthenticationRequest(request: Request): void {
  if (!isHostedOidcRuntime()) {
    assertLocalAuthRequest(request);
    return;
  }
  if (!requestMatchesCanonicalOrigin(request, runtimeEnv().SUTRA_PUBLIC_ORIGIN)) {
    throw new LocalAuthError(404, "AUTHENTICATION_REQUIRED", "Authentication is unavailable");
  }
}

export function localAuthSecrets(): LocalAuthSecrets {
  const config = runtimeEnv();
  const encryptionKey = config.SUTRA_AUTH_ENCRYPTION_KEY?.trim();
  const keyVersion = config.SUTRA_AUTH_KEY_VERSION?.trim() || "local-auth-v1";
  if (
    !encryptionKey ||
    !/^[A-Za-z0-9_-]{43}$/u.test(encryptionKey) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(keyVersion)
  ) {
    throw new LocalAuthError(503, "PERSISTENCE_FAILED", "Run the local setup before using authentication");
  }
  return { encryptionKey, keyVersion };
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (cookie === null) return null;
  for (const segment of cookie.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    if (segment.slice(0, separator).trim() !== name) continue;
    const value = segment.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

export function sessionTokenFromRequest(request: Request): string | null {
  const token = cookieValue(request, LOCAL_SESSION_COOKIE);
  return token !== null && /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}

function sessionCookieSecuritySuffix(request: Request): string {
  const url = new URL(request.url);
  // The session cookie is ALWAYS marked Secure except on a genuine loopback
  // HTTP dev box. Crucially, when a TLS-terminating edge (e.g. the EC2 Caddy
  // proxy) served the public request over HTTPS it forwards
  // `X-Forwarded-Proto: https`; we honour that and keep the cookie Secure even
  // though the internal hop to the app is loopback HTTP. Spoofing the header can
  // only ADD Secure (fail-safe), never drop it, and on a loopback-only box there
  // is no untrusted client to spoof it.
  const forwardedProto = request.headers.get("x-forwarded-proto")?.trim().toLowerCase();
  const servedOverHttps = url.protocol === "https:" || forwardedProto === "https";
  const localHttp =
    runtimeEnv().SUTRA_LOCAL_MODE === "true" &&
    isLoopbackHostname(url.hostname) &&
    url.protocol !== "https:" &&
    !servedOverHttps;
  const secure = localHttp ? "" : "; Secure";
  return `; Path=/; HttpOnly; SameSite=Strict${secure}`;
}

/**
 * Issues a browser-session cookie, deliberately without Max-Age or Expires.
 * The browser should discard it when the browser session ends; the server-side
 * idle and absolute deadlines remain authoritative if a browser restores
 * session cookies after a crash or "continue where you left off" restart.
 */
export function sessionCookie(request: Request, token: string): string {
  return `${LOCAL_SESSION_COOKIE}=${encodeURIComponent(token)}${sessionCookieSecuritySuffix(request)}`;
}

export function expiredSessionCookie(request: Request): string {
  return `${LOCAL_SESSION_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${sessionCookieSecuritySuffix(request)}`;
}

export async function requireApiSession(
  request: Request,
  options: { readonly requireMfa?: boolean } = {},
): Promise<AuthenticatedLocalSession> {
  assertAuthenticationRequest(request);
  const token = sessionTokenFromRequest(request);
  // Generic every-request authorize path: nothing downstream reads
  // `session.availableOrganizations` here (only the session/org-switcher views
  // do), so skip its extra memberships-join query.
  const authenticated =
    token === null ? null : await getLocalSession(token, undefined, { withAvailableOrganizations: false });
  if (authenticated === null) {
    throw new LocalAuthError(401, "AUTHENTICATION_REQUIRED", "Sign in before using the Sutra workspace");
  }
  if (options.requireMfa !== false) requireMfa(authenticated);
  return authenticated;
}

export function assertSessionCapability(
  authenticated: AuthenticatedLocalSession,
  capability: Capability,
  customerId?: string,
): void {
  const decision = authorize(authenticated.subject, {
    orgId: authenticated.subject.orgId,
    capability,
    ...(customerId === undefined ? {} : { customerId }),
  });
  if (!decision.allowed) {
    throw new LocalAuthError(403, "AUTHORIZATION_DENIED", "This account cannot access the requested workspace scope");
  }
}

function pilotActorFromSession(authenticated: AuthenticatedLocalSession): AuthorizedPilotActor {
  return {
    id: authenticated.subject.userId,
    email: authenticated.session.user.email,
    local: !isHostedOidcRuntime(),
    orgId: authenticated.subject.orgId,
    authenticated,
  };
}

export async function authorizePilotRequest(
  request: Request,
  capability: Capability,
  customerId?: string,
): Promise<AuthorizedPilotActor> {
  const authenticated = await requireApiSession(request);
  assertSessionCapability(authenticated, capability, customerId);
  return pilotActorFromSession(authenticated);
}

/**
 * Authorizes a membership-management request under EITHER org-wide
 * `membership:manage` (org operators) OR customer-scoped
 * `membership:manage:customer` (customer_admin). The resolved
 * {@link MembershipManagementScope} is handed to the repository so the actual
 * per-customer scoping is enforced in SQL, not merely at the capability gate.
 */
export async function authorizeMembershipManagementRequest(
  request: Request,
): Promise<{ readonly actor: AuthorizedPilotActor; readonly scope: MembershipManagementScope }> {
  const authenticated = await requireApiSession(request);
  const scope = resolveMembershipManagementScope(authenticated.subject);
  if (scope === null) {
    throw new LocalAuthError(
      403,
      "AUTHORIZATION_DENIED",
      "This account cannot manage organization membership",
    );
  }
  return { actor: pilotActorFromSession(authenticated), scope };
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function assertBootstrapToken(request: Request): Promise<void> {
  assertLocalAuthRequest(request);
  const expected = runtimeEnv().SUTRA_LOCAL_BOOTSTRAP_TOKEN?.trim();
  // Loopback-only path (assertLocalAuthRequest above), so distinguishing a
  // missing server config from a wrong token is a helpful operator hint, not
  // an internet-facing information leak.
  if (!expected || expected.length < 32) {
    throw new LocalAuthError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Bootstrap is not configured on this deployment: set SUTRA_LOCAL_BOOTSTRAP_TOKEN (>=32 chars) on the host and restart.",
    );
  }
  const suppliedHeader = request.headers.get("authorization") ?? "";
  const supplied = suppliedHeader.startsWith("Bearer ") ? suppliedHeader.slice(7) : "";
  if (supplied.length < 32 || !constantTimeEqual(await sha256(supplied), await sha256(expected))) {
    throw new LocalAuthError(401, "AUTHENTICATION_REQUIRED", "The local bootstrap token is invalid");
  }
}

import { env } from "cloudflare:workers";
import {
  LOCAL_AUTH_ORG_ID,
  LocalAuthError,
  getLocalSession,
  requireMfa,
  type AuthenticatedLocalSession,
  type LocalAuthSecrets,
} from "../db/auth-repository";
import { authorize, type Capability } from "./auth-policy";

export const LOCAL_SESSION_COOKIE = "sutra_session";

interface LocalAuthRuntimeEnv {
  readonly SUTRA_LOCAL_MODE?: string;
  readonly SUTRA_AUTH_ENCRYPTION_KEY?: string;
  readonly SUTRA_AUTH_KEY_VERSION?: string;
  readonly SUTRA_LOCAL_BOOTSTRAP_TOKEN?: string;
}

export interface AuthorizedPilotActor {
  readonly id: string;
  readonly email: string;
  readonly local: true;
  readonly orgId: string;
  readonly authenticated: AuthenticatedLocalSession;
}

function runtimeEnv(): LocalAuthRuntimeEnv {
  return env as unknown as LocalAuthRuntimeEnv;
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function assertLocalAuthRequest(request: Request): void {
  const url = new URL(request.url);
  if (runtimeEnv().SUTRA_LOCAL_MODE !== "true" || !isLoopbackHostname(url.hostname)) {
    throw new LocalAuthError(404, "AUTHENTICATION_REQUIRED", "Local authentication is unavailable");
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

export function sessionCookie(request: Request, token: string, maximumAgeSeconds: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${LOCAL_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maximumAgeSeconds}${secure}`;
}

export function expiredSessionCookie(request: Request): string {
  return sessionCookie(request, "", 0);
}

export async function requireApiSession(
  request: Request,
  options: { readonly requireMfa?: boolean } = {},
): Promise<AuthenticatedLocalSession> {
  assertLocalAuthRequest(request);
  const token = sessionTokenFromRequest(request);
  const authenticated = token === null ? null : await getLocalSession(token);
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
    orgId: LOCAL_AUTH_ORG_ID,
    capability,
    ...(customerId === undefined ? {} : { customerId }),
  });
  if (!decision.allowed) {
    throw new LocalAuthError(403, "AUTHORIZATION_DENIED", "This account cannot access the requested workspace scope");
  }
}

export async function authorizePilotRequest(
  request: Request,
  capability: Capability,
  customerId?: string,
): Promise<AuthorizedPilotActor> {
  const authenticated = await requireApiSession(request);
  assertSessionCapability(authenticated, capability, customerId);
  return {
    id: authenticated.subject.userId,
    email: authenticated.session.user.email,
    local: true,
    orgId: authenticated.subject.orgId,
    authenticated,
  };
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
  const suppliedHeader = request.headers.get("authorization") ?? "";
  const supplied = suppliedHeader.startsWith("Bearer ") ? suppliedHeader.slice(7) : "";
  if (
    !expected ||
    expected.length < 32 ||
    supplied.length < 32 ||
    !constantTimeEqual(await sha256(supplied), await sha256(expected))
  ) {
    throw new LocalAuthError(401, "AUTHENTICATION_REQUIRED", "The local bootstrap token is invalid");
  }
}

import { env } from "cloudflare:workers";
import { LocalAuthError } from "../db/auth-repository";
import { assertAuthenticationRequest, sessionTokenFromRequest } from "./api-auth";
import type { HostedOidcConfiguration } from "./hosted-oidc";

export const OIDC_TRANSACTION_COOKIE = "sutra_oidc_transaction";

interface HostedOidcRuntimeEnvironment {
  readonly SUTRA_PUBLIC_ORIGIN?: string;
  readonly SUTRA_OIDC_ISSUER?: string;
  readonly SUTRA_OIDC_AUTHORIZATION_ENDPOINT?: string;
  readonly SUTRA_OIDC_TOKEN_ENDPOINT?: string;
  readonly SUTRA_OIDC_CLIENT_ID?: string;
  readonly SUTRA_OIDC_TRANSACTION_KEY?: string;
}

function runtime(): HostedOidcRuntimeEnvironment {
  return env as unknown as HostedOidcRuntimeEnvironment;
}

export function hostedOidcRuntimeConfiguration(request: Request): {
  readonly client: HostedOidcConfiguration;
  readonly transactionKey: string;
} {
  assertAuthenticationRequest(request);
  const config = runtime();
  const origin = config.SUTRA_PUBLIC_ORIGIN?.trim() ?? "";
  const issuer = config.SUTRA_OIDC_ISSUER?.trim() ?? "";
  const transactionKey = config.SUTRA_OIDC_TRANSACTION_KEY?.trim() ?? "";
  const client: HostedOidcConfiguration = {
    issuer,
    authorizationEndpoint: config.SUTRA_OIDC_AUTHORIZATION_ENDPOINT?.trim() ?? "",
    tokenEndpoint: config.SUTRA_OIDC_TOKEN_ENDPOINT?.trim() ?? "",
    clientId: config.SUTRA_OIDC_CLIENT_ID?.trim() ?? "",
    redirectUri: `${origin}/api/auth/oidc/callback`,
    jwksUrl: `${issuer.replace(/\/$/u, "")}/.well-known/jwks.json`,
  };
  if (!/^[A-Za-z0-9_-]{43}$/u.test(transactionKey)) {
    throw new LocalAuthError(503, "PERSISTENCE_FAILED", "Hosted authentication is not configured");
  }
  return { client, transactionKey };
}

export function requestCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (cookie === null) return null;
  for (const segment of cookie.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0 || segment.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(segment.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function oidcTransactionCookie(value: string, maximumAgeSeconds = 5 * 60): string {
  return `${OIDC_TRANSACTION_COOKIE}=${encodeURIComponent(value)}; Path=/api/auth/oidc; HttpOnly; Secure; SameSite=Lax; Max-Age=${maximumAgeSeconds}`;
}

export function expiredOidcTransactionCookie(): string {
  return oidcTransactionCookie("", 0);
}

export function hasSessionCookie(request: Request): boolean {
  return sessionTokenFromRequest(request) !== null;
}

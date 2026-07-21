import { env } from "cloudflare:workers";
import { LocalAuthError } from "../db/auth-repository";
import { assertAuthenticationRequest, sessionTokenFromRequest } from "./api-auth";
import type { HostedOidcConfiguration } from "./hosted-oidc";
import { parseHostedOidcProviders, type HostedOidcProviderConfig } from "./hosted-oidc-providers";

export const OIDC_TRANSACTION_COOKIE = "sutra_oidc_transaction";

interface HostedOidcRuntimeEnvironment {
  readonly SUTRA_PUBLIC_ORIGIN?: string;
  readonly SUTRA_OIDC_PROVIDERS?: string;
  readonly SUTRA_OIDC_TRANSACTION_KEY?: string;
  readonly SUTRA_HOSTED_SELF_SERVE_SIGNUP?: string;
}

function runtime(): HostedOidcRuntimeEnvironment {
  return env as unknown as HostedOidcRuntimeEnvironment;
}

function notConfigured(): never {
  throw new LocalAuthError(503, "PERSISTENCE_FAILED", "Hosted authentication is not configured");
}

/**
 * The validated set of configured OIDC providers plus the sealed-transaction
 * key and canonical origin. Fails closed (503) unless the origin is pinned, the
 * transaction key is a managed 256-bit value, and at least one provider is fully
 * configured with no configuration issues.
 */
function hostedOidcBase(request: Request): {
  readonly origin: string;
  readonly transactionKey: string;
  readonly providers: readonly HostedOidcProviderConfig[];
} {
  assertAuthenticationRequest(request);
  const config = runtime();
  const origin = config.SUTRA_PUBLIC_ORIGIN?.trim() ?? "";
  const transactionKey = config.SUTRA_OIDC_TRANSACTION_KEY?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/u.test(transactionKey)) notConfigured();
  const { providers, issues } = parseHostedOidcProviders(config.SUTRA_OIDC_PROVIDERS);
  if (issues.length > 0 || providers.length === 0) notConfigured();
  return { origin, transactionKey, providers };
}

function toClientConfiguration(provider: HostedOidcProviderConfig, origin: string): HostedOidcConfiguration {
  return {
    issuer: provider.issuer,
    authorizationEndpoint: provider.authorizationEndpoint,
    tokenEndpoint: provider.tokenEndpoint,
    clientId: provider.clientId,
    redirectUri: `${origin}/api/auth/oidc/callback`,
    jwksUrl: provider.jwksUri,
  };
}

/** The ids of the configured providers, for the login-provider selection UI. */
export function hostedOidcProviderIds(request: Request): readonly string[] {
  return hostedOidcBase(request).providers.map((provider) => provider.id);
}

/**
 * The sealed-transaction key, resolved independently of any provider. The
 * callback needs it to OPEN the sealed transaction (which is what reveals the
 * provider) before it can resolve that provider's configuration.
 */
export function hostedOidcTransactionKey(request: Request): string {
  return hostedOidcBase(request).transactionKey;
}

/**
 * Resolve the client configuration for exactly ONE configured provider, chosen
 * by its id. An unknown or malformed provider id fails closed and never falls
 * back to another provider — the sealed provider must be honoured exactly on the
 * callback so a token from one federated IdP can never satisfy another's login.
 */
export function resolveHostedOidcProvider(request: Request, providerId: string): {
  readonly client: HostedOidcConfiguration;
  readonly transactionKey: string;
  readonly providerId: string;
} {
  const { origin, transactionKey, providers } = hostedOidcBase(request);
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (provider === undefined) {
    throw new LocalAuthError(404, "AUTHENTICATION_REQUIRED", "The requested sign-in provider is unavailable");
  }
  return { client: toClientConfiguration(provider, origin), transactionKey, providerId: provider.id };
}

/**
 * Self-serve organisation creation on first login. This is OFF by default and is
 * a SEPARATE switch from the SUTRA_HOSTED_ENABLED master gate: even with hosted
 * mode live, provisioning stays invite-only unless an operator explicitly opts
 * into open signup. Anything other than the exact string "true" keeps it off.
 */
export function isHostedSelfServeSignupEnabled(): boolean {
  return runtime().SUTRA_HOSTED_SELF_SERVE_SIGNUP === "true";
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

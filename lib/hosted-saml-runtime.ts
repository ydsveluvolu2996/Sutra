import { env } from "cloudflare:workers";
import { LocalAuthError } from "../db/auth-repository.ts";
import { assertAuthenticationRequest } from "./api-auth.ts";
import {
  parseHostedSamlProviders,
  type HostedSamlProviderConfig,
} from "./hosted-saml-providers.ts";

export const SAML_TRANSACTION_COOKIE = "sutra_saml_transaction";

interface HostedSamlEnvironment {
  readonly SUTRA_DEPLOYMENT_ENV?: string;
  readonly SUTRA_HOSTED_ENABLED?: string;
  readonly SUTRA_IDENTITY_MODE?: string;
  readonly SUTRA_PUBLIC_ORIGIN?: string;
  readonly SUTRA_SAML_PROVIDERS?: string;
  readonly SUTRA_SAML_TRANSACTION_KEY?: string;
}

export interface ResolvedSamlProvider {
  readonly provider: HostedSamlProviderConfig;
  readonly transactionKey: string;
  readonly acsUrl: string;
  readonly spEntityId: string;
  readonly identityIssuer: string;
}

function runtime(): HostedSamlEnvironment {
  return env as unknown as HostedSamlEnvironment;
}

function unavailable(): never {
  throw new LocalAuthError(503, "PERSISTENCE_FAILED", "Enterprise SAML is not configured");
}

function exactOrigin(value: string | undefined): string | null {
  if (!value || /[\r\n]/u.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function base(request: Request): {
  readonly origin: string;
  readonly transactionKey: string;
  readonly providers: readonly HostedSamlProviderConfig[];
} {
  assertAuthenticationRequest(request);
  const config = runtime();
  if (
    config.SUTRA_DEPLOYMENT_ENV !== "production"
    || config.SUTRA_HOSTED_ENABLED !== "true"
    || config.SUTRA_IDENTITY_MODE !== "federated"
  ) unavailable();
  const origin = exactOrigin(config.SUTRA_PUBLIC_ORIGIN);
  const transactionKey = config.SUTRA_SAML_TRANSACTION_KEY?.trim() ?? "";
  const parsed = parseHostedSamlProviders(config.SUTRA_SAML_PROVIDERS);
  if (
    origin === null
    || !/^[A-Za-z0-9_-]{43}$/u.test(transactionKey)
    || parsed.issues.length > 0
    || parsed.providers.length === 0
  ) unavailable();
  return { origin, transactionKey, providers: parsed.providers };
}

function resolved(
  origin: string,
  transactionKey: string,
  provider: HostedSamlProviderConfig,
): ResolvedSamlProvider {
  const spEntityId = `${origin}/api/auth/saml/metadata`;
  return {
    provider,
    transactionKey,
    acsUrl: `${origin}/api/auth/saml/callback`,
    spEntityId,
    identityIssuer: `${origin}/identity/saml/${encodeURIComponent(provider.tenantId)}/${provider.id}`,
  };
}

export function resolveHostedSamlProvider(request: Request, providerId: string): ResolvedSamlProvider {
  const current = base(request);
  const provider = current.providers.find((candidate) => candidate.id === providerId);
  if (provider === undefined) {
    throw new LocalAuthError(404, "AUTHENTICATION_REQUIRED", "The requested SAML provider is unavailable");
  }
  return resolved(current.origin, current.transactionKey, provider);
}

export function resolveDefaultHostedSamlProvider(request: Request): ResolvedSamlProvider {
  const current = base(request);
  if (current.providers.length !== 1 || current.providers[0] === undefined) {
    throw new LocalAuthError(400, "INVALID_INPUT", "Choose an enterprise SAML provider");
  }
  return resolved(current.origin, current.transactionKey, current.providers[0]);
}

export function hostedSamlProviderSummaries(request: Request): readonly {
  readonly id: string;
  readonly label: string;
}[] {
  return base(request).providers.map((provider) => ({ id: provider.id, label: provider.label }));
}

export function hostedSamlTransactionKey(request: Request): string {
  return base(request).transactionKey;
}

export function samlServiceProviderMetadata(request: Request): {
  readonly acsUrl: string;
  readonly spEntityId: string;
} {
  const current = base(request);
  return {
    acsUrl: `${current.origin}/api/auth/saml/callback`,
    spEntityId: `${current.origin}/api/auth/saml/metadata`,
  };
}

export function samlTransactionCookie(value: string, maximumAgeSeconds = 5 * 60): string {
  return `${SAML_TRANSACTION_COOKIE}=${encodeURIComponent(value)}; Path=/api/auth/saml; HttpOnly; Secure; SameSite=None; Max-Age=${maximumAgeSeconds}`;
}

export function expiredSamlTransactionCookie(): string {
  return samlTransactionCookie("", 0);
}

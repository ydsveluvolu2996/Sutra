import { env } from "cloudflare:workers";

import { LocalAuthError } from "../db/auth-repository";
import { isHostedOidcRuntime } from "./api-auth";
import {
  hostedOidcProviderIds,
  resolveHostedOidcProvider,
} from "./hosted-oidc-runtime";
import {
  hostedSamlProviderSummaries,
  resolveHostedSamlProvider,
} from "./hosted-saml-runtime";

interface IdentityProviderEnvironment {
  readonly SUTRA_IDENTITY_MODE?: string;
  readonly SUTRA_OIDC_PROVIDERS?: string;
}

export interface HostedIdentityProviderSummary {
  readonly kind: "oidc" | "saml";
  readonly id: string;
  readonly label: string;
}

export interface HostedIdentityProviderDescriptor {
  readonly kind: "oidc" | "saml";
  readonly id: string;
}

const PROVIDER_ID = /^[a-z][a-z0-9_-]{1,31}$/u;

function oidcLabel(id: string): string {
  if (id === "zoho") return "Zoho SSO";
  if (id === "entra") return "Microsoft Entra ID";
  if (id === "google") return "Google";
  return `${id.slice(0, 1).toLocaleUpperCase("en-US")}${id.slice(1)} OIDC`;
}

function descriptor(value: unknown): HostedIdentityProviderDescriptor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalAuthError(400, "INVALID_INPUT", "Choose a configured sign-in provider");
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (
    keys.length !== 2
    || keys[0] !== "id"
    || keys[1] !== "kind"
    || (candidate.kind !== "oidc" && candidate.kind !== "saml")
    || typeof candidate.id !== "string"
    || !PROVIDER_ID.test(candidate.id)
  ) {
    throw new LocalAuthError(400, "INVALID_INPUT", "Choose a configured sign-in provider");
  }
  return { kind: candidate.kind, id: candidate.id };
}

/**
 * Returns only non-secret provider identifiers and labels. The exact issuer is
 * deliberately kept server-side so a browser cannot substitute an arbitrary
 * issuer when creating an invitation or SCIM connector.
 */
export function hostedIdentityProviderSummaries(
  request: Request,
): readonly HostedIdentityProviderSummary[] {
  if (!isHostedOidcRuntime()) return [];
  const config = env as unknown as IdentityProviderEnvironment;
  const mode = config.SUTRA_IDENTITY_MODE;
  const includeOidc = mode === "oidc"
    || (mode === "federated" && Boolean(config.SUTRA_OIDC_PROVIDERS?.trim()));
  const oidc = includeOidc
    ? hostedOidcProviderIds(request).map((id) => ({
        kind: "oidc" as const,
        id,
        label: oidcLabel(id),
      }))
    : [];
  const saml = mode === "federated"
    ? hostedSamlProviderSummaries(request).map((provider) => ({
        kind: "saml" as const,
        id: provider.id,
        label: provider.label,
      }))
    : [];
  const providers = [...oidc, ...saml];
  if (providers.length === 0) {
    throw new LocalAuthError(503, "PERSISTENCE_FAILED", "Enterprise identity providers are not configured");
  }
  return providers;
}

/**
 * Resolves a browser-supplied provider descriptor against the server's exact
 * runtime configuration. No raw issuer supplied by a browser is ever trusted.
 */
export function resolveHostedIdentityProviderIssuer(
  request: Request,
  value: unknown,
): string {
  if (!isHostedOidcRuntime()) {
    throw new LocalAuthError(400, "INVALID_INPUT", "Federated sign-in is not enabled");
  }
  const selected = descriptor(value);
  const configured = hostedIdentityProviderSummaries(request).some(
    (provider) => provider.kind === selected.kind && provider.id === selected.id,
  );
  if (!configured) {
    throw new LocalAuthError(400, "INVALID_INPUT", "Choose a configured sign-in provider");
  }
  return selected.kind === "oidc"
    ? resolveHostedOidcProvider(request, selected.id).client.issuer
    : resolveHostedSamlProvider(request, selected.id).identityIssuer;
}

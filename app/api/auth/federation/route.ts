import { env } from "cloudflare:workers";
import { assertAuthenticationRequest } from "../../../../lib/api-auth";
import { parseHostedOidcProviders } from "../../../../lib/hosted-oidc-providers";
import { hostedOidcProviderIds } from "../../../../lib/hosted-oidc-runtime";
import { hostedSamlProviderSummaries } from "../../../../lib/hosted-saml-runtime";

export const dynamic = "force-dynamic";

interface FederationEnvironment {
  readonly SUTRA_IDENTITY_MODE?: string;
  readonly SUTRA_OIDC_PROVIDERS?: string;
  readonly SUTRA_HOSTED_SELF_SERVE_SIGNUP?: string;
}

function oidcLabel(id: string): string {
  if (id === "zoho") return "Zoho SSO";
  if (id === "entra") return "Microsoft Entra ID";
  if (id === "google") return "Google";
  return `${id.slice(0, 1).toLocaleUpperCase("en-US")}${id.slice(1)} OIDC`;
}

export async function GET(request: Request): Promise<Response> {
  try {
    assertAuthenticationRequest(request);
    const config = env as unknown as FederationEnvironment;
    const mode = config.SUTRA_IDENTITY_MODE;
    const oidcIds = mode === "oidc"
      ? hostedOidcProviderIds(request)
      : (() => {
          const parsed = parseHostedOidcProviders(config.SUTRA_OIDC_PROVIDERS);
          if (parsed.issues.length > 0 && config.SUTRA_OIDC_PROVIDERS?.trim()) throw new Error("OIDC configuration is invalid");
          return parsed.providers.map((provider) => provider.id);
        })();
    const saml = mode === "federated" ? hostedSamlProviderSummaries(request) : [];
    const providers = [
      ...oidcIds.map((id) => ({
        id,
        kind: "oidc" as const,
        label: oidcLabel(id),
        startUrl: `/api/auth/oidc/start?provider=${encodeURIComponent(id)}`,
      })),
      ...saml.map((provider) => ({
        id: provider.id,
        kind: "saml" as const,
        label: provider.label,
        startUrl: `/api/auth/saml/start?provider=${encodeURIComponent(provider.id)}`,
      })),
    ].sort((left, right) => {
      if (left.id === "google") return -1;
      if (right.id === "google") return 1;
      return 0;
    });
    if (providers.length === 0) throw new Error("No federation providers are configured");
    return Response.json({
      identityMode: mode,
      invitationOnly: config.SUTRA_HOSTED_SELF_SERVE_SIGNUP !== "true",
      providers,
      ...(saml.length === 0
        ? {}
        : {
            saml: {
              metadataUrl: "/api/auth/saml/metadata",
              assertionConsumerServiceUrl: "/api/auth/saml/callback",
              assertionsSigned: true,
            },
          }),
    }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json(
      { error: { code: "AUTH_REQUEST_FAILED", message: "Enterprise identity is unavailable" } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

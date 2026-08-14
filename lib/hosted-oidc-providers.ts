// Multi-provider hosted OIDC configuration.
//
// The hosted deployment federates identity to MORE THAN ONE OpenID Connect
// provider side by side (Google and Microsoft Entra today, N in general). Each
// provider is pinned independently: its own issuer, authorization/token
// endpoints, JWKS URI, and client id. A single validated JSON list keeps the
// worker environment interface flat while supporting an arbitrary provider set.
//
// SUTRA_OIDC_PROVIDERS is a JSON array, for example:
//   [
//     {
//       "id": "google",
//       "issuer": "https://accounts.google.com",
//       "authorizationEndpoint": "https://accounts.google.com/o/oauth2/v2/auth",
//       "tokenEndpoint": "https://oauth2.googleapis.com/token",
//       "jwksUri": "https://www.googleapis.com/oauth2/v3/certs",
//       "clientId": "1234567890-abc.apps.googleusercontent.com",
//       "authorizationPrompt": "select_account"
//     },
//     {
//       "id": "entra",
//       "issuer": "https://login.microsoftonline.com/<tenant-guid>/v2.0",
//       "authorizationEndpoint": "https://login.microsoftonline.com/<tenant-guid>/oauth2/v2.0/authorize",
//       "tokenEndpoint": "https://login.microsoftonline.com/<tenant-guid>/oauth2/v2.0/token",
//       "jwksUri": "https://login.microsoftonline.com/<tenant-guid>/discovery/v2.0/keys",
//       "clientId": "00000000-0000-0000-0000-000000000000"
//     }
//   ]
//
// The issuer is pinned EXACTLY per provider (Entra's issuer is tenant-scoped),
// and the JWKS URI is an operator-trusted configuration value — it need not be
// issuer-relative because Google publishes its keys on a different host. The
// per-request binding to a single provider is enforced at token verification
// (issuer + audience + signature), never inferred from the token itself.

export interface HostedOidcProviderConfig {
  readonly id: string;
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly clientId: string;
  /** Confidential web clients (including Zoho) require this at code exchange. */
  readonly clientSecret?: string;
  /** The only reviewed provider-scoped authorization prompt. */
  readonly authorizationPrompt?: "select_account";
}

export interface HostedOidcProvidersResult {
  readonly providers: readonly HostedOidcProviderConfig[];
  readonly issues: readonly string[];
}

const PROVIDER_ID = /^[a-z][a-z0-9_-]{1,31}$/u;
const CLIENT_ID = /^[A-Za-z0-9._:-]{3,256}$/u;
const MAX_PROVIDERS = 8;
const MAX_RAW_BYTES = 8 * 1024;
const REQUIRED_KEYS = ["authorizationEndpoint", "clientId", "id", "issuer", "jwksUri", "tokenEndpoint"] as const;
const OPTIONAL_KEYS = ["authorizationPrompt", "clientSecret"] as const;
const REQUIRED_KEY_SIGNATURE = [...REQUIRED_KEYS].sort().join("\0");

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/**
 * Parse a candidate as an exact, non-loopback HTTPS URL. Credentials, fragments,
 * control characters, and (unless explicitly allowed) query strings are rejected
 * so a provider endpoint can never smuggle an open-redirect or credential.
 */
function httpsUrl(value: unknown, allowQuery = false): URL | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    (!allowQuery && parsed.search) ||
    isLoopbackHost(parsed.hostname)
  ) {
    return null;
  }
  return parsed;
}

function providerIssues(entry: unknown, index: number): { readonly config: HostedOidcProviderConfig | null; readonly issues: readonly string[] } {
  const label = `OIDC provider #${index + 1}`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return { config: null, issues: [`${label} must be a JSON object`] };
  }
  const candidate = entry as Record<string, unknown>;
  const keys = Object.keys(candidate);
  const requiredSignature = keys
    .filter((key) => !OPTIONAL_KEYS.includes(key as (typeof OPTIONAL_KEYS)[number]))
    .sort()
    .join("\0");
  if (
    requiredSignature !== REQUIRED_KEY_SIGNATURE ||
    keys.some((key) => !REQUIRED_KEYS.includes(key as (typeof REQUIRED_KEYS)[number]) && !OPTIONAL_KEYS.includes(key as (typeof OPTIONAL_KEYS)[number]))
  ) {
    return {
      config: null,
      issues: [`${label} must define id, issuer, authorizationEndpoint, tokenEndpoint, jwksUri, and clientId, with only optional clientSecret and authorizationPrompt`],
    };
  }
  const issues: string[] = [];
  if (typeof candidate.id !== "string" || !PROVIDER_ID.test(candidate.id)) {
    issues.push(`${label} id must be a short lowercase slug`);
  }
  if (httpsUrl(candidate.issuer) === null) {
    issues.push(`${label} issuer must be a non-loopback HTTPS URL without a query`);
  }
  if (httpsUrl(candidate.authorizationEndpoint) === null) {
    issues.push(`${label} authorization endpoint must be a non-loopback HTTPS URL`);
  }
  if (httpsUrl(candidate.tokenEndpoint) === null) {
    issues.push(`${label} token endpoint must be a non-loopback HTTPS URL`);
  }
  if (httpsUrl(candidate.jwksUri) === null) {
    issues.push(`${label} JWKS URI must be a non-loopback HTTPS URL`);
  }
  if (typeof candidate.clientId !== "string" || !CLIENT_ID.test(candidate.clientId)) {
    issues.push(`${label} client id is invalid`);
  }
  if (
    candidate.clientSecret !== undefined &&
    (
      typeof candidate.clientSecret !== "string" ||
      candidate.clientSecret.length < 8 ||
      candidate.clientSecret.length > 512 ||
      /[\u0000-\u001f\u007f]/u.test(candidate.clientSecret)
    )
  ) {
    issues.push(`${label} client secret is invalid`);
  }
  if (
    candidate.authorizationPrompt !== undefined &&
    candidate.authorizationPrompt !== "select_account"
  ) {
    issues.push(`${label} authorization prompt must be exactly select_account`);
  }
  if (candidate.id !== "google" && candidate.authorizationPrompt !== undefined) {
    issues.push(`${label} authorization prompt is supported only for Google`);
  }
  if (issues.length > 0) return { config: null, issues };
  return {
    config: {
      id: candidate.id as string,
      issuer: candidate.issuer as string,
      authorizationEndpoint: candidate.authorizationEndpoint as string,
      tokenEndpoint: candidate.tokenEndpoint as string,
      jwksUri: candidate.jwksUri as string,
      clientId: candidate.clientId as string,
      ...(candidate.clientSecret === undefined ? {} : { clientSecret: candidate.clientSecret as string }),
      // Google always gets the account chooser, and the default is applied here
      // rather than demanded of the stored secret.
      //
      // Requiring the key instead would reject every environment provisioned
      // before this field existed -- and because one invalid provider fails the
      // whole list, that takes down every other provider with it. The managed
      // SUTRA_OIDC_PROVIDERS secret is written by `sync-zoho-runtime.sh` on each
      // EC2 release, so a hard requirement would abort the deploy that was
      // supposed to carry the migration, and leave sign-in unavailable until
      // someone rewrote the secret by hand.
      //
      // Defaulting is safe in the direction that matters: the only accepted
      // value is `select_account` (validated above), so a config that omits it
      // and a config that states it now resolve identically. Nothing can select
      // a different prompt by staying silent.
      ...(candidate.id === "google"
        ? { authorizationPrompt: "select_account" as const }
        : {}),
    },
    issues: [],
  };
}

/**
 * Validate the SUTRA_OIDC_PROVIDERS list. Returns the fully-valid providers and
 * a list of human-readable issues. A configuration is acceptable only when
 * `issues` is empty AND at least one provider is present; callers must treat any
 * issue as fatal (fail closed) rather than silently dropping a bad provider.
 */
export function parseHostedOidcProviders(raw: string | undefined): HostedOidcProvidersResult {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return { providers: [], issues: ["at least one fully-configured OIDC provider is required (SUTRA_OIDC_PROVIDERS)"] };
  }
  if (new TextEncoder().encode(trimmed).length > MAX_RAW_BYTES) {
    return { providers: [], issues: ["SUTRA_OIDC_PROVIDERS is too large"] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { providers: [], issues: ["SUTRA_OIDC_PROVIDERS must be valid JSON"] };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { providers: [], issues: ["SUTRA_OIDC_PROVIDERS must be a non-empty JSON array of providers"] };
  }
  if (parsed.length > MAX_PROVIDERS) {
    return { providers: [], issues: [`SUTRA_OIDC_PROVIDERS must configure at most ${MAX_PROVIDERS} providers`] };
  }
  const issues: string[] = [];
  const providers: HostedOidcProviderConfig[] = [];
  const seen = new Set<string>();
  parsed.forEach((entry, index) => {
    const result = providerIssues(entry, index);
    issues.push(...result.issues);
    if (result.config === null) return;
    if (seen.has(result.config.id)) {
      issues.push(`OIDC provider id "${result.config.id}" is duplicated`);
      return;
    }
    seen.add(result.config.id);
    providers.push(result.config);
  });
  return { providers, issues };
}

/** Deployment-boundary helper: the configuration issues for the provider list. */
export function hostedOidcProviderIssues(raw: string | undefined): readonly string[] {
  const { providers, issues } = parseHostedOidcProviders(raw);
  if (issues.length > 0) return issues;
  if (providers.length === 0) return ["at least one fully-configured OIDC provider is required (SUTRA_OIDC_PROVIDERS)"];
  return [];
}

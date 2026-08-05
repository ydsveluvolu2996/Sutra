import {
  oidcTokenRequestBody,
  validateOidcClientConfiguration,
  type OidcClientConfiguration,
} from "./oidc-pkce.ts";
import type { OidcJsonWebKey } from "./oidc-id-token.ts";
import {
  productionOutboundFetch,
  type ManagedOutboundEnvironment,
} from "./managed-outbound-fetch.ts";

const MAX_TOKEN_RESPONSE_BYTES = 32 * 1024;
const MAX_JWKS_BYTES = 128 * 1024;

export interface HostedOidcConfiguration extends OidcClientConfiguration {
  readonly jwksUrl: string;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function exactJsonContentType(response: Response): void {
  const value = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US");
  if (value !== "application/json") throw new Error("OIDC endpoint returned an unsupported content type");
}

async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  exactJsonContentType(response);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("OIDC response is too large");
  const source = await response.text();
  if (new TextEncoder().encode(source).length > maximumBytes) throw new Error("OIDC response is too large");
  return JSON.parse(source) as unknown;
}

function assertJwksUrl(configuration: HostedOidcConfiguration): void {
  // The JWKS URI is an operator-trusted, per-provider configuration value. It is
  // NOT required to be issuer-relative: federated providers publish their signing
  // keys on their own hosts (Google's keys live on www.googleapis.com, not on
  // accounts.google.com), so requiring same-origin would make multi-provider
  // federation impossible. The per-request identity binding is enforced at token
  // verification (issuer + audience + signature pinned to the SEALED provider),
  // never by the transport host of the key set. We still reject anything that
  // could smuggle credentials or an open-redirect: non-HTTPS, embedded
  // credentials, a fragment, or a query string.
  if (configuration.jwksUrl.length > 2048 || /[\u0000-\u001f\u007f]/u.test(configuration.jwksUrl)) {
    throw new Error("OIDC JWKS endpoint must be a bounded HTTPS URL");
  }
  const supplied = new URL(configuration.jwksUrl);
  if (
    supplied.protocol !== "https:" ||
    supplied.username ||
    supplied.password ||
    supplied.hash ||
    supplied.search
  ) {
    throw new Error("OIDC JWKS endpoint must be a query-less HTTPS URL without credentials");
  }
}

export function validateHostedOidcConfiguration(configuration: HostedOidcConfiguration): void {
  validateOidcClientConfiguration(configuration);
  assertJwksUrl(configuration);
}

export async function exchangeOidcAuthorizationCode(
  configuration: HostedOidcConfiguration,
  code: string,
  codeVerifier: string,
  fetcher?: Fetcher,
  environment: ManagedOutboundEnvironment = {},
): Promise<string> {
  validateHostedOidcConfiguration(configuration);
  const outboundFetch = productionOutboundFetch(environment, fetcher);
  const response = await outboundFetch(configuration.tokenEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: oidcTokenRequestBody(configuration, code, codeVerifier).toString(),
    // Workerd rejects the Fetch API's "error" redirect mode before completing
    // otherwise valid Zoho requests. "manual" preserves the fail-closed
    // boundary because every 3xx remains a non-ok response below and is never
    // followed to a different origin.
    redirect: "manual",
  });
  if (!response.ok) throw new Error("OIDC code exchange was rejected");
  const value = await boundedJson(response, MAX_TOKEN_RESPONSE_BYTES);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OIDC token response is invalid");
  }
  const idToken = (value as Record<string, unknown>).id_token;
  if (typeof idToken !== "string" || idToken.length < 32 || idToken.length > 16 * 1024 || /\s/u.test(idToken)) {
    throw new Error("OIDC token response does not contain a valid ID token");
  }
  return idToken;
}

export async function fetchOidcJwks(
  configuration: HostedOidcConfiguration,
  fetcher?: Fetcher,
  environment: ManagedOutboundEnvironment = {},
): Promise<{ readonly keys: readonly OidcJsonWebKey[] }> {
  validateHostedOidcConfiguration(configuration);
  const outboundFetch = productionOutboundFetch(environment, fetcher);
  const response = await outboundFetch(configuration.jwksUrl, {
    headers: { accept: "application/json" },
    // See the token exchange above: manual is the Workerd-compatible mode, and
    // the explicit response.ok check still refuses every redirect response.
    redirect: "manual",
  });
  if (!response.ok) throw new Error("OIDC signing keys are unavailable");
  const value = await boundedJson(response, MAX_JWKS_BYTES);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OIDC signing key response is invalid");
  }
  const keys = (value as Record<string, unknown>).keys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 32 || keys.some((key) => key === null || typeof key !== "object" || Array.isArray(key))) {
    throw new Error("OIDC signing key response is invalid");
  }
  return { keys: keys as readonly OidcJsonWebKey[] };
}

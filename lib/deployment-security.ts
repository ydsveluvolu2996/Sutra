import { hostedOidcProviderIssues } from "./hosted-oidc-providers.ts";
import { effectiveRequestOrigin } from "./request-origin.ts";
import {
  isCanonicalPublicSiteUrl,
  isPublicIndexablePath,
  PUBLIC_INDEXABLE_PATHS,
} from "./site-seo.ts";

export type DeploymentEnvironment = "local" | "preview" | "staging" | "production";

export interface DeploymentSecurityEnvironment {
  readonly SUTRA_DEPLOYMENT_ENV?: string;
  readonly SUTRA_PUBLIC_ORIGIN?: string;
  readonly SUTRA_LOCAL_MODE?: string;
  readonly SUTRA_IDENTITY_MODE?: string;
  readonly SUTRA_OIDC_PROVIDERS?: string;
  readonly SUTRA_OIDC_TRANSACTION_KEY?: string;
  readonly SUTRA_BROKER_URL?: string;
  readonly SUTRA_BROKER_AUTH_MODE?: string;
  readonly SUTRA_DATABASE_MODE?: string;
  readonly SUTRA_SECRET_STORE?: string;
  readonly SUTRA_ENVIRONMENT_KEY_SCOPE?: string;
  readonly SUTRA_HOSTED_ENABLED?: string;
  readonly SUTRA_AUTH_ENCRYPTION_KEY?: string;
  readonly SUTRA_PASSWORD_MFA_REQUIRED?: string;
  readonly SUTRA_PASSWORD_IDENTITY_ENABLED?: string;
  readonly SUTRA_PRIVATE_BETA_PASSWORD_ENABLED?: string;
  readonly SUTRA_PRIVATE_BETA_OIDC_ENABLED?: string;
}

export interface DeploymentBoundaryDecision {
  readonly allowed: boolean;
  readonly environment: DeploymentEnvironment;
  readonly status: 200 | 404 | 421 | 503;
  readonly code: "ALLOWED" | "INVALID_CONFIGURATION" | "ORIGIN_MISMATCH" | "PREVIEW_MARKETING_ONLY";
  readonly issues: readonly string[];
}

const publicPreviewPaths = new Set([
  ...PUBLIC_INDEXABLE_PATHS,
  "/api/contact",
  "/api/turnstile/config",
  "/favicon.svg",
  "/og.png",
  "/robots.txt",
  "/sitemap.xml",
]);
const publicSearchControlPaths = new Set(["/robots.txt", "/sitemap.xml"]);
const turnstilePagePaths = new Set([
  "/login",
  "/contact",
  "/accept-invite",
  "/forgot-password",
  "/reset-password",
]);
const protectedPrefixes = [
  "/api/",
  "/dashboard",
  "/customers",
  "/cmdb",
  "/changes",
  "/findings",
  "/vulnerabilities",
  "/security-events",
  "/cases",
  "/compliance",
  "/costs",
  "/reports",
  "/controls",
  "/roadmap",
  "/operations",
  "/onboard",
  "/login",
  "/mfa/",
] as const;

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function deploymentEnvironment(value: string | undefined): DeploymentEnvironment | null {
  const normalized = value?.trim() || "local";
  return normalized === "local" || normalized === "preview" || normalized === "staging" || normalized === "production"
    ? normalized
    : null;
}

function exactHttpsOrigin(value: string | undefined): URL | null {
  if (!value || /[\r\n]/u.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      isLoopbackHost(parsed.hostname)
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isExactHttpsUrl(value: string | undefined): boolean {
  if (!value || /[\r\n]/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function hostedConfigurationIssues(environment: DeploymentSecurityEnvironment): readonly string[] {
  const issues: string[] = [];
  if (environment.SUTRA_LOCAL_MODE === "true") issues.push("local authentication must be disabled");
  if (exactHttpsOrigin(environment.SUTRA_PUBLIC_ORIGIN) === null) issues.push("a canonical non-loopback HTTPS public origin is required");
  if (environment.SUTRA_IDENTITY_MODE !== "oidc") issues.push("the hosted OIDC identity adapter is required");
  // Federated login is MULTI-PROVIDER (Google, Microsoft Entra, ...). At least
  // one fully-configured provider is required and every configured provider must
  // pass its own HTTPS issuer/endpoint validation, so a single malformed entry
  // still fails closed.
  issues.push(...hostedOidcProviderIssues(environment.SUTRA_OIDC_PROVIDERS));
  if (!/^[A-Za-z0-9_-]{43}$/u.test(environment.SUTRA_OIDC_TRANSACTION_KEY ?? "")) issues.push("a managed 256-bit OIDC transaction key is required");
  if (!isExactHttpsUrl(environment.SUTRA_BROKER_URL)) issues.push("a non-loopback HTTPS broker URL is required");
  if (environment.SUTRA_BROKER_AUTH_MODE !== "asymmetric") issues.push("asymmetric broker authentication is required");
  if (!new Set(["d1", "postgres-tls"]).has(environment.SUTRA_DATABASE_MODE ?? "")) issues.push("a supported hosted database mode is required");
  if (environment.SUTRA_SECRET_STORE !== "managed") issues.push("a managed secret store is required");
  if (environment.SUTRA_ENVIRONMENT_KEY_SCOPE !== "isolated") issues.push("environment-isolated encryption and signing keys are required");

  // The hosted identity + session lifecycle (OIDC authorization-code + PKCE with
  // sealed state/nonce transactions, invitation-bound first-login provisioning,
  // and session issuance through the same hardened cookie/crypto path as local
  // mode) now exists in this build, as do the durable background-job runner and
  // the asymmetric hosted-broker request verifier — all covered by tests. Even
  // so, production stays disabled behind ONE explicit master switch until a
  // dedicated adversarial auth review signs off. The switch defaults OFF:
  // anything other than the exact string "true" keeps hosted deployments blocked.
  // This is intentionally the LAST gate — every configuration requirement above
  // (HTTPS origin, OIDC endpoints, broker URL + asymmetric auth, database mode,
  // managed secret store, isolated key scope) must still pass on its own.
  if (environment.SUTRA_HOSTED_ENABLED !== "true") {
    issues.push("hosted deployment is disabled pending adversarial auth review (set SUTRA_HOSTED_ENABLED=true only after sign-off)");
  }
  return issues;
}

/**
 * Configuration contract for MANAGED-PASSWORD identity: the network-reachable
 * form of the local email + password + TOTP stack. It shares every transport
 * and secret requirement with the OIDC contract above (HTTPS origin, asymmetric
 * broker, TLS/managed database, managed secret store, isolated key scope) but
 * swaps the OIDC provider set for a managed 256-bit auth-encryption key (used to
 * seal sessions and TOTP secrets) and REQUIRES multi-factor authentication to be
 * mandatory — a password reachable from the internet is never sufficient on its
 * own. Like the OIDC path it fails closed behind its own LAST master switch,
 * `SUTRA_PASSWORD_IDENTITY_ENABLED`, which defaults OFF until an adversarial auth
 * review signs off; every requirement above it must still pass independently.
 */
export function managedPasswordConfigurationIssues(environment: DeploymentSecurityEnvironment): readonly string[] {
  const issues: string[] = [];
  if (environment.SUTRA_LOCAL_MODE === "true") issues.push("local authentication must be disabled");
  if (exactHttpsOrigin(environment.SUTRA_PUBLIC_ORIGIN) === null) issues.push("a canonical non-loopback HTTPS public origin is required");
  if (environment.SUTRA_IDENTITY_MODE !== "password") issues.push("the managed password identity adapter is required");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(environment.SUTRA_AUTH_ENCRYPTION_KEY ?? "")) issues.push("a managed 256-bit auth encryption key is required");
  if (environment.SUTRA_PASSWORD_MFA_REQUIRED !== "true") issues.push("multi-factor authentication must be mandatory for password identities");
  if (!isExactHttpsUrl(environment.SUTRA_BROKER_URL)) issues.push("a non-loopback HTTPS broker URL is required");
  if (environment.SUTRA_BROKER_AUTH_MODE !== "asymmetric") issues.push("asymmetric broker authentication is required");
  if (!new Set(["d1", "postgres-tls"]).has(environment.SUTRA_DATABASE_MODE ?? "")) issues.push("a supported hosted database mode is required");
  if (environment.SUTRA_SECRET_STORE !== "managed") issues.push("a managed secret store is required");
  if (environment.SUTRA_ENVIRONMENT_KEY_SCOPE !== "isolated") issues.push("environment-isolated encryption and signing keys are required");
  if (environment.SUTRA_PASSWORD_IDENTITY_ENABLED !== "true") {
    issues.push("managed password deployment is disabled pending adversarial auth review (set SUTRA_PASSWORD_IDENTITY_ENABLED=true only after sign-off)");
  }
  return issues;
}

/**
 * Deliberately narrower contract for the single-host, invitation-only private
 * beta. It may run only as `staging` and has a separate exact-string opt-in, so
 * it cannot clear the production managed-password release hold. The common
 * public-password invariants remain load-bearing: canonical HTTPS, local mode
 * explicitly off, a 256-bit session/TOTP key, and mandatory MFA.
 */
export function privateBetaPasswordConfigurationIssues(environment: DeploymentSecurityEnvironment): readonly string[] {
  const issues: string[] = [];
  if (environment.SUTRA_DEPLOYMENT_ENV !== "staging") issues.push("private-beta password identity is restricted to staging");
  if (environment.SUTRA_LOCAL_MODE !== "false") issues.push("local authentication must be explicitly disabled");
  if (exactHttpsOrigin(environment.SUTRA_PUBLIC_ORIGIN) === null) issues.push("a canonical non-loopback HTTPS public origin is required");
  if (environment.SUTRA_IDENTITY_MODE !== "password") issues.push("the private-beta password identity adapter is required");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(environment.SUTRA_AUTH_ENCRYPTION_KEY ?? "")) issues.push("a private-beta 256-bit auth encryption key is required");
  if (environment.SUTRA_PASSWORD_MFA_REQUIRED !== "true") issues.push("multi-factor authentication must be mandatory for password identities");
  if (environment.SUTRA_PRIVATE_BETA_PASSWORD_ENABLED !== "true") {
    issues.push("private-beta password deployment is disabled (set SUTRA_PRIVATE_BETA_PASSWORD_ENABLED=true only for an approved staging pilot)");
  }
  return issues;
}

/**
 * Invitation-only OIDC contract for the single-host private beta. This keeps
 * the reviewed staging boundary and exact master switch without pretending the
 * single-node loopback collector is the separately-reviewed hosted broker.
 */
export function privateBetaOidcConfigurationIssues(environment: DeploymentSecurityEnvironment): readonly string[] {
  const issues: string[] = [];
  if (environment.SUTRA_DEPLOYMENT_ENV !== "staging") issues.push("private-beta OIDC identity is restricted to staging");
  if (environment.SUTRA_LOCAL_MODE !== "false") issues.push("local authentication must be explicitly disabled");
  if (exactHttpsOrigin(environment.SUTRA_PUBLIC_ORIGIN) === null) issues.push("a canonical non-loopback HTTPS public origin is required");
  if (environment.SUTRA_IDENTITY_MODE !== "oidc") issues.push("the private-beta OIDC identity adapter is required");
  issues.push(...hostedOidcProviderIssues(environment.SUTRA_OIDC_PROVIDERS));
  if (!/^[A-Za-z0-9_-]{43}$/u.test(environment.SUTRA_OIDC_TRANSACTION_KEY ?? "")) {
    issues.push("a private-beta managed 256-bit OIDC transaction key is required");
  }
  if (environment.SUTRA_PRIVATE_BETA_OIDC_ENABLED !== "true") {
    issues.push("private-beta OIDC deployment is disabled (set SUTRA_PRIVATE_BETA_OIDC_ENABLED=true only for an approved staging pilot)");
  }
  return issues;
}

/**
 * Selects the identity contract for a network deployment. `password` and `oidc`
 * are the only supported hosted identity modes; anything else falls through to
 * the OIDC contract, whose first check reports the missing adapter.
 */
export function networkConfigurationIssues(environment: DeploymentSecurityEnvironment): readonly string[] {
  if (environment.SUTRA_DEPLOYMENT_ENV === "staging") {
    return environment.SUTRA_IDENTITY_MODE === "password"
      ? privateBetaPasswordConfigurationIssues(environment)
      : privateBetaOidcConfigurationIssues(environment);
  }
  return environment.SUTRA_IDENTITY_MODE === "password"
    ? managedPasswordConfigurationIssues(environment)
    : hostedConfigurationIssues(environment);
}

function isPreviewPublicPath(pathname: string): boolean {
  return publicPreviewPaths.has(pathname) || pathname.startsWith("/assets/");
}

export function isProtectedPath(pathname: string): boolean {
  return protectedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

export function evaluateDeploymentBoundary(
  request: Request | string,
  runtime: DeploymentSecurityEnvironment,
): DeploymentBoundaryDecision {
  const requestUrl = typeof request === "string" ? request : request.url;
  const url = new URL(requestUrl);
  const environment = deploymentEnvironment(runtime.SUTRA_DEPLOYMENT_ENV);
  if (environment === null) {
    return { allowed: false, environment: "local", status: 503, code: "INVALID_CONFIGURATION", issues: ["SUTRA_DEPLOYMENT_ENV is invalid"] };
  }

  if (environment === "local") {
    const issues = isLoopbackHost(url.hostname) ? [] : ["local mode is restricted to a loopback host"];
    return { allowed: issues.length === 0, environment, status: issues.length === 0 ? 200 : 503, code: issues.length === 0 ? "ALLOWED" : "INVALID_CONFIGURATION", issues };
  }

  const canonicalOrigin = exactHttpsOrigin(runtime.SUTRA_PUBLIC_ORIGIN);
  if (canonicalOrigin === null) {
    return { allowed: false, environment, status: 503, code: "INVALID_CONFIGURATION", issues: ["a canonical non-loopback HTTPS public origin is required"] };
  }
  if (effectiveRequestOrigin(request) !== canonicalOrigin.origin) {
    return { allowed: false, environment, status: 421, code: "ORIGIN_MISMATCH", issues: ["the request origin does not match SUTRA_PUBLIC_ORIGIN"] };
  }

  if (environment === "preview") {
    const allowed = isPreviewPublicPath(url.pathname);
    return {
      allowed,
      environment,
      status: allowed ? 200 : 404,
      code: allowed ? "ALLOWED" : "PREVIEW_MARKETING_ONLY",
      issues: allowed ? [] : ["preview deployments expose only the public product site"],
    };
  }

  const issues = networkConfigurationIssues(runtime);
  return {
    allowed: issues.length === 0,
    environment,
    status: issues.length === 0 ? 200 : 503,
    code: issues.length === 0 ? "ALLOWED" : "INVALID_CONFIGURATION",
    issues,
  };
}

const SCRIPT_NONCE_PATTERN = /^[A-Za-z0-9+/=_-]{16,}$/u;

/**
 * Generates a per-response base64 nonce for the CSP `script-src` directive. The
 * worker pins it on the request so the framework's inline hydration scripts and
 * the inline theme bootstrap all carry it, which lets `'unsafe-inline'` be
 * dropped from `script-src`. A static hash is not usable because the app streams
 * dynamic inline RSC scripts whose contents vary per request.
 */
export function generateScriptNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function responseSecurityHeaders(
  request: Request | string,
  environment: DeploymentEnvironment,
  scriptNonce?: string,
): Readonly<Record<string, string>> {
  const transportUrl = new URL(typeof request === "string" ? request : request.url);
  const effectiveOrigin = effectiveRequestOrigin(request);
  const url = effectiveOrigin === null
    ? transportUrl
    : new URL(`${transportUrl.pathname}${transportUrl.search}`, effectiveOrigin);
  const usesTurnstile = turnstilePagePaths.has(url.pathname);
  // 'unsafe-inline' is removed from script-src. A valid per-request nonce (for
  // HTML responses) allowlists the inline hydration + theme scripts; responses
  // without inline scripts (API/image/boundary) fall back to 'self' only.
  const scriptSrc = [
    "script-src 'self'",
    ...(scriptNonce !== undefined && SCRIPT_NONCE_PATTERN.test(scriptNonce)
      ? [`'nonce-${scriptNonce}'`]
      : []),
    ...(usesTurnstile ? ["https://challenges.cloudflare.com"] : []),
  ].join(" ");
  const connectSrc = usesTurnstile
    ? "connect-src 'self' https://challenges.cloudflare.com"
    : "connect-src 'self'";
  const frameSrc = usesTurnstile
    ? "frame-src https://challenges.cloudflare.com"
    : "frame-src 'none'";
  const headers: Record<string, string> = {
    "Content-Security-Policy": `default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; ${scriptSrc}; ${connectSrc}; ${frameSrc}`,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
  if (url.protocol === "https:" && !isLoopbackHost(url.hostname)) {
    headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload";
  }
  const isPublicSearchResource = isPublicIndexablePath(url.pathname) || publicSearchControlPaths.has(url.pathname);
  // The current private beta deliberately runs under the staging identity
  // contract. Permit indexing only for reviewed marketing URLs on Sutra's one
  // canonical public origin; every app/customer/API URL and every preview or
  // alternate hostname remains noindex at the response layer.
  const mayBeIndexed =
    (environment === "staging" || environment === "production") &&
    isCanonicalPublicSiteUrl(url) &&
    isPublicSearchResource;
  if (!mayBeIndexed) headers["X-Robots-Tag"] = "noindex, nofollow";
  return headers;
}

export type DeploymentEnvironment = "local" | "preview" | "staging" | "production";

export interface DeploymentSecurityEnvironment {
  readonly SUTRA_DEPLOYMENT_ENV?: string;
  readonly SUTRA_PUBLIC_ORIGIN?: string;
  readonly SUTRA_LOCAL_MODE?: string;
  readonly SUTRA_IDENTITY_MODE?: string;
  readonly SUTRA_OIDC_ISSUER?: string;
  readonly SUTRA_OIDC_CLIENT_ID?: string;
  readonly SUTRA_OIDC_AUTHORIZATION_ENDPOINT?: string;
  readonly SUTRA_OIDC_TOKEN_ENDPOINT?: string;
  readonly SUTRA_OIDC_TRANSACTION_KEY?: string;
  readonly SUTRA_BROKER_URL?: string;
  readonly SUTRA_BROKER_AUTH_MODE?: string;
  readonly SUTRA_DATABASE_MODE?: string;
  readonly SUTRA_SECRET_STORE?: string;
  readonly SUTRA_ENVIRONMENT_KEY_SCOPE?: string;
}

export interface DeploymentBoundaryDecision {
  readonly allowed: boolean;
  readonly environment: DeploymentEnvironment;
  readonly status: 200 | 404 | 421 | 503;
  readonly code: "ALLOWED" | "INVALID_CONFIGURATION" | "ORIGIN_MISMATCH" | "PREVIEW_MARKETING_ONLY";
  readonly issues: readonly string[];
}

const publicPreviewPaths = new Set(["/", "/contact", "/api/contact", "/privacy", "/terms", "/security", "/status", "/favicon.svg", "/og.png", "/robots.txt"]);
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
  if (!isExactHttpsUrl(environment.SUTRA_OIDC_ISSUER)) issues.push("a non-loopback HTTPS OIDC issuer is required");
  if (!/^[A-Za-z0-9._:-]{3,256}$/u.test(environment.SUTRA_OIDC_CLIENT_ID ?? "")) issues.push("a bounded OIDC client identifier is required");
  if (!isExactHttpsUrl(environment.SUTRA_OIDC_AUTHORIZATION_ENDPOINT)) issues.push("a non-loopback HTTPS OIDC authorization endpoint is required");
  if (!isExactHttpsUrl(environment.SUTRA_OIDC_TOKEN_ENDPOINT)) issues.push("a non-loopback HTTPS OIDC token endpoint is required");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(environment.SUTRA_OIDC_TRANSACTION_KEY ?? "")) issues.push("a managed 256-bit OIDC transaction key is required");
  if (!isExactHttpsUrl(environment.SUTRA_BROKER_URL)) issues.push("a non-loopback HTTPS broker URL is required");
  if (environment.SUTRA_BROKER_AUTH_MODE !== "asymmetric") issues.push("asymmetric broker authentication is required");
  if (!new Set(["d1", "postgres-tls"]).has(environment.SUTRA_DATABASE_MODE ?? "")) issues.push("a supported hosted database mode is required");
  if (environment.SUTRA_SECRET_STORE !== "managed") issues.push("a managed secret store is required");
  if (environment.SUTRA_ENVIRONMENT_KEY_SCOPE !== "isolated") issues.push("environment-isolated encryption and signing keys are required");

  // These release holds are removed only when their adapters and adversarial
  // acceptance tests land. Configuration flags alone cannot create readiness.
  issues.push("hosted identity and session lifecycle are not implemented in this build");
  issues.push("hosted broker ingestion and durable jobs are not implemented in this build");
  return issues;
}

function isPreviewPublicPath(pathname: string): boolean {
  return publicPreviewPaths.has(pathname) || pathname.startsWith("/assets/");
}

export function isProtectedPath(pathname: string): boolean {
  return protectedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

export function evaluateDeploymentBoundary(
  requestUrl: string,
  runtime: DeploymentSecurityEnvironment,
): DeploymentBoundaryDecision {
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
  if (url.origin !== canonicalOrigin.origin) {
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

  const issues = hostedConfigurationIssues(runtime);
  return {
    allowed: issues.length === 0,
    environment,
    status: issues.length === 0 ? 200 : 503,
    code: issues.length === 0 ? "ALLOWED" : "INVALID_CONFIGURATION",
    issues,
  };
}

export function responseSecurityHeaders(
  requestUrl: string,
  environment: DeploymentEnvironment,
): Readonly<Record<string, string>> {
  const url = new URL(requestUrl);
  const headers: Record<string, string> = {
    "Content-Security-Policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
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
  if (environment !== "production" || isProtectedPath(url.pathname)) headers["X-Robots-Tag"] = "noindex, nofollow";
  return headers;
}

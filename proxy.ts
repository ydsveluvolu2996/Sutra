import { NextResponse } from "next/server.js";
import { getLocalSession } from "./db/auth-repository.ts";

const SESSION_COOKIE = "sutra_session";
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

/**
 * These are the only browser pages that can render without an authenticated
 * workspace session. API routes keep their own stronger authentication
 * boundaries (session, service token, signed callback, or internal token).
 */
export const PUBLIC_PAGE_PATHS = new Set([
  "/",
  "/about",
  "/accept-invite",
  "/contact",
  "/forgot-password",
  "/login",
  "/mfa/setup",
  "/privacy",
  "/reset-password",
  "/security",
  "/status",
  "/terms",
]);

export const PUBLIC_ASSET_PATHS = new Set([
  "/favicon.svg",
  "/file.svg",
  "/globe.svg",
  "/og.png",
  "/sutra-customer-onboarding-role.yaml",
  "/sutra-customer-role.yaml",
  "/window.svg",
]);

/**
 * Public crawler-control route handlers are not pages or static assets, but
 * they must bypass the private workspace session gate. Keeping them explicit
 * prevents a filename extension from becoming a general authentication bypass.
 */
export const PUBLIC_SEARCH_CONTROL_PATHS = new Set([
  "/robots.txt",
  "/sitemap.xml",
]);

function cookieValue(request: Request, name: string): string | null {
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

export function isPublicBrowserPath(pathname: string): boolean {
  if (pathname.startsWith("/api/") || pathname === "/api") return true;
  if (pathname.startsWith("/_next/")) return true;
  if (PUBLIC_PAGE_PATHS.has(pathname)) return true;
  if (PUBLIC_SEARCH_CONTROL_PATHS.has(pathname)) return true;
  return PUBLIC_ASSET_PATHS.has(pathname);
}

export default async function proxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (isPublicBrowserPath(url.pathname)) return NextResponse.next();

  const sessionToken = cookieValue(request, SESSION_COOKIE);
  if (sessionToken !== null && SESSION_TOKEN.test(sessionToken)) {
    try {
      const authenticated = await getLocalSession(
        sessionToken,
        undefined,
        { withAvailableOrganizations: false },
      );
      if (authenticated !== null) return NextResponse.next();
    } catch {
      // A database/runtime failure must not turn the page gate into an
      // authentication bypass. The API can expose an operator-safe diagnostic;
      // the browser receives only the same sterile login redirect.
    }
  }

  const login = new URL("/login", url);
  login.searchParams.set("next", `${url.pathname}${url.search}`);
  const response = NextResponse.redirect(login, 307);
  response.headers.set("cache-control", "private, no-store, max-age=0");
  response.headers.set("pragma", "no-cache");
  response.headers.set("vary", "cookie");
  return response;
}

export const config = {
  matcher: ["/:path*"],
};

/**
 * Resolve the browser-visible origin without trusting a forwarded host. The
 * reverse proxy must set the upstream `Host` header to the canonical public
 * host; only the transport scheme may be supplied by `X-Forwarded-Proto` for
 * the private HTTP hop behind TLS termination.
 *
 * A malformed or multi-valued forwarded protocol fails closed. Callers still
 * compare the result with their configured canonical origin, so this helper
 * cannot turn an arbitrary Host into an accepted public origin.
 */
export function effectiveRequestOrigin(request: Request | string): string | null {
  try {
    const url = new URL(typeof request === "string" ? request : request.url);
    let protocol = url.protocol;
    if (typeof request !== "string") {
      const forwardedProto = request.headers.get("x-forwarded-proto");
      if (forwardedProto !== null) {
        const normalized = forwardedProto.trim().toLowerCase();
        if (normalized !== "http" && normalized !== "https") return null;
        protocol = `${normalized}:`;
      }
    }
    if (protocol !== "http:" && protocol !== "https:") return null;
    return new URL(`${protocol}//${url.host}`).origin;
  } catch {
    return null;
  }
}

export function requestMatchesCanonicalOrigin(
  request: Request | string,
  configuredOrigin: string | undefined,
): boolean {
  const effective = effectiveRequestOrigin(request);
  const configured = configuredOrigin?.trim();
  if (effective === null || !configured) return false;
  try {
    const parsed = new URL(configured);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) return false;
    return effective === parsed.origin;
  } catch {
    return false;
  }
}

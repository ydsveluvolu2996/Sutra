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
    let host = url.host;
    if (typeof request !== "string") {
      // THE HOST HEADER IS THE AUTHORITY, NOT request.url.
      //
      // This function's contract (above) is that the reverse proxy sets the upstream
      // Host to the canonical public host. It used to read that host off request.url,
      // which held for wrangler 4.102/miniflare 4.20260617 — and silently stopped
      // holding when 03302d4 bumped them to 4.114/4.20260722, where request.url is
      // built from the LISTENING SOCKET instead. The derived origin became
      // https://127.0.0.1:3000, so every same-origin check compared a browser Origin
      // of https://www.sutracmdb.com against the socket address and rejected it.
      //
      // That took out all 54 assertSameOrigin call sites at once — every mutating
      // endpoint in the app, with sign-in the first one a person hits, reporting only
      // "The request origin is invalid". Reading the header directly restores the
      // documented behaviour and no longer depends on how the runtime reconstructs a
      // URL. An empty or multi-valued Host fails closed rather than falling back to
      // the socket, because a silent fallback is what made this hard to see.
      const suppliedHost = request.headers.get("host");
      if (suppliedHost !== null) {
        const trimmed = suppliedHost.trim();
        if (trimmed.length === 0 || trimmed.includes(",")) return null;
        host = trimmed;
      }
      const forwardedProto = request.headers.get("x-forwarded-proto");
      if (forwardedProto !== null) {
        const normalized = forwardedProto.trim().toLowerCase();
        if (normalized !== "http" && normalized !== "https") return null;
        protocol = `${normalized}:`;
      }
    }
    if (protocol !== "http:" && protocol !== "https:") return null;
    // Round-tripping through URL rejects a malformed or path-bearing Host, so a
    // header like "evil.example/x" cannot become an accepted origin.
    const parsed = new URL(`${protocol}//${host}`);
    if (parsed.host !== host.toLowerCase() || parsed.pathname !== "/") return null;
    return parsed.origin;
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

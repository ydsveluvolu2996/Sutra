/**
 * Outbound SSRF guard for tenant-supplied URLs (e.g. ITSM connector base URLs).
 *
 * A tenant can configure the endpoint Sutra POSTs a signed ticket to, so the
 * value is attacker-influenced. Without a guard it could point at the loopback
 * interface, an RFC 1918 range, or a cloud metadata service (169.254.169.254),
 * and the delivery result leaks back as an oracle. This module rejects those
 * targets from a parsed URL string.
 *
 * SCOPE / LIMITATION: this closes literal-IP and known-internal-hostname
 * targets at parse time. It CANNOT close DNS rebinding on its own — a public
 * hostname that resolves to a private address is not visible here because no
 * DNS lookup happens in this runtime. Full protection additionally requires a
 * network egress policy (a locked-down fetch egress / firewall) around the
 * worker. Callers should also pass `redirect: "error"` to the fetch so a 3xx to
 * an internal target cannot bypass this check after the first hop.
 */

export class SsrfBlockedError extends Error {
  public readonly code: "SSRF_BLOCKED";

  public constructor(message = "The outbound URL is not permitted") {
    super(message);
    this.name = "SsrfBlockedError";
    this.code = "SSRF_BLOCKED";
  }
}

const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

/** Blocked hostname suffixes (matched case-insensitively). */
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal"] as const;

function isBlockedIpv4(host: string): boolean {
  const match = IPV4_LITERAL.exec(host);
  if (match === null) return false;
  const octets = match.slice(1, 5).map((part) => Number(part));
  if (octets.some((value) => value > 255)) return true; // malformed → reject
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 unspecified / "this network"
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
  return false;
}

function ipv6HighGroup(address: string): number | null {
  if (address.startsWith("::")) return 0; // compressed leading zeros
  const first = address.split(":")[0];
  if (!/^[0-9a-f]{1,4}$/u.test(first)) return null;
  return Number.parseInt(first, 16);
}

function isBlockedIpv6(host: string): boolean {
  const address = host.toLowerCase();
  const collapsed = address.replace(/:+/gu, ":");
  if (address === "::1" || collapsed === "0:0:0:0:0:0:0:1") return true; // loopback
  if (address === "::" || /^0(:0)*$/u.test(collapsed.replace(/^:|:$/gu, ""))) return true; // unspecified
  const high = ipv6HighGroup(address);
  if (high !== null) {
    if (high >= 0xfc00 && high <= 0xfdff) return true; // fc00::/7 unique-local
    if (high >= 0xfe80 && high <= 0xfebf) return true; // fe80::/10 link-local
  }
  // IPv4-mapped/embedded dotted form (e.g. ::ffff:169.254.169.254).
  if (address.includes(".")) {
    const tail = address.slice(address.lastIndexOf(":") + 1);
    if (isBlockedIpv4(tail)) return true;
  }
  // IPv4-mapped hex form — most runtimes normalize ::ffff:169.254.169.254 to
  // ::ffff:a9fe:a9fe, so decode the trailing two hextets back to IPv4.
  const mapped = /::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address);
  if (mapped !== null) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    const dotted = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
    if (isBlockedIpv4(dotted)) return true;
  }
  return false;
}

/**
 * Parses and validates an outbound URL. Throws {@link SsrfBlockedError} for any
 * disallowed target. Returns the parsed {@link URL} for a permitted public
 * HTTPS endpoint.
 */
export function assertSafeOutboundUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2_048) {
    throw new SsrfBlockedError();
  }
  // Reject CR/LF (header/request splitting) before parsing.
  if (/[\r\n\t]/u.test(raw)) throw new SsrfBlockedError();

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SsrfBlockedError();
  }

  if (parsed.protocol !== "https:") throw new SsrfBlockedError();
  // Embedded credentials are never legitimate for a webhook target.
  if (parsed.username !== "" || parsed.password !== "") throw new SsrfBlockedError();

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host.length === 0) throw new SsrfBlockedError();

  // Exact and suffix internal hostnames (covers metadata.google.internal via
  // the ".internal" suffix, plus localhost/*.localhost/*.local/*.internal).
  if (host === "localhost" || host === "metadata.google.internal") throw new SsrfBlockedError();
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) throw new SsrfBlockedError();

  if (isBlockedIpv4(host)) throw new SsrfBlockedError();
  if (host.includes(":") && isBlockedIpv6(host)) throw new SsrfBlockedError();

  return parsed;
}

/** Boolean convenience wrapper around {@link assertSafeOutboundUrl}. */
export function isSafeOutboundUrl(raw: string): boolean {
  try {
    assertSafeOutboundUrl(raw);
    return true;
  } catch {
    return false;
  }
}

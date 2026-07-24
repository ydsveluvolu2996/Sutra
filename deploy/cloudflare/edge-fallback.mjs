const FALLBACK_STATUS_CODES = new Set([
  502,
  503,
  504,
  ...Array.from({ length: 11 }, (_, index) => 520 + index),
]);

const SAFE_METHODS = new Set(["GET", "HEAD"]);
const RETRY_AFTER_SECONDS = "60";
const SECURITY_TEXT_PATHS = new Set([
  "/.well-known/security.txt",
  "/security.txt",
]);

export const SECURITY_TEXT = `Contact: https://www.sutracmdb.com/contact
Expires: 2027-07-24T23:59:00Z
Canonical: https://www.sutracmdb.com/.well-known/security.txt
Policy: https://www.sutracmdb.com/security
Preferred-Languages: en
`;

export const MAINTENANCE_CSS = `
:root{color-scheme:dark;--night:#05070f;--panel:#0c1226;--ink:#f3f6ff;--muted:#9aa8c5;--cyan:#22d3ee;--blue:#3b82f6;--violet:#8b5cf6}
*{box-sizing:border-box}
html,body{min-height:100%;margin:0}
body{display:grid;place-items:center;padding:24px;background:radial-gradient(60rem 34rem at 14% -10%,rgba(59,130,246,.28),transparent 62%),radial-gradient(52rem 32rem at 100% 110%,rgba(139,92,246,.23),transparent 60%),var(--night);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(680px,100%);padding:clamp(28px,6vw,54px);border:1px solid rgba(139,165,235,.23);border-radius:24px;background:linear-gradient(150deg,rgba(18,28,58,.94),rgba(8,13,29,.96));box-shadow:0 32px 90px rgba(0,0,0,.48),inset 0 1px rgba(255,255,255,.08)}
.brand{display:flex;align-items:center;gap:12px;margin:0 0 46px;font-weight:800;letter-spacing:.02em}
.mark{display:flex;align-items:end;gap:3px;width:24px;height:24px}
.mark i{display:block;width:5px;border-radius:4px;background:linear-gradient(180deg,var(--cyan),var(--blue) 54%,var(--violet))}
.mark i:nth-child(1){height:12px}.mark i:nth-child(2){height:22px}.mark i:nth-child(3){height:17px}
.eyebrow{margin:0 0 14px;color:#79dcf2;font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}
h1{max-width:560px;margin:0;font-size:clamp(36px,7vw,64px);line-height:1.02;letter-spacing:-.045em}
.copy{max-width:540px;margin:22px 0 0;color:var(--muted);font-size:clamp(16px,2.4vw,19px);line-height:1.65}
.status{display:flex;align-items:center;gap:10px;margin:34px 0 0;padding:14px 16px;border:1px solid rgba(34,211,238,.19);border-radius:12px;background:rgba(34,211,238,.07);color:#c6f5ff;font-size:14px}
.status i{width:9px;height:9px;border-radius:50%;background:var(--cyan);box-shadow:0 0 0 5px rgba(34,211,238,.12)}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:30px}
a{display:inline-flex;align-items:center;min-height:44px;padding:0 18px;border:1px solid rgba(150,180,245,.26);border-radius:10px;color:#eaf2ff;font-weight:750;text-decoration:none}
a:first-child{border:0;background:linear-gradient(115deg,var(--cyan),var(--blue) 48%,var(--violet));color:#061225;box-shadow:0 10px 28px rgba(59,130,246,.3)}
footer{margin-top:46px;color:#7785a4;font-size:12px}
@media (prefers-reduced-motion:no-preference){.status i{animation:pulse 2s ease-out infinite}@keyframes pulse{50%{box-shadow:0 0 0 9px rgba(34,211,238,0)}}}
`;

// Update this digest whenever MAINTENANCE_CSS changes. The contract test verifies it.
export const MAINTENANCE_STYLE_SHA256 = "sha256-NP+w9jegpmMFIRXQ1QsGQFB971QLB0B1bXpvCUlTpPo=";

const MAINTENANCE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>Sutra | Brief maintenance</title>
<style>${MAINTENANCE_CSS}</style>
</head>
<body>
<main>
  <p class="brand"><span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>Sutra</p>
  <p class="eyebrow">Planned resilience</p>
  <h1>We are weaving things back together.</h1>
  <p class="copy">Sutra is briefly unavailable while the service is starting or receiving an update. Customer data remains protected. Please try again shortly.</p>
  <p class="status"><i aria-hidden="true"></i>Service recovery is in progress</p>
  <div class="actions"><a href="/">Try again</a><a href="mailto:support@sutracmdb.com?subject=Sutra%20availability">Contact support</a></div>
  <footer>Sutra CMDB · Cloud operations and assurance</footer>
</main>
</body>
</html>`;

const PROBLEM_BODY = JSON.stringify({
  type: "https://www.sutracmdb.com/problems/service-unavailable",
  title: "Service temporarily unavailable",
  status: 503,
  detail: "Sutra is temporarily unavailable. Retry the request shortly.",
});

const MISDIRECTED_BODY = JSON.stringify({
  type: "https://www.sutracmdb.com/problems/misdirected-request",
  title: "Use the canonical Sutra hostname",
  status: 421,
  detail: "Send API and webhook requests directly to https://www.sutracmdb.com.",
});

function commonSecurityHeaders(contentType) {
  return new Headers({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    "CDN-Cache-Control": "no-store",
    "Cloudflare-CDN-Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; style-src '${MAINTENANCE_STYLE_SHA256}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; img-src 'none'; font-src 'none'; script-src 'none'; connect-src 'none'`,
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Expires": "0",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Pragma": "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  });
}

function isMachineEndpoint(pathname) {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/openapi.json" ||
    /\/(?:webhooks?|hooks)(?:\/|$)/i.test(pathname)
  );
}

function bodyForMethod(request, body) {
  return request.method === "HEAD" ? null : body;
}

function securityTextResponse(request) {
  const headers = new Headers({
    "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
    "CDN-Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    "Cloudflare-CDN-Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "Content-Type": "text/plain; charset=utf-8",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow",
  });

  return new Response(bodyForMethod(request, SECURITY_TEXT), { status: 200, headers });
}

function serviceUnavailable(request) {
  const machineEndpoint = isMachineEndpoint(new URL(request.url).pathname);
  const headers = commonSecurityHeaders(
    machineEndpoint ? "application/problem+json; charset=utf-8" : "text/html; charset=utf-8",
  );
  headers.set("Retry-After", RETRY_AFTER_SECONDS);

  return new Response(
    bodyForMethod(request, machineEndpoint ? PROBLEM_BODY : MAINTENANCE_HTML),
    { status: 503, headers },
  );
}

function misdirectedRequest(request) {
  const headers = commonSecurityHeaders("application/problem+json; charset=utf-8");
  return new Response(bodyForMethod(request, MISDIRECTED_BODY), { status: 421, headers });
}

function apexRedirect(request, publicHostname) {
  if (!SAFE_METHODS.has(request.method)) {
    // Redirecting a write can make a client replay it. Fail closed and tell the
    // caller to use the canonical host instead.
    return misdirectedRequest(request);
  }

  const target = new URL(request.url);
  target.protocol = "https:";
  target.hostname = publicHostname;
  target.port = "";

  const headers = commonSecurityHeaders("text/plain; charset=utf-8");
  headers.set("Location", target.toString());
  return new Response(null, { status: 308, headers });
}

function normalizedHostname(value) {
  if (typeof value !== "string") return null;
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)
  ) {
    return null;
  }
  return hostname;
}

function originRequest(request, originHostname) {
  const incomingUrl = new URL(request.url);
  const target = new URL(incomingUrl);
  target.protocol = "https:";
  target.hostname = originHostname;
  target.port = "";

  const proxiedRequest = new Request(target, request);
  const headers = new Headers(proxiedRequest.headers);
  // Access identity headers are not part of Sutra's application protocol and
  // must never be forwarded from a browser into the origin or its logs.
  headers.delete("CF-Access-Client-Id");
  headers.delete("CF-Access-Client-Secret");
  headers.delete("CF-Access-Jwt-Assertion");
  headers.set("X-Forwarded-Host", incomingUrl.host);
  headers.set("X-Forwarded-Proto", "https");
  headers.set("X-Sutra-Edge", "cloudflare-worker");

  return new Request(proxiedRequest, { headers, redirect: "manual" });
}

async function discardBody(response) {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // A best-effort cancellation must never mask the deterministic fallback.
  }
}

export async function handleRequest(request, env = {}, runtime = {}) {
  const fetchOrigin = runtime.fetch ?? globalThis.fetch;
  const requestUrl = new URL(request.url);
  const requestHostname = requestUrl.hostname.toLowerCase();
  const publicHostname = normalizedHostname(env.PUBLIC_HOSTNAME ?? "www.sutracmdb.com");
  const apexHostname = normalizedHostname(env.APEX_HOSTNAME ?? "sutracmdb.com");

  if (!publicHostname || !apexHostname) return serviceUnavailable(request);
  if (requestHostname === apexHostname) return apexRedirect(request, publicHostname);
  if (requestHostname !== publicHostname) return misdirectedRequest(request);
  if (SAFE_METHODS.has(request.method) && SECURITY_TEXT_PATHS.has(requestUrl.pathname)) {
    return securityTextResponse(request);
  }

  const originHostname = normalizedHostname(env.ORIGIN_HOSTNAME);
  if (
    !originHostname ||
    originHostname === publicHostname ||
    originHostname === apexHostname ||
    typeof fetchOrigin !== "function"
  ) {
    return serviceUnavailable(request);
  }

  try {
    // Exactly one origin attempt: unsafe requests are never retried or replayed.
    const response = await fetchOrigin(originRequest(request, originHostname));
    if (!FALLBACK_STATUS_CODES.has(response.status)) return response;
    await discardBody(response);
    return serviceUnavailable(request);
  } catch {
    return serviceUnavailable(request);
  }
}

const worker = {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};

export default worker;

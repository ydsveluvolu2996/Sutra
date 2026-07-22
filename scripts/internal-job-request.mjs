import { request } from "node:http";

const LOOPBACK_HOST = "127.0.0.1";
const JOB_PATH = "/api/internal/jobs/run";

function canonicalProxyHeaders(publicOrigin, port) {
  if (publicOrigin === undefined || publicOrigin === "") {
    return {
      host: `${LOOPBACK_HOST}:${port}`,
      "x-forwarded-proto": "http",
    };
  }

  const origin = new URL(publicOrigin);
  if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("SUTRA_PUBLIC_ORIGIN must be an HTTP(S) origin without a path, query, or fragment");
  }

  return {
    host: origin.host,
    "x-forwarded-proto": origin.protocol.slice(0, -1),
  };
}

/**
 * Drain due background jobs through the local Worker listener.
 *
 * `fetch`/undici treats Host as a transport-controlled header and can replace
 * it with the loopback destination. node:http keeps the TCP destination and
 * the HTTP Host independent, which is required by Sutra's canonical-origin
 * boundary when TLS terminates at Cloudflare/Caddy.
 */
export function postInternalJobRun({ port, token, publicOrigin, timeoutMs = 30_000 }) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535) {
    return Promise.reject(new Error("Internal job runner port is invalid"));
  }

  const headers = {
    ...canonicalProxyHeaders(publicOrigin, numericPort),
    "x-sutra-job-token": token,
    "content-length": "0",
  };

  return new Promise((resolvePromise, rejectPromise) => {
    const outgoing = request({
      hostname: LOOPBACK_HOST,
      port: numericPort,
      path: JOB_PATH,
      method: "POST",
      headers,
    }, (response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      resolvePromise({ status, ok: status >= 200 && status < 300 });
    });

    outgoing.once("error", rejectPromise);
    outgoing.setTimeout(timeoutMs, () => {
      const error = new Error("Internal job runner request timed out");
      error.name = "TimeoutError";
      outgoing.destroy(error);
    });
    outgoing.end();
  });
}

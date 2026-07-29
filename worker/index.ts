/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  evaluateDeploymentBoundary,
  generateScriptNonce,
  responseSecurityHeaders,
  type DeploymentSecurityEnvironment,
} from "../lib/deployment-security";
// Buffering the body up front is what keeps a rejected POST from killing the
// runtime — see lib/request-body-buffer.ts for the measured crash behind it.
// (Cancelling after the handler returned was tried first and did not hold: the
// framework clones the request, and the abandoned branch is out of reach here.)
import { bufferRequestBody } from "../lib/request-body-buffer";

interface Env extends DeploymentSecurityEnvironment {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(incoming: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Consume the incoming stream BEFORE anything can reject or clone the request.
    // Every downstream consumer then works on a memory-backed body, which is
    // harmless to abandon. Over the cap is refused here as 413 — no route accepts
    // a body this large, and refusing early bounds what an unauthenticated caller
    // can make us hold.
    const buffered = await bufferRequestBody(incoming);
    if (buffered.kind === "too-large") {
      return Response.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: `The request body exceeds the ${buffered.limitBytes} byte limit`,
          },
        },
        { status: 413, headers: { "Cache-Control": "no-store" } },
      );
    }
    const request = buffered.request;
    const url = new URL(request.url);
    const boundary = evaluateDeploymentBoundary(request, env);
    if (!boundary.allowed) {
      const response = Response.json(
        { ok: false, code: boundary.code, message: "This Sutra deployment is not available in the requested environment." },
        { status: boundary.status },
      );
      for (const [name, value] of Object.entries(responseSecurityHeaders(request, boundary.environment))) response.headers.set(name, value);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const imageResponse = await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
      for (const [name, value] of Object.entries(responseSecurityHeaders(request, boundary.environment))) imageResponse.headers.set(name, value);
      return imageResponse;
    }

    // Per-request CSP nonce for inline scripts. Pinned on the request's
    // `content-security-policy` header so the framework stamps its inline
    // hydration scripts (and the layout reads it for the theme bootstrap), then
    // set on the response — this is what lets 'unsafe-inline' stay out of
    // script-src while the app still runs.
    const scriptNonce = generateScriptNonce();
    const renderRequest = new Request(request, { headers: new Headers(request.headers) });
    renderRequest.headers.set("content-security-policy", `script-src 'self' 'nonce-${scriptNonce}'`);
    const applicationResponse = await handler.fetch(renderRequest, env, ctx);
    const response = new Response(applicationResponse.body, applicationResponse);
    for (const [name, value] of Object.entries(responseSecurityHeaders(request, boundary.environment, scriptNonce))) response.headers.set(name, value);
    response.headers.delete("X-Powered-By");
    if (url.pathname.startsWith("/api/") || boundary.environment !== "production") response.headers.set("Cache-Control", "no-store");
    return response;
  },
};

export default worker;

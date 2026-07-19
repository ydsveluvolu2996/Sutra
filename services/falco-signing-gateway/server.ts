#!/usr/bin/env node
import { createServer, type IncomingMessage } from "node:http";
import {
  FALCO_MAXIMUM_BODY_BYTES,
} from "../../lib/falco-runtime-boundary.ts";
import {
  handleFalcoGatewayRequest,
  loadFalcoGatewayConfig,
} from "./gateway.ts";

const HOST = "0.0.0.0";
const PORT = 8080;
const config = loadFalcoGatewayConfig();

async function readBody(request: IncomingMessage): Promise<Uint8Array | null> {
  const contentLength = request.headers["content-length"];
  if (
    contentLength !== undefined &&
    (!/^\d{1,9}$/u.test(contentLength) || Number(contentLength) > FALCO_MAXIMUM_BODY_BYTES)
  ) {
    request.resume();
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > FALCO_MAXIMUM_BODY_BYTES) {
      request.resume();
      return null;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

const server = createServer(async (request, output) => {
  output.setHeader("cache-control", "no-store");
  output.setHeader("content-type", "application/json; charset=utf-8");
  output.setHeader("x-content-type-options", "nosniff");
  try {
    const url = new URL(request.url ?? "/", "http://gateway.invalid");
    const body = await readBody(request);
    const result = body === null
      ? {
          status: 413,
          body: {
            schemaVersion: "sutra.falco.gateway-response.v1",
            code: "BODY_TOO_LARGE",
          },
        }
      : await handleFalcoGatewayRequest({
          method: request.method ?? "",
          pathname: url.pathname,
          contentType: request.headers["content-type"] ?? null,
          body,
        }, config);
    output.statusCode = result.status;
    output.end(JSON.stringify(result.body));
  } catch {
    output.statusCode = 500;
    output.end(JSON.stringify({
      schemaVersion: "sutra.falco.gateway-response.v1",
      code: "INTERNAL_ERROR",
    }));
  }
});

server.requestTimeout = 10_000;
server.headersTimeout = 5_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

server.listen(PORT, HOST);

function terminate(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGTERM", terminate);
process.once("SIGINT", terminate);

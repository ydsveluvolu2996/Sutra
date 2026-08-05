/** Strict signed HTTP route for the ADD-08 credential boundary. */
import type { IncomingHttpHeaders } from "node:http";
import { createHash } from "node:crypto";
import {
  HostedRequestAuthenticationError,
  type HostedRequestAuthenticator,
} from "./hosted-request-auth.js";
import {
  collectSustainabilityProviderEvidence,
  SustainabilityProviderAdapterError,
  type SustainabilityProviderBinding,
  type SustainabilityProviderReader,
  type SustainabilityProviderRequest,
} from "./sustainability-carbon-provider-adapter.js";
import type { AwsTemporaryCredentials } from "./types.js";

export const SUSTAINABILITY_PROVIDER_ROUTE = "/v1/finops/sustainability-carbon/materialize";
const MAXIMUM_REQUEST_BYTES = 512 * 1024;

export interface SustainabilityCarbonRouteDependencies {
  readonly authenticator: HostedRequestAuthenticator;
  readonly loadBinding: (scope: SustainabilityProviderRequest["scope"]) => Promise<SustainabilityProviderBinding | null>;
  readonly assumeRole: (scope: SustainabilityProviderRequest["scope"], signal: AbortSignal) => Promise<AwsTemporaryCredentials>;
  readonly reader: SustainabilityProviderReader;
  readonly now?: () => number;
}

export interface SustainabilityCarbonRouteResponse {
  readonly status: number; readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parse(body: string): SustainabilityProviderRequest {
  if (Buffer.byteLength(body, "utf8") > MAXIMUM_REQUEST_BYTES) throw new Error("invalid");
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new Error("invalid"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid");
  const record = value as Readonly<Record<string, unknown>>;
  if (record.schemaVersion !== "sutra.sustainability-carbon-runtime-request.v1"
    || typeof record.scope !== "object" || record.scope === null || Array.isArray(record.scope)) throw new Error("invalid");
  return value as SustainabilityProviderRequest;
}

async function response(
  dependencies: SustainabilityCarbonRouteDependencies,
  status: number,
  nonce: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<SustainabilityCarbonRouteResponse> {
  const body = JSON.stringify(payload);
  const signature = await dependencies.authenticator.responseSignature(
    status, SUSTAINABILITY_PROVIDER_ROUTE, nonce, body,
  );
  return { status, body, headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-sutra-key-id": signature.keyId,
    "x-sutra-signature": signature.signature,
  } };
}

export async function handleSustainabilityCarbonRoute(input: {
  readonly method: string; readonly path: string;
  readonly headers: IncomingHttpHeaders; readonly body: string;
  readonly dependencies: SustainabilityCarbonRouteDependencies;
  readonly signal: AbortSignal;
}): Promise<SustainabilityCarbonRouteResponse> {
  let nonce = "";
  try {
    if (input.method.toUpperCase() !== "POST" || input.path !== SUSTAINABILITY_PROVIDER_ROUTE
      || input.signal.aborted) throw new Error("invalid");
    const authenticated = await input.dependencies.authenticator.verify({
      method: input.method, path: input.path, headers: input.headers, body: input.body,
    });
    nonce = authenticated.nonce;
    const request = parse(input.body);
    const binding = await input.dependencies.loadBinding(request.scope);
    if (binding === null) {
      return response(input.dependencies, 409, nonce, {
        code: "SUSTAINABILITY_PROVIDER_BINDING_UNAVAILABLE",
        state: "unavailable",
      });
    }
    const credentials = await input.dependencies.assumeRole(request.scope, input.signal);
    const result = await collectSustainabilityProviderEvidence({
      request, binding, credentials, reader: input.dependencies.reader,
      signal: input.signal,
      ...(input.dependencies.now === undefined ? {} : { now: input.dependencies.now }),
    });
    return response(input.dependencies, 200, nonce, {
      schemaVersion: "sutra.sustainability-carbon-materializer-response.v1",
      requestBodySha256: sha256(input.body),
      capture: result.capture,
      captureBodySha256: result.captureSha256,
      directApiComparator: result.directApiComparator,
      separation: result.separation,
    });
  } catch (error) {
    const code = error instanceof HostedRequestAuthenticationError
      ? "AUTHENTICATION_FAILED"
      : error instanceof SustainabilityProviderAdapterError
        ? error.code : input.signal.aborted ? "ABORTED" : "REQUEST_REJECTED";
    const status = code === "AUTHENTICATION_FAILED" ? 401
      : code === "BOUND_REACHED" ? 413 : code === "ABORTED" ? 408 : 400;
    return response(input.dependencies, status, nonce, {
      code, state: "failed",
      message: "Sustainability provider request did not complete",
    });
  }
}

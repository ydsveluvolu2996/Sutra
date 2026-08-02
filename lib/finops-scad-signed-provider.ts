/** App-side adapter for the authenticated SCAD provider route. */
import type { ScadCur2ProviderRequest } from "../services/aws-collector/src/scad-cur2-provider-adapter.ts";
import type { ScadCur2Manifest, ScadCur2ObjectPage, ScadCur2Provider, ScadCur2RowPage,
  ScadCur2RuntimeBoundary } from "./finops-scad-cur2-runtime-adapter.ts";

const SHA = /^[a-f0-9]{64}$/u; const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
export interface ScadCur2SignedProviderTransport {
  invoke(input: { readonly path: "/v1/finops/scad/cur2-provider"; readonly body: string;
    readonly headers: { readonly tenantId: string; readonly customerId: string;
      readonly connectionId: string; readonly jobId: string }; readonly signal: AbortSignal }): Promise<{
        readonly verified: true; readonly keyId: string; readonly responseBodySha256: string;
        readonly body: unknown }>;
}
export class ScadCur2SignedProviderError extends Error {
  public readonly code: "INVALID_CONFIGURATION" | "BROKER_RESPONSE_INVALID";
  public constructor(code: "INVALID_CONFIGURATION" | "BROKER_RESPONSE_INVALID") {
    super("SCAD CUR2 signed provider rejected"); this.name = "ScadCur2SignedProviderError";
    this.code = code;
  }
}
const reject = (code: ScadCur2SignedProviderError["code"]): never => { throw new ScadCur2SignedProviderError(code); };
async function sha256(value: string): Promise<string> { const digest = await crypto.subtle.digest("SHA-256",
  new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join(""); }
function exact(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
export function createScadCur2SignedProvider(configuration: { readonly jobId: string;
  readonly scheduledWindow: string; readonly transport: ScadCur2SignedProviderTransport }): ScadCur2Provider {
  if (!/^job_[a-f0-9]{32}$/u.test(configuration.jobId)
    || !/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u.test(configuration.scheduledWindow)
    || typeof configuration.transport?.invoke !== "function") reject("INVALID_CONFIGURATION");
  const invoke = async (boundary: ScadCur2RuntimeBoundary, operation: ScadCur2ProviderRequest["operation"],
    signal: AbortSignal): Promise<unknown> => {
    const requestId = `scr_${await sha256(JSON.stringify([configuration.jobId,
      configuration.scheduledWindow, boundary.scope, boundary.exportArn, boundary.billingPeriodStartAt, operation]))}`;
    const request: ScadCur2ProviderRequest = { schemaVersion: "sutra.scad-cur2-provider-request.v1", requestId,
      jobId: configuration.jobId, scheduledWindow: configuration.scheduledWindow, boundary, operation };
    const body = JSON.stringify(request); const response = await configuration.transport.invoke({
      path: "/v1/finops/scad/cur2-provider", body, headers: { tenantId: boundary.scope.orgId,
        customerId: boundary.scope.customerId, connectionId: boundary.scope.connectionId,
        jobId: configuration.jobId }, signal });
    const envelope = response.body;
    if (response.verified !== true || !KEY.test(response.keyId) || !SHA.test(response.responseBodySha256)
      || response.responseBodySha256 !== await sha256(JSON.stringify(response.body))) {
      reject("BROKER_RESPONSE_INVALID");
    }
    if (!exact(envelope, ["payload", "requestBodySha256", "requestId", "schemaVersion"])) {
      reject("BROKER_RESPONSE_INVALID");
    }
    const validated = envelope as Readonly<Record<string, unknown>>;
    if (validated.schemaVersion !== "sutra.scad-cur2-provider-response.v1"
      || validated.requestId !== requestId || validated.requestBodySha256 !== await sha256(body)) {
      reject("BROKER_RESPONSE_INVALID");
    }
    return validated.payload;
  };
  const provider: ScadCur2Provider = {
    getManifest: async (boundary: ScadCur2RuntimeBoundary, signal: AbortSignal) =>
      invoke(boundary, { kind: "GET_MANIFEST" }, signal) as Promise<ScadCur2Manifest>,
    listManifestObjects: async (input: Parameters<ScadCur2Provider["listManifestObjects"]>[0], signal: AbortSignal) =>
      invoke(input.boundary, { kind: "LIST_OBJECTS", manifestSha256: input.manifestSha256,
        pageSize: input.pageSize, token: input.token }, signal) as Promise<ScadCur2ObjectPage>,
    readObjectRows: async (input: Parameters<ScadCur2Provider["readObjectRows"]>[0], signal: AbortSignal) =>
      invoke(input.boundary, { kind: "READ_ROWS", manifestSha256: input.manifestSha256,
        pageSize: input.pageSize, token: input.token, object: input.object }, signal) as Promise<ScadCur2RowPage>,
  };
  return Object.freeze(provider);
}

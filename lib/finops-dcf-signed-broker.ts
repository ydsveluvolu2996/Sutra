/** Signed, bounded app-to-collector transport for ADV-12 DCF metadata. */
import {
  signHostedBrokerRequest,
  verifyHostedBrokerResponse,
  type HostedBrokerClientSigningConfiguration,
} from "./hosted-broker-client-security.ts";
import {
  DCF_EXECUTION_READ_OPERATIONS,
  normalizeDcfCapture,
} from "./finops-dcf-execution-history.ts";
import {
  DCF_STEP_FUNCTIONS_ADAPTER_BOUNDS,
  DcfStepFunctionsAdapterError,
  type DcfStepFunctionsBoundary,
  type DcfStepFunctionsCollectionResult,
} from "./finops-dcf-step-functions-adapter.ts";

export const DCF_STEP_FUNCTIONS_BROKER_PATH = "/v1/finops/dcf-step-functions/collect";
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAXIMUM_RESPONSE_BYTES = 65 * 1_024 * 1_024;
const FAILURE_CODES = new Set([
  "AUTHORIZATION_FAILED", "SOURCE_UNAVAILABLE", "THROTTLED", "TIMEOUT",
  "SCHEMA_MISMATCH", "SCOPE_MISMATCH", "UNSUPPORTED_STATE_MACHINE",
  "LIMIT_REACHED", "INTERNAL_ERROR",
]);

export interface DcfStepFunctionsSignedBrokerConfiguration {
  readonly brokerOrigin: string;
  readonly signing: HostedBrokerClientSigningConfiguration;
}
export class DcfStepFunctionsSignedBrokerError extends Error {
  public readonly code: "BROKER_UNAVAILABLE" | "BROKER_TIMEOUT" | "BROKER_AUTHENTICATION_FAILED" | "BROKER_RESPONSE_INVALID" | "EVIDENCE_REJECTED";
  public constructor(code: DcfStepFunctionsSignedBrokerError["code"]) {
    super("Data Collection Monitor broker request failed");
    this.name = "DcfStepFunctionsSignedBrokerError";
    this.code = code;
  }
}
function reject(code: DcfStepFunctionsSignedBrokerError["code"]): never {
  throw new DcfStepFunctionsSignedBrokerError(code);
}
function origin(value: string): string {
  let parsed: URL; try { parsed = new URL(value); } catch { return reject("BROKER_UNAVAILABLE"); }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") reject("BROKER_UNAVAILABLE");
  return parsed.origin;
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
async function boundedBody(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAXIMUM_RESPONSE_BYTES)) reject("BROKER_RESPONSE_INVALID");
  if (response.body === null) reject("BROKER_RESPONSE_INVALID");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    total += part.value.byteLength;
    if (total > MAXIMUM_RESPONSE_BYTES) { await reader.cancel(); reject("BROKER_RESPONSE_INVALID"); }
    chunks.push(part.value);
  }
  if (total < 2) reject("BROKER_RESPONSE_INVALID");
  const result = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
function parseEnvelope(bytes: Uint8Array): {
  readonly schemaVersion: "sutra.dcf-step-functions-broker-response.v1";
  readonly boundaryId: string;
  readonly requestBodySha256: string;
  readonly result: DcfStepFunctionsCollectionResult;
} {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return reject("BROKER_RESPONSE_INVALID"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    || JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify([
      "boundaryId", "requestBodySha256", "result", "schemaVersion",
    ])) reject("BROKER_RESPONSE_INVALID");
  const envelope = parsed as Record<string, unknown>;
  if (envelope.schemaVersion !== "sutra.dcf-step-functions-broker-response.v1"
    || typeof envelope.boundaryId !== "string" || !/^dcfb_[a-f0-9]{64}$/u.test(envelope.boundaryId)
    || typeof envelope.requestBodySha256 !== "string" || !SHA256.test(envelope.requestBodySha256)
    || typeof envelope.result !== "object" || envelope.result === null || Array.isArray(envelope.result)) reject("BROKER_RESPONSE_INVALID");
  const result = envelope.result as Record<string, unknown>;
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify([
    "capture", "failureCodes", "requestCount", "retryCount", "schemaVersion", "sourceState",
  ]) || result.schemaVersion !== "sutra.dcf-step-functions-collection-result.v1"
    || !new Set(["READY", "PARTIAL", "STALE", "UNAVAILABLE"]).has(String(result.sourceState))
    || !Array.isArray(result.failureCodes)
    || result.failureCodes.some((code) => typeof code !== "string" || !FAILURE_CODES.has(code))
    || new Set(result.failureCodes).size !== result.failureCodes.length
    || JSON.stringify([...result.failureCodes].sort()) !== JSON.stringify(result.failureCodes)
    || !Number.isSafeInteger(result.requestCount) || Number(result.requestCount) < 0
    || Number(result.requestCount) > DCF_STEP_FUNCTIONS_ADAPTER_BOUNDS.maximumRequests
    || !Number.isSafeInteger(result.retryCount) || Number(result.retryCount) < 0
    || Number(result.retryCount) > Number(result.requestCount)
    || typeof result.capture !== "object" || result.capture === null || Array.isArray(result.capture)) reject("BROKER_RESPONSE_INVALID");
  return envelope as unknown as ReturnType<typeof parseEnvelope>;
}

export function createDcfStepFunctionsSignedBroker(input: {
  readonly configuration: DcfStepFunctionsSignedBrokerConfiguration;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly nonce?: () => string;
}): { readonly collect: (boundary: DcfStepFunctionsBoundary, signal: AbortSignal) => Promise<DcfStepFunctionsCollectionResult> } {
  const brokerOrigin = origin(input.configuration.brokerOrigin);
  const fetcher = input.fetcher ?? fetch; const now = input.now ?? Date.now;
  const nonce = input.nonce ?? (() => crypto.randomUUID().replaceAll("-", ""));
  return Object.freeze({
    collect: async (boundary: DcfStepFunctionsBoundary, parentSignal: AbortSignal) => {
      const requestedAt = now();
      if (!Number.isSafeInteger(requestedAt) || requestedAt < 0 || parentSignal.aborted) reject("BROKER_TIMEOUT");
      const request = Object.freeze({
        schemaVersion: "sutra.dcf-step-functions-provider-request.v1" as const,
        boundary,
        operations: DCF_EXECUTION_READ_OPERATIONS,
        bounds: DCF_STEP_FUNCTIONS_ADAPTER_BOUNDS,
        credentials: "SERVER_OWNED_TRUST_ROLE_SESSION" as const,
        includeRawInput: false as const,
        includeRawOutput: false as const,
        includeRawProviderErrors: false as const,
        includeRawPaginationTokens: false as const,
        deadlineAtIso: new Date(requestedAt + DCF_STEP_FUNCTIONS_ADAPTER_BOUNDS.maximumDurationMs).toISOString(),
      });
      const body = JSON.stringify(request); const requestBodySha256 = await sha256(body);
      let signed: Awaited<ReturnType<typeof signHostedBrokerRequest>>;
      try { signed = await signHostedBrokerRequest({ method: "POST", path: DCF_STEP_FUNCTIONS_BROKER_PATH, body, now: requestedAt, nonce: nonce(), config: input.configuration.signing }); }
      catch { return reject("BROKER_AUTHENTICATION_FAILED"); }
      const controller = new AbortController(); const abort = () => controller.abort();
      parentSignal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, DCF_STEP_FUNCTIONS_ADAPTER_BOUNDS.maximumDurationMs);
      let response: Response;
      try {
        response = await fetcher(`${brokerOrigin}${DCF_STEP_FUNCTIONS_BROKER_PATH}`, {
          method: "POST", headers: { accept: "application/json", "content-type": "application/json",
            "x-sutra-tenant-id": boundary.scope.orgId,
            "x-sutra-customer-id": boundary.scope.customerId,
            "x-sutra-connection-id": boundary.scope.connectionId,
            "x-sutra-boundary-id": boundary.boundaryId,
            ...signed.headers }, body, signal: controller.signal,
        });
      } catch { return reject(controller.signal.aborted ? "BROKER_TIMEOUT" : "BROKER_UNAVAILABLE"); }
      finally { clearTimeout(timeout); parentSignal.removeEventListener("abort", abort); }
      const bytes = await boundedBody(response);
      try { await verifyHostedBrokerResponse({ status: response.status, path: DCF_STEP_FUNCTIONS_BROKER_PATH, nonce: signed.nonce, body: bytes, headers: response.headers, config: input.configuration.signing }); }
      catch { return reject("BROKER_AUTHENTICATION_FAILED"); }
      if (response.status !== 200 || !JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) reject("BROKER_UNAVAILABLE");
      const envelope = parseEnvelope(bytes);
      if (envelope.boundaryId !== boundary.boundaryId || envelope.requestBodySha256 !== requestBodySha256) reject("BROKER_RESPONSE_INVALID");
      try {
        const snapshot = normalizeDcfCapture(envelope.result.capture, boundary.scope, Date.parse(envelope.result.capture.completedAt));
        if (snapshot.complete !== (envelope.result.sourceState === "READY" || envelope.result.sourceState === "STALE")) {
          throw new DcfStepFunctionsAdapterError("COLLECTION_FAILED");
        }
      } catch { return reject("EVIDENCE_REJECTED"); }
      return envelope.result;
    },
  });
}

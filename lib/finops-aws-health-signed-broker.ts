/** Signed, bounded app-to-collector transport for ADV-06 AWS Health. */
import {
  signHostedBrokerRequest,
  verifyHostedBrokerResponse,
  type HostedBrokerClientSigningConfiguration,
} from "./hosted-broker-client-security.ts";
import {
  AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS,
  AWS_HEALTH_ORGANIZATION_CONFIGURATION_READ_OPERATION,
  AWS_HEALTH_ORGANIZATION_READ_OPERATIONS,
  normalizeAwsHealthOrganizationCapture,
  type AwsHealthOrganizationCapture,
} from "./finops-aws-health-organization.ts";
import {
  AwsHealthRuntimeBindingError,
  type AwsHealthRuntimeAdapter,
  type AwsHealthRuntimeAdapterRequest,
} from "./finops-aws-health-runtime-binding.ts";
import type { AwsHealthProviderContext } from
  "../db/finops-aws-health-runtime-repository.ts";

export const AWS_HEALTH_BROKER_PATH = "/v1/finops/aws-health/collect";
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_RESPONSE_BYTES = AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.maximumCaptureBytes + 2 * 1_024 * 1_024;

export interface AwsHealthSignedBrokerConfiguration {
  readonly brokerOrigin: string;
  readonly signing: HostedBrokerClientSigningConfiguration;
}

function fail(code: AwsHealthRuntimeBindingError["code"]): never { throw new AwsHealthRuntimeBindingError(code); }
function origin(value: string): string {
  let parsed: URL; try { parsed = new URL(value); } catch { fail("ADAPTER_UNAVAILABLE"); }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") fail("ADAPTER_UNAVAILABLE");
  return parsed.origin;
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
async function bounded(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) fail("CAPTURE_REJECTED");
  if (response.body === null) fail("CAPTURE_REJECTED");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const item = await reader.read(); if (item.done) break; total += item.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); fail("CAPTURE_REJECTED"); }
    chunks.push(item.value);
  }
  if (total < 2) fail("CAPTURE_REJECTED");
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
function envelope(bytes: Uint8Array): { readonly schemaVersion: "sutra.aws-health-provider-response.v1"; readonly requestId: string; readonly requestBodySha256: string; readonly capture: AwsHealthOrganizationCapture } {
  let parsed: unknown; try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("CAPTURE_REJECTED"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail("CAPTURE_REJECTED");
  const value = parsed as Record<string, unknown>;
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["capture", "requestBodySha256", "requestId", "schemaVersion"])
    || value.schemaVersion !== "sutra.aws-health-provider-response.v1"
    || typeof value.requestId !== "string" || !/^hrr_[a-f0-9]{64}$/u.test(value.requestId)
    || typeof value.requestBodySha256 !== "string" || !SHA256.test(value.requestBodySha256)
    || typeof value.capture !== "object" || value.capture === null || Array.isArray(value.capture)) fail("CAPTURE_REJECTED");
  return value as unknown as ReturnType<typeof envelope>;
}

export function createAwsHealthSignedBrokerAdapter(input: {
  readonly configuration: AwsHealthSignedBrokerConfiguration;
  readonly resolveContext: (request: AwsHealthRuntimeAdapterRequest) => Promise<AwsHealthProviderContext>;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly nonce?: () => string;
}): AwsHealthRuntimeAdapter {
  const brokerOrigin = origin(input.configuration.brokerOrigin); const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? Date.now; const nonce = input.nonce ?? (() => crypto.randomUUID().replaceAll("-", ""));
  return Object.freeze({
    collect: async (runtimeRequest: AwsHealthRuntimeAdapterRequest, parentSignal: AbortSignal) => {
      let context: AwsHealthProviderContext; try { context = await input.resolveContext(runtimeRequest); } catch { fail("ADAPTER_UNAVAILABLE"); }
      const requestedAt = now();
      if (!Number.isSafeInteger(requestedAt) || requestedAt < 0) fail("CAPTURE_REJECTED");
      const deadlineAtIso = new Date(requestedAt + AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.maximumDurationMs).toISOString();
      const request = Object.freeze({
        schemaVersion: "sutra.aws-health-provider-request.v1" as const,
        requestId: runtimeRequest.requestId, scheduledWindow: runtimeRequest.scheduledWindow,
        scope: runtimeRequest.scope, candidateAccounts: context.candidateAccounts,
        enabledObservedSince: context.enabledObservedSince,
        healthOperations: AWS_HEALTH_ORGANIZATION_READ_OPERATIONS,
        configurationOperation: AWS_HEALTH_ORGANIZATION_CONFIGURATION_READ_OPERATION,
        prerequisiteOperations: Object.freeze(["organizations:DescribeOrganization", "organizations:ListDelegatedAdministrators"] as const),
        bounds: AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS,
        locale: "en" as const, unfilteredAvailableEvents: true as const,
        credentials: "SERVER_OWNED_TRUST_ROLE_SESSIONS" as const, deadlineAtIso,
      });
      const body = JSON.stringify(request); const requestBodySha256 = await sha256(body);
      let signed: Awaited<ReturnType<typeof signHostedBrokerRequest>>;
      try { signed = await signHostedBrokerRequest({ method: "POST", path: AWS_HEALTH_BROKER_PATH, body, now: requestedAt, nonce: nonce(), config: input.configuration.signing }); }
      catch { fail("ADAPTER_UNAVAILABLE"); }
      const controller = new AbortController();
      const abort = () => controller.abort(); if (parentSignal.aborted) abort(); else parentSignal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.maximumDurationMs);
      let response: Response;
      try {
        response = await fetcher(`${brokerOrigin}${AWS_HEALTH_BROKER_PATH}`, { method: "POST", headers: {
          "content-type": "application/json", accept: "application/json",
          "x-sutra-tenant-id": runtimeRequest.scope.orgId,
          "x-sutra-customer-id": runtimeRequest.scope.customerId,
          "x-sutra-connection-id": runtimeRequest.scope.connectionId,
          "x-sutra-request-id": runtimeRequest.requestId,
          ...signed.headers,
        }, body, signal: controller.signal });
      } catch {
        clearTimeout(timer); parentSignal.removeEventListener("abort", abort);
        fail(controller.signal.aborted ? "ADAPTER_TIMEOUT" : "ADAPTER_UNAVAILABLE");
      }
      let bytes: Uint8Array;
      try { bytes = await bounded(response); }
      finally { clearTimeout(timer); parentSignal.removeEventListener("abort", abort); }
      try { await verifyHostedBrokerResponse({ status: response.status, path: AWS_HEALTH_BROKER_PATH, nonce: signed.nonce, body: bytes, headers: response.headers, config: input.configuration.signing }); }
      catch { fail("ADAPTER_UNAVAILABLE"); }
      if (response.status !== 200 || !JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) fail("ADAPTER_UNAVAILABLE");
      const parsed = envelope(bytes);
      if (parsed.requestId !== runtimeRequest.requestId || parsed.requestBodySha256 !== requestBodySha256) fail("CAPTURE_REJECTED");
      if (parsed.capture.captureId !== `health_${runtimeRequest.requestId.slice(4)}`) fail("CAPTURE_REJECTED");
      try { normalizeAwsHealthOrganizationCapture(parsed.capture, runtimeRequest.scope, Date.parse(parsed.capture.completedAtIso)); }
      catch { fail("CAPTURE_REJECTED"); }
      return parsed.capture;
    },
  });
}

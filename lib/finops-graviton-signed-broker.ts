/** Signed, bounded application-to-provider transport for ADV-05. */
import {
  signHostedBrokerRequest,
  verifyHostedBrokerResponse,
  type HostedBrokerClientSigningConfiguration,
} from "./hosted-broker-client-security.ts";
import {
  GRAVITON_SAVINGS_BOUNDS,
  GRAVITON_SAVINGS_READ_OPERATIONS,
  buildGravitonSavingsSnapshot,
  type GravitonSavingsCapture,
} from "./finops-graviton-savings.ts";
import type { GravitonSignedCollector, GravitonMaterializationRequest } from "./finops-graviton-savings-job.ts";
import type { GravitonRuntimeProviderContext } from "../db/finops-graviton-runtime-repository.ts";

export const GRAVITON_BROKER_PATH = "/v1/finops/graviton-savings/collect";
const CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const SHA = /^[a-f0-9]{64}$/u;
const MAX_RESPONSE_BYTES = GRAVITON_SAVINGS_BOUNDS.maximumCaptureBytes + 2 * 1_024 * 1_024;
export interface GravitonSignedBrokerConfiguration {
  readonly brokerOrigin: string;
  readonly signing: HostedBrokerClientSigningConfiguration;
}
export class GravitonSignedBrokerError extends Error {
  public readonly code: "INVALID_CONFIGURATION" | "TRANSPORT_FAILED" | "RESPONSE_REJECTED" | "TIMEOUT";
  public constructor(code: GravitonSignedBrokerError["code"]) {
    super("Graviton signed broker operation failed"); this.name = "GravitonSignedBrokerError"; this.code = code;
  }
}
function reject(code: GravitonSignedBrokerError["code"]): never { throw new GravitonSignedBrokerError(code); }
function origin(value: string): string {
  let parsed: URL; try { parsed = new URL(value); } catch { reject("INVALID_CONFIGURATION"); }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/"
    || parsed.search !== "" || parsed.hash !== "") reject("INVALID_CONFIGURATION");
  return parsed.origin;
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
async function bounded(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) reject("RESPONSE_REJECTED");
  if (response.body === null) reject("RESPONSE_REJECTED");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const item = await reader.read(); if (item.done) break; size += item.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); reject("RESPONSE_REJECTED"); }
    chunks.push(item.value);
  }
  if (size < 2) reject("RESPONSE_REJECTED");
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
function envelope(bytes: Uint8Array): { readonly schemaVersion: "sutra.graviton-provider-response.v1"; readonly requestKey: string; readonly requestBodySha256: string; readonly capture: GravitonSavingsCapture } {
  let parsed: unknown; try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { reject("RESPONSE_REJECTED"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) reject("RESPONSE_REJECTED");
  const value = parsed as Record<string, unknown>;
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["capture", "requestBodySha256", "requestKey", "schemaVersion"])
    || value.schemaVersion !== "sutra.graviton-provider-response.v1"
    || typeof value.requestKey !== "string" || !/^gvrq_[a-f0-9]{64}$/u.test(value.requestKey)
    || typeof value.requestBodySha256 !== "string" || !SHA.test(value.requestBodySha256)
    || typeof value.capture !== "object" || value.capture === null || Array.isArray(value.capture)) reject("RESPONSE_REJECTED");
  return value as unknown as ReturnType<typeof envelope>;
}

export function createGravitonSignedBrokerCollector(input: {
  readonly configuration: GravitonSignedBrokerConfiguration;
  readonly resolveContext: (request: GravitonMaterializationRequest) => Promise<GravitonRuntimeProviderContext>;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly nonce?: () => string;
}): GravitonSignedCollector {
  const brokerOrigin = origin(input.configuration.brokerOrigin), fetcher = input.fetcher ?? fetch;
  const now = input.now ?? Date.now, nonce = input.nonce ?? (() => crypto.randomUUID().replaceAll("-", ""));
  return Object.freeze({
    collect: async (runtimeRequest: GravitonMaterializationRequest, parentSignal?: AbortSignal) => {
      let context: GravitonRuntimeProviderContext;
      try { context = await input.resolveContext(runtimeRequest); } catch { reject("INVALID_CONFIGURATION"); }
      const requestedAt = now();
      if (!Number.isSafeInteger(requestedAt) || requestedAt < 0) reject("RESPONSE_REJECTED");
      const deadlineAtIso = new Date(requestedAt + GRAVITON_SAVINGS_BOUNDS.maximumDurationMs).toISOString();
      const request = Object.freeze({
        schemaVersion: "sutra.graviton-provider-request.v1" as const,
        requestKey: runtimeRequest.requestKey, scheduledWindow: runtimeRequest.scheduledWindow,
        boundary: runtimeRequest.boundary, accountTargets: context.accountTargets,
        services: runtimeRequest.services, operations: GRAVITON_SAVINGS_READ_OPERATIONS,
        recommendationPolicy: runtimeRequest.recommendationPolicy,
        evidenceAuthority: context.evidenceAuthority,
        credentials: "SERVER_OWNED_TRUST_ROLE_SESSIONS" as const,
        bounds: Object.freeze({ ...GRAVITON_SAVINGS_BOUNDS, rejectPaginationTokenReplay: true, requireExhaustionEvidence: true }),
        deadlineAtIso,
      });
      const body = JSON.stringify(request), bodySha = await sha256(body);
      let signed: Awaited<ReturnType<typeof signHostedBrokerRequest>>;
      try { signed = await signHostedBrokerRequest({ method: "POST", path: GRAVITON_BROKER_PATH, body, now: requestedAt, nonce: nonce(), config: input.configuration.signing }); }
      catch { reject("INVALID_CONFIGURATION"); }
      const controller = new AbortController(), abort = () => controller.abort();
      if (parentSignal?.aborted) abort(); else parentSignal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, GRAVITON_SAVINGS_BOUNDS.maximumDurationMs);
      let response: Response;
      try {
        response = await fetcher(`${brokerOrigin}${GRAVITON_BROKER_PATH}`, { method: "POST", headers: {
          "content-type": "application/json", accept: "application/json",
          "x-sutra-tenant-id": runtimeRequest.boundary.scope.orgId,
          "x-sutra-customer-id": runtimeRequest.boundary.scope.customerId,
          "x-sutra-connection-id": runtimeRequest.boundary.scope.connectionId,
          "x-sutra-request-id": runtimeRequest.requestKey, ...signed.headers,
        }, body, signal: controller.signal });
      } catch {
        clearTimeout(timer); parentSignal?.removeEventListener("abort", abort);
        reject(controller.signal.aborted ? "TIMEOUT" : "TRANSPORT_FAILED");
      }
      let bytes: Uint8Array;
      try { bytes = await bounded(response); }
      finally { clearTimeout(timer); parentSignal?.removeEventListener("abort", abort); }
      try { await verifyHostedBrokerResponse({ status: response.status, path: GRAVITON_BROKER_PATH,
        nonce: signed.nonce, body: bytes, headers: response.headers, config: input.configuration.signing }); }
      catch { reject("TRANSPORT_FAILED"); }
      if (response.status !== 200 || !CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) reject("TRANSPORT_FAILED");
      const parsed = envelope(bytes);
      if (parsed.requestKey !== runtimeRequest.requestKey || parsed.requestBodySha256 !== bodySha) reject("RESPONSE_REJECTED");
      const completedAtMs = Date.parse(parsed.capture.completedAt);
      if (!Number.isFinite(completedAtMs) || completedAtMs < requestedAt - 5 * 60 * 1_000
        || completedAtMs > Date.parse(deadlineAtIso)) reject("RESPONSE_REJECTED");
      try { buildGravitonSavingsSnapshot(parsed.capture, runtimeRequest.boundary, new Date(Date.parse(deadlineAtIso))); }
      catch { reject("RESPONSE_REJECTED"); }
      return parsed.capture;
    },
  });
}

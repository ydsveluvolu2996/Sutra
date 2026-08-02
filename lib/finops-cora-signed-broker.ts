/** Authenticated, bounded app-to-collector transport for ADD-01 CORA. */
import { signHostedBrokerRequest, verifyHostedBrokerResponse,
  type HostedBrokerClientSigningConfiguration } from "./hosted-broker-client-security.ts";
import { CORA_EXPORT_OBJECT_BOUNDS,
  normalizeCoraExportObjectMaterialization, type CoraExportObjectMaterialization,
  type CoraExportServerBoundary } from "./finops-cora-export-materialization.ts";
import type { CoraExportS3Adapter } from "./finops-cora-export-orchestration.ts";

export const CORA_BROKER_PATH = "/v1/finops/cora/collect";
export const CORA_REQUIRED_PERMISSION_PACK = "standard-2026-08.14" as const;
const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu; const SHA = /^[a-f0-9]{64}$/u;
const MAX_RESPONSE_BYTES = CORA_EXPORT_OBJECT_BOUNDS.maximumBytes + 16 * 1_024 * 1_024;
const CORA_PROVIDER_READ_OPERATIONS = Object.freeze([
  "bcm-data-exports:GetExport", "bcm-data-exports:GetExecution", "bcm-data-exports:ListExecutions",
  "cost-optimization-hub:GetPreferences", "cost-optimization-hub:ListEnrollmentStatuses",
  "organizations:DescribeOrganization", "organizations:ListAccounts",
  "s3:GetBucketLocation", "s3:ListBucket", "s3:GetObject", "s3:GetObjectAttributes",
] as const);
export interface CoraSignedBrokerConfiguration { readonly brokerOrigin: string; readonly signing: HostedBrokerClientSigningConfiguration; }
export class CoraSignedBrokerError extends Error { public readonly code: "BROKER_UNAVAILABLE" | "BROKER_TIMEOUT" | "BROKER_AUTHENTICATION_FAILED" | "BROKER_RESPONSE_INVALID" | "EVIDENCE_REJECTED"; public constructor(code: CoraSignedBrokerError["code"]) { super("CORA broker request failed"); this.name = "CoraSignedBrokerError"; this.code = code; } }
function reject(code: CoraSignedBrokerError["code"]): never { throw new CoraSignedBrokerError(code); }
function origin(value: string): string { let parsed: URL; try { parsed = new URL(value); } catch { reject("BROKER_UNAVAILABLE"); } if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") reject("BROKER_UNAVAILABLE"); return parsed.origin; }
async function sha256(value: string): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join(""); }
async function bounded(response: Response): Promise<Uint8Array> { const declared = response.headers.get("content-length"); if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) reject("BROKER_RESPONSE_INVALID"); if (response.body === null) reject("BROKER_RESPONSE_INVALID"); const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0; while (true) { const next = await reader.read(); if (next.done) break; total += next.value.byteLength; if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); reject("BROKER_RESPONSE_INVALID"); } chunks.push(next.value); } const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes; }
export function createCoraSignedBroker(input: { readonly configuration: CoraSignedBrokerConfiguration; readonly boundaryForRequest: (request: Parameters<CoraExportS3Adapter["materialize"]>[0]) => Promise<CoraExportServerBoundary>; readonly fetcher?: typeof fetch; readonly now?: () => number; readonly nonce?: () => string }): CoraExportS3Adapter {
  const broker = origin(input.configuration.brokerOrigin); const fetcher = input.fetcher ?? fetch; const now = input.now ?? Date.now; const nonce = input.nonce ?? (() => crypto.randomUUID().replaceAll("-", ""));
  return { async materialize(request, parentSignal) {
    const boundary = await input.boundaryForRequest(request); const requestedAt = now(); if (!Number.isSafeInteger(requestedAt) || requestedAt < 0 || parentSignal.aborted) reject("BROKER_TIMEOUT");
    const providerRequest = { schemaVersion: "sutra.cora-export-provider-request.v1", requestKey: request.requestKey, scheduledWindow: request.scheduledWindow, scope: request.scope, target: request.target, expectedAccountIds: request.expectedAccountIds, expectedRegions: request.expectedRegions, operations: CORA_PROVIDER_READ_OPERATIONS, manifestSelection: request.manifestSelection, rejectMutableLatestManifest: request.rejectMutableLatestManifest, acceptDirectApiRecommendationRows: request.acceptDirectApiRecommendationRows,
      bounds: { maximumObjects: request.maximumObjects, maximumRows: request.maximumRows, maximumBytes: request.maximumBytes, maximumManifestBytes: 8 * 1_024 * 1_024, maximumRowBytes: 96 * 1_024, maximumDurationMs: 15 * 60 * 1_000, maximumAccounts: 10_000, maximumRegions: 100, rejectPaginationTokenReplay: true, requireExhaustionEvidence: true }, deadlineAtIso: new Date(requestedAt + 15 * 60 * 1_000).toISOString(), credentials: "SERVER_OWNED_TRUST_ROLE_SESSION" };
    const body = JSON.stringify(providerRequest); const bodyHash = await sha256(body); let signed; try { signed = await signHostedBrokerRequest({ method: "POST", path: CORA_BROKER_PATH, body, now: requestedAt, nonce: nonce(), config: input.configuration.signing }); } catch { reject("BROKER_AUTHENTICATION_FAILED"); }
    const controller = new AbortController(); const abort = () => controller.abort(); parentSignal.addEventListener("abort", abort, { once: true }); const timer = setTimeout(abort, 15 * 60 * 1_000);
    let response: Response; try { response = await fetcher(`${broker}${CORA_BROKER_PATH}`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "x-sutra-tenant-id": request.scope.orgId, "x-sutra-customer-id": request.scope.customerId, "x-sutra-connection-id": request.scope.connectionId, "x-sutra-request-id": request.requestKey, ...signed.headers }, body, signal: controller.signal }); } catch { reject(controller.signal.aborted ? "BROKER_TIMEOUT" : "BROKER_UNAVAILABLE"); } finally { clearTimeout(timer); parentSignal.removeEventListener("abort", abort); }
    const bytes = await bounded(response); try { await verifyHostedBrokerResponse({ status: response.status, path: CORA_BROKER_PATH, nonce: signed.nonce, body: bytes, headers: response.headers, config: input.configuration.signing }); } catch { reject("BROKER_AUTHENTICATION_FAILED"); }
    if (response.status !== 200 || !JSON_TYPE.test(response.headers.get("content-type") ?? "")) reject("BROKER_UNAVAILABLE"); let parsed: unknown; try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { reject("BROKER_RESPONSE_INVALID"); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) reject("BROKER_RESPONSE_INVALID"); const envelope = parsed as Record<string, unknown>; if (JSON.stringify(Object.keys(envelope).sort()) !== JSON.stringify(["materialization", "requestBodySha256", "requestId", "schemaVersion"]) || envelope.schemaVersion !== "sutra.cora-export-provider-response.v1" || envelope.requestId !== request.requestKey || envelope.requestBodySha256 !== bodyHash || typeof envelope.requestBodySha256 !== "string" || !SHA.test(envelope.requestBodySha256) || typeof envelope.materialization !== "object" || envelope.materialization === null || Array.isArray(envelope.materialization)) reject("BROKER_RESPONSE_INVALID");
    try { return normalizeCoraExportObjectMaterialization(envelope.materialization as CoraExportObjectMaterialization, boundary, now()); } catch { reject("EVIDENCE_REJECTED"); }
  } };
}

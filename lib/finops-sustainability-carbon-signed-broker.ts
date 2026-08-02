/** Exact-byte authenticated app-side transport for the ADD-08 collector route. */
import { canonicalJson } from "./canonical-json.ts";
import {
  SUSTAINABILITY_CARBON_BOUNDS,
  normalizeSustainabilityCarbonCapture,
  type SustainabilityCarbonCapture,
} from "./finops-sustainability-carbon.ts";
import {
  SUSTAINABILITY_CARBON_RUNTIME_TIMEOUT_MS,
  type SustainabilityCarbonRuntimeMaterializer,
  type SustainabilityCarbonRuntimeRequest,
} from "./finops-sustainability-carbon-runtime-binding.ts";
import {
  signHostedBrokerRequest,
  verifyHostedBrokerResponse,
  type HostedBrokerClientSigningConfiguration,
} from "./hosted-broker-client-security.ts";

export const SUSTAINABILITY_CARBON_BROKER_PATH = "/v1/finops/sustainability-carbon/materialize";
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const SHA = /^[a-f0-9]{64}$/u;
const MAX_RESPONSE_BYTES = SUSTAINABILITY_CARBON_BOUNDS.maximumDashboardInputBytes + 2 * 1_024 * 1_024;
export class SustainabilityCarbonSignedBrokerError extends Error {
  public readonly code: "INVALID_CONFIGURATION" | "AUTHENTICATION_FAILED" | "TIMEOUT" | "UNAVAILABLE" | "RESPONSE_INVALID" | "CAPTURE_REJECTED";

  public constructor(code: SustainabilityCarbonSignedBrokerError["code"]) {
    super("Sustainability collector request failed");
    this.name = "SustainabilityCarbonSignedBrokerError";
    this.code = code;
  }
}
function reject(code: SustainabilityCarbonSignedBrokerError["code"]): never { throw new SustainabilityCarbonSignedBrokerError(code); }
function origin(value: string): string { let parsed: URL; try { parsed = new URL(value); } catch { reject("INVALID_CONFIGURATION"); } if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") reject("INVALID_CONFIGURATION"); return parsed.origin; }
function buffer(value: Uint8Array): ArrayBuffer { const copy = new Uint8Array(value.byteLength); copy.set(value); return copy.buffer; }
async function sha256(value: string | Uint8Array): Promise<string> { const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value; const digest = await crypto.subtle.digest("SHA-256", buffer(bytes)); return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join(""); }
async function bounded(response: Response): Promise<Uint8Array> { const declared = response.headers.get("content-length"); if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) reject("RESPONSE_INVALID"); const body = response.body; if (body === null) reject("RESPONSE_INVALID"); const reader = body.getReader(), chunks: Uint8Array[] = []; let total = 0; while (true) { const item = await reader.read(); if (item.done) break; total += item.value.byteLength; if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); reject("RESPONSE_INVALID"); } chunks.push(item.value); } if (total < 2) reject("RESPONSE_INVALID"); const result = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result; }
function parse(bytes: Uint8Array): { readonly requestBodySha256: string; readonly captureBodySha256: string; readonly capture: SustainabilityCarbonCapture } { let value: unknown; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { reject("RESPONSE_INVALID"); } if (typeof value !== "object" || value === null || Array.isArray(value)) reject("RESPONSE_INVALID"); const record = value as Readonly<Record<string, unknown>>; if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["capture", "captureBodySha256", "directApiComparator", "requestBodySha256", "schemaVersion", "separation"]) || record.schemaVersion !== "sutra.sustainability-carbon-materializer-response.v1" || typeof record.requestBodySha256 !== "string" || !SHA.test(record.requestBodySha256) || typeof record.captureBodySha256 !== "string" || !SHA.test(record.captureBodySha256) || typeof record.capture !== "object" || record.capture === null || Array.isArray(record.capture) || typeof record.separation !== "object" || record.separation === null || Array.isArray(record.separation)) reject("RESPONSE_INVALID"); const separation = record.separation as Readonly<Record<string, unknown>>; if (separation.exportIsAuthoritativeHistory !== true || separation.comparatorPersistedAsExport !== false || separation.comparatorMayReplaceExportState !== false || separation.proxyConvertedToCarbon !== false || separation.carbonAllocatedToCur2 !== false) reject("RESPONSE_INVALID"); if (record.directApiComparator !== null) { if (typeof record.directApiComparator !== "object" || Array.isArray(record.directApiComparator) || (record.directApiComparator as Readonly<Record<string, unknown>>).source !== "AWS_SUSTAINABILITY_DIRECT_API") reject("RESPONSE_INVALID"); } return { requestBodySha256: record.requestBodySha256 as string, captureBodySha256: record.captureBodySha256 as string, capture: record.capture as SustainabilityCarbonCapture }; }

export function createSustainabilityCarbonSignedBroker(input: { readonly brokerOrigin: string; readonly signing: HostedBrokerClientSigningConfiguration; readonly fetcher?: typeof fetch; readonly now?: () => number; readonly nonce?: () => string }): SustainabilityCarbonRuntimeMaterializer {
  const brokerOrigin = origin(input.brokerOrigin), fetcher = input.fetcher ?? fetch, now = input.now ?? Date.now, nonce = input.nonce ?? (() => crypto.randomUUID().replaceAll("-", ""));
  return Object.freeze({ collect: async (request: SustainabilityCarbonRuntimeRequest, parentSignal: AbortSignal) => {
    const requestedAt = now(); if (!Number.isSafeInteger(requestedAt) || requestedAt < 0 || parentSignal.aborted) reject("TIMEOUT"); const body = JSON.stringify(request), rawRequestHash = await sha256(body), canonicalRequestHash = await sha256(canonicalJson(request)); let signed: Awaited<ReturnType<typeof signHostedBrokerRequest>>; try { signed = await signHostedBrokerRequest({ method: "POST", path: SUSTAINABILITY_CARBON_BROKER_PATH, body, now: requestedAt, nonce: nonce(), config: input.signing }); } catch { reject("AUTHENTICATION_FAILED"); }
    const controller = new AbortController(), abort = () => controller.abort(); parentSignal.addEventListener("abort", abort, { once: true }); const timeout = setTimeout(abort, SUSTAINABILITY_CARBON_RUNTIME_TIMEOUT_MS); let response: Response; try { response = await fetcher(`${brokerOrigin}${SUSTAINABILITY_CARBON_BROKER_PATH}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "x-sutra-tenant-id": request.scope.orgId, "x-sutra-customer-id": request.scope.customerId, "x-sutra-connection-id": request.scope.connectionId, "x-sutra-request-id": request.requestId, ...signed.headers }, body, signal: controller.signal }); } catch { clearTimeout(timeout); parentSignal.removeEventListener("abort", abort); reject(controller.signal.aborted ? "TIMEOUT" : "UNAVAILABLE"); }
    let bytes: Uint8Array; try { bytes = await bounded(response); } catch (error) { if (controller.signal.aborted) reject("TIMEOUT"); if (error instanceof SustainabilityCarbonSignedBrokerError) throw error; reject("RESPONSE_INVALID"); } finally { clearTimeout(timeout); parentSignal.removeEventListener("abort", abort); }
    try { await verifyHostedBrokerResponse({ status: response.status, path: SUSTAINABILITY_CARBON_BROKER_PATH, nonce: signed.nonce, body: bytes, headers: response.headers, config: input.signing }); } catch { reject("AUTHENTICATION_FAILED"); }
    if (response.status !== 200) reject("UNAVAILABLE"); if (!JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) reject("RESPONSE_INVALID"); const envelope = parse(bytes); if (envelope.requestBodySha256 !== rawRequestHash || envelope.captureBodySha256 !== await sha256(canonicalJson(envelope.capture))) reject("RESPONSE_INVALID"); try { normalizeSustainabilityCarbonCapture(envelope.capture, request.scope, Date.parse(envelope.capture.completedAtIso)); } catch { reject("CAPTURE_REJECTED"); }
    return Object.freeze({ capture: envelope.capture, verification: Object.freeze({ authentication: "ED25519_RESPONSE_SIGNATURE_VERIFIED" as const, requestBodySha256: canonicalRequestHash, captureBodySha256: envelope.captureBodySha256, materializerKeyId: input.signing.brokerKeyId }) });
  } });
}

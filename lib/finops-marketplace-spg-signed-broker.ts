/** Signed, replay-safe app-to-collector transport for ADD-05. */
import { canonicalJson } from "./canonical-json.ts";
import { signHostedBrokerRequest, verifyHostedBrokerResponse, type HostedBrokerClientSigningConfiguration } from "./hosted-broker-client-security.ts";
import { normalizeAwsMarketplaceSpgCapture, type AwsMarketplaceSpgCapture } from "./finops-marketplace-spg.ts";
import { MarketplaceSpgRuntimeBindingError, type MarketplaceSpgRuntimeBrokerRequest, type MarketplaceSpgRuntimeSignedBroker } from "./finops-marketplace-spg-runtime-binding.ts";

export const MARKETPLACE_SPG_BROKER_PATH = "/v1/finops/marketplace-spg/collect";
const MAX_RESPONSE_BYTES = 98 * 1_024 * 1_024; const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
export interface MarketplaceSpgSignedBrokerConfiguration { readonly brokerOrigin: string; readonly signing: HostedBrokerClientSigningConfiguration }
function fail(code: MarketplaceSpgRuntimeBindingError["code"]): never { throw new MarketplaceSpgRuntimeBindingError(code); }
function origin(value: string) { let parsed: URL; try { parsed = new URL(value); } catch { fail("BROKER_UNAVAILABLE"); } if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) fail("BROKER_UNAVAILABLE"); return parsed.origin; }
async function sha256(value: string) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2,"0")).join(""); }
async function bounded(response: Response) { const declared = response.headers.get("content-length"); if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) fail("BROKER_RESPONSE_REJECTED"); if (response.body === null) fail("BROKER_RESPONSE_REJECTED"); const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0; while (true) { const part = await reader.read(); if (part.done) break; total += part.value.byteLength; if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); fail("BROKER_RESPONSE_REJECTED"); } chunks.push(part.value); } const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; } return bytes; }
function exact(value: unknown, keys: readonly string[]) { if (typeof value !== "object" || value === null || Array.isArray(value)) fail("BROKER_RESPONSE_REJECTED"); const item = value as Record<string,unknown>; if (JSON.stringify(Object.keys(item).sort()) !== JSON.stringify([...keys].sort())) fail("BROKER_RESPONSE_REJECTED"); return item; }

export function createMarketplaceSpgSignedBroker(input: { readonly configuration: MarketplaceSpgSignedBrokerConfiguration; readonly fetcher?: typeof fetch; readonly now?: () => number; readonly nonce?: () => string }): MarketplaceSpgRuntimeSignedBroker {
  const brokerOrigin = origin(input.configuration.brokerOrigin); const fetcher = input.fetcher ?? fetch; const now = input.now ?? Date.now; const nonce = input.nonce ?? (() => crypto.randomUUID().replaceAll("-",""));
  return Object.freeze({ collect: async (runtime: MarketplaceSpgRuntimeBrokerRequest, parentSignal: AbortSignal) => {
    const requestedAt = now(); if (!Number.isSafeInteger(requestedAt) || requestedAt < 0) fail("BROKER_RESPONSE_REJECTED");
    const request = Object.freeze({ schemaVersion: "sutra.marketplace-spg-provider-request.v1" as const, requestId: runtime.requestId, expectedCaptureId: runtime.expectedCaptureId, scheduledWindow: runtime.scheduledWindow,
      scope: runtime.scope, expectedAccountIds: runtime.accountCoverage.expectedAccountIds, accountCoverageEvidenceId: runtime.accountCoverage.evidenceGenerationId,
      accountCoverageObservedAt: runtime.accountCoverage.observedAt, licenseManagerRegion: runtime.endpoints.licenseManagerRegion, approvedProductTypes: runtime.approvedProductTypes,
      deadlineAtIso: new Date(requestedAt + runtime.maximumDurationMs).toISOString(), buyerOperations: runtime.buyerOperations, licenseOperations: runtime.licenseOperations,
      accountCoverageActions: runtime.accountCoverageActions, buyerParty: runtime.buyerParty, credentials: "SERVER_OWNED_TRUST_ROLE_SESSIONS" as const, privacy: runtime.privacy, bounds: runtime.bounds });
    const body = canonicalJson(request); const requestBodySha256 = await sha256(body);
    let signed: Awaited<ReturnType<typeof signHostedBrokerRequest>>; try { signed = await signHostedBrokerRequest({ method:"POST", path:MARKETPLACE_SPG_BROKER_PATH, body, now:requestedAt, nonce:nonce(), config:input.configuration.signing }); } catch { fail("BROKER_UNAVAILABLE"); }
    const controller = new AbortController(); const abort = () => controller.abort(); if (parentSignal.aborted) abort(); else parentSignal.addEventListener("abort",abort,{once:true}); const timer = setTimeout(abort,runtime.maximumDurationMs);
    let response: Response; try { response = await fetcher(`${brokerOrigin}${MARKETPLACE_SPG_BROKER_PATH}`, { method:"POST", headers:{ "content-type":"application/json",accept:"application/json","x-sutra-tenant-id":runtime.scope.orgId,"x-sutra-customer-id":runtime.scope.customerId,"x-sutra-connection-id":runtime.scope.connectionId,"x-sutra-request-id":runtime.requestId,...signed.headers },body,signal:controller.signal }); } catch { clearTimeout(timer); parentSignal.removeEventListener("abort",abort); fail(controller.signal.aborted ? "BROKER_TIMEOUT" : "BROKER_UNAVAILABLE"); }
    let bytes: Uint8Array; try { bytes = await bounded(response); } finally { clearTimeout(timer); parentSignal.removeEventListener("abort",abort); }
    try { await verifyHostedBrokerResponse({ status:response.status,path:MARKETPLACE_SPG_BROKER_PATH,nonce:signed.nonce,body:bytes,headers:response.headers,config:input.configuration.signing }); } catch { fail("BROKER_AUTHENTICATION_FAILED"); }
    if (response.status !== 200 || !JSON_TYPE.test(response.headers.get("content-type") ?? "")) fail("BROKER_UNAVAILABLE");
    let parsed: unknown; try { parsed = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)); } catch { fail("BROKER_RESPONSE_REJECTED"); }
    const envelope = exact(parsed,["schemaVersion","requestId","requestBodySha256","captureBodySha256","capture"]);
    if (envelope.schemaVersion !== "sutra.marketplace-spg-provider-response.v1" || envelope.requestId !== runtime.requestId || envelope.requestBodySha256 !== requestBodySha256 || typeof envelope.captureBodySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(envelope.captureBodySha256)) fail("BROKER_RESPONSE_REJECTED");
    const capture = envelope.capture as AwsMarketplaceSpgCapture; const captureBodySha256 = await sha256(JSON.stringify(capture));
    if (captureBodySha256 !== envelope.captureBodySha256) fail("BROKER_AUTHENTICATION_FAILED");
    try { normalizeAwsMarketplaceSpgCapture(capture,runtime.scope,Date.parse(capture.completedAt)); } catch { fail("CAPTURE_REJECTED"); }
    return Object.freeze({ capture, verification:Object.freeze({ authentication:"ED25519_RESPONSE_SIGNATURE_VERIFIED" as const, requestBodySha256:await sha256(canonicalJson(runtime)), captureBodySha256:await sha256(canonicalJson(capture)), brokerKeyId:input.configuration.signing.brokerKeyId }) });
  } });
}

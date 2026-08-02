/** Exact-byte authenticated app transport for ADD-13 historical pricing. */
import type { PricingChangeCur2Artifact } from "../db/finops-pricing-change-cur2-reader.ts";
import { canonicalJson } from "./canonical-json.ts";
import { buildPricingChangeAnalysis, PRICING_CHANGE_ANALYSIS_BOUNDS, type PricingChangeCapture } from "./finops-pricing-change-analysis.ts";
import type { PricingChangeCaptureMaterializer, PricingChangeMaterializerRequest } from "./finops-pricing-change-materialization-job.ts";
import { signHostedBrokerRequest, verifyHostedBrokerResponse, type HostedBrokerClientSigningConfiguration } from "./hosted-broker-client-security.ts";

export const PRICING_CHANGE_BROKER_PATH = "/v1/finops/pricing-change-analysis/materialize";
const CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const SHA = /^[a-f0-9]{64}$/u;
const MAXIMUM_RESPONSE_BYTES = PRICING_CHANGE_ANALYSIS_BOUNDS.maximumCaptureBytes + 2 * 1_024 * 1_024;
const ACTIONS = Object.freeze(["pricing:ListPriceLists", "pricing:GetPriceListFileUrl"] as const);

export class PricingChangeSignedBrokerError extends Error {
  public readonly code: "INVALID_CONFIGURATION" | "TRANSPORT_FAILED" | "AUTHENTICATION_FAILED" | "RESPONSE_REJECTED" | "TIMEOUT";
  public constructor(code: PricingChangeSignedBrokerError["code"]) { super("Pricing Change signed provider call failed"); this.name = "PricingChangeSignedBrokerError"; this.code = code; }
}
function reject(code: PricingChangeSignedBrokerError["code"]): never { throw new PricingChangeSignedBrokerError(code); }
function origin(value: string): string {
  let parsed: URL; try { parsed = new URL(value); } catch { reject("INVALID_CONFIGURATION"); }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") reject("INVALID_CONFIGURATION");
  return parsed.origin;
}
async function sha(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
async function bounded(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAXIMUM_RESPONSE_BYTES)) reject("RESPONSE_REJECTED");
  if (response.body === null) reject("RESPONSE_REJECTED");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  while (true) { const item = await reader.read(); if (item.done) break; total += item.value.byteLength;
    if (total > MAXIMUM_RESPONSE_BYTES) { await reader.cancel(); reject("RESPONSE_REJECTED"); } chunks.push(item.value); }
  if (total < 2) reject("RESPONSE_REJECTED"); const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes;
}
function envelope(bytes: Uint8Array): { readonly requestKey: string; readonly requestBodySha256: string; readonly captureBodySha256: string; readonly capture: PricingChangeCapture } {
  let parsed: unknown; try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { reject("RESPONSE_REJECTED"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) reject("RESPONSE_REJECTED");
  const value = parsed as Readonly<Record<string, unknown>>;
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["capture", "captureBodySha256", "requestBodySha256", "requestKey", "schemaVersion"])
    || value.schemaVersion !== "sutra.pricing-change.provider-response.v1" || typeof value.requestKey !== "string" || !/^pcrq_[a-f0-9]{64}$/u.test(value.requestKey)
    || typeof value.requestBodySha256 !== "string" || !SHA.test(value.requestBodySha256) || typeof value.captureBodySha256 !== "string" || !SHA.test(value.captureBodySha256)
    || typeof value.capture !== "object" || value.capture === null || Array.isArray(value.capture)) reject("RESPONSE_REJECTED");
  return value as unknown as ReturnType<typeof envelope>;
}

export function createPricingChangeSignedBroker(input: {
  readonly brokerOrigin: string; readonly signing: HostedBrokerClientSigningConfiguration;
  readonly readCur2: (request: PricingChangeMaterializerRequest) => Promise<PricingChangeCur2Artifact>;
  readonly fetcher?: typeof fetch; readonly now?: () => number; readonly nonce?: () => string;
}): PricingChangeCaptureMaterializer {
  const brokerOrigin = origin(input.brokerOrigin), fetcher = input.fetcher ?? fetch, now = input.now ?? Date.now;
  const nonce = input.nonce ?? (() => crypto.randomUUID().replaceAll("-", ""));
  return Object.freeze({ collect: async (materialization: PricingChangeMaterializerRequest, parentSignal: AbortSignal) => {
    let cur2: PricingChangeCur2Artifact; try { cur2 = await input.readCur2(materialization); } catch { reject("INVALID_CONFIGURATION"); }
    const requestKey = `pcrq_${await sha(canonicalJson({ materialization, cur2 }))}`;
    const request = Object.freeze({ schemaVersion: "sutra.pricing-change.provider-request.v1" as const, requestKey,
      materialization, cur2, credentials: "SERVER_OWNED_TRUST_ROLE_SESSION" as const, actions: ACTIONS,
      deadlineAtIso: materialization.deadlineAtIso });
    const body = JSON.stringify(request), bodySha = await sha(body), requestedAt = now();
    if (!Number.isSafeInteger(requestedAt) || requestedAt < 0 || parentSignal.aborted) reject("TIMEOUT");
    let signed: Awaited<ReturnType<typeof signHostedBrokerRequest>>;
    try { signed = await signHostedBrokerRequest({ method: "POST", path: PRICING_CHANGE_BROKER_PATH, body, now: requestedAt, nonce: nonce(), config: input.signing }); }
    catch { reject("INVALID_CONFIGURATION"); }
    const controller = new AbortController(), abort = () => controller.abort(); parentSignal.addEventListener("abort", abort, { once: true });
    const duration = Math.max(1, Math.min(PRICING_CHANGE_ANALYSIS_BOUNDS.maximumDurationMs, Date.parse(materialization.deadlineAtIso) - requestedAt));
    const timer = setTimeout(abort, duration); let response: Response;
    try { response = await fetcher(`${brokerOrigin}${PRICING_CHANGE_BROKER_PATH}`, { method: "POST", headers: { "content-type": "application/json",
      accept: "application/json", "x-sutra-tenant-id": materialization.scope.organizationId, "x-sutra-customer-id": materialization.scope.customerId,
      "x-sutra-connection-id": materialization.scope.connectionId, "x-sutra-request-id": requestKey, ...signed.headers }, body, signal: controller.signal }); }
    catch { clearTimeout(timer); parentSignal.removeEventListener("abort", abort); reject(controller.signal.aborted ? "TIMEOUT" : "TRANSPORT_FAILED"); }
    let bytes: Uint8Array; try { bytes = await bounded(response); }
    finally { clearTimeout(timer); parentSignal.removeEventListener("abort", abort); }
    try { await verifyHostedBrokerResponse({ status: response.status, path: PRICING_CHANGE_BROKER_PATH, nonce: signed.nonce,
      body: bytes, headers: response.headers, config: input.signing }); } catch { reject("AUTHENTICATION_FAILED"); }
    if (response.status !== 200 || !CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) reject("TRANSPORT_FAILED");
    const parsed = envelope(bytes);
    if (parsed.requestKey !== requestKey || parsed.requestBodySha256 !== bodySha || parsed.captureBodySha256 !== await sha(canonicalJson(parsed.capture))) reject("RESPONSE_REJECTED");
    try { buildPricingChangeAnalysis(materialization.boundary, parsed.capture, new Date(Date.parse(materialization.deadlineAtIso))); }
    catch { reject("RESPONSE_REJECTED"); }
    return parsed.capture;
  } });
}

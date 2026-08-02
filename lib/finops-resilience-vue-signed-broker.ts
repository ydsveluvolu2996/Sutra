/** Authenticated exact-response transport for ADV-10 ResilienceVue. */
import { signHostedBrokerRequest, verifyHostedBrokerResponse,
  type HostedBrokerClientSigningConfiguration } from "./hosted-broker-client-security.ts";
import { normalizeResilienceVueCapture, type ResilienceVueCapture } from "./finops-resilience-vue.ts";
import type { ResilienceVueRuntimeAwsAdapter, ResilienceVueRuntimeAdapterRequest } from
  "./finops-resilience-vue-runtime-binding.ts";

export const RESILIENCE_VUE_BROKER_PATH = "/v1/finops/resilience-vue/collect";
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const SHA = /^[a-f0-9]{64}$/u;
const MAX_RESPONSE_BYTES = 13 * 1_024 * 1_024;

export interface ResilienceVueSignedBrokerConfiguration {
  readonly brokerOrigin: string;
  readonly signing: HostedBrokerClientSigningConfiguration;
}
export class ResilienceVueSignedBrokerError extends Error {
  public readonly code: "BROKER_UNAVAILABLE" | "BROKER_TIMEOUT" | "BROKER_AUTHENTICATION_FAILED" | "BROKER_RESPONSE_INVALID" | "EVIDENCE_REJECTED";
  public constructor(code: ResilienceVueSignedBrokerError["code"]) {
    super("ResilienceVue broker request failed"); this.name = "ResilienceVueSignedBrokerError"; this.code = code;
  }
}
function reject(code: ResilienceVueSignedBrokerError["code"]): never { throw new ResilienceVueSignedBrokerError(code); }
function brokerOrigin(value: string): string {
  let parsed: URL; try { parsed = new URL(value); } catch { return reject("BROKER_UNAVAILABLE"); }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") reject("BROKER_UNAVAILABLE");
  return parsed.origin;
}
async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value); const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  const result = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(result)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
async function bounded(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) reject("BROKER_RESPONSE_INVALID");
  const value = new Uint8Array(await response.arrayBuffer());
  if (value.byteLength < 2 || value.byteLength > MAX_RESPONSE_BYTES) reject("BROKER_RESPONSE_INVALID");
  return value;
}

export function createResilienceVueSignedBroker(input: {
  readonly configuration: ResilienceVueSignedBrokerConfiguration;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly nonce?: () => string;
}): ResilienceVueRuntimeAwsAdapter {
  const origin = brokerOrigin(input.configuration.brokerOrigin);
  const fetcher = input.fetcher ?? fetch; const now = input.now ?? Date.now;
  const nonce = input.nonce ?? (() => crypto.randomUUID().replaceAll("-", ""));
  return { async collect(request: ResilienceVueRuntimeAdapterRequest, outerSignal: AbortSignal) {
    const body = JSON.stringify(request); const requestBodySha256 = await digest(body); const requestedAt = now();
    if (!Number.isSafeInteger(requestedAt) || requestedAt < 0 || outerSignal.aborted) reject("BROKER_TIMEOUT");
    let signed; try { signed = await signHostedBrokerRequest({ method: "POST", path: RESILIENCE_VUE_BROKER_PATH,
      body, now: requestedAt, nonce: nonce(), config: input.configuration.signing }); }
    catch { return reject("BROKER_AUTHENTICATION_FAILED"); }
    const controller = new AbortController();
    const abort = () => controller.abort(); outerSignal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, request.maximumDurationMs);
    let response: Response;
    try { response = await fetcher(`${origin}${RESILIENCE_VUE_BROKER_PATH}`, { method: "POST",
      headers: { accept: "application/json", "content-type": "application/json",
        "x-sutra-tenant-id": request.scope.orgId, "x-sutra-customer-id": request.scope.customerId,
        "x-sutra-connection-id": request.scope.connectionId, "x-sutra-request-id": request.requestId,
        ...signed.headers }, body, signal: controller.signal }); }
    catch { return reject(controller.signal.aborted ? "BROKER_TIMEOUT" : "BROKER_UNAVAILABLE"); }
    finally { clearTimeout(timeout); outerSignal.removeEventListener("abort", abort); }
    const bytes = await bounded(response);
    try { await verifyHostedBrokerResponse({ status: response.status, path: RESILIENCE_VUE_BROKER_PATH,
      nonce: signed.nonce, body: bytes, headers: response.headers, config: input.configuration.signing }); }
    catch { return reject("BROKER_AUTHENTICATION_FAILED"); }
    if (response.status !== 200 || !JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) reject("BROKER_UNAVAILABLE");
    let parsed: unknown; try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { return reject("BROKER_RESPONSE_INVALID"); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      || JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(["capture", "requestBodySha256", "requestId", "schemaVersion"])) reject("BROKER_RESPONSE_INVALID");
    const envelope = parsed as Record<string, unknown>;
    if (envelope.schemaVersion !== "sutra.resilience-vue-broker-response.v1"
      || envelope.requestId !== request.requestId || envelope.requestBodySha256 !== requestBodySha256
      || typeof envelope.requestBodySha256 !== "string" || !SHA.test(envelope.requestBodySha256)
      || typeof envelope.capture !== "object" || envelope.capture === null || Array.isArray(envelope.capture)) reject("BROKER_RESPONSE_INVALID");
    try { normalizeResilienceVueCapture(envelope.capture as ResilienceVueCapture, request.scope, now()); }
    catch { return reject("EVIDENCE_REJECTED"); }
    return envelope.capture as ResilienceVueCapture;
  } };
}

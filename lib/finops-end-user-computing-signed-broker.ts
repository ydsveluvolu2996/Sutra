/** Strict Ed25519 transport for the privacy-minimized ADV-11 broker. */
import { signHostedBrokerRequest, verifyHostedBrokerResponse, type HostedBrokerClientSigningConfiguration } from "./hosted-broker-client-security.ts";
import { normalizeEndUserComputingCapture, END_USER_COMPUTING_COLLECTION_BOUNDS, type EndUserComputingCapture } from "./finops-end-user-computing.ts";
import { END_USER_COMPUTING_RUNTIME_TIMEOUT_MS, EndUserComputingRuntimeError, type EndUserComputingRuntimeRequest, type VerifiedEndUserComputingBrokerResult } from "./finops-end-user-computing-runtime-binding.ts";

export const END_USER_COMPUTING_BROKER_PATH = "/v1/finops/end-user-computing/collect";
const REQUEST = /^eur_[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const MAX_RESPONSE_BYTES = END_USER_COMPUTING_COLLECTION_BOUNDS.maximumCaptureBytes + 2 * 1_024 * 1_024;

interface Envelope {
  readonly schemaVersion: "sutra.end-user-computing-runtime-response.v1";
  readonly requestId: string;
  readonly requestBodySha256: string;
  readonly capture: EndUserComputingCapture;
}

function origin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new EndUserComputingRuntimeError("BROKER_UNAVAILABLE"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new EndUserComputingRuntimeError("BROKER_UNAVAILABLE");
  }
  return parsed.origin;
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes); return copy.buffer;
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", exactBuffer(bytes));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function bounded(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES) || response.body === null) {
    throw new EndUserComputingRuntimeError("BROKER_RESPONSE_INVALID");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new EndUserComputingRuntimeError("BROKER_RESPONSE_INVALID"); }
    chunks.push(item.value);
  }
  if (total < 2) throw new EndUserComputingRuntimeError("BROKER_RESPONSE_INVALID");
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function parse(bytes: Uint8Array): Envelope {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new EndUserComputingRuntimeError("BROKER_RESPONSE_INVALID"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new EndUserComputingRuntimeError("BROKER_RESPONSE_INVALID");
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["capture", "requestBodySha256", "requestId", "schemaVersion"])
    || record.schemaVersion !== "sutra.end-user-computing-runtime-response.v1"
    || typeof record.requestId !== "string" || !REQUEST.test(record.requestId)
    || typeof record.requestBodySha256 !== "string" || !SHA.test(record.requestBodySha256)
    || typeof record.capture !== "object" || record.capture === null || Array.isArray(record.capture)) {
    throw new EndUserComputingRuntimeError("BROKER_RESPONSE_INVALID");
  }
  return record as unknown as Envelope;
}

export function createEndUserComputingSignedBroker(input: {
  readonly brokerOrigin: string;
  readonly signing: HostedBrokerClientSigningConfiguration;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly nonce?: () => string;
}): { readonly collect: (request: EndUserComputingRuntimeRequest) => Promise<VerifiedEndUserComputingBrokerResult> } {
  const brokerOrigin = origin(input.brokerOrigin);
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? Date.now;
  const nonce = input.nonce ?? (() => crypto.randomUUID().replaceAll("-", ""));
  return { async collect(request) {
    const requestedAt = now();
    if (!Number.isSafeInteger(requestedAt) || request.maximumDurationMs !== END_USER_COMPUTING_RUNTIME_TIMEOUT_MS
      || Object.values(request.privacy).some(Boolean)) throw new EndUserComputingRuntimeError("PRIVACY_REJECTED");
    const body = JSON.stringify(request);
    const requestBodySha256 = await sha256(body);
    let signed;
    try { signed = await signHostedBrokerRequest({ method: "POST", path: END_USER_COMPUTING_BROKER_PATH,
      body, now: requestedAt, nonce: nonce(), config: input.signing }); }
    catch { throw new EndUserComputingRuntimeError("BROKER_AUTHENTICATION_FAILED"); }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), END_USER_COMPUTING_RUNTIME_TIMEOUT_MS);
    let response: Response;
    try { response = await fetcher(`${brokerOrigin}${END_USER_COMPUTING_BROKER_PATH}`, { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json",
        "x-sutra-tenant-id": request.boundary.scope.orgId,
        "x-sutra-customer-id": request.boundary.scope.customerId,
        "x-sutra-connection-id": request.boundary.scope.connectionId,
        "x-sutra-job-id": request.jobId, ...signed.headers }, body, signal: controller.signal }); }
    catch { clearTimeout(timeout); throw new EndUserComputingRuntimeError(controller.signal.aborted ? "BROKER_TIMEOUT" : "BROKER_UNAVAILABLE"); }
    let bytes: Uint8Array;
    try { bytes = await bounded(response); }
    catch (error) {
      if (controller.signal.aborted) throw new EndUserComputingRuntimeError("BROKER_TIMEOUT");
      if (error instanceof EndUserComputingRuntimeError) throw error;
      throw new EndUserComputingRuntimeError("BROKER_RESPONSE_INVALID");
    } finally { clearTimeout(timeout); }
    try { await verifyHostedBrokerResponse({ status: response.status, path: END_USER_COMPUTING_BROKER_PATH,
      nonce: signed.nonce, body: bytes, headers: response.headers, config: input.signing }); }
    catch { throw new EndUserComputingRuntimeError("BROKER_AUTHENTICATION_FAILED"); }
    if (response.status !== 200) throw new EndUserComputingRuntimeError("BROKER_UNAVAILABLE");
    if (!JSON_TYPE.test(response.headers.get("content-type") ?? "")) throw new EndUserComputingRuntimeError("BROKER_RESPONSE_INVALID");
    const envelope = parse(bytes);
    if (envelope.requestId !== request.requestId || envelope.requestBodySha256 !== requestBodySha256) throw new EndUserComputingRuntimeError("BROKER_RESPONSE_INVALID");
    try { normalizeEndUserComputingCapture(envelope.capture, request.boundary, Date.parse(envelope.capture.completedAt)); }
    catch { throw new EndUserComputingRuntimeError("EVIDENCE_REJECTED"); }
    return { capture: envelope.capture, verification: { requestBodySha256,
      responseBodySha256: await sha256(bytes), brokerKeyId: response.headers.get("x-sutra-key-id")! } };
  } };
}

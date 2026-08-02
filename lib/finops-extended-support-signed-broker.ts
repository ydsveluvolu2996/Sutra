/** Signed, bounded app-to-collector transport for ADV-04. */
import {
  signHostedBrokerRequest,
  verifyHostedBrokerResponse,
  type HostedBrokerClientSigningConfiguration,
} from "./hosted-broker-client-security.ts";
import {
  EXTENDED_SUPPORT_PROJECTION_BOUNDS,
  buildExtendedSupportProjection,
  type ExtendedSupportProjectionCapture,
} from "./finops-extended-support-projection.ts";
import type {
  ExtendedSupportCollectorRequest,
  ExtendedSupportSignedBroker,
} from "./finops-extended-support-collector-job.ts";

export const EXTENDED_SUPPORT_BROKER_PATH = "/v1/finops/extended-support/collect";
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAXIMUM_RESPONSE_BYTES = EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumCaptureBytes
  + 2 * 1_024 * 1_024;

export interface ExtendedSupportSignedBrokerConfiguration {
  readonly brokerOrigin: string;
  readonly signing: HostedBrokerClientSigningConfiguration;
}

export class ExtendedSupportSignedBrokerError extends Error {
  public readonly code:
    | "INVALID_CONFIGURATION" | "AUTHENTICATION_FAILED" | "TIMEOUT"
    | "UNAVAILABLE" | "RESPONSE_INVALID" | "EVIDENCE_REJECTED";
  public constructor(code: ExtendedSupportSignedBrokerError["code"]) {
    super("Extended Support collector request failed");
    this.name = "ExtendedSupportSignedBrokerError";
    this.code = code;
  }
}

function reject(code: ExtendedSupportSignedBrokerError["code"]): never {
  throw new ExtendedSupportSignedBrokerError(code);
}

function origin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { reject("INVALID_CONFIGURATION"); }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    reject("INVALID_CONFIGURATION");
  }
  return parsed.origin;
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function boundedBody(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared)
    || Number(declared) > MAXIMUM_RESPONSE_BYTES)) reject("RESPONSE_INVALID");
  if (response.body === null) reject("RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > MAXIMUM_RESPONSE_BYTES) {
      await reader.cancel();
      reject("RESPONSE_INVALID");
    }
    chunks.push(item.value);
  }
  if (total < 2) reject("RESPONSE_INVALID");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function envelope(value: Uint8Array): {
  readonly schemaVersion: "sutra.extended-support-provider-response.v1";
  readonly jobId: string;
  readonly requestBodySha256: string;
  readonly capture: ExtendedSupportProjectionCapture;
} {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)); }
  catch { reject("RESPONSE_INVALID"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) reject("RESPONSE_INVALID");
  const record = parsed as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([
    "capture", "jobId", "requestBodySha256", "schemaVersion",
  ]) || record.schemaVersion !== "sutra.extended-support-provider-response.v1"
    || typeof record.jobId !== "string" || !/^job_[a-f0-9]{32}$/u.test(record.jobId)
    || typeof record.requestBodySha256 !== "string" || !SHA256.test(record.requestBodySha256)
    || typeof record.capture !== "object" || record.capture === null || Array.isArray(record.capture)) {
    reject("RESPONSE_INVALID");
  }
  return record as unknown as ReturnType<typeof envelope>;
}

export function createExtendedSupportSignedBroker(input: {
  readonly configuration: ExtendedSupportSignedBrokerConfiguration;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly nonce?: () => string;
}): ExtendedSupportSignedBroker {
  const brokerOrigin = origin(input.configuration.brokerOrigin);
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? Date.now;
  const nonce = input.nonce ?? (() => crypto.randomUUID().replaceAll("-", ""));
  return Object.freeze({
    collect: async (request: ExtendedSupportCollectorRequest) => {
      const requestedAt = now();
      const deadline = Date.parse(request.deadlineAtIso);
      if (!Number.isSafeInteger(requestedAt) || requestedAt < 0
        || !Number.isFinite(deadline) || deadline < requestedAt
        || deadline - requestedAt > EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumDurationMs) {
        reject("RESPONSE_INVALID");
      }
      const body = JSON.stringify(request);
      const requestBodySha256 = await sha256(body);
      let signed;
      try {
        signed = await signHostedBrokerRequest({
          method: "POST",
          path: EXTENDED_SUPPORT_BROKER_PATH,
          body,
          now: requestedAt,
          nonce: nonce(),
          config: input.configuration.signing,
        });
      } catch { reject("AUTHENTICATION_FAILED"); }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deadline - requestedAt);
      let response: Response;
      try {
        response = await fetcher(`${brokerOrigin}${EXTENDED_SUPPORT_BROKER_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "accept": "application/json",
            "x-sutra-tenant-id": request.boundary.scope.orgId,
            "x-sutra-customer-id": request.boundary.scope.customerId,
            "x-sutra-connection-id": request.boundary.scope.connectionId,
            "x-sutra-job-id": request.jobId,
            ...signed.headers,
          },
          body,
          signal: controller.signal,
        });
      } catch {
        clearTimeout(timer);
        reject(controller.signal.aborted ? "TIMEOUT" : "UNAVAILABLE");
      }
      let bytes: Uint8Array;
      try { bytes = await boundedBody(response); }
      catch (error) {
        if (controller.signal.aborted) reject("TIMEOUT");
        if (error instanceof ExtendedSupportSignedBrokerError) throw error;
        reject("RESPONSE_INVALID");
      } finally { clearTimeout(timer); }
      try {
        await verifyHostedBrokerResponse({
          status: response.status,
          path: EXTENDED_SUPPORT_BROKER_PATH,
          nonce: signed.nonce,
          body: bytes,
          headers: response.headers,
          config: input.configuration.signing,
        });
      } catch { reject("AUTHENTICATION_FAILED"); }
      if (response.status !== 200) reject("UNAVAILABLE");
      if (!JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) reject("RESPONSE_INVALID");
      const parsed = envelope(bytes);
      if (parsed.jobId !== request.jobId || parsed.requestBodySha256 !== requestBodySha256) {
        reject("RESPONSE_INVALID");
      }
      try {
        buildExtendedSupportProjection(
          parsed.capture,
          request.boundary,
          new Date(parsed.capture.completedAt),
        );
      } catch { reject("EVIDENCE_REJECTED"); }
      return parsed.capture;
    },
  });
}

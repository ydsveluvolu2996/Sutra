/** Exact-byte authenticated transport for ADD-06 versioned export ingestion. */
import {
  signHostedBrokerRequest,
  verifyHostedBrokerResponse,
  type HostedBrokerClientSigningConfiguration,
} from "./hosted-broker-client-security.ts";
import {
  buildKubecostAllocationSnapshot,
  KUBECOST_ALLOCATION_BOUNDS,
  type KubecostAllocationCapture,
} from "./finops-kubecost-allocation.ts";
import {
  KUBECOST_RUNTIME_TIMEOUT_MS,
  KubecostRuntimeError,
  type KubecostRuntimeRequest,
  type VerifiedKubecostRuntimeResult,
} from "./finops-kubecost-runtime-binding.ts";

export const KUBECOST_EXPORT_BROKER_PATH = "/v1/finops/kubecost/versioned-export";
const REQUEST_ID = /^kur_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const MAXIMUM_RESPONSE_BYTES = KUBECOST_ALLOCATION_BOUNDS.maximumCaptureBytes + 2 * 1_024 * 1_024;

interface KubecostBrokerEnvelope {
  readonly schemaVersion: "sutra.kubecost-versioned-runtime-response.v1";
  readonly requestId: string;
  readonly requestBodySha256: string;
  readonly capture: KubecostAllocationCapture;
}

function brokerOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new KubecostRuntimeError("BROKER_UNAVAILABLE");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new KubecostRuntimeError("BROKER_UNAVAILABLE");
  }
  return parsed.origin;
}

function exactBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", exactBuffer(bytes));
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

async function boundedBody(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAXIMUM_RESPONSE_BYTES)) {
    throw new KubecostRuntimeError("BROKER_RESPONSE_INVALID");
  }
  if (response.body === null) throw new KubecostRuntimeError("BROKER_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > MAXIMUM_RESPONSE_BYTES) {
      await reader.cancel();
      throw new KubecostRuntimeError("BROKER_RESPONSE_INVALID");
    }
    chunks.push(item.value);
  }
  if (total < 2) throw new KubecostRuntimeError("BROKER_RESPONSE_INVALID");
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function parseEnvelope(bytes: Uint8Array): KubecostBrokerEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new KubecostRuntimeError("BROKER_RESPONSE_INVALID");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new KubecostRuntimeError("BROKER_RESPONSE_INVALID");
  }
  const record = parsed as Record<string, unknown>;
  if (!exactKeys(record, ["schemaVersion", "requestId", "requestBodySha256", "capture"])
    || record.schemaVersion !== "sutra.kubecost-versioned-runtime-response.v1"
    || typeof record.requestId !== "string" || !REQUEST_ID.test(record.requestId)
    || typeof record.requestBodySha256 !== "string" || !SHA256.test(record.requestBodySha256)
    || typeof record.capture !== "object" || record.capture === null || Array.isArray(record.capture)) {
    throw new KubecostRuntimeError("BROKER_RESPONSE_INVALID");
  }
  return record as unknown as KubecostBrokerEnvelope;
}

export function createKubecostSignedExportBroker(input: {
  readonly brokerOrigin: string;
  readonly signing: HostedBrokerClientSigningConfiguration;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly nonce?: () => string;
}): { readonly collect: (request: KubecostRuntimeRequest) => Promise<VerifiedKubecostRuntimeResult> } {
  const origin = brokerOrigin(input.brokerOrigin);
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? Date.now;
  const nonce = input.nonce ?? (() => crypto.randomUUID().replaceAll("-", ""));
  return {
    async collect(request) {
      const requestedAt = now();
      if (!Number.isSafeInteger(requestedAt) || requestedAt < 0
        || request.maximumDurationMs !== KUBECOST_RUNTIME_TIMEOUT_MS
        || request.exporterWriteActions.length !== 0
        || request.destination.requireObjectVersionIds !== true) {
        throw new KubecostRuntimeError("BROKER_RESPONSE_INVALID");
      }
      const body = JSON.stringify(request);
      const requestBodySha256 = await sha256(body);
      let signed;
      try {
        signed = await signHostedBrokerRequest({
          method: "POST",
          path: KUBECOST_EXPORT_BROKER_PATH,
          body,
          now: requestedAt,
          nonce: nonce(),
          config: input.signing,
        });
      } catch {
        throw new KubecostRuntimeError("BROKER_AUTHENTICATION_FAILED");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), KUBECOST_RUNTIME_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetcher(`${origin}${KUBECOST_EXPORT_BROKER_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "accept": "application/json",
            "x-sutra-tenant-id": request.scope.orgId,
            "x-sutra-customer-id": request.scope.customerId,
            "x-sutra-connection-id": request.scope.connectionId,
            "x-sutra-job-id": request.jobId,
            ...signed.headers,
          },
          body,
          signal: controller.signal,
        });
      } catch {
        clearTimeout(timeout);
        throw new KubecostRuntimeError(controller.signal.aborted ? "BROKER_TIMEOUT" : "BROKER_UNAVAILABLE");
      }
      let responseBytes: Uint8Array;
      try {
        responseBytes = await boundedBody(response);
      } catch (error) {
        if (controller.signal.aborted) throw new KubecostRuntimeError("BROKER_TIMEOUT");
        if (error instanceof KubecostRuntimeError) throw error;
        throw new KubecostRuntimeError("BROKER_RESPONSE_INVALID");
      } finally {
        clearTimeout(timeout);
      }
      try {
        await verifyHostedBrokerResponse({
          status: response.status,
          path: KUBECOST_EXPORT_BROKER_PATH,
          nonce: signed.nonce,
          body: responseBytes,
          headers: response.headers,
          config: input.signing,
        });
      } catch {
        throw new KubecostRuntimeError("BROKER_AUTHENTICATION_FAILED");
      }
      if (response.status !== 200) throw new KubecostRuntimeError("BROKER_UNAVAILABLE");
      if (!JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) {
        throw new KubecostRuntimeError("BROKER_RESPONSE_INVALID");
      }
      const envelope = parseEnvelope(responseBytes);
      if (envelope.requestId !== request.requestId
        || envelope.requestBodySha256 !== requestBodySha256) {
        throw new KubecostRuntimeError("BROKER_RESPONSE_INVALID");
      }
      try {
        buildKubecostAllocationSnapshot(
          envelope.capture,
          request.scope,
          Date.parse(envelope.capture.completedAtIso),
        );
      } catch {
        throw new KubecostRuntimeError("EVIDENCE_REJECTED");
      }
      return {
        capture: envelope.capture,
        verification: {
          requestBodySha256,
          responseBodySha256: await sha256(responseBytes),
          brokerKeyId: response.headers.get("x-sutra-key-id")!,
        },
      };
    },
  };
}

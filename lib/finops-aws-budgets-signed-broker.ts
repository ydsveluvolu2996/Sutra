/** Strict authenticated transport for the ADV-08 durable broker request. */
import {
  signHostedBrokerRequest,
  verifyHostedBrokerResponse,
  type HostedBrokerClientSigningConfiguration,
} from "./hosted-broker-client-security.ts";
import {
  AWS_BUDGETS_DURABLE_TIMEOUT_MS,
  AwsBudgetsDurableBindingError,
  type AwsBudgetsDurableBrokerRequest,
  type VerifiedAwsBudgetsBrokerResult,
} from "./finops-aws-budgets-durable-binding.ts";
import {
  AWS_BUDGETS_COLLECTION_BOUNDS,
  normalizeAwsBudgetsCapture,
  type AwsBudgetsCapture,
  type AwsOrganizationHierarchyEvidence,
} from "./finops-aws-budgets-organization.ts";

export const AWS_BUDGETS_BROKER_PATH = "/v1/finops/aws-budgets/collect";
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const REQUEST_ID = /^abr_[a-f0-9]{64}$/u;
const MAXIMUM_RESPONSE_BYTES = AWS_BUDGETS_COLLECTION_BOUNDS.maximumCaptureBytes + 2 * 1_024 * 1_024;

interface BrokerResponseEnvelope {
  readonly schemaVersion: "sutra.aws-budgets-durable-response.v1";
  readonly requestId: string;
  readonly requestBodySha256: string;
  readonly capture: AwsBudgetsCapture;
  readonly hierarchy: AwsOrganizationHierarchyEvidence | null;
}

export interface AwsBudgetsSignedBrokerConfiguration {
  /** Exact private broker origin provisioned by the managed runtime. */
  readonly brokerOrigin: string;
  readonly signing: HostedBrokerClientSigningConfiguration;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function brokerOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new AwsBudgetsDurableBindingError("BROKER_UNAVAILABLE"); }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new AwsBudgetsDurableBindingError("BROKER_UNAVAILABLE");
  }
  return parsed.origin;
}

function exactBytes(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", exactBytes(bytes));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

export function canonicalAwsBudgetsBrokerBody(request: AwsBudgetsDurableBrokerRequest): string {
  return JSON.stringify(request);
}

async function boundedBody(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAXIMUM_RESPONSE_BYTES)) {
    throw new AwsBudgetsDurableBindingError("BROKER_RESPONSE_INVALID");
  }
  if (response.body === null) throw new AwsBudgetsDurableBindingError("BROKER_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > MAXIMUM_RESPONSE_BYTES) {
      await reader.cancel();
      throw new AwsBudgetsDurableBindingError("BROKER_RESPONSE_INVALID");
    }
    chunks.push(item.value);
  }
  if (total < 2) {
    throw new AwsBudgetsDurableBindingError("BROKER_RESPONSE_INVALID");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseEnvelope(bytes: Uint8Array): BrokerResponseEnvelope {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new AwsBudgetsDurableBindingError("BROKER_RESPONSE_INVALID"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    || !exactKeys(parsed as Record<string, unknown>, [
      "schemaVersion", "requestId", "requestBodySha256", "capture", "hierarchy",
    ])) throw new AwsBudgetsDurableBindingError("BROKER_RESPONSE_INVALID");
  const value = parsed as Record<string, unknown>;
  if (value.schemaVersion !== "sutra.aws-budgets-durable-response.v1"
    || typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId)
    || typeof value.requestBodySha256 !== "string" || !SHA256.test(value.requestBodySha256)
    || typeof value.capture !== "object" || value.capture === null || Array.isArray(value.capture)
    || (value.hierarchy !== null && (
      typeof value.hierarchy !== "object" || Array.isArray(value.hierarchy)
    ))) throw new AwsBudgetsDurableBindingError("BROKER_RESPONSE_INVALID");
  return value as unknown as BrokerResponseEnvelope;
}

/**
 * The response signature is verified over the exact bytes before status or
 * JSON fields are trusted. Provider diagnostics are never copied into errors.
 */
export function createAwsBudgetsSignedBroker(input: {
  readonly configuration: AwsBudgetsSignedBrokerConfiguration;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly nonce?: () => string;
}): { readonly collect: (request: AwsBudgetsDurableBrokerRequest) => Promise<VerifiedAwsBudgetsBrokerResult> } {
  const origin = brokerOrigin(input.configuration.brokerOrigin);
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? Date.now;
  const nonce = input.nonce ?? (() => crypto.randomUUID().replaceAll("-", ""));
  return {
    async collect(request) {
      const requestedAt = now();
      if (!Number.isSafeInteger(requestedAt) || requestedAt < 0
        || request.maximumDurationMs !== AWS_BUDGETS_DURABLE_TIMEOUT_MS) {
        throw new AwsBudgetsDurableBindingError("BROKER_RESPONSE_INVALID");
      }
      const body = canonicalAwsBudgetsBrokerBody(request);
      const requestBodySha256 = await sha256(body);
      let signed;
      try {
        signed = await signHostedBrokerRequest({
          method: "POST", path: AWS_BUDGETS_BROKER_PATH, body,
          now: requestedAt, nonce: nonce(), config: input.configuration.signing,
        });
      } catch {
        throw new AwsBudgetsDurableBindingError("BROKER_AUTHENTICATION_FAILED");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AWS_BUDGETS_DURABLE_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetcher(`${origin}${AWS_BUDGETS_BROKER_PATH}`, {
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
        throw new AwsBudgetsDurableBindingError(
          controller.signal.aborted ? "BROKER_TIMEOUT" : "BROKER_UNAVAILABLE",
        );
      }
      let bytes: Uint8Array;
      try {
        bytes = await boundedBody(response);
      } catch (error) {
        if (controller.signal.aborted) throw new AwsBudgetsDurableBindingError("BROKER_TIMEOUT");
        if (error instanceof AwsBudgetsDurableBindingError) throw error;
        throw new AwsBudgetsDurableBindingError("BROKER_RESPONSE_INVALID");
      } finally {
        clearTimeout(timeout);
      }
      try {
        await verifyHostedBrokerResponse({
          status: response.status, path: AWS_BUDGETS_BROKER_PATH,
          nonce: signed.nonce, body: bytes, headers: response.headers,
          config: input.configuration.signing,
        });
      } catch {
        throw new AwsBudgetsDurableBindingError("BROKER_AUTHENTICATION_FAILED");
      }
      if (response.status !== 200) throw new AwsBudgetsDurableBindingError("BROKER_UNAVAILABLE");
      if (!JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) {
        throw new AwsBudgetsDurableBindingError("BROKER_RESPONSE_INVALID");
      }
      const envelope = parseEnvelope(bytes);
      if (envelope.requestId !== request.requestId
        || envelope.requestBodySha256 !== requestBodySha256) {
        throw new AwsBudgetsDurableBindingError("BROKER_RESPONSE_INVALID");
      }
      try {
        normalizeAwsBudgetsCapture(envelope.capture, request.scope, Date.parse(envelope.capture.completedAtIso));
      } catch {
        throw new AwsBudgetsDurableBindingError("EVIDENCE_REJECTED");
      }
      return {
        capture: envelope.capture,
        hierarchy: envelope.hierarchy,
        verification: {
          requestBodySha256,
          responseBodySha256: await sha256(bytes),
          brokerKeyId: response.headers.get("x-sutra-key-id")!,
        },
      };
    },
  };
}

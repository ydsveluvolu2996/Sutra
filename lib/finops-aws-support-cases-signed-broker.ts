/** Authenticated, bounded transport for privacy-minimized AWS Support cases. */
import {
  signHostedBrokerRequest,
  verifyHostedBrokerResponse,
  type HostedBrokerClientSigningConfiguration,
} from "./hosted-broker-client-security.ts";
import {
  AWS_SUPPORT_CASES_COLLECTION_BOUNDS,
  normalizeAwsSupportCasesCapture,
  type AwsSupportCasesBoundary,
  type AwsSupportCasesBrokerRequest,
  type AwsSupportCasesCapture,
  type AwsSupportCasesTransport,
} from "./finops-aws-support-cases-radar.ts";

export const AWS_SUPPORT_CASES_BROKER_PATH = "/v1/finops/aws-support-cases/collect";
export const AWS_SUPPORT_CASES_SIGNED_BROKER_ACTIVATION_REASON =
  "AWS_SUPPORT_CASES_SIGNED_BROKER_HANDLER_NOT_REGISTERED";

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const JOB_ID = /^supportjob_[a-f0-9]{32}$/u;
const MAXIMUM_RESPONSE_BYTES =
  AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumCaptureBytes + 1024 * 1024;

interface BrokerEnvelope {
  readonly schemaVersion: "sutra.aws-support-cases-broker-response.v1";
  readonly jobId: string;
  readonly requestBodySha256: string;
  readonly capture: AwsSupportCasesCapture;
}

export interface AwsSupportCasesSignedBrokerConfiguration {
  readonly brokerOrigin: string;
  readonly signing: HostedBrokerClientSigningConfiguration;
}

export class AwsSupportCasesSignedBrokerError extends Error {
  public readonly code:
    | "BROKER_UNAVAILABLE"
    | "BROKER_TIMEOUT"
    | "BROKER_AUTHENTICATION_FAILED"
    | "BROKER_RESPONSE_INVALID"
    | "EVIDENCE_REJECTED";

  public constructor(code: AwsSupportCasesSignedBrokerError["code"]) {
    super("AWS Support cases broker request failed");
    this.name = "AwsSupportCasesSignedBrokerError";
    this.code = code;
  }
}

function reject(code: AwsSupportCasesSignedBrokerError["code"]): never {
  throw new AwsSupportCasesSignedBrokerError(code);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function origin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return reject("BROKER_UNAVAILABLE");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
  ) reject("BROKER_UNAVAILABLE");
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
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

async function boundedBody(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null
    && (!/^\d+$/u.test(declared) || Number(declared) > MAXIMUM_RESPONSE_BYTES)
  ) reject("BROKER_RESPONSE_INVALID");
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength < 2 || body.byteLength > MAXIMUM_RESPONSE_BYTES) {
    reject("BROKER_RESPONSE_INVALID");
  }
  return body;
}

function parseEnvelope(bytes: Uint8Array): BrokerEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return reject("BROKER_RESPONSE_INVALID");
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || !exactKeys(parsed as Record<string, unknown>, [
      "schemaVersion", "jobId", "requestBodySha256", "capture",
    ])
  ) reject("BROKER_RESPONSE_INVALID");
  const value = parsed as Record<string, unknown>;
  if (
    value.schemaVersion !== "sutra.aws-support-cases-broker-response.v1"
    || typeof value.jobId !== "string"
    || !JOB_ID.test(value.jobId)
    || typeof value.requestBodySha256 !== "string"
    || !SHA256.test(value.requestBodySha256)
    || typeof value.capture !== "object"
    || value.capture === null
    || Array.isArray(value.capture)
  ) reject("BROKER_RESPONSE_INVALID");
  return value as unknown as BrokerEnvelope;
}

function boundaryFor(request: AwsSupportCasesBrokerRequest): AwsSupportCasesBoundary {
  return {
    scope: {
      orgId: request.tenantId,
      customerId: request.customerId,
      connectionId: request.parentConnectionId,
      partition: request.partition,
      endpointRegion: request.endpointRegion,
    },
    binding: "SERVER_RESOLVED_CONNECTIONS",
    intendedAccounts: request.intendedAccounts,
  };
}

/** The exact response bytes are authenticated before JSON or status is trusted. */
export function createAwsSupportCasesSignedBroker(input: {
  readonly configuration: AwsSupportCasesSignedBrokerConfiguration;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly nonce?: () => string;
}): AwsSupportCasesTransport {
  const brokerOrigin = origin(input.configuration.brokerOrigin);
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? Date.now;
  const nonce = input.nonce ?? (() => crypto.randomUUID().replaceAll("-", ""));
  return {
    async collect(request) {
      const requestedAt = now();
      if (!Number.isSafeInteger(requestedAt) || requestedAt < 0) {
        reject("BROKER_RESPONSE_INVALID");
      }
      const body = JSON.stringify(request);
      const requestBodySha256 = await sha256(body);
      let signed;
      try {
        signed = await signHostedBrokerRequest({
          method: "POST",
          path: AWS_SUPPORT_CASES_BROKER_PATH,
          body,
          now: requestedAt,
          nonce: nonce(),
          config: input.configuration.signing,
        });
      } catch {
        return reject("BROKER_AUTHENTICATION_FAILED");
      }
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumDurationMs,
      );
      let response: Response;
      try {
        response = await fetcher(`${brokerOrigin}${AWS_SUPPORT_CASES_BROKER_PATH}`, {
          method: "POST",
          headers: {
            "accept": "application/json",
            "content-type": "application/json",
            "x-sutra-tenant-id": request.tenantId,
            "x-sutra-customer-id": request.customerId,
            "x-sutra-connection-id": request.parentConnectionId,
            "x-sutra-job-id": request.jobId,
            ...signed.headers,
          },
          body,
          signal: controller.signal,
        });
      } catch {
        return reject(controller.signal.aborted ? "BROKER_TIMEOUT" : "BROKER_UNAVAILABLE");
      } finally {
        clearTimeout(timeout);
      }
      const bytes = await boundedBody(response);
      try {
        await verifyHostedBrokerResponse({
          status: response.status,
          path: AWS_SUPPORT_CASES_BROKER_PATH,
          nonce: signed.nonce,
          body: bytes,
          headers: response.headers,
          config: input.configuration.signing,
        });
      } catch {
        return reject("BROKER_AUTHENTICATION_FAILED");
      }
      if (response.status !== 200) reject("BROKER_UNAVAILABLE");
      if (!JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) {
        reject("BROKER_RESPONSE_INVALID");
      }
      const envelope = parseEnvelope(bytes);
      if (
        envelope.jobId !== request.jobId
        || envelope.requestBodySha256 !== requestBodySha256
      ) reject("BROKER_RESPONSE_INVALID");
      try {
        normalizeAwsSupportCasesCapture(
          envelope.capture,
          boundaryFor(request),
          Date.parse(envelope.capture.completedAt),
        );
      } catch {
        return reject("EVIDENCE_REJECTED");
      }
      return envelope.capture;
    },
  };
}

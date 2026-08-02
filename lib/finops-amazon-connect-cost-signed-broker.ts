/** Signed, bounded application-to-collector transport for ADD-11. */
import { canonicalJson } from "./canonical-json.ts";
import {
  AMAZON_CONNECT_COST_INSIGHT_BOUNDS,
  normalizeAmazonConnectCostInsightCapture,
  type AmazonConnectCostInsightCapture,
} from "./finops-amazon-connect-cost-insight.ts";
import {
  type AmazonConnectCostRuntimeMaterializer,
  type AmazonConnectCostRuntimeRequest,
} from "./finops-amazon-connect-cost-insight-runtime-binding.ts";
import {
  signHostedBrokerRequest,
  verifyHostedBrokerResponse,
  type HostedBrokerClientSigningConfiguration,
} from "./hosted-broker-client-security.ts";

export const AMAZON_CONNECT_COST_BROKER_PATH =
  "/v1/finops/amazon-connect-cost-insights/collect";
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const SHA = /^[a-f0-9]{64}$/u;
const MAX_RESPONSE_BYTES = AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumCaptureBytes
  + 2 * 1_024 * 1_024;

export interface AmazonConnectCostSignedBrokerConfiguration {
  readonly brokerOrigin: string;
  readonly signing: HostedBrokerClientSigningConfiguration;
}
export class AmazonConnectCostSignedBrokerError extends Error {
  public readonly code: "INVALID_CONFIGURATION" | "AUTHENTICATION_FAILED" | "TIMEOUT"
    | "UNAVAILABLE" | "RESPONSE_INVALID" | "CAPTURE_REJECTED";
  public constructor(code: AmazonConnectCostSignedBrokerError["code"]) {
    super("Amazon Connect cost collector request failed");
    this.name = "AmazonConnectCostSignedBrokerError";
    this.code = code;
  }
}
function reject(code: AmazonConnectCostSignedBrokerError["code"]): never {
  throw new AmazonConnectCostSignedBrokerError(code);
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
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0")).join("");
}
async function bounded(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared)
    || Number(declared) > MAX_RESPONSE_BYTES)) reject("RESPONSE_INVALID");
  if (response.body === null) reject("RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      reject("RESPONSE_INVALID");
    }
    chunks.push(item.value);
  }
  if (total < 2) reject("RESPONSE_INVALID");
  const value = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.byteLength; }
  return value;
}
function envelope(bytes: Uint8Array): {
  readonly schemaVersion: "sutra.amazon-connect-cost-provider-response.v1";
  readonly requestId: string;
  readonly requestBodySha256: string;
  readonly capture: AmazonConnectCostInsightCapture;
} {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { reject("RESPONSE_INVALID"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) reject("RESPONSE_INVALID");
  const item = parsed as Record<string, unknown>;
  if (JSON.stringify(Object.keys(item).sort())
      !== JSON.stringify(["capture", "requestBodySha256", "requestId", "schemaVersion"])
    || item.schemaVersion !== "sutra.amazon-connect-cost-provider-response.v1"
    || typeof item.requestId !== "string" || !/^acr_[a-f0-9]{64}$/u.test(item.requestId)
    || typeof item.requestBodySha256 !== "string" || !SHA.test(item.requestBodySha256)
    || typeof item.capture !== "object" || item.capture === null || Array.isArray(item.capture)) {
    reject("RESPONSE_INVALID");
  }
  return item as unknown as ReturnType<typeof envelope>;
}

export function createAmazonConnectCostSignedBroker(input: {
  readonly configuration: AmazonConnectCostSignedBrokerConfiguration;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly nonce?: () => string;
}): AmazonConnectCostRuntimeMaterializer {
  const brokerOrigin = origin(input.configuration.brokerOrigin);
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? Date.now;
  const nonce = input.nonce ?? (() => crypto.randomUUID().replaceAll("-", ""));
  return Object.freeze({
    collect: async (request: AmazonConnectCostRuntimeRequest, parentSignal: AbortSignal) => {
      const requestedAt = now();
      if (!Number.isSafeInteger(requestedAt) || requestedAt < 0
        || !(parentSignal instanceof AbortSignal) || parentSignal.aborted) reject("TIMEOUT");
      const body = JSON.stringify(request);
      const rawRequestBodySha256 = await sha256(body);
      const requestBodySha256 = await sha256(canonicalJson(request));
      let signed: Awaited<ReturnType<typeof signHostedBrokerRequest>>;
      try {
        signed = await signHostedBrokerRequest({ method: "POST",
          path: AMAZON_CONNECT_COST_BROKER_PATH, body, now: requestedAt,
          nonce: nonce(), config: input.configuration.signing });
      } catch { reject("AUTHENTICATION_FAILED"); }
      const controller = new AbortController();
      const abort = () => controller.abort();
      parentSignal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumDurationMs);
      let response: Response;
      try {
        response = await fetcher(`${brokerOrigin}${AMAZON_CONNECT_COST_BROKER_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json",
            "x-sutra-tenant-id": request.scope.orgId,
            "x-sutra-customer-id": request.scope.customerId,
            "x-sutra-connection-id": request.scope.connectionId,
            "x-sutra-request-id": request.requestId,
            ...signed.headers },
          body,
          signal: controller.signal,
        });
      } catch {
        clearTimeout(timer); parentSignal.removeEventListener("abort", abort);
        reject(controller.signal.aborted ? "TIMEOUT" : "UNAVAILABLE");
      }
      let bytes: Uint8Array;
      try { bytes = await bounded(response); }
      catch (error) {
        if (controller.signal.aborted) reject("TIMEOUT");
        if (error instanceof AmazonConnectCostSignedBrokerError) throw error;
        reject("RESPONSE_INVALID");
      } finally {
        clearTimeout(timer); parentSignal.removeEventListener("abort", abort);
      }
      try {
        await verifyHostedBrokerResponse({ status: response.status,
          path: AMAZON_CONNECT_COST_BROKER_PATH, nonce: signed.nonce,
          body: bytes, headers: response.headers, config: input.configuration.signing });
      } catch { reject("AUTHENTICATION_FAILED"); }
      if (response.status !== 200) reject("UNAVAILABLE");
      if (!JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) {
        reject("RESPONSE_INVALID");
      }
      const parsed = envelope(bytes);
      if (parsed.requestId !== request.requestId
        || parsed.requestBodySha256 !== rawRequestBodySha256) reject("RESPONSE_INVALID");
      try {
        normalizeAmazonConnectCostInsightCapture(
          parsed.capture, request.scope, Date.parse(parsed.capture.completedAtIso),
        );
      } catch { reject("CAPTURE_REJECTED"); }
      return Object.freeze({
        capture: parsed.capture,
        verification: Object.freeze({
          authentication: "ED25519_RESPONSE_SIGNATURE_VERIFIED" as const,
          requestBodySha256,
          captureBodySha256: await sha256(canonicalJson(parsed.capture)),
          materializerKeyId: input.configuration.signing.brokerKeyId,
        }),
      });
    },
  });
}

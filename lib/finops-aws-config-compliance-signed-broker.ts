/** Signed app-to-collector transport for ADD-12 AWS Config compliance. */
import {
  signHostedBrokerRequest,
  verifyHostedBrokerResponse,
  type HostedBrokerClientSigningConfiguration,
} from "./hosted-broker-client-security.ts";
import {
  AWS_CONFIG_AGGREGATOR_READ_OPERATIONS,
  AWS_CONFIG_ORGANIZATION_READ_OPERATIONS,
  AWS_CONFIG_RECORDER_COVERAGE_READ_OPERATIONS,
  AWS_CONFIG_RULE_LIFECYCLE_READ_OPERATIONS,
  AWS_CONFIG_COMPLIANCE_BOUNDS,
  normalizeAwsConfigComplianceCapture,
  type AwsConfigActivityEvidence,
  type AwsConfigCur2Evidence,
  type AwsConfigExpectedCoverage,
} from "./finops-aws-config-compliance.ts";
import type { AwsConfigComplianceCollectorAdapter, AwsConfigComplianceCollectorRequest } from
  "./finops-aws-config-compliance-job.ts";

export const AWS_CONFIG_COMPLIANCE_BROKER_PATH = "/v1/finops/aws-config-compliance/collect";
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const MAX_RESPONSE_BYTES = AWS_CONFIG_COMPLIANCE_BOUNDS.maximumCaptureBytes + 2 * 1_024 * 1_024;
const PROVIDER_BOUNDS = Object.freeze({ maximumDurationMs: 20 * 60 * 1_000,
  maximumCaptureBytes: 96 * 1_024 * 1_024, maximumAccounts: 10_000,
  maximumRegions: 64, maximumAccountRegions: 100_000, maximumProjectionRows: 1_000_000 });

export interface AwsConfigComplianceProviderContext {
  readonly expectedCoverage: AwsConfigExpectedCoverage;
  readonly targets: readonly { readonly accountId: string; readonly region: string;
    readonly connectionId: string }[];
  readonly activity: AwsConfigActivityEvidence | null;
  readonly cur2: AwsConfigCur2Evidence | null;
}
export interface AwsConfigComplianceSignedBrokerConfiguration {
  readonly brokerOrigin: string;
  readonly signing: HostedBrokerClientSigningConfiguration;
}
class BrokerError extends Error { public constructor() { super("AWS_CONFIG_COMPLIANCE_BROKER_REJECTED"); } }
function reject(): never { throw new BrokerError(); }
function origin(value: string): string {
  let parsed: URL; try { parsed = new URL(value); } catch { reject(); }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") reject();
  return parsed.origin;
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
async function bounded(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
    || response.body === null) reject();
  const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  while (true) { const item = await reader.read(); if (item.done) break; total += item.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); reject(); } chunks.push(item.value); }
  if (total < 2) reject(); const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
function parse(bytes: Uint8Array): { requestId: string; requestBodySha256: string; capture: unknown } {
  let value: unknown; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { reject(); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject();
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([
    "capture", "requestBodySha256", "requestId", "schemaVersion"])
    || record.schemaVersion !== "sutra.aws-config-compliance-provider-response.v1"
    || typeof record.requestId !== "string" || !/^acr_[a-f0-9]{64}$/u.test(record.requestId)
    || typeof record.requestBodySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.requestBodySha256)) reject();
  return record as unknown as ReturnType<typeof parse>;
}

export function createAwsConfigComplianceSignedBrokerAdapter(input: {
  readonly configuration: AwsConfigComplianceSignedBrokerConfiguration;
  readonly resolveContext: (request: AwsConfigComplianceCollectorRequest) => Promise<AwsConfigComplianceProviderContext>;
  readonly fetcher?: typeof fetch; readonly now?: () => number; readonly nonce?: () => string;
}): AwsConfigComplianceCollectorAdapter {
  const brokerOrigin = origin(input.configuration.brokerOrigin); const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? Date.now; const nonce = input.nonce ?? (() => crypto.randomUUID().replaceAll("-", ""));
  return Object.freeze({ collect: async (
    runtimeRequest: AwsConfigComplianceCollectorRequest,
    parentSignal: AbortSignal,
  ) => {
    let context: AwsConfigComplianceProviderContext; try { context = await input.resolveContext(runtimeRequest); }
    catch { reject(); }
    const requestId = `acr_${await sha256(JSON.stringify({ scope: runtimeRequest.scope,
      scheduledWindow: runtimeRequest.scheduledWindow }))}`;
    const requestedAt = now(); if (!Number.isSafeInteger(requestedAt) || requestedAt < 0) reject();
    const request = Object.freeze({ schemaVersion: "sutra.aws-config-compliance-provider-request.v1" as const,
      requestId, scheduledWindow: runtimeRequest.scheduledWindow, scope: runtimeRequest.scope,
      expectedCoverage: context.expectedCoverage, targets: context.targets,
      operations: Object.freeze({ central: Object.freeze([...AWS_CONFIG_AGGREGATOR_READ_OPERATIONS,
        ...AWS_CONFIG_ORGANIZATION_READ_OPERATIONS]), fanout: Object.freeze([
        ...AWS_CONFIG_RULE_LIFECYCLE_READ_OPERATIONS, ...AWS_CONFIG_RECORDER_COVERAGE_READ_OPERATIONS]) }),
      inventoryQuery: runtimeRequest.inventoryQuery, activity: context.activity, cur2: context.cur2,
      credentials: "SERVER_OWNED_TRUST_ROLE_SESSIONS" as const,
      deadlineAtIso: new Date(requestedAt + AWS_CONFIG_COMPLIANCE_BOUNDS.maximumDurationMs).toISOString(),
      bounds: PROVIDER_BOUNDS });
    const body = JSON.stringify(request); const bodyDigest = await sha256(body);
    let signed: Awaited<ReturnType<typeof signHostedBrokerRequest>>;
    try { signed = await signHostedBrokerRequest({ method: "POST", path: AWS_CONFIG_COMPLIANCE_BROKER_PATH,
      body, now: requestedAt, nonce: nonce(), config: input.configuration.signing }); } catch { reject(); }
    const controller = new AbortController(); const abort = () => controller.abort();
    if (parentSignal.aborted) abort(); else parentSignal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, AWS_CONFIG_COMPLIANCE_BOUNDS.maximumDurationMs);
    let response: Response;
    try { response = await fetcher(`${brokerOrigin}${AWS_CONFIG_COMPLIANCE_BROKER_PATH}`, { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json",
        "x-sutra-tenant-id": runtimeRequest.scope.orgId,
        "x-sutra-customer-id": runtimeRequest.scope.customerId,
        "x-sutra-connection-id": runtimeRequest.scope.connectionId,
        "x-sutra-request-id": requestId, ...signed.headers }, body, signal: controller.signal }); }
    catch { clearTimeout(timer); parentSignal.removeEventListener("abort", abort); reject(); }
    let bytes: Uint8Array; try { bytes = await bounded(response); }
    finally { clearTimeout(timer); parentSignal.removeEventListener("abort", abort); }
    try { await verifyHostedBrokerResponse({ status: response.status, path: AWS_CONFIG_COMPLIANCE_BROKER_PATH,
      nonce: signed.nonce, body: bytes, headers: response.headers, config: input.configuration.signing }); }
    catch { reject(); }
    if (response.status !== 200 || !JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) reject();
    const envelope = parse(bytes);
    if (envelope.requestId !== requestId || envelope.requestBodySha256 !== bodyDigest) reject();
    const capture = envelope.capture as Parameters<typeof normalizeAwsConfigComplianceCapture>[0];
    try { normalizeAwsConfigComplianceCapture(capture, runtimeRequest.scope, Date.now()); } catch { reject(); }
    return capture as Awaited<ReturnType<AwsConfigComplianceCollectorAdapter["collect"]>>;
  } });
}

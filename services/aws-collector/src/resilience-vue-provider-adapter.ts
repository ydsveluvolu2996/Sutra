/** Credential-scoped provider boundary for ADV-10 ResilienceVue. */
import type { AwsTemporaryCredentials } from "./types.js";

export const RESILIENCE_VUE_PROVIDER_READ_ACTIONS = Object.freeze([
  "resiliencehub:DescribeApp",
  "resiliencehub:DescribeAppAssessment",
  "resiliencehub:DescribeResiliencyPolicy",
  "resiliencehub:ListAlarmRecommendations",
  "resiliencehub:ListAppAssessmentComplianceDrifts",
  "resiliencehub:ListAppAssessmentResourceDrifts",
  "resiliencehub:ListAppAssessments",
  "resiliencehub:ListAppComponentCompliances",
  "resiliencehub:ListAppComponentRecommendations",
  "resiliencehub:ListAppVersionResources",
  "resiliencehub:ListApps",
  "resiliencehub:ListResiliencyPolicies",
  "resiliencehub:ListSopRecommendations",
  "resiliencehub:ListTestRecommendations",
] as const);
export const RESILIENCE_VUE_PROVIDER_SESSION_ACTIONS = Object.freeze([
  "sts:GetCallerIdentity",
  ...RESILIENCE_VUE_PROVIDER_READ_ACTIONS,
] as const);

export interface ResilienceVueProviderScope {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: "aws" | "aws-cn" | "aws-us-gov";
  readonly region: string;
}

export interface ResilienceVueProviderRequest {
  readonly schemaVersion: "sutra.resilience-vue-runtime-request.v1";
  readonly requestId: string;
  readonly expectedCaptureId: string;
  readonly scheduledWindow: string;
  readonly scope: ResilienceVueProviderScope;
  readonly incrementalAfterIso: string | null;
  readonly credentials: "SERVER_OWNED_TRUST_ROLE_SESSION";
  readonly operations: typeof RESILIENCE_VUE_PROVIDER_READ_ACTIONS;
  readonly pagination: Readonly<Record<string, unknown>>;
  readonly bounds: Readonly<Record<string, unknown>>;
  readonly maximumDurationMs: number;
}

export interface ResilienceVueProviderClient {
  /**
   * The SDK-backed implementation must execute every declared read operation,
   * exhaust each pagination chain or mark it bounded, and return only the
   * versioned capture schema. Raw SDK exceptions, credentials and tokens never
   * cross this boundary.
   */
  collect(request: ResilienceVueProviderRequest, signal: AbortSignal): Promise<unknown>;
}

export type ResilienceVueProviderClientFactory = (input: {
  readonly region: string;
  readonly partition: ResilienceVueProviderScope["partition"];
  readonly credentials: AwsTemporaryCredentials;
}) => ResilienceVueProviderClient;

export class ResilienceVueProviderAdapterError extends Error {
  public readonly code: "INVALID_REQUEST" | "PROVIDER_RESPONSE_INVALID" | "BOUND_REACHED" | "ABORTED";
  public constructor(code: ResilienceVueProviderAdapterError["code"]) {
    super("AWS Resilience Hub provider collection did not complete");
    this.name = "ResilienceVueProviderAdapterError";
    this.code = code;
  }
}

function reject(code: ResilienceVueProviderAdapterError["code"]): never {
  throw new ResilienceVueProviderAdapterError(code);
}

export async function collectResilienceVueProviderEvidence(input: {
  readonly request: ResilienceVueProviderRequest;
  readonly client: ResilienceVueProviderClient;
  readonly signal: AbortSignal;
}): Promise<unknown> {
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted) reject("ABORTED");
  let capture: unknown;
  try { capture = await input.client.collect(input.request, input.signal); }
  catch { return reject(input.signal.aborted ? "ABORTED" : "PROVIDER_RESPONSE_INVALID"); }
  if (typeof capture !== "object" || capture === null || Array.isArray(capture)) {
    reject("PROVIDER_RESPONSE_INVALID");
  }
  const record = capture as Record<string, unknown>;
  if (record.schemaVersion !== "sutra.resilience-vue.v1"
    || record.captureId !== input.request.expectedCaptureId
    || JSON.stringify(record.scope) !== JSON.stringify(input.request.scope)) {
    reject("PROVIDER_RESPONSE_INVALID");
  }
  const bytes = Buffer.byteLength(JSON.stringify(capture), "utf8");
  const maximum = Number(input.request.bounds.maximumCaptureBytes);
  if (!Number.isSafeInteger(maximum) || bytes > maximum) reject("BOUND_REACHED");
  return capture;
}

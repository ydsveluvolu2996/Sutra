/** Credential-owning cross-service provider boundary for ADV-05. */
import type { AwsTemporaryCredentials } from "./types.js";

export const GRAVITON_PROVIDER_SESSION_ACTIONS = Object.freeze([
  "compute-optimizer:GetEC2InstanceRecommendations",
  "compute-optimizer:GetAutoScalingGroupRecommendations",
  "compute-optimizer:GetRDSDatabaseRecommendations",
  "ec2:DescribeInstances",
  "ec2:DescribeImages",
  "ec2:DescribeInstanceTypes",
  "autoscaling:DescribeAutoScalingGroups",
  "rds:DescribeDBInstances",
  "rds:DescribeDBClusters",
  "es:ListDomainNames",
  "es:DescribeDomain",
  "elasticache:DescribeCacheClusters",
  "elasticache:DescribeReplicationGroups",
  "pricing:ListPriceLists",
  "pricing:GetPriceListFileUrl",
] as const);

export const GRAVITON_PROVIDER_BOUNDS = Object.freeze({
  maximumCaptureBytes: 32 * 1_024 * 1_024,
  maximumResponseBytes: 8 * 1_024 * 1_024,
  maximumDurationMs: 15 * 60 * 1_000,
  maximumAccounts: 1_000,
  maximumRegions: 50,
  maximumRecommendations: 100_000,
  maximumInventoryObservations: 100_000,
  maximumMetadataRecords: 20_000,
  maximumCompatibilityRecords: 500_000,
  maximumCostRecords: 250_000,
  maximumPricingRecords: 50_000,
  maximumRealizationRecords: 100_000,
  maximumHistoryPerResource: 24,
  maximumHistoryAgeDays: 400,
  maximumOpportunitiesInResponse: 5_000,
  maximumEvidencePerRecord: 12,
  maximumTextLength: 512,
  rejectPaginationTokenReplay: true,
  requireExhaustionEvidence: true,
});

export interface GravitonProviderBoundary {
  readonly scope: { readonly orgId: string; readonly customerId: string; readonly connectionId: string };
  readonly managementAccountId: string;
  readonly partition: "aws" | "aws-cn" | "aws-us-gov";
  readonly accountIds: readonly string[];
  readonly regions: readonly string[];
}
export interface GravitonEvidenceAuthority {
  readonly cur2: { readonly generationId: string; readonly contentSha256: string };
  readonly pricing: { readonly catalogVersion: string; readonly contentSha256: string };
  readonly compatibility: { readonly policyVersion: string; readonly contentSha256: string };
  readonly workloadAttestations: { readonly setId: string; readonly contentSha256: string };
  readonly licenseAttestations: { readonly setId: string; readonly contentSha256: string };
}
export interface GravitonProviderRequest {
  readonly schemaVersion: "sutra.graviton-provider-request.v1";
  readonly requestKey: string;
  readonly scheduledWindow: string;
  readonly boundary: GravitonProviderBoundary;
  readonly accountTargets: readonly { readonly accountId: string; readonly connectionId: string }[];
  readonly services: readonly ["EC2_AND_AUTO_SCALING", "RDS_AND_AURORA", "OPENSEARCH", "ELASTICACHE"];
  readonly operations: typeof GRAVITON_PROVIDER_SESSION_ACTIONS;
  readonly recommendationPolicy: {
    readonly computeOptimizerAccepted: true;
    readonly managedServiceInventoryPricingAcceptedOnlyWithAllCompatibilityDimensions: true;
    readonly inferCompatibilityFromFamilyName: false;
    readonly inferSavingsWithoutPeriodMatchedCur2AndPricing: false;
  };
  readonly evidenceAuthority: GravitonEvidenceAuthority;
  readonly credentials: "SERVER_OWNED_TRUST_ROLE_SESSIONS";
  readonly bounds: typeof GRAVITON_PROVIDER_BOUNDS;
  readonly deadlineAtIso: string;
}
export interface GravitonProviderTarget {
  readonly accountId: string;
  readonly region: string;
}
export interface GravitonProviderReader {
  /**
   * The SDK-backed reader must exhaust every pagination chain and emit a
   * minimized capture. It may resolve the five content-addressed authorities,
   * but must never replace them with resource-name heuristics or estimates.
   */
  collect(input: {
    readonly request: GravitonProviderRequest;
    readonly sessionForTarget: (target: GravitonProviderTarget, signal: AbortSignal) => Promise<AwsTemporaryCredentials>;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}
export class GravitonProviderAdapterError extends Error {
  public readonly code: "INVALID_REQUEST" | "PROVIDER_RESPONSE_INVALID" | "BOUND_REACHED" | "ABORTED";
  public constructor(code: GravitonProviderAdapterError["code"]) {
    super("Graviton provider collection did not complete");
    this.name = "GravitonProviderAdapterError";
    this.code = code;
  }
}
function reject(code: GravitonProviderAdapterError["code"]): never { throw new GravitonProviderAdapterError(code); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) reject("PROVIDER_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

export async function collectGravitonProviderEvidence(input: {
  readonly request: GravitonProviderRequest;
  readonly reader: GravitonProviderReader;
  readonly sessionForTarget: (target: GravitonProviderTarget, signal: AbortSignal) => Promise<AwsTemporaryCredentials>;
  readonly signal: AbortSignal;
}): Promise<unknown> {
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted) reject("ABORTED");
  let capture: unknown;
  try {
    capture = await Promise.race([
      input.reader.collect({ request: input.request, sessionForTarget: input.sessionForTarget, signal: input.signal }),
      new Promise<never>((_resolve, rejectPromise) => input.signal.addEventListener("abort", () => rejectPromise(new GravitonProviderAdapterError("ABORTED")), { once: true })),
    ]);
  } catch {
    reject(input.signal.aborted ? "ABORTED" : "PROVIDER_RESPONSE_INVALID");
  }
  const value = exact(capture, ["schemaVersion", "scope", "managementAccountId", "partition", "accountIds", "regions",
    "collectionId", "startedAt", "completedAt", "recommendations", "inventory", "instanceMetadata", "compatibility",
    "costs", "pricing", "realizations"]);
  if (value.schemaVersion !== "sutra.graviton-savings.capture.v1"
    || !same(value.scope, input.request.boundary.scope)
    || value.managementAccountId !== input.request.boundary.managementAccountId
    || value.partition !== input.request.boundary.partition
    || !same(value.accountIds, input.request.boundary.accountIds)
    || !same(value.regions, input.request.boundary.regions)) reject("PROVIDER_RESPONSE_INVALID");
  const listBounds: readonly [string, number][] = [
    ["recommendations", GRAVITON_PROVIDER_BOUNDS.maximumRecommendations],
    ["inventory", GRAVITON_PROVIDER_BOUNDS.maximumInventoryObservations],
    ["instanceMetadata", GRAVITON_PROVIDER_BOUNDS.maximumMetadataRecords],
    ["compatibility", GRAVITON_PROVIDER_BOUNDS.maximumCompatibilityRecords],
    ["costs", GRAVITON_PROVIDER_BOUNDS.maximumCostRecords],
    ["pricing", GRAVITON_PROVIDER_BOUNDS.maximumPricingRecords],
    ["realizations", GRAVITON_PROVIDER_BOUNDS.maximumRealizationRecords],
  ];
  for (const [key, maximum] of listBounds) {
    if (!Array.isArray(value[key]) || (value[key] as unknown[]).length > maximum) reject("BOUND_REACHED");
  }
  if (Buffer.byteLength(JSON.stringify(capture), "utf8") > GRAVITON_PROVIDER_BOUNDS.maximumCaptureBytes) reject("BOUND_REACHED");
  return capture;
}

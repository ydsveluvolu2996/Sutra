/** Credential-owning, bounded collection boundary for ADD-12 AWS Config compliance. */
export const AWS_CONFIG_COMPLIANCE_PROVIDER_BOUNDS = Object.freeze({
  maximumDurationMs: 20 * 60 * 1_000,
  maximumCaptureBytes: 96 * 1_024 * 1_024,
  maximumAccounts: 10_000,
  maximumRegions: 64,
  maximumAccountRegions: 100_000,
  maximumProjectionRows: 1_000_000,
} as const);

export const AWS_CONFIG_COMPLIANCE_PROVIDER_SESSION_ACTIONS = Object.freeze([
  "config:DescribeConfigurationAggregators",
  "config:DescribeConfigurationAggregatorSourcesStatus",
  "config:DescribeAggregateComplianceByConfigRules",
  "config:GetAggregateComplianceDetailsByConfigRule",
  "config:DescribeAggregateComplianceByConformancePacks",
  "config:GetAggregateDiscoveredResourceCounts",
  "config:SelectAggregateResourceConfig",
  "config:DescribeConfigRules",
  "config:DescribeConfigRuleEvaluationStatus",
  "config:DescribeConfigurationRecorders",
  "config:DescribeConfigurationRecorderStatus",
  "organizations:DescribeOrganization",
  "organizations:ListAccounts",
] as const);

const CENTRAL_OPERATIONS = Object.freeze([
  ...AWS_CONFIG_COMPLIANCE_PROVIDER_SESSION_ACTIONS.slice(0, 7),
  ...AWS_CONFIG_COMPLIANCE_PROVIDER_SESSION_ACTIONS.slice(11),
] as readonly string[]);
const FANOUT_OPERATIONS = Object.freeze(
  AWS_CONFIG_COMPLIANCE_PROVIDER_SESSION_ACTIONS.slice(7, 11) as readonly string[],
);
const ACCOUNT = /^\d{12}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const REQUEST = /^acr_[a-f0-9]{64}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;

export interface AwsConfigComplianceProviderTarget {
  readonly accountId: string;
  readonly region: string;
  readonly connectionId: string;
}

export interface AwsConfigComplianceProviderRequest {
  readonly schemaVersion: "sutra.aws-config-compliance-provider-request.v1";
  readonly requestId: string;
  readonly scheduledWindow: string;
  readonly scope: Readonly<Record<string, unknown>> & {
    readonly orgId: string; readonly customerId: string; readonly connectionId: string;
    readonly partition: "aws" | "aws-us-gov" | "aws-cn";
    readonly aggregatorAccountId: string; readonly aggregatorRegion: string;
    readonly aggregatorName: string; readonly aggregatorArn: string;
  };
  readonly expectedCoverage: {
    readonly awsOrganizationId: string;
    readonly accountsEvidenceId: string;
    readonly accountsObservedAt: string;
    readonly activeAccountIds: readonly string[];
    readonly expectedRegions: readonly string[];
  };
  readonly targets: readonly AwsConfigComplianceProviderTarget[];
  readonly operations: { readonly central: readonly string[]; readonly fanout: readonly string[] };
  readonly inventoryQuery: string;
  readonly activity: unknown | null;
  readonly cur2: unknown | null;
  readonly credentials: "SERVER_OWNED_TRUST_ROLE_SESSIONS";
  readonly deadlineAtIso: string;
  readonly bounds: typeof AWS_CONFIG_COMPLIANCE_PROVIDER_BOUNDS;
}

export interface AwsConfigComplianceCentralProjection {
  readonly prerequisites: {
    readonly serviceConfigured: boolean; readonly aggregatorValidated: boolean;
    readonly readPermissionsValidated: boolean; readonly organizationsAllFeaturesEnabled: boolean;
  };
  readonly aggregator: unknown | null;
  readonly operationCoverage: readonly unknown[];
  readonly sourceStatuses: readonly unknown[];
  readonly ruleCompliance: readonly unknown[];
  readonly evaluations: readonly unknown[];
  readonly conformancePacks: readonly unknown[];
  readonly resourceCounts: readonly unknown[];
  readonly resourceInventory: readonly unknown[];
}

export interface AwsConfigComplianceFanoutProjection {
  readonly operationCoverage: readonly unknown[];
  readonly recorders: readonly unknown[];
  readonly rules: readonly unknown[];
}

export interface AwsConfigComplianceProviderReader {
  readCentral(input: {
    readonly target: AwsConfigComplianceProviderTarget;
    readonly aggregatorName: string;
    readonly inventoryQuery: string;
    readonly operations: typeof CENTRAL_OPERATIONS;
  }, signal: AbortSignal): Promise<AwsConfigComplianceCentralProjection>;
  readAccountRegion(input: {
    readonly target: AwsConfigComplianceProviderTarget;
    readonly operations: typeof FANOUT_OPERATIONS;
  }, signal: AbortSignal): Promise<AwsConfigComplianceFanoutProjection>;
}

export class AwsConfigComplianceProviderError extends Error {
  public readonly code: "INVALID_REQUEST" | "INVALID_RESPONSE" | "BOUND_REACHED" | "ABORTED";
  public constructor(code: AwsConfigComplianceProviderError["code"]) {
    super("AWS Config compliance provider collection rejected");
    this.name = "AwsConfigComplianceProviderError"; this.code = code;
  }
}
function reject(code: AwsConfigComplianceProviderError["code"]): never {
  throw new AwsConfigComplianceProviderError(code);
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function canonicalIso(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}
function validRequest(request: AwsConfigComplianceProviderRequest): boolean {
  const expectedTargets = request.expectedCoverage.activeAccountIds.flatMap((accountId) =>
    request.expectedCoverage.expectedRegions.map((region) => `${accountId}|${region}`));
  const actualTargets = request.targets.map((target) => `${target.accountId}|${target.region}`);
  return request.schemaVersion === "sutra.aws-config-compliance-provider-request.v1"
    && REQUEST.test(request.requestId) && WINDOW.test(request.scheduledWindow)
    && IDENTIFIER.test(request.scope.orgId) && IDENTIFIER.test(request.scope.customerId)
    && CONNECTION.test(request.scope.connectionId) && ACCOUNT.test(request.scope.aggregatorAccountId)
    && REGION.test(request.scope.aggregatorRegion)
    && request.credentials === "SERVER_OWNED_TRUST_ROLE_SESSIONS"
    && same(request.operations.central, CENTRAL_OPERATIONS)
    && same(request.operations.fanout, FANOUT_OPERATIONS)
    && same(request.bounds, AWS_CONFIG_COMPLIANCE_PROVIDER_BOUNDS)
    && canonicalIso(request.deadlineAtIso) && canonicalIso(request.expectedCoverage.accountsObservedAt)
    && request.expectedCoverage.activeAccountIds.length >= 1
    && request.expectedCoverage.activeAccountIds.length <= AWS_CONFIG_COMPLIANCE_PROVIDER_BOUNDS.maximumAccounts
    && request.expectedCoverage.expectedRegions.length >= 1
    && request.expectedCoverage.expectedRegions.length <= AWS_CONFIG_COMPLIANCE_PROVIDER_BOUNDS.maximumRegions
    && request.targets.length === expectedTargets.length
    && request.targets.length <= AWS_CONFIG_COMPLIANCE_PROVIDER_BOUNDS.maximumAccountRegions
    && request.targets.every((target) => ACCOUNT.test(target.accountId) && REGION.test(target.region)
      && CONNECTION.test(target.connectionId))
    && same(actualTargets, expectedTargets)
    && new Set(actualTargets).size === actualTargets.length
    && request.targets.some((target) => target.accountId === request.scope.aggregatorAccountId
      && target.region === request.scope.aggregatorRegion && target.connectionId === request.scope.connectionId);
}
function list(value: unknown, maximum = AWS_CONFIG_COMPLIANCE_PROVIDER_BOUNDS.maximumProjectionRows): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) reject("BOUND_REACHED");
  return value;
}

export async function collectAwsConfigComplianceProviderEvidence(input: {
  readonly request: AwsConfigComplianceProviderRequest;
  readonly reader: AwsConfigComplianceProviderReader;
  readonly signal: AbortSignal;
  readonly now?: () => number;
}): Promise<Readonly<Record<string, unknown>>> {
  if (!validRequest(input.request) || !(input.signal instanceof AbortSignal) || input.signal.aborted) reject("INVALID_REQUEST");
  const now = input.now ?? Date.now; const started = now(); const deadline = Date.parse(input.request.deadlineAtIso);
  if (!Number.isSafeInteger(started) || started < 0 || deadline <= started
    || deadline - started > AWS_CONFIG_COMPLIANCE_PROVIDER_BOUNDS.maximumDurationMs) reject("INVALID_REQUEST");
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(deadline - started)]);
  const centralTarget = input.request.targets.find((target) =>
    target.accountId === input.request.scope.aggregatorAccountId
    && target.region === input.request.scope.aggregatorRegion
    && target.connectionId === input.request.scope.connectionId)!;
  let central: AwsConfigComplianceCentralProjection; const fanout: AwsConfigComplianceFanoutProjection[] = [];
  try {
    central = await input.reader.readCentral({ target: centralTarget,
      aggregatorName: input.request.scope.aggregatorName,
      inventoryQuery: input.request.inventoryQuery, operations: CENTRAL_OPERATIONS }, signal);
    for (const target of input.request.targets) {
      fanout.push(await input.reader.readAccountRegion({ target, operations: FANOUT_OPERATIONS }, signal));
    }
  } catch (error) {
    if (signal.aborted) reject("ABORTED");
    throw error;
  }
  const completed = now();
  if (!Number.isSafeInteger(completed) || completed < started || completed > deadline) reject("INVALID_RESPONSE");
  const capture = {
    schemaVersion: "sutra.aws-config-compliance.v1",
    scope: input.request.scope,
    captureId: `config_${input.request.requestId.slice(4)}`,
    startedAt: new Date(started).toISOString(), completedAt: new Date(completed).toISOString(),
    prerequisites: central.prerequisites, expectedCoverage: input.request.expectedCoverage,
    aggregator: central.aggregator,
    operationCoverage: [...list(central.operationCoverage), ...fanout.flatMap((value) => list(value.operationCoverage))],
    sourceStatuses: list(central.sourceStatuses),
    recorders: fanout.flatMap((value) => list(value.recorders)),
    rules: fanout.flatMap((value) => list(value.rules)),
    ruleCompliance: list(central.ruleCompliance), evaluations: list(central.evaluations),
    conformancePacks: list(central.conformancePacks), resourceCounts: list(central.resourceCounts),
    inventoryQuery: input.request.inventoryQuery, resourceInventory: list(central.resourceInventory),
    activity: input.request.activity, cur2: input.request.cur2,
  } as const;
  if (new TextEncoder().encode(JSON.stringify(capture)).byteLength
    > AWS_CONFIG_COMPLIANCE_PROVIDER_BOUNDS.maximumCaptureBytes) reject("BOUND_REACHED");
  return Object.freeze(capture);
}

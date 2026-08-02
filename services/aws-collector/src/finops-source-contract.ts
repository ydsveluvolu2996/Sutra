import type {
  AwsPartition,
  FinopsSourceContract,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const IAM_POLICY_NAME = /^[\w+=,.@-]{1,128}$/u;

export const FINOPS_COLLECTOR_SOURCE_IDS = Object.freeze([
  "aws_cur2_data_export",
  "aws_focus_1_2_data_export",
  "trusted_advisor_standard_checks",
  "trusted_advisor_organization",
  "compute_optimizer_organization_export",
  "cost_anomaly_detection",
  "extended_support_inventory",
  "aws_health_organization",
  "aws_news_feeds",
  "aws_budgets",
  "aws_support_cases_organization",
  "aws_resilience_hub",
  "end_user_computing_telemetry",
  "data_collection_telemetry",
  "media_services_telemetry",
  "cost_optimization_hub_export",
  "aws_marketplace_intelligence",
  "kubecost_allocation",
  "scad_allocation",
  "aws_carbon_footprint",
  "amazon_connect_telemetry",
  "aws_config_organization_aggregator",
  "aws_pricing_catalog",
  "aws_organizations_taxonomy",
  "sutra_billing_workspace",
] as const);

export type FinopsCollectorSourceId =
  (typeof FINOPS_COLLECTOR_SOURCE_IDS)[number];

export const COST_ANOMALY_SOURCE_PERMISSION_CONTRACT_ID =
  "aws-cost-anomaly-read-v1" as const;
export const COST_ANOMALY_SOURCE_POLICY_NAME =
  "SutraFinopsCostAnomalyReadV1" as const;
export const COST_ANOMALY_SOURCE_ACTIONS = Object.freeze([
  "ce:GetAnomalies",
  "ce:GetAnomalyMonitors",
  "ce:GetAnomalySubscriptions",
] as const);

export const TRUSTED_ADVISOR_STANDARD_SOURCE_PERMISSION_CONTRACT_ID =
  "aws-trusted-advisor-standard-checks-read-v1" as const;
export const TRUSTED_ADVISOR_STANDARD_SOURCE_POLICY_NAME =
  "SutraFinopsTrustedAdvisorStandardReadV1" as const;
export const TRUSTED_ADVISOR_STANDARD_SOURCE_ACTIONS = Object.freeze([
  "support:DescribeTrustedAdvisorCheckResult",
  "support:DescribeTrustedAdvisorChecks",
] as const);

export const COMPUTE_OPTIMIZER_EXPORT_SOURCE_PERMISSION_CONTRACT_ID =
  "aws-compute-optimizer-organization-export-read-v1" as const;
export const COMPUTE_OPTIMIZER_EXPORT_SOURCE_POLICY_NAME =
  "SutraFinopsComputeOptimizerExportReadV1" as const;
export const COMPUTE_OPTIMIZER_EXPORT_SOURCE_ACTIONS = Object.freeze([
  "compute-optimizer:DescribeRecommendationExportJobs",
  "compute-optimizer:GetEnrollmentStatus",
  "compute-optimizer:GetEnrollmentStatusesForOrganization",
] as const);

export const AWS_ORGANIZATIONS_TAXONOMY_SOURCE_PERMISSION_CONTRACT_ID =
  "aws-organizations-taxonomy-read-v1" as const;
export const AWS_ORGANIZATIONS_TAXONOMY_SOURCE_POLICY_NAME =
  "SutraFinopsOrganizationsTaxonomyReadV1" as const;
export const AWS_ORGANIZATIONS_TAXONOMY_SOURCE_ACTIONS = Object.freeze([
  "organizations:DescribeOrganization",
  "organizations:ListAccounts",
] as const);

export interface FinopsSourceDefinition {
  readonly implementationState: "IMPLEMENTED" | "NOT_IMPLEMENTED";
  readonly permissionContractId: string | null;
  readonly policyName: string | null;
  readonly actions: readonly string[];
}

const NOT_IMPLEMENTED_SOURCE: FinopsSourceDefinition = Object.freeze({
  implementationState: "NOT_IMPLEMENTED",
  permissionContractId: null,
  policyName: null,
  actions: Object.freeze([]),
});

const IMPLEMENTED_SOURCE_DEFINITIONS = Object.freeze({
  cost_anomaly_detection: Object.freeze({
    implementationState: "IMPLEMENTED" as const,
    permissionContractId: COST_ANOMALY_SOURCE_PERMISSION_CONTRACT_ID,
    policyName: COST_ANOMALY_SOURCE_POLICY_NAME,
    actions: COST_ANOMALY_SOURCE_ACTIONS,
  }),
  trusted_advisor_standard_checks: Object.freeze({
    implementationState: "IMPLEMENTED" as const,
    permissionContractId: TRUSTED_ADVISOR_STANDARD_SOURCE_PERMISSION_CONTRACT_ID,
    policyName: TRUSTED_ADVISOR_STANDARD_SOURCE_POLICY_NAME,
    actions: TRUSTED_ADVISOR_STANDARD_SOURCE_ACTIONS,
  }),
  compute_optimizer_organization_export: Object.freeze({
    implementationState: "IMPLEMENTED" as const,
    permissionContractId: COMPUTE_OPTIMIZER_EXPORT_SOURCE_PERMISSION_CONTRACT_ID,
    policyName: COMPUTE_OPTIMIZER_EXPORT_SOURCE_POLICY_NAME,
    actions: COMPUTE_OPTIMIZER_EXPORT_SOURCE_ACTIONS,
  }),
  aws_organizations_taxonomy: Object.freeze({
    implementationState: "IMPLEMENTED" as const,
    permissionContractId: AWS_ORGANIZATIONS_TAXONOMY_SOURCE_PERMISSION_CONTRACT_ID,
    policyName: AWS_ORGANIZATIONS_TAXONOMY_SOURCE_POLICY_NAME,
    actions: AWS_ORGANIZATIONS_TAXONOMY_SOURCE_ACTIONS,
  }),
});

export const FINOPS_SOURCE_DEFINITIONS: Readonly<
  Record<FinopsCollectorSourceId, FinopsSourceDefinition>
> = Object.freeze(Object.fromEntries(FINOPS_COLLECTOR_SOURCE_IDS.map((sourceId) => [
  sourceId,
  sourceId in IMPLEMENTED_SOURCE_DEFINITIONS
    ? IMPLEMENTED_SOURCE_DEFINITIONS[
        sourceId as keyof typeof IMPLEMENTED_SOURCE_DEFINITIONS
      ]
    : NOT_IMPLEMENTED_SOURCE,
])) as unknown as Readonly<
  Record<FinopsCollectorSourceId, FinopsSourceDefinition>
>);

export interface FinopsSourceContractOwner {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly expectedAccountId: string;
  readonly partition: AwsPartition;
}

export class FinopsSourceContractError extends Error {
  public constructor() {
    super("The persisted FinOps source contract is invalid");
    this.name = "FinopsSourceContractError";
  }
}

export function parseFinopsSourceContracts(
  value: unknown,
  owner: FinopsSourceContractOwner,
): readonly FinopsSourceContract[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) failContract();
  const contracts = value.map((candidate) => parseContract(candidate, owner));
  if (
    new Set(contracts.map(({ contractId }) => contractId)).size !== contracts.length ||
    new Set(contracts.map(({ sourceId }) => sourceId)).size !== contracts.length ||
    new Set(contracts.flatMap(({ policyName }) => policyName === null ? [] : [policyName])).size !==
      contracts.filter(({ policyName }) => policyName !== null).length
  ) failContract();
  return contracts.sort((left, right) => left.contractId.localeCompare(right.contractId));
}

export function resolveFinopsSourceContract(
  value: unknown,
  owner: FinopsSourceContractOwner,
  contractId: string,
): FinopsSourceContract | null {
  if (!IDENTIFIER.test(contractId)) throw new FinopsSourceContractError();
  const contracts = value === undefined
    ? []
    : parseFinopsSourceContracts(value, owner);
  return contracts.find((contract) => contract.contractId === contractId) ?? null;
}

export function actionsForFinopsSourceContracts(
  contracts: readonly FinopsSourceContract[],
): readonly string[] {
  return [...new Set(contracts.flatMap((contract) =>
    finopsSourceDefinition(contract.sourceId).actions
  ))].sort();
}

export function finopsSourceDefinition(sourceId: string): FinopsSourceDefinition {
  if (!isFinopsCollectorSourceId(sourceId)) failContract();
  return FINOPS_SOURCE_DEFINITIONS[sourceId];
}

function parseContract(
  value: unknown,
  owner: FinopsSourceContractOwner,
): FinopsSourceContract {
  const record = exactRecord(value, [
    "tenantId",
    "connectionId",
    "contractId",
    "sourceId",
    "accountId",
    "partition",
    "region",
    "permissionContractId",
    "policyName",
  ]);
  if (
    record.tenantId !== owner.tenantId ||
    record.connectionId !== owner.connectionId ||
    record.accountId !== owner.expectedAccountId ||
    record.partition !== owner.partition ||
    typeof record.contractId !== "string" || !IDENTIFIER.test(record.contractId) ||
    typeof record.sourceId !== "string" || !isFinopsCollectorSourceId(record.sourceId) ||
    typeof record.region !== "string" || !REGION.test(record.region) ||
    !regionMatchesPartition(record.region, owner.partition)
  ) failContract();
  const definition = finopsSourceDefinition(record.sourceId);
  if (
    record.permissionContractId !== definition.permissionContractId ||
    record.policyName !== definition.policyName ||
    (record.policyName !== null &&
      (typeof record.policyName !== "string" || !IAM_POLICY_NAME.test(record.policyName))) ||
    (new Set([
      "cost_anomaly_detection",
      "trusted_advisor_standard_checks",
      "aws_organizations_taxonomy",
    ])
      .has(record.sourceId) &&
      (owner.partition !== "aws" || record.region !== "us-east-1"))
  ) failContract();
  return {
    tenantId: owner.tenantId,
    connectionId: owner.connectionId,
    contractId: record.contractId,
    sourceId: record.sourceId,
    accountId: owner.expectedAccountId,
    partition: owner.partition,
    region: record.region,
    permissionContractId: definition.permissionContractId,
    policyName: definition.policyName,
  };
}

function isFinopsCollectorSourceId(value: string): value is FinopsCollectorSourceId {
  return (FINOPS_COLLECTOR_SOURCE_IDS as readonly string[]).includes(value);
}

function regionMatchesPartition(region: string, partition: AwsPartition): boolean {
  if (partition === "aws-cn") return region.startsWith("cn-");
  if (partition === "aws-us-gov") return region.startsWith("us-gov-");
  return !region.startsWith("cn-") && !region.startsWith("us-gov-");
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) failContract();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    failContract();
  }
  return record;
}

function failContract(): never {
  throw new FinopsSourceContractError();
}

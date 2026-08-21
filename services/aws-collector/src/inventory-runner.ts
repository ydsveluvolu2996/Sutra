import { createHash } from "node:crypto";

import {
  BedrockClient,
  GetAccountDataRetentionCommand,
  GetGuardrailCommand,
  GetModelInvocationLoggingConfigurationCommand,
  ListGuardrailsCommand,
  type GetAccountDataRetentionCommandOutput,
  type GetGuardrailCommandInput,
  type GetGuardrailCommandOutput,
  type GetModelInvocationLoggingConfigurationCommandOutput,
  type ListGuardrailsCommandInput,
  type ListGuardrailsCommandOutput,
} from "@aws-sdk/client-bedrock";
import {
  CloudTrailClient,
  DescribeTrailsCommand,
  GetTrailStatusCommand,
  type DescribeTrailsCommandInput,
  type DescribeTrailsCommandOutput,
  type GetTrailStatusCommandInput,
  type GetTrailStatusCommandOutput,
} from "@aws-sdk/client-cloudtrail";
import {
  DescribeAddressesCommand,
  DescribeFlowLogsCommand,
  DescribeNetworkAclsCommand,
  DescribeNetworkInterfacesCommand,
  DescribeInstancesCommand,
  DescribeInternetGatewaysCommand,
  DescribeRegionsCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSnapshotsCommand,
  DescribeSubnetsCommand,
  DescribeVolumesCommand,
  DescribeVpcsCommand,
  EC2Client,
  type DescribeAddressesCommandInput,
  type DescribeAddressesCommandOutput,
  type DescribeFlowLogsCommandInput,
  type DescribeFlowLogsCommandOutput,
  type DescribeNetworkAclsCommandInput,
  type DescribeNetworkAclsCommandOutput,
  type DescribeNetworkInterfacesCommandInput,
  type DescribeNetworkInterfacesCommandOutput,
  type DescribeInstancesCommandInput,
  type DescribeInstancesCommandOutput,
  type DescribeInternetGatewaysCommandInput,
  type DescribeInternetGatewaysCommandOutput,
  type DescribeRegionsCommandOutput,
  type DescribeRouteTablesCommandInput,
  type DescribeRouteTablesCommandOutput,
  type DescribeSecurityGroupsCommandInput,
  type DescribeSecurityGroupsCommandOutput,
  type DescribeSnapshotsCommandInput,
  type DescribeSnapshotsCommandOutput,
  type DescribeSubnetsCommandInput,
  type DescribeSubnetsCommandOutput,
  type DescribeVolumesCommandInput,
  type DescribeVolumesCommandOutput,
  type DescribeVpcsCommandInput,
  type DescribeVpcsCommandOutput,
  type IpPermission,
  type Route,
} from "@aws-sdk/client-ec2";
import {
  DescribeListenersCommand,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
  type DescribeListenersCommandInput,
  type DescribeListenersCommandOutput,
  type DescribeLoadBalancersCommandInput,
  type DescribeLoadBalancersCommandOutput,
  type DescribeTargetGroupsCommandInput,
  type DescribeTargetGroupsCommandOutput,
  type DescribeTargetHealthCommandInput,
  type DescribeTargetHealthCommandOutput,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import {
  DescribeKeyCommand,
  KMSClient,
  ListAliasesCommand,
  ListKeysCommand,
  type DescribeKeyCommandInput,
  type DescribeKeyCommandOutput,
  type ListAliasesCommandInput,
  type ListAliasesCommandOutput,
  type ListKeysCommandInput,
  type ListKeysCommandOutput,
} from "@aws-sdk/client-kms";
import {
  DescribeTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  type DescribeTableCommandInput,
  type DescribeTableCommandOutput,
  type ListTablesCommandInput,
  type ListTablesCommandOutput,
} from "@aws-sdk/client-dynamodb";
import {
  DescribeRepositoriesCommand,
  ECRClient,
  type DescribeRepositoriesCommandInput,
  type DescribeRepositoriesCommandOutput,
} from "@aws-sdk/client-ecr";
import {
  DescribeClusterCommand,
  EKSClient,
  ListClustersCommand,
  type DescribeClusterCommandInput,
  type DescribeClusterCommandOutput,
  type ListClustersCommandInput,
  type ListClustersCommandOutput,
} from "@aws-sdk/client-eks";
import {
  GetFindingsCommand as GetGuardDutyFindingsCommand,
  GetDetectorCommand,
  GuardDutyClient,
  ListDetectorsCommand,
  ListFindingsCommand as ListGuardDutyFindingsCommand,
  type Finding as GuardDutyFinding,
  type GetDetectorCommandInput,
  type GetDetectorCommandOutput,
  type GetFindingsCommandInput as GetGuardDutyFindingsCommandInput,
  type GetFindingsCommandOutput as GetGuardDutyFindingsCommandOutput,
  type ListDetectorsCommandInput,
  type ListDetectorsCommandOutput,
  type ListFindingsCommandInput as ListGuardDutyFindingsCommandInput,
  type ListFindingsCommandOutput as ListGuardDutyFindingsCommandOutput,
} from "@aws-sdk/client-guardduty";
import {
  BatchGetAccountStatusCommand,
  Inspector2Client,
  ListFindingsCommand as ListInspectorFindingsCommand,
  type BatchGetAccountStatusCommandInput,
  type BatchGetAccountStatusCommandOutput,
  type Finding as InspectorFinding,
  type ListFindingsCommandInput as ListInspectorFindingsCommandInput,
  type ListFindingsCommandOutput as ListInspectorFindingsCommandOutput,
} from "@aws-sdk/client-inspector2";
import {
  GetAccountPasswordPolicyCommand,
  GetAccountSummaryCommand,
  IAMClient,
  type GetAccountPasswordPolicyCommandOutput,
  type GetAccountSummaryCommandOutput,
} from "@aws-sdk/client-iam";
import {
  DescribeDBInstancesCommand,
  RDSClient,
  type DescribeDBInstancesCommandInput,
  type DescribeDBInstancesCommandOutput,
} from "@aws-sdk/client-rds";
import {
  GetPublicAccessBlockCommand,
  ListBucketsCommand,
  S3Client,
  type GetPublicAccessBlockCommandInput,
  type GetPublicAccessBlockCommandOutput,
  type ListBucketsCommandInput,
  type ListBucketsCommandOutput,
} from "@aws-sdk/client-s3";
import {
  DescribeHubCommand,
  GetFindingsCommand as GetSecurityHubFindingsCommand,
  SecurityHubClient,
  type AwsSecurityFinding,
  type DescribeHubCommandOutput,
  type GetFindingsCommandInput as GetSecurityHubFindingsCommandInput,
  type GetFindingsCommandOutput as GetSecurityHubFindingsCommandOutput,
} from "@aws-sdk/client-securityhub";
import {
  DescribeInstanceInformationCommand,
  DescribeInstancePatchStatesCommand,
  DescribeInstancePatchesCommand,
  SSMClient,
  type DescribeInstanceInformationCommandInput,
  type DescribeInstanceInformationCommandOutput,
  type DescribeInstancePatchStatesCommandInput,
  type DescribeInstancePatchStatesCommandOutput,
  type DescribeInstancePatchesCommandInput,
  type DescribeInstancePatchesCommandOutput,
  type InstancePatchState,
} from "@aws-sdk/client-ssm";

import type {
  AwsInventoryBatch,
  AwsInventorySink,
  AwsTemporaryCredentials,
  InventoryCollectionContext,
  InventoryCollectionResult,
  InventoryCollectorCoverage,
  InventoryEvidenceStatus,
  InventoryRunner,
  NormalizedAwsEvidence,
  NormalizedAwsResource,
  SafeJsonObject,
  SafeJsonValue,
} from "./types.js";
import {
  ALL_ENABLED_AWS_REGIONS,
  isAllEnabledAwsRegionSelection,
} from "./aws-region-selection.js";
import {
  LIVE_AWS_COLLECTION_DEADLINE_MS,
  LIVE_AWS_COMMAND_DEADLINE_MS,
  LIVE_AWS_MAX_REGIONS,
} from "./live-collection-limits.js";

const REGION = /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]+$/;
const MAX_REGIONS = LIVE_AWS_MAX_REGIONS;
const MAX_PAGES = 10_000;
const MAX_NATIVE_FINDING_PAGES = 50;
const MAX_NATIVE_FINDINGS_PER_SERVICE_REGION = 1_000;
const MAX_NATIVE_FINDING_RESOURCES = 20;
// DescribeInstancePatchStates accepts at most 50 instance ids per call; the
// missing-patch detail fan-out and per-instance patch list are bounded so a
// large fleet cannot turn a single read-only patch-posture scan unbounded.
const MAX_SSM_PATCH_STATE_BATCH = 50;
const MAX_SSM_MISSING_PATCH_INSTANCES = 50;
const MAX_SSM_MISSING_PATCHES_PER_INSTANCE = 60;
const SAFE_TAG_KEYS = new Set([
  "name",
  "environment",
  "env",
  "service",
  "application",
  "app",
  "project",
  "owner",
  "team",
  "costcenter",
  "costcentre",
  "managedby",
]);
const DANGEROUS_TAG_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RETRYABLE_TASK_ERRORS = new Set([
  "TimeoutError",
  "RequestTimeout",
  "RequestTimeoutException",
  "NetworkingError",
  "Throttling",
  "ThrottlingException",
  "TooManyRequestsException",
  "RequestLimitExceeded",
  "ServiceUnavailable",
  "ServiceUnavailableException",
  "InternalFailure",
  "InternalServerError",
]);
const HIGH_CONFIDENCE_SECRET_VALUE =
  /(?:\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|secret|session[_ -]?token|api[_ -]?key)\s*[:=]|\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/iu;
const CREDENTIAL_URI_OR_SIGNED_URL =
  /(?:(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/|https?:\/\/[^\s]+[?&](?:x-amz-(?:credential|signature|security-token)|signature|sig|token|api[_-]?key)=)/iu;
const LONG_OPAQUE_TAG_TOKEN = /\b[A-Za-z0-9_-]{40,}\b/u;

export interface InventorySelectionContext {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: string;
  readonly credentials: AwsTemporaryCredentials;
}

export interface InventoryRegionSelector {
  selectRegions(
    context: InventorySelectionContext,
    abortSignal?: AbortSignal,
  ): Promise<readonly string[]> | readonly string[];
}

export class StaticInventoryRegionSelector implements InventoryRegionSelector {
  public constructor(private readonly regions: readonly string[]) {}

  public selectRegions(): readonly string[] {
    return this.regions;
  }
}

export interface AwsRegionDiscoveryClient {
  describeRegions(abortSignal?: AbortSignal): Promise<DescribeRegionsCommandOutput>;
}

export interface AwsEnabledRegionSelectorOptions {
  readonly controlRegion: string;
  /** Either a strict explicit Region list or the sole `all-enabled` marker. */
  readonly requestedRegions: readonly string[];
  readonly maxAttempts?: number;
  readonly clientFactory?: (
    controlRegion: string,
    credentials: AwsTemporaryCredentials,
  ) => AwsRegionDiscoveryClient;
}

/**
 * Discovers account-enabled Regions after AssumeRole. Explicit selections are
 * checked against AWS; `all-enabled` returns the actual discovered names so
 * the selection marker can never leak into inventory or coverage evidence.
 */
export class AwsEnabledRegionSelector implements InventoryRegionSelector {
  private readonly maxAttempts: number;

  public constructor(private readonly options: AwsEnabledRegionSelectorOptions) {
    if (!REGION.test(options.controlRegion)) {
      throw new InventoryConfigurationError("A valid Region discovery endpoint is required");
    }
    this.maxAttempts = validateMaxAttempts(options.maxAttempts ?? 4);
  }

  public async selectRegions(
    context: InventorySelectionContext,
    abortSignal?: AbortSignal,
  ): Promise<readonly string[]> {
    const allEnabledSelection = isAllEnabledAwsRegionSelection(
      this.options.requestedRegions,
    );
    if (
      !allEnabledSelection &&
      this.options.requestedRegions.includes(ALL_ENABLED_AWS_REGIONS)
    ) {
      throw new InventoryConfigurationError(
        "All enabled Regions cannot be combined with an explicit Region",
      );
    }
    const requested = allEnabledSelection
      ? null
      : normalizeRegions(this.options.requestedRegions);
    const client = this.options.clientFactory?.(
      this.options.controlRegion,
      context.credentials,
    ) ?? this.createClient(context.credentials);
    const output = await client.describeRegions(abortSignal);
    const enabled = normalizeDiscoveredRegions(
      (output.Regions ?? []).flatMap((region) =>
        typeof region.RegionName === "string" &&
          (region.OptInStatus === "opted-in" || region.OptInStatus === "opt-in-not-required")
          ? [region.RegionName]
          : [],
      ),
    );
    if (requested === null) {
      if (enabled.length === 0) {
        throw new InventoryConfigurationError(
          "AWS did not return any enabled Regions for this account",
        );
      }
      return enabled;
    }
    const enabledSet = new Set(enabled);
    const unavailable = requested.filter((region) => !enabledSet.has(region));
    if (unavailable.length > 0) {
      throw new InventoryConfigurationError(
        `Selected AWS Regions are not enabled: ${unavailable.join(", ")}`,
      );
    }
    return requested;
  }

  private createClient(credentials: AwsTemporaryCredentials): AwsRegionDiscoveryClient {
    const client = new EC2Client({
      region: this.options.controlRegion,
      credentials,
      retryMode: "standard",
      maxAttempts: this.maxAttempts,
    });
    return {
      describeRegions: (abortSignal) =>
        sendSdkCommand(client, new DescribeRegionsCommand({ AllRegions: true }), abortSignal),
    };
  }
}

export interface Ec2InventoryClient {
  describeInstances(
    input: DescribeInstancesCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeInstancesCommandOutput>;
  describeVpcs(
    input: DescribeVpcsCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeVpcsCommandOutput>;
  describeSubnets(
    input: DescribeSubnetsCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeSubnetsCommandOutput>;
  describeSecurityGroups(
    input: DescribeSecurityGroupsCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeSecurityGroupsCommandOutput>;
  describeVolumes(
    input: DescribeVolumesCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeVolumesCommandOutput>;
  describeNetworkInterfaces(
    input: DescribeNetworkInterfacesCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeNetworkInterfacesCommandOutput>;
  describeRouteTables(
    input: DescribeRouteTablesCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeRouteTablesCommandOutput>;
  describeInternetGateways(
    input: DescribeInternetGatewaysCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeInternetGatewaysCommandOutput>;
  describeFlowLogs?(
    input: DescribeFlowLogsCommandInput,
    signal?: AbortSignal,
  ): Promise<DescribeFlowLogsCommandOutput>;
  describeNetworkAcls(
    input: DescribeNetworkAclsCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeNetworkAclsCommandOutput>;
  // Optional so pre-existing test factories that predate these read-only cost
  // collectors remain source-compatible (mirrors the optional `eks` factory).
  describeAddresses?(
    input: DescribeAddressesCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeAddressesCommandOutput>;
  describeSnapshots?(
    input: DescribeSnapshotsCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeSnapshotsCommandOutput>;
}

export interface Elbv2InventoryClient {
  describeLoadBalancers(
    input: DescribeLoadBalancersCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeLoadBalancersCommandOutput>;
  describeListeners(
    input: DescribeListenersCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeListenersCommandOutput>;
  describeTargetGroups(
    input: DescribeTargetGroupsCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeTargetGroupsCommandOutput>;
  describeTargetHealth(
    input: DescribeTargetHealthCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeTargetHealthCommandOutput>;
}

export interface KmsInventoryClient {
  listKeys(
    input: ListKeysCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<ListKeysCommandOutput>;
  listAliases(
    input: ListAliasesCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<ListAliasesCommandOutput>;
  describeKey(
    input: DescribeKeyCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeKeyCommandOutput>;
}

export interface DynamoDbInventoryClient {
  listTables(
    input: ListTablesCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<ListTablesCommandOutput>;
  describeTable(
    input: DescribeTableCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeTableCommandOutput>;
}

export interface EcrInventoryClient {
  describeRepositories(
    input: DescribeRepositoriesCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeRepositoriesCommandOutput>;
}

export interface EksInventoryClient {
  listClusters(
    input: ListClustersCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<ListClustersCommandOutput>;
  describeCluster(
    input: DescribeClusterCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeClusterCommandOutput>;
}

export interface S3InventoryClient {
  listBuckets(
    input: ListBucketsCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<ListBucketsCommandOutput>;
  getPublicAccessBlock(
    input: GetPublicAccessBlockCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<GetPublicAccessBlockCommandOutput>;
}

export interface RdsInventoryClient {
  describeDBInstances(
    input: DescribeDBInstancesCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeDBInstancesCommandOutput>;
}

export interface IamInventoryClient {
  getAccountSummary(abortSignal?: AbortSignal): Promise<GetAccountSummaryCommandOutput>;
  getAccountPasswordPolicy(
    abortSignal?: AbortSignal,
  ): Promise<GetAccountPasswordPolicyCommandOutput>;
}

export interface CloudTrailInventoryClient {
  describeTrails(
    input: DescribeTrailsCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeTrailsCommandOutput>;
  getTrailStatus(
    input: GetTrailStatusCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<GetTrailStatusCommandOutput>;
}

export interface GuardDutyInventoryClient {
  listDetectors(
    input: ListDetectorsCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<ListDetectorsCommandOutput>;
  getDetector(
    input: GetDetectorCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<GetDetectorCommandOutput>;
  listFindings(
    input: ListGuardDutyFindingsCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<ListGuardDutyFindingsCommandOutput>;
  getFindings(
    input: GetGuardDutyFindingsCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<GetGuardDutyFindingsCommandOutput>;
}

export interface SecurityHubInventoryClient {
  describeHub(abortSignal?: AbortSignal): Promise<DescribeHubCommandOutput>;
  getFindings(
    input: GetSecurityHubFindingsCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<GetSecurityHubFindingsCommandOutput>;
}

export interface InspectorInventoryClient {
  batchGetAccountStatus(
    input: BatchGetAccountStatusCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<BatchGetAccountStatusCommandOutput>;
  listFindings(
    input: ListInspectorFindingsCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<ListInspectorFindingsCommandOutput>;
}

/**
 * Read-only SSM patch-compliance client. Only the three Describe APIs the
 * onboarding role grants are exposed; there is deliberately no SendCommand or
 * any write, so the collector can observe patch state but never patch a host.
 */
export interface SsmInventoryClient {
  describeInstanceInformation(
    input: DescribeInstanceInformationCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeInstanceInformationCommandOutput>;
  describeInstancePatchStates(
    input: DescribeInstancePatchStatesCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeInstancePatchStatesCommandOutput>;
  describeInstancePatches(
    input: DescribeInstancePatchesCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<DescribeInstancePatchesCommandOutput>;
}

/**
 * Read-only Amazon Bedrock control-plane posture. Prompt/response payloads,
 * denied-topic examples, regex patterns, blocked messages, and model invocation
 * log objects are deliberately outside this interface.
 */
export interface BedrockInventoryClient {
  listGuardrails(
    input: ListGuardrailsCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<ListGuardrailsCommandOutput>;
  getGuardrail(
    input: GetGuardrailCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<GetGuardrailCommandOutput>;
  getModelInvocationLoggingConfiguration(
    abortSignal?: AbortSignal,
  ): Promise<GetModelInvocationLoggingConfigurationCommandOutput>;
  getAccountDataRetention(
    abortSignal?: AbortSignal,
  ): Promise<GetAccountDataRetentionCommandOutput>;
}

export interface AwsInventoryClientFactory {
  ec2(region: string, credentials: AwsTemporaryCredentials): Ec2InventoryClient;
  elbv2(region: string, credentials: AwsTemporaryCredentials): Elbv2InventoryClient;
  kms(region: string, credentials: AwsTemporaryCredentials): KmsInventoryClient;
  dynamodb(region: string, credentials: AwsTemporaryCredentials): DynamoDbInventoryClient;
  ecr(region: string, credentials: AwsTemporaryCredentials): EcrInventoryClient;
  /** Optional only so existing isolated test factories remain source-compatible. */
  eks?(region: string, credentials: AwsTemporaryCredentials): EksInventoryClient;
  s3(region: string, credentials: AwsTemporaryCredentials): S3InventoryClient;
  rds(region: string, credentials: AwsTemporaryCredentials): RdsInventoryClient;
  iam(region: string, credentials: AwsTemporaryCredentials): IamInventoryClient;
  cloudTrail(
    region: string,
    credentials: AwsTemporaryCredentials,
  ): CloudTrailInventoryClient;
  guardDuty(
    region: string,
    credentials: AwsTemporaryCredentials,
  ): GuardDutyInventoryClient;
  securityHub(
    region: string,
    credentials: AwsTemporaryCredentials,
  ): SecurityHubInventoryClient;
  inspector(
    region: string,
    credentials: AwsTemporaryCredentials,
  ): InspectorInventoryClient;
  /** Optional only so existing isolated test factories remain source-compatible. */
  ssm?(region: string, credentials: AwsTemporaryCredentials): SsmInventoryClient;
  /** Optional so older custom factories fail closed as unassessed, not as clean. */
  bedrock?(region: string, credentials: AwsTemporaryCredentials): BedrockInventoryClient;
}

export interface AwsSdkInventoryClientFactoryOptions {
  readonly maxAttempts?: number;
}

export const AWS_INVENTORY_CONNECTION_TIMEOUT_MS = 5_000;
export const AWS_INVENTORY_REQUEST_TIMEOUT_MS = 10_000;

export interface AwsInventorySdkClientConfig {
  readonly region: string;
  readonly credentials: AwsTemporaryCredentials;
  readonly retryMode: "standard";
  readonly maxAttempts: number;
  readonly requestHandler: {
    readonly connectionTimeout: number;
    readonly requestTimeout: number;
  };
}

export function awsInventorySdkClientConfig(
  region: string,
  credentials: AwsTemporaryCredentials,
  maxAttempts: number,
): AwsInventorySdkClientConfig {
  return {
    region,
    credentials,
    retryMode: "standard",
    maxAttempts,
    requestHandler: {
      connectionTimeout: AWS_INVENTORY_CONNECTION_TIMEOUT_MS,
      requestTimeout: AWS_INVENTORY_REQUEST_TIMEOUT_MS,
    },
  };
}

function sendSdkCommand<Command, Output>(
  client: unknown,
  command: Command,
  abortSignal?: AbortSignal,
): Promise<Output> {
  const sender = client as {
    send(
      command: Command,
      options?: { readonly abortSignal?: AbortSignal },
    ): Promise<Output>;
  };
  return abortSignal === undefined
    ? sender.send(command)
    : sender.send(command, { abortSignal });
}

/** Real SDK v3 client factory. Every client uses bounded standard-mode retries. */
export class AwsSdkInventoryClientFactory implements AwsInventoryClientFactory {
  private readonly maxAttempts: number;

  public constructor(options: AwsSdkInventoryClientFactoryOptions = {}) {
    this.maxAttempts = validateMaxAttempts(options.maxAttempts ?? 4);
  }

  public ec2(region: string, credentials: AwsTemporaryCredentials): Ec2InventoryClient {
    const client = new EC2Client(this.clientConfig(region, credentials));
    return {
      describeInstances: (input, signal) => sendSdkCommand(client, new DescribeInstancesCommand(input), signal),
      describeVpcs: (input, signal) => sendSdkCommand(client, new DescribeVpcsCommand(input), signal),
      describeSubnets: (input, signal) => sendSdkCommand(client, new DescribeSubnetsCommand(input), signal),
      describeSecurityGroups: (input, signal) =>
        sendSdkCommand(client, new DescribeSecurityGroupsCommand(input), signal),
      describeVolumes: (input, signal) =>
        sendSdkCommand(client, new DescribeVolumesCommand(input), signal),
      describeNetworkInterfaces: (input, signal) =>
        sendSdkCommand(client, new DescribeNetworkInterfacesCommand(input), signal),
      describeRouteTables: (input, signal) =>
        sendSdkCommand(client, new DescribeRouteTablesCommand(input), signal),
      describeInternetGateways: (input, signal) =>
        sendSdkCommand(client, new DescribeInternetGatewaysCommand(input), signal),
      describeFlowLogs: (input, signal) =>
        sendSdkCommand(client, new DescribeFlowLogsCommand(input), signal),
      describeNetworkAcls: (input, signal) =>
        sendSdkCommand(client, new DescribeNetworkAclsCommand(input), signal),
      describeAddresses: (input, signal) =>
        sendSdkCommand(client, new DescribeAddressesCommand(input), signal),
      describeSnapshots: (input, signal) =>
        sendSdkCommand(client, new DescribeSnapshotsCommand(input), signal),
    };
  }

  public elbv2(region: string, credentials: AwsTemporaryCredentials): Elbv2InventoryClient {
    const client = new ElasticLoadBalancingV2Client(this.clientConfig(region, credentials));
    return {
      describeLoadBalancers: (input, signal) =>
        sendSdkCommand(client, new DescribeLoadBalancersCommand(input), signal),
      describeListeners: (input, signal) =>
        sendSdkCommand(client, new DescribeListenersCommand(input), signal),
      describeTargetGroups: (input, signal) =>
        sendSdkCommand(client, new DescribeTargetGroupsCommand(input), signal),
      describeTargetHealth: (input, signal) =>
        sendSdkCommand(client, new DescribeTargetHealthCommand(input), signal),
    };
  }

  public kms(region: string, credentials: AwsTemporaryCredentials): KmsInventoryClient {
    const client = new KMSClient(this.clientConfig(region, credentials));
    return {
      listKeys: (input, signal) => sendSdkCommand(client, new ListKeysCommand(input), signal),
      listAliases: (input, signal) => sendSdkCommand(client, new ListAliasesCommand(input), signal),
      describeKey: (input, signal) => sendSdkCommand(client, new DescribeKeyCommand(input), signal),
    };
  }

  public dynamodb(region: string, credentials: AwsTemporaryCredentials): DynamoDbInventoryClient {
    const client = new DynamoDBClient(this.clientConfig(region, credentials));
    return {
      listTables: (input, signal) => sendSdkCommand(client, new ListTablesCommand(input), signal),
      describeTable: (input, signal) => sendSdkCommand(client, new DescribeTableCommand(input), signal),
    };
  }

  public ecr(region: string, credentials: AwsTemporaryCredentials): EcrInventoryClient {
    const client = new ECRClient(this.clientConfig(region, credentials));
    return {
      describeRepositories: (input, signal) =>
        sendSdkCommand(client, new DescribeRepositoriesCommand(input), signal),
    };
  }

  public eks(region: string, credentials: AwsTemporaryCredentials): EksInventoryClient {
    const client = new EKSClient(this.clientConfig(region, credentials));
    return {
      listClusters: (input, signal) =>
        sendSdkCommand(client, new ListClustersCommand(input), signal),
      describeCluster: (input, signal) =>
        sendSdkCommand(client, new DescribeClusterCommand(input), signal),
    };
  }

  public s3(region: string, credentials: AwsTemporaryCredentials): S3InventoryClient {
    const client = new S3Client(this.clientConfig(region, credentials));
    return {
      listBuckets: (input, signal) => sendSdkCommand(client, new ListBucketsCommand(input), signal),
      getPublicAccessBlock: (input, signal) =>
        sendSdkCommand(client, new GetPublicAccessBlockCommand(input), signal),
    };
  }

  public rds(region: string, credentials: AwsTemporaryCredentials): RdsInventoryClient {
    const client = new RDSClient(this.clientConfig(region, credentials));
    return {
      describeDBInstances: (input, signal) =>
        sendSdkCommand(client, new DescribeDBInstancesCommand(input), signal),
    };
  }

  public iam(region: string, credentials: AwsTemporaryCredentials): IamInventoryClient {
    const client = new IAMClient(this.clientConfig(region, credentials));
    return {
      getAccountSummary: (signal) => sendSdkCommand(client, new GetAccountSummaryCommand({}), signal),
      getAccountPasswordPolicy: (signal) =>
        sendSdkCommand(client, new GetAccountPasswordPolicyCommand({}), signal),
    };
  }

  public cloudTrail(
    region: string,
    credentials: AwsTemporaryCredentials,
  ): CloudTrailInventoryClient {
    const client = new CloudTrailClient(this.clientConfig(region, credentials));
    return {
      describeTrails: (input, signal) => sendSdkCommand(client, new DescribeTrailsCommand(input), signal),
      getTrailStatus: (input, signal) => sendSdkCommand(client, new GetTrailStatusCommand(input), signal),
    };
  }

  public guardDuty(
    region: string,
    credentials: AwsTemporaryCredentials,
  ): GuardDutyInventoryClient {
    const client = new GuardDutyClient(this.clientConfig(region, credentials));
    return {
      listDetectors: (input, signal) => sendSdkCommand(client, new ListDetectorsCommand(input), signal),
      getDetector: (input, signal) => sendSdkCommand(client, new GetDetectorCommand(input), signal),
      listFindings: (input, signal) =>
        sendSdkCommand(client, new ListGuardDutyFindingsCommand(input), signal),
      getFindings: (input, signal) => sendSdkCommand(client, new GetGuardDutyFindingsCommand(input), signal),
    };
  }

  public securityHub(
    region: string,
    credentials: AwsTemporaryCredentials,
  ): SecurityHubInventoryClient {
    const client = new SecurityHubClient(this.clientConfig(region, credentials));
    return {
      describeHub: (signal) => sendSdkCommand(client, new DescribeHubCommand({}), signal),
      getFindings: (input, signal) =>
        sendSdkCommand(client, new GetSecurityHubFindingsCommand(input), signal),
    };
  }

  public inspector(
    region: string,
    credentials: AwsTemporaryCredentials,
  ): InspectorInventoryClient {
    const client = new Inspector2Client(this.clientConfig(region, credentials));
    return {
      batchGetAccountStatus: (input, signal) =>
        sendSdkCommand(client, new BatchGetAccountStatusCommand(input), signal),
      listFindings: (input, signal) => sendSdkCommand(client, new ListInspectorFindingsCommand(input), signal),
    };
  }

  public ssm(region: string, credentials: AwsTemporaryCredentials): SsmInventoryClient {
    const client = new SSMClient(this.clientConfig(region, credentials));
    return {
      describeInstanceInformation: (input, signal) =>
        sendSdkCommand(client, new DescribeInstanceInformationCommand(input), signal),
      describeInstancePatchStates: (input, signal) =>
        sendSdkCommand(client, new DescribeInstancePatchStatesCommand(input), signal),
      describeInstancePatches: (input, signal) =>
        sendSdkCommand(client, new DescribeInstancePatchesCommand(input), signal),
    };
  }

  public bedrock(region: string, credentials: AwsTemporaryCredentials): BedrockInventoryClient {
    const client = new BedrockClient(this.clientConfig(region, credentials));
    return {
      listGuardrails: (input, signal) =>
        sendSdkCommand(client, new ListGuardrailsCommand(input), signal),
      getGuardrail: (input, signal) =>
        sendSdkCommand(client, new GetGuardrailCommand(input), signal),
      getModelInvocationLoggingConfiguration: (signal) =>
        sendSdkCommand(client, new GetModelInvocationLoggingConfigurationCommand({}), signal),
      getAccountDataRetention: (signal) =>
        sendSdkCommand(client, new GetAccountDataRetentionCommand({}), signal),
    };
  }

  private clientConfig(region: string, credentials: AwsTemporaryCredentials) {
    return awsInventorySdkClientConfig(region, credentials, this.maxAttempts);
  }
}

class DeadlineAwsInventoryClientFactory implements AwsInventoryClientFactory {
  public readonly eks?: (
    region: string,
    credentials: AwsTemporaryCredentials,
  ) => EksInventoryClient;

  public readonly ssm?: (
    region: string,
    credentials: AwsTemporaryCredentials,
  ) => SsmInventoryClient;

  public readonly bedrock?: (
    region: string,
    credentials: AwsTemporaryCredentials,
  ) => BedrockInventoryClient;

  public constructor(
    private readonly delegate: AwsInventoryClientFactory,
    private readonly overallSignal: AbortSignal,
    private readonly commandDeadlineMs: number,
  ) {
    if (delegate.eks !== undefined) {
      this.eks = (region, credentials) => {
        const client = delegate.eks?.(region, credentials);
        if (client === undefined) {
          throw new InventoryConfigurationError("The EKS inventory client is unavailable");
        }
        return {
          listClusters: (input) => this.run((signal) => client.listClusters(input, signal)),
          describeCluster: (input) => this.run((signal) => client.describeCluster(input, signal)),
        };
      };
    }
    if (delegate.ssm !== undefined) {
      this.ssm = (region, credentials) => {
        const client = delegate.ssm?.(region, credentials);
        if (client === undefined) {
          throw new InventoryConfigurationError("The SSM inventory client is unavailable");
        }
        return {
          describeInstanceInformation: (input) =>
            this.run((signal) => client.describeInstanceInformation(input, signal)),
          describeInstancePatchStates: (input) =>
            this.run((signal) => client.describeInstancePatchStates(input, signal)),
          describeInstancePatches: (input) =>
            this.run((signal) => client.describeInstancePatches(input, signal)),
        };
      };
    }
    if (delegate.bedrock !== undefined) {
      this.bedrock = (region, credentials) => {
        const client = delegate.bedrock?.(region, credentials);
        if (client === undefined) {
          throw new InventoryConfigurationError("The Bedrock inventory client is unavailable");
        }
        return {
          listGuardrails: (input) => this.run((signal) => client.listGuardrails(input, signal)),
          getGuardrail: (input) => this.run((signal) => client.getGuardrail(input, signal)),
          getModelInvocationLoggingConfiguration: () =>
            this.run((signal) => client.getModelInvocationLoggingConfiguration(signal)),
          getAccountDataRetention: () =>
            this.run((signal) => client.getAccountDataRetention(signal)),
        };
      };
    }
  }

  public ec2(region: string, credentials: AwsTemporaryCredentials): Ec2InventoryClient {
    const client = this.delegate.ec2(region, credentials);
    const describeFlowLogs = client.describeFlowLogs;
    const describeAddresses = client.describeAddresses;
    const describeSnapshots = client.describeSnapshots;
    return {
      describeInstances: (input) => this.run((signal) => client.describeInstances(input, signal)),
      describeVpcs: (input) => this.run((signal) => client.describeVpcs(input, signal)),
      describeSubnets: (input) => this.run((signal) => client.describeSubnets(input, signal)),
      describeSecurityGroups: (input) =>
        this.run((signal) => client.describeSecurityGroups(input, signal)),
      describeVolumes: (input) => this.run((signal) => client.describeVolumes(input, signal)),
      describeNetworkInterfaces: (input) =>
        this.run((signal) => client.describeNetworkInterfaces(input, signal)),
      describeRouteTables: (input) => this.run((signal) => client.describeRouteTables(input, signal)),
      describeInternetGateways: (input) =>
        this.run((signal) => client.describeInternetGateways(input, signal)),
      describeNetworkAcls: (input) => this.run((signal) => client.describeNetworkAcls(input, signal)),
      // Forwarded only when the delegate provides them, so pre-existing test
      // factories that omit these optional read-only cost collectors stay intact.
      ...(describeFlowLogs === undefined
        ? {}
        : { describeFlowLogs: (input) => this.run((signal) => describeFlowLogs(input, signal)) }),
      ...(describeAddresses === undefined
        ? {}
        : { describeAddresses: (input) => this.run((signal) => describeAddresses(input, signal)) }),
      ...(describeSnapshots === undefined
        ? {}
        : { describeSnapshots: (input) => this.run((signal) => describeSnapshots(input, signal)) }),
    };
  }

  public elbv2(region: string, credentials: AwsTemporaryCredentials): Elbv2InventoryClient {
    const client = this.delegate.elbv2(region, credentials);
    return {
      describeLoadBalancers: (input) =>
        this.run((signal) => client.describeLoadBalancers(input, signal)),
      describeListeners: (input) => this.run((signal) => client.describeListeners(input, signal)),
      describeTargetGroups: (input) => this.run((signal) => client.describeTargetGroups(input, signal)),
      describeTargetHealth: (input) => this.run((signal) => client.describeTargetHealth(input, signal)),
    };
  }

  public kms(region: string, credentials: AwsTemporaryCredentials): KmsInventoryClient {
    const client = this.delegate.kms(region, credentials);
    return {
      listKeys: (input) => this.run((signal) => client.listKeys(input, signal)),
      listAliases: (input) => this.run((signal) => client.listAliases(input, signal)),
      describeKey: (input) => this.run((signal) => client.describeKey(input, signal)),
    };
  }

  public dynamodb(region: string, credentials: AwsTemporaryCredentials): DynamoDbInventoryClient {
    const client = this.delegate.dynamodb(region, credentials);
    return {
      listTables: (input) => this.run((signal) => client.listTables(input, signal)),
      describeTable: (input) => this.run((signal) => client.describeTable(input, signal)),
    };
  }

  public ecr(region: string, credentials: AwsTemporaryCredentials): EcrInventoryClient {
    const client = this.delegate.ecr(region, credentials);
    return {
      describeRepositories: (input) =>
        this.run((signal) => client.describeRepositories(input, signal)),
    };
  }

  public s3(region: string, credentials: AwsTemporaryCredentials): S3InventoryClient {
    const client = this.delegate.s3(region, credentials);
    return {
      listBuckets: (input) => this.run((signal) => client.listBuckets(input, signal)),
      getPublicAccessBlock: (input) =>
        this.run((signal) => client.getPublicAccessBlock(input, signal)),
    };
  }

  public rds(region: string, credentials: AwsTemporaryCredentials): RdsInventoryClient {
    const client = this.delegate.rds(region, credentials);
    return {
      describeDBInstances: (input) =>
        this.run((signal) => client.describeDBInstances(input, signal)),
    };
  }

  public iam(region: string, credentials: AwsTemporaryCredentials): IamInventoryClient {
    const client = this.delegate.iam(region, credentials);
    return {
      getAccountSummary: () => this.run((signal) => client.getAccountSummary(signal)),
      getAccountPasswordPolicy: () =>
        this.run((signal) => client.getAccountPasswordPolicy(signal)),
    };
  }

  public cloudTrail(
    region: string,
    credentials: AwsTemporaryCredentials,
  ): CloudTrailInventoryClient {
    const client = this.delegate.cloudTrail(region, credentials);
    return {
      describeTrails: (input) => this.run((signal) => client.describeTrails(input, signal)),
      getTrailStatus: (input) => this.run((signal) => client.getTrailStatus(input, signal)),
    };
  }

  public guardDuty(
    region: string,
    credentials: AwsTemporaryCredentials,
  ): GuardDutyInventoryClient {
    const client = this.delegate.guardDuty(region, credentials);
    return {
      listDetectors: (input) => this.run((signal) => client.listDetectors(input, signal)),
      getDetector: (input) => this.run((signal) => client.getDetector(input, signal)),
      listFindings: (input) => this.run((signal) => client.listFindings(input, signal)),
      getFindings: (input) => this.run((signal) => client.getFindings(input, signal)),
    };
  }

  public securityHub(
    region: string,
    credentials: AwsTemporaryCredentials,
  ): SecurityHubInventoryClient {
    const client = this.delegate.securityHub(region, credentials);
    return {
      describeHub: () => this.run((signal) => client.describeHub(signal)),
      getFindings: (input) => this.run((signal) => client.getFindings(input, signal)),
    };
  }

  public inspector(
    region: string,
    credentials: AwsTemporaryCredentials,
  ): InspectorInventoryClient {
    const client = this.delegate.inspector(region, credentials);
    return {
      batchGetAccountStatus: (input) =>
        this.run((signal) => client.batchGetAccountStatus(input, signal)),
      listFindings: (input) => this.run((signal) => client.listFindings(input, signal)),
    };
  }

  private run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return runWithCommandDeadline(
      this.overallSignal,
      this.commandDeadlineMs,
      operation,
    );
  }
}

export interface SingleAccountAwsInventoryRunnerDependencies {
  readonly clients: AwsInventoryClientFactory;
  readonly sink: AwsInventorySink;
  readonly regionSelector: InventoryRegionSelector;
  readonly globalControlRegion?: string;
  readonly maxConcurrency?: number;
  readonly commandDeadlineMs?: number;
  readonly collectionDeadlineMs?: number;
  readonly now?: () => Date;
}

interface CollectionTask {
  readonly collectorKey: string;
  readonly service: string;
  readonly subject: string;
  readonly region: string;
  run(state: TaskCollectionState): Promise<void>;
}

/**
 * Single-account collector. It persists normalized batches to a sink and returns
 * only counts/coverage to the public job handler.
 */
export class SingleAccountAwsInventoryRunner implements InventoryRunner {
  private readonly maxConcurrency: number;
  private readonly commandDeadlineMs: number;
  private readonly collectionDeadlineMs: number;
  private readonly now: () => Date;

  public constructor(
    private readonly dependencies: SingleAccountAwsInventoryRunnerDependencies,
  ) {
    this.maxConcurrency = validateConcurrency(dependencies.maxConcurrency ?? 4);
    this.commandDeadlineMs = validateDeadline(
      dependencies.commandDeadlineMs ?? LIVE_AWS_COMMAND_DEADLINE_MS,
      "AWS command deadline",
    );
    this.collectionDeadlineMs = validateDeadline(
      dependencies.collectionDeadlineMs ?? LIVE_AWS_COLLECTION_DEADLINE_MS,
      "AWS collection deadline",
    );
    if (this.collectionDeadlineMs <= this.commandDeadlineMs) {
      throw new InventoryConfigurationError(
        "The AWS collection deadline must exceed the per-command deadline",
      );
    }
    this.now = dependencies.now ?? (() => new Date());
  }

  public async collect(
    context: InventoryCollectionContext,
  ): Promise<InventoryCollectionResult> {
    const overallController = new AbortController();
    const overallDeadline = new InventoryDeadlineError("collection");
    const collectionDeadlineAt = Date.now() + this.collectionDeadlineMs;
    const overallTimer = setTimeout(
      () => overallController.abort(overallDeadline),
      this.collectionDeadlineMs,
    );
    try {
      const selectionContext = {
        tenantId: context.tenantId,
        connectionId: context.connectionId,
        accountId: context.accountId,
        partition: context.partition,
        credentials: context.credentials,
      };
      const regions = normalizeRegions(
        await runWithCommandDeadline(
          overallController.signal,
          this.commandDeadlineMs,
          (signal) => this.dependencies.regionSelector.selectRegions(selectionContext, signal),
        ),
      );
      const controlRegion = this.dependencies.globalControlRegion ?? regions[0];
      if (controlRegion === undefined || !REGION.test(controlRegion)) {
        throw new InventoryConfigurationError("A valid global control Region is required");
      }

      const observedAt = this.now().toISOString();
      const state = new BatchState(this.dependencies.sink);
      const clients = new DeadlineAwsInventoryClientFactory(
        this.dependencies.clients,
        overallController.signal,
        this.commandDeadlineMs,
      );
      const tasks = this.buildTasks(context, regions, controlRegion, observedAt, clients);
      const collectorCoverage = new Array<InventoryCollectorCoverage>(tasks.length);

      await runBounded(tasks.map((value, index) => ({ value, index })), this.maxConcurrency, async ({ value: task, index }) => {
        let taskState = new TaskCollectionState(state, task);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await task.run(taskState);
            collectorCoverage[index] = taskState.finish();
            return;
          } catch (error: unknown) {
            if (error instanceof InventorySinkWriteError) {
              throw error;
            }
            if (attempt === 0 && taskState.canRetry(error)) {
              taskState = new TaskCollectionState(state, task);
              continue;
            }
            await state.emit({
              resources: [],
              evidence: [
                evidence(
                  context,
                  observedAt,
                  task.region,
                  task.service,
                  "COLLECTION_ERROR",
                  task.subject,
                  "ERROR",
                  { errorName: safeErrorName(error) },
                ),
              ],
            });
            collectorCoverage[index] = taskState.finish(error);
            return;
          }
        }
      });

      if (overallController.signal.aborted || Date.now() >= collectionDeadlineAt) {
        collectorCoverage.push({
          collectorKey: "sutra.collection-deadline",
          region: "global",
          status: "PARTIAL",
          itemsObserved: 0,
          pagesObserved: 0,
          errorCode: "COLLECTION_TIMEOUT",
          message: "The bounded AWS collection reached its overall deadline.",
        });
      }

      const partial = collectorCoverage.some((entry) => entry.status !== "SUCCEEDED");

      return {
        resourcesObserved: state.resourcesObserved,
        findingsObserved: state.evidenceObserved,
        coverage: partial ? "PARTIAL" : "COMPLETE",
        collectorCoverage,
      };
    } finally {
      clearTimeout(overallTimer);
    }
  }

  private buildTasks(
    context: InventoryCollectionContext,
    regions: readonly string[],
    controlRegion: string,
    observedAt: string,
    clients: AwsInventoryClientFactory,
  ): CollectionTask[] {
    const credentials = context.credentials;
    const tasks: CollectionTask[] = [];
    const iam = clients.iam(controlRegion, credentials);
    const collectCloudTrailRegion = createCloudTrailCollector(
      context,
      observedAt,
      clients,
    );
    tasks.push(
      task("iam.account", "iam", "account-summary", "global", (state) =>
        collectIamSummary(context, iam, observedAt, state),
      ),
      task("iam.password-policy", "iam", "password-policy", "global", (state) =>
        collectIamPasswordPolicy(context, iam, observedAt, state),
      ),
    );

    for (const region of regions) {
      const ec2 = clients.ec2(region, credentials);
      const rds = clients.rds(region, credentials);
      const cloudTrail = clients.cloudTrail(region, credentials);
      const guardDuty = clients.guardDuty(region, credentials);
      const securityHub = clients.securityHub(region, credentials);
      const inspector = clients.inspector(region, credentials);
      const s3 = clients.s3(region, credentials);
      const elbv2 = clients.elbv2(region, credentials);
      const kms = clients.kms(region, credentials);
      const dynamodb = clients.dynamodb(region, credentials);
      const ecr = clients.ecr(region, credentials);
      const eks = clients.eks?.(region, credentials);
      const ssm = clients.ssm?.(region, credentials);
      const bedrock = clients.bedrock?.(region, credentials);

      tasks.push(
        task("s3.buckets", "s3", "buckets", region, (state) =>
          collectS3(context, region, s3, observedAt, state),
        ),
        task("ec2.instances", "ec2", "instances", region, (state) =>
          collectEc2Instances(context, region, ec2, observedAt, state),
        ),
        task("ec2.vpcs", "ec2", "vpcs", region, (state) =>
          collectVpcs(context, region, ec2, observedAt, state),
        ),
        task("ec2.subnets", "ec2", "subnets", region, (state) =>
          collectSubnets(context, region, ec2, observedAt, state),
        ),
        task("ec2.security-groups", "ec2", "security-groups", region, (state) =>
          collectSecurityGroups(context, region, ec2, observedAt, state),
        ),
        task("ec2.volumes", "ec2", "volumes", region, (state) =>
          collectVolumes(context, region, ec2, observedAt, state),
        ),
        task("ec2.network-interfaces", "ec2", "network-interfaces", region, (state) =>
          collectNetworkInterfaces(context, region, ec2, observedAt, state),
        ),
        task("ec2.route-tables", "ec2", "route-tables", region, (state) =>
          collectRouteTables(context, region, ec2, observedAt, state),
        ),
        task("ec2.internet-gateways", "ec2", "internet-gateways", region, (state) =>
          collectInternetGateways(context, region, ec2, observedAt, state),
        ),
        task("ec2.network-acls", "ec2", "network-acls", region, (state) =>
          collectNetworkAcls(context, region, ec2, observedAt, state),
        ),
        // Flow-log configuration. Optional on the client for the same reason as
        // describeAddresses below: making it required would break every existing
        // test factory, and a factory that omits it simply collects no flow logs,
        // which the coverage engine reports as absent rather than as "no gaps".
        ...(ec2.describeFlowLogs === undefined ? [] : [
          task("ec2.flow-logs", "ec2", "flow-logs", region, (state) =>
            collectFlowLogs(context, region, ec2, observedAt, state),
          ),
        ]),
        // Read-only cost-waste evidence. Registered only when the ec2 client
        // exposes the (optional) call, mirroring the optional `eks` collector so
        // pre-existing test factories are unaffected.
        ...(ec2.describeAddresses === undefined ? [] : [
          task("ec2.elastic-ips", "ec2", "elastic-ips", region, (state) =>
            collectElasticIps(context, region, ec2, observedAt, state),
          ),
        ]),
        ...(ec2.describeSnapshots === undefined ? [] : [
          task("ec2.snapshots", "ec2", "snapshots", region, (state) =>
            collectSnapshots(context, region, ec2, observedAt, state),
          ),
        ]),
        task("elbv2.load-balancers", "elasticloadbalancing", "load-balancers", region, (state) =>
          collectLoadBalancers(context, region, elbv2, observedAt, state),
        ),
        task("elbv2.target-groups", "elasticloadbalancing", "target-groups", region, (state) =>
          collectTargetGroups(context, region, elbv2, observedAt, state),
        ),
        task("kms.keys", "kms", "keys", region, (state) =>
          collectKmsKeys(context, region, kms, observedAt, state),
        ),
        task("dynamodb.tables", "dynamodb", "tables", region, (state) =>
          collectDynamoDbTables(context, region, dynamodb, observedAt, state),
        ),
        task("ecr.repositories", "ecr", "repositories", region, (state) =>
          collectEcrRepositories(context, region, ecr, observedAt, state),
        ),
        ...(eks === undefined ? [] : [
          task("eks.clusters", "eks", "clusters", region, (state) =>
            collectEksClusters(context, region, eks, observedAt, state),
          ),
        ]),
        // Read-only patch-compliance posture. Registered only when the ssm client
        // is available (mirrors the optional eks collector), so pre-existing test
        // factories are unaffected. Its own coverage row means an SSM denial or
        // outage is disclosed as an unassessed collector, never silently folded
        // into EC2 inventory.
        ...(ssm === undefined ? [] : [
          task("ssm.patch-states", "ssm", "patch-states", region, (state) =>
            collectSsmPatchStates(context, region, ssm, observedAt, state),
          ),
        ]),
        ...(bedrock === undefined ? [] : [
          task("bedrock.guardrails", "bedrock", "guardrails", region, (state) =>
            collectBedrockGuardrails(context, region, bedrock, observedAt, state),
          ),
          task("bedrock.account-posture", "bedrock", "account-posture", region, (state) =>
            collectBedrockAccountPosture(context, region, bedrock, observedAt, state),
          ),
        ]),
        task("rds.db-instances", "rds", "db-instances", region, (state) =>
          collectRds(context, region, rds, observedAt, state),
        ),
        task("cloudtrail.trails", "cloudtrail", "trails", region, (state) =>
          collectCloudTrailRegion(region, cloudTrail, state),
        ),
        task("guardduty.detectors", "guardduty", "detectors", region, (state) =>
          collectGuardDuty(context, region, guardDuty, observedAt, state),
        ),
        task("guardduty.findings", "guardduty", "aws-native-findings", region, (state) =>
          collectGuardDutyFindings(context, region, guardDuty, observedAt, state),
        ),
        task("securityhub.hub", "securityhub", "hub", region, (state) =>
          collectSecurityHub(context, region, securityHub, observedAt, state),
        ),
        task("securityhub.findings", "securityhub", "aws-native-findings", region, (state) =>
          collectSecurityHubFindings(context, region, securityHub, observedAt, state),
        ),
        task("inspector2.findings", "inspector2", "aws-native-findings", region, (state) =>
          collectInspectorFindings(context, region, inspector, observedAt, state),
        ),
      );
    }
    return tasks;
  }
}

async function collectEc2Instances(
  context: InventoryCollectionContext,
  region: string,
  client: Ec2InventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  let token: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.describeInstances(
      token === undefined ? { MaxResults: 1000 } : { MaxResults: 1000, NextToken: token },
    );
    const resources: NormalizedAwsResource[] = [];
    for (const reservation of output.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        if (instance.InstanceId === undefined) continue;
        resources.push(
          resource(
            context,
            observedAt,
            region,
            "ec2",
            "aws.ec2.instance",
            instance.InstanceId,
            `arn:${context.partition}:ec2:${region}:${context.accountId}:instance/${instance.InstanceId}`,
            compact({
              state: instance.State?.Name,
              instanceType: instance.InstanceType,
              architecture: instance.Architecture,
              platformDetails: instance.PlatformDetails,
              launchTime: iso(instance.LaunchTime),
              vpcId: instance.VpcId,
              subnetId: instance.SubnetId,
              privateIpAddress: instance.PrivateIpAddress,
              publicIpAddress: instance.PublicIpAddress,
              iamInstanceProfileArn: instance.IamInstanceProfile?.Arn,
              metadataHttpTokens: instance.MetadataOptions?.HttpTokens,
              securityGroupIds: strings(
                (instance.SecurityGroups ?? []).map((group) => group.GroupId),
              ),
            }),
            instance.Tags,
          ),
        );
      }
    }
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    token = nextToken(output.NextToken, seen, "EC2 DescribeInstances");
    if (token === undefined) return;
  }
  throw new InventoryProtocolError("EC2 DescribeInstances exceeded pagination limit");
}

async function collectVpcs(
  context: InventoryCollectionContext,
  region: string,
  client: Ec2InventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  let token: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.describeVpcs(
      token === undefined ? { MaxResults: 1000 } : { MaxResults: 1000, NextToken: token },
    );
    const resources = (output.Vpcs ?? []).flatMap((vpc) =>
      vpc.VpcId === undefined
        ? []
        : [
            resource(
              context,
              observedAt,
              region,
              "ec2",
              "aws.ec2.vpc",
              vpc.VpcId,
              `arn:${context.partition}:ec2:${region}:${context.accountId}:vpc/${vpc.VpcId}`,
              compact({
                state: vpc.State,
                cidrBlock: vpc.CidrBlock,
                isDefault: vpc.IsDefault,
                dhcpOptionsId: vpc.DhcpOptionsId,
                ipv6CidrBlocks: strings(
                  (vpc.Ipv6CidrBlockAssociationSet ?? []).map(
                    (association) => association.Ipv6CidrBlock,
                  ),
                ),
              }),
              vpc.Tags,
            ),
          ],
    );
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    token = nextToken(output.NextToken, seen, "EC2 DescribeVpcs");
    if (token === undefined) return;
  }
  throw new InventoryProtocolError("EC2 DescribeVpcs exceeded pagination limit");
}

async function collectSubnets(
  context: InventoryCollectionContext,
  region: string,
  client: Ec2InventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  let token: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.describeSubnets(
      token === undefined ? { MaxResults: 1000 } : { MaxResults: 1000, NextToken: token },
    );
    const resources = (output.Subnets ?? []).flatMap((subnet) =>
      subnet.SubnetId === undefined
        ? []
        : [
            resource(
              context,
              observedAt,
              region,
              "ec2",
              "aws.ec2.subnet",
              subnet.SubnetId,
              `arn:${context.partition}:ec2:${region}:${context.accountId}:subnet/${subnet.SubnetId}`,
              compact({
                state: subnet.State,
                vpcId: subnet.VpcId,
                cidrBlock: subnet.CidrBlock,
                ipv6Native: subnet.Ipv6Native,
                availabilityZone: subnet.AvailabilityZone,
                availabilityZoneId: subnet.AvailabilityZoneId,
                mapPublicIpOnLaunch: subnet.MapPublicIpOnLaunch,
                availableIpAddressCount: subnet.AvailableIpAddressCount,
              }),
              subnet.Tags,
            ),
          ],
    );
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    token = nextToken(output.NextToken, seen, "EC2 DescribeSubnets");
    if (token === undefined) return;
  }
  throw new InventoryProtocolError("EC2 DescribeSubnets exceeded pagination limit");
}

async function collectSecurityGroups(
  context: InventoryCollectionContext,
  region: string,
  client: Ec2InventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  let token: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.describeSecurityGroups(
      token === undefined ? { MaxResults: 1000 } : { MaxResults: 1000, NextToken: token },
    );
    const resources = (output.SecurityGroups ?? []).flatMap((group) =>
      group.GroupId === undefined
        ? []
        : [
            resource(
              context,
              observedAt,
              region,
              "ec2",
              "aws.ec2.security-group",
              group.GroupId,
              `arn:${context.partition}:ec2:${region}:${context.accountId}:security-group/${group.GroupId}`,
              compact({
                groupName: group.GroupName,
                vpcId: group.VpcId,
                ingress: (group.IpPermissions ?? []).map(normalizeIpPermission),
                egress: (group.IpPermissionsEgress ?? []).map(normalizeIpPermission),
              }),
              group.Tags,
            ),
          ],
    );
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    token = nextToken(output.NextToken, seen, "EC2 DescribeSecurityGroups");
    if (token === undefined) return;
  }
  throw new InventoryProtocolError("EC2 DescribeSecurityGroups exceeded pagination limit");
}

async function collectVolumes(
  context: InventoryCollectionContext,
  region: string,
  client: Ec2InventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  let token: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.describeVolumes(
      token === undefined ? { MaxResults: 500 } : { MaxResults: 500, NextToken: token },
    );
    const resources = (output.Volumes ?? []).flatMap((volume) =>
      volume.VolumeId === undefined
        ? []
        : [resourceFromApi(
            context,
            observedAt,
            region,
            "ec2",
            "aws.ec2.volume",
            volume.VolumeId,
            `arn:${context.partition}:ec2:${region}:${context.accountId}:volume/${volume.VolumeId}`,
            "ec2:DescribeVolumes",
            compact({
              state: volume.State,
              volumeType: volume.VolumeType,
              sizeGiB: volume.Size,
              iops: volume.Iops,
              throughput: volume.Throughput,
              encrypted: volume.Encrypted,
              kmsKeyId: volume.KmsKeyId,
              availabilityZone: volume.AvailabilityZone,
              multiAttachEnabled: volume.MultiAttachEnabled,
              instanceIds: strings((volume.Attachments ?? []).map((attachment) => attachment.InstanceId)),
              attachments: (volume.Attachments ?? []).flatMap((attachment) =>
                attachment.InstanceId === undefined
                  ? []
                  : [compact({
                      instanceId: attachment.InstanceId,
                      device: attachment.Device,
                      state: attachment.State,
                      attachTime: iso(attachment.AttachTime),
                      deleteOnTermination: attachment.DeleteOnTermination,
                    })],
              ),
            }),
            volume.Tags,
          )],
    );
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    token = nextToken(output.NextToken, seen, "EC2 DescribeVolumes");
    if (token === undefined) return;
  }
  throw new InventoryProtocolError("EC2 DescribeVolumes exceeded pagination limit");
}

async function collectNetworkInterfaces(
  context: InventoryCollectionContext,
  region: string,
  client: Ec2InventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  let token: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.describeNetworkInterfaces(
      token === undefined ? { MaxResults: 1000 } : { MaxResults: 1000, NextToken: token },
    );
    const resources = (output.NetworkInterfaces ?? []).flatMap((networkInterface) =>
      networkInterface.NetworkInterfaceId === undefined
        ? []
        : [resourceFromApi(
            context,
            observedAt,
            region,
            "ec2",
            "aws.ec2.network-interface",
            networkInterface.NetworkInterfaceId,
            `arn:${context.partition}:ec2:${region}:${context.accountId}:network-interface/${networkInterface.NetworkInterfaceId}`,
            "ec2:DescribeNetworkInterfaces",
            compact({
              status: networkInterface.Status,
              interfaceType: networkInterface.InterfaceType,
              vpcId: networkInterface.VpcId,
              subnetId: networkInterface.SubnetId,
              availabilityZone: networkInterface.AvailabilityZone,
              privateIpAddress: networkInterface.PrivateIpAddress,
              privateIpAddresses: strings(
                (networkInterface.PrivateIpAddresses ?? []).map((address) => address.PrivateIpAddress),
              ),
              publicIpAddress: networkInterface.Association?.PublicIp,
              securityGroupIds: strings((networkInterface.Groups ?? []).map((group) => group.GroupId)),
              instanceId: networkInterface.Attachment?.InstanceId,
              attachmentStatus: networkInterface.Attachment?.Status,
              sourceDestCheck: networkInterface.SourceDestCheck,
              requesterManaged: networkInterface.RequesterManaged,
            }),
            networkInterface.TagSet,
          )],
    );
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    token = nextToken(output.NextToken, seen, "EC2 DescribeNetworkInterfaces");
    if (token === undefined) return;
  }
  throw new InventoryProtocolError("EC2 DescribeNetworkInterfaces exceeded pagination limit");
}

interface RouteEndpoint {
  readonly value: string;
  readonly type: string;
}

function routeDestination(route: Route): RouteEndpoint | null {
  if (route.DestinationCidrBlock !== undefined) {
    return { value: route.DestinationCidrBlock, type: "ipv4_cidr" };
  }
  if (route.DestinationIpv6CidrBlock !== undefined) {
    return { value: route.DestinationIpv6CidrBlock, type: "ipv6_cidr" };
  }
  if (route.DestinationPrefixListId !== undefined) {
    return { value: route.DestinationPrefixListId, type: "prefix_list" };
  }
  return null;
}

function routeTarget(route: Route): RouteEndpoint | null {
  const candidates: readonly (readonly [string | undefined, string])[] = [
    [route.EgressOnlyInternetGatewayId, "egress_only_internet_gateway"],
    [route.GatewayId, "gateway"],
    [route.InstanceId, "instance"],
    [route.NatGatewayId, "nat_gateway"],
    [route.TransitGatewayId, "transit_gateway"],
    [route.LocalGatewayId, "local_gateway"],
    [route.CarrierGatewayId, "carrier_gateway"],
    [route.NetworkInterfaceId, "network_interface"],
    [route.VpcPeeringConnectionId, "vpc_peering_connection"],
    [route.CoreNetworkArn, "core_network"],
    [route.OdbNetworkArn, "odb_network"],
    [route.IpAddress, "ip_address"],
  ];
  for (const [value, type] of candidates) {
    if (value !== undefined) return { value, type };
  }
  return null;
}

async function collectRouteTables(
  context: InventoryCollectionContext,
  region: string,
  client: Ec2InventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  let token: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.describeRouteTables(
      token === undefined ? { MaxResults: 100 } : { MaxResults: 100, NextToken: token },
    );
    const resources = (output.RouteTables ?? []).flatMap((routeTable) => {
      if (routeTable.RouteTableId === undefined) return [];
      const associations = routeTable.Associations ?? [];
      const routes = routeTable.Routes ?? [];
      // "main" route table when any association is flagged main. A route to an
      // internet gateway makes the associated subnets a public egress path — a
      // fact aws-network-exposure consumes; we record it, never infer beyond it.
      const routesToIgw = routes.some((route) => (route.GatewayId ?? "").startsWith("igw-"));
      const routesToNat = routes.some((route) => route.NatGatewayId !== undefined);
      const parent = resourceFromApi(
        context,
        observedAt,
        region,
        "ec2",
        "aws.ec2.route-table",
        routeTable.RouteTableId,
        `arn:${context.partition}:ec2:${region}:${context.accountId}:route-table/${routeTable.RouteTableId}`,
        "ec2:DescribeRouteTables",
        compact({
          vpcId: routeTable.VpcId,
          main: associations.some((association) => association.Main === true),
          routeCount: routes.length,
          associationCount: associations.length,
          associatedSubnetIds: strings(associations.map((association) => association.SubnetId)),
          routesToInternetGateway: routesToIgw,
          routesToNatGateway: routesToNat,
          // Raw route entries (destination -> target) so downstream reachability
          // analysis can confirm an exact internet-gateway hop, not just a flag.
          routes: routes.map((route) => compact({
            destination: routeDestination(route)?.value,
            destinationType: routeDestination(route)?.type,
            target: routeTarget(route)?.value,
            targetType: routeTarget(route)?.type,
            state: route.State,
            origin: route.Origin,
          })),
          propagatingVgws: strings((routeTable.PropagatingVgws ?? []).map((vgw) => vgw.GatewayId)),
        }),
        routeTable.Tags,
      );
      const associationResources = associations.flatMap((association) =>
        association.RouteTableAssociationId === undefined
          ? []
          : [resourceFromApi(
              context,
              observedAt,
              region,
              "ec2",
              "aws.ec2.route-table-association",
              association.RouteTableAssociationId,
              undefined,
              "ec2:DescribeRouteTables",
              compact({
                routeTableId: routeTable.RouteTableId,
                vpcId: routeTable.VpcId,
                subnetId: association.SubnetId,
                gatewayId: association.GatewayId,
                publicIpv4Pool: association.PublicIpv4Pool,
                main: association.Main,
                state: association.AssociationState?.State,
              }),
            )],
      );
      const routeResources = routes.flatMap((route) => {
        const destination = routeDestination(route);
        if (destination === null) return [];
        const target = routeTarget(route);
        return [resourceFromApi(
          context,
          observedAt,
          region,
          "ec2",
          "aws.ec2.route",
          `${routeTable.RouteTableId}/route/${encodeURIComponent(destination.value)}`,
          undefined,
          "ec2:DescribeRouteTables",
          compact({
            routeTableId: routeTable.RouteTableId,
            vpcId: routeTable.VpcId,
            destination: destination.value,
            destinationType: destination.type,
            target: target?.value,
            targetType: target?.type,
            state: route.State,
            origin: route.Origin,
          }),
        )];
      });
      return [parent, ...associationResources, ...routeResources];
    });
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    token = nextToken(output.NextToken, seen, "EC2 DescribeRouteTables");
    if (token === undefined) return;
  }
  throw new InventoryProtocolError("EC2 DescribeRouteTables exceeded pagination limit");
}

async function collectInternetGateways(
  context: InventoryCollectionContext,
  region: string,
  client: Ec2InventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  let token: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.describeInternetGateways(
      token === undefined ? { MaxResults: 100 } : { MaxResults: 100, NextToken: token },
    );
    const resources = (output.InternetGateways ?? []).flatMap((gateway) => {
      if (gateway.InternetGatewayId === undefined) return [];
      const attachments = gateway.Attachments ?? [];
      const parent = resourceFromApi(
        context,
        observedAt,
        region,
        "ec2",
        "aws.ec2.internet-gateway",
        gateway.InternetGatewayId,
        `arn:${context.partition}:ec2:${region}:${context.accountId}:internet-gateway/${gateway.InternetGatewayId}`,
        "ec2:DescribeInternetGateways",
        compact({
          attachedVpcIds: strings(attachments.map((attachment) => attachment.VpcId)),
          attachmentStates: strings(attachments.map((attachment) => attachment.State)),
          attached: attachments.length > 0,
        }),
        gateway.Tags,
      );
      const attachmentResources = attachments.flatMap((attachment) =>
        attachment.VpcId === undefined
          ? []
          : [resourceFromApi(
              context,
              observedAt,
              region,
              "ec2",
              "aws.ec2.internet-gateway-attachment",
              `${gateway.InternetGatewayId}/attachment/${attachment.VpcId}`,
              undefined,
              "ec2:DescribeInternetGateways",
              compact({
                internetGatewayId: gateway.InternetGatewayId,
                vpcId: attachment.VpcId,
                state: attachment.State,
              }),
            )],
      );
      return [parent, ...attachmentResources];
    });
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    token = nextToken(output.NextToken, seen, "EC2 DescribeInternetGateways");
    if (token === undefined) return;
  }
  throw new InventoryProtocolError("EC2 DescribeInternetGateways exceeded pagination limit");
}

/**
 * Collects VPC flow log CONFIGURATION (ec2:DescribeFlowLogs).
 *
 * This records whether a VPC is observable, NOT what traffic occurred. The flow
 * records live in a CloudWatch Logs group or an S3 bucket and reading them needs
 * logs:FilterLogEvents / s3:GetObject, which the customer role deliberately does
 * not grant. lib/aws-flow-log-coverage.ts turns these rows into a coverage
 * verdict and states that boundary rather than letting "covered" read as
 * "analysed".
 *
 * A VPC with no flow log is the actionable finding: when something happens
 * there, the evidence does not exist and cannot be recovered retroactively.
 */
async function collectFlowLogs(
  context: InventoryCollectionContext,
  region: string,
  client: Ec2InventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  const describe = client.describeFlowLogs;
  if (describe === undefined) return; // task is only registered when present
  let token: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await describe(
      token === undefined ? { MaxResults: 100 } : { MaxResults: 100, NextToken: token },
    );
    const resources = (output.FlowLogs ?? []).flatMap((log) => {
      if (log.FlowLogId === undefined) return [];
      return [resourceFromApi(
        context,
        observedAt,
        region,
        "ec2",
        "aws.ec2.flow-log",
        log.FlowLogId,
        `arn:${context.partition}:ec2:${region}:${context.accountId}:vpc-flow-log/${log.FlowLogId}`,
        "ec2:DescribeFlowLogs",
        compact({
          // ResourceId is the VPC, subnet or ENI this log covers — the join key
          // the coverage engine needs.
          resourceId: log.ResourceId,
          // Only ACTIVE produces records; anything else is configuration that
          // looks like coverage and delivers none.
          flowLogStatus: log.FlowLogStatus,
          deliverLogsStatus: log.DeliverLogsStatus,
          // REJECT-only logging cannot answer "what did the attacker reach",
          // so the traffic type is load-bearing, not cosmetic.
          trafficType: log.TrafficType,
          logDestinationType: log.LogDestinationType,
        }),
        log.Tags,
      )];
    });
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    token = nextToken(output.NextToken, seen, "EC2 DescribeFlowLogs");
    if (token === undefined) return;
  }
  throw new InventoryProtocolError("EC2 DescribeFlowLogs exceeded pagination limit");
}

async function collectNetworkAcls(
  context: InventoryCollectionContext,
  region: string,
  client: Ec2InventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  let token: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.describeNetworkAcls(
      token === undefined ? { MaxResults: 100 } : { MaxResults: 100, NextToken: token },
    );
    const resources = (output.NetworkAcls ?? []).flatMap((acl) => {
      if (acl.NetworkAclId === undefined) return [];
      const associations = acl.Associations ?? [];
      const entries = acl.Entries ?? [];
      const parent = resourceFromApi(
        context,
        observedAt,
        region,
        "ec2",
        "aws.ec2.network-acl",
        acl.NetworkAclId,
        `arn:${context.partition}:ec2:${region}:${context.accountId}:network-acl/${acl.NetworkAclId}`,
        "ec2:DescribeNetworkAcls",
        compact({
          vpcId: acl.VpcId,
          isDefault: acl.IsDefault,
          associatedSubnetIds: strings(associations.map((association) => association.SubnetId)),
          // Ordered ACL entries (rule number, direction, protocol, allow/deny,
          // CIDR, port range) — the exact evidence subnet-boundary port
          // filtering needs. Protocol "-1" is all; "6"/"17" are TCP/UDP.
          entries: entries.map((entry) => compact({
            ruleNumber: entry.RuleNumber,
            egress: entry.Egress,
            protocol: entry.Protocol,
            ruleAction: entry.RuleAction,
            cidr: entry.CidrBlock ?? entry.Ipv6CidrBlock,
            fromPort: entry.PortRange?.From,
            toPort: entry.PortRange?.To,
          })),
        }),
        acl.Tags,
      );
      const associationResources = associations.flatMap((association) =>
        association.NetworkAclAssociationId === undefined
          ? []
          : [resourceFromApi(
              context,
              observedAt,
              region,
              "ec2",
              "aws.ec2.network-acl-association",
              association.NetworkAclAssociationId,
              undefined,
              "ec2:DescribeNetworkAcls",
              compact({
                networkAclId: acl.NetworkAclId,
                vpcId: acl.VpcId,
                subnetId: association.SubnetId,
              }),
            )],
      );
      const entryResources = entries.flatMap((entry) =>
        entry.RuleNumber === undefined || entry.Egress === undefined
          ? []
          : [resourceFromApi(
              context,
              observedAt,
              region,
              "ec2",
              "aws.ec2.network-acl-entry",
              `${acl.NetworkAclId}/entry/${entry.Egress ? "egress" : "ingress"}/${entry.RuleNumber}`,
              undefined,
              "ec2:DescribeNetworkAcls",
              compact({
                networkAclId: acl.NetworkAclId,
                vpcId: acl.VpcId,
                ruleNumber: entry.RuleNumber,
                egress: entry.Egress,
                protocol: entry.Protocol,
                ruleAction: entry.RuleAction,
                cidr: entry.CidrBlock ?? entry.Ipv6CidrBlock,
                fromPort: entry.PortRange?.From,
                toPort: entry.PortRange?.To,
                icmpType: entry.IcmpTypeCode?.Type,
                icmpCode: entry.IcmpTypeCode?.Code,
              }),
            )],
      );
      return [parent, ...associationResources, ...entryResources];
    });
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    token = nextToken(output.NextToken, seen, "EC2 DescribeNetworkAcls");
    if (token === undefined) return;
  }
  throw new InventoryProtocolError("EC2 DescribeNetworkAcls exceeded pagination limit");
}

async function collectElasticIps(
  context: InventoryCollectionContext,
  region: string,
  client: Ec2InventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  const describe = client.describeAddresses;
  if (describe === undefined) return; // task is only registered when present
  // DescribeAddresses returns the full set in one response (no pagination).
  const output = await describe({});
  const resources = (output.Addresses ?? []).flatMap((address) => {
    const nativeIdValue = address.AllocationId ?? address.PublicIp;
    if (nativeIdValue === undefined) return [];
    // Associated when the address is bound to an association, instance, or ENI.
    // The `associated` flag is the exact fact the idle/waste engine consumes to
    // flag an unused (billing) Elastic IP — recorded, never inferred beyond it.
    const associated =
      address.AssociationId !== undefined ||
      address.InstanceId !== undefined ||
      address.NetworkInterfaceId !== undefined;
    return [resourceFromApi(
      context,
      observedAt,
      region,
      "ec2",
      "aws.ec2.elastic-ip",
      nativeIdValue,
      address.AllocationId === undefined
        ? undefined
        : `arn:${context.partition}:ec2:${region}:${context.accountId}:elastic-ip/${address.AllocationId}`,
      "ec2:DescribeAddresses",
      compact({
        allocationId: address.AllocationId,
        publicIp: address.PublicIp,
        domain: address.Domain,
        associated,
        associationId: address.AssociationId,
        instanceId: address.InstanceId,
        networkInterfaceId: address.NetworkInterfaceId,
        privateIpAddress: address.PrivateIpAddress,
        publicIpv4Pool: address.PublicIpv4Pool,
        networkBorderGroup: address.NetworkBorderGroup,
      }),
      address.Tags,
    )];
  });
  await state.emit({ resources, evidence: [] });
  state.observePage(resources.length);
}

async function collectSnapshots(
  context: InventoryCollectionContext,
  region: string,
  client: Ec2InventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  const describe = client.describeSnapshots;
  if (describe === undefined) return; // task is only registered when present
  let token: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // OwnerIds: ["self"] keeps this to the account's own snapshots — never the
    // enormous set of public/shared snapshots.
    const output = await describe(
      token === undefined
        ? { OwnerIds: ["self"], MaxResults: 500 }
        : { OwnerIds: ["self"], MaxResults: 500, NextToken: token },
    );
    const resources = (output.Snapshots ?? []).flatMap((snapshot) =>
      snapshot.SnapshotId === undefined
        ? []
        : [resourceFromApi(
            context,
            observedAt,
            region,
            "ec2",
            "aws.ec2.snapshot",
            snapshot.SnapshotId,
            `arn:${context.partition}:ec2:${region}:${context.accountId}:snapshot/${snapshot.SnapshotId}`,
            "ec2:DescribeSnapshots",
            compact({
              state: snapshot.State,
              // Source volume id — the idle/waste engine joins it against the
              // collected volume inventory to flag a snapshot whose source is gone.
              volumeId: snapshot.VolumeId,
              volumeSizeGiB: snapshot.VolumeSize,
              encrypted: snapshot.Encrypted,
              storageTier: snapshot.StorageTier,
              startTime: iso(snapshot.StartTime),
              ownerId: snapshot.OwnerId,
            }),
            snapshot.Tags,
          )],
    );
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    token = nextToken(output.NextToken, seen, "EC2 DescribeSnapshots");
    if (token === undefined) return;
  }
  throw new InventoryProtocolError("EC2 DescribeSnapshots exceeded pagination limit");
}

interface SsmManagedInstance {
  readonly pingStatus?: string;
  readonly platformType?: string;
  readonly platformName?: string;
  readonly platformVersion?: string;
  readonly agentVersion?: string;
}

/**
 * Read-only patch-compliance posture for SSM-managed EC2 instances. This
 * collects state ONLY — DescribeInstanceInformation to learn which EC2
 * instances are SSM-managed, DescribeInstancePatchStates for the installed /
 * missing / failed counts and the critical/security non-compliant totals, and
 * DescribeInstancePatches (State=Missing) for the missing-patch detail on
 * non-compliant hosts. It never sends a command or applies a patch. Instances
 * not returned by DescribeInstanceInformation get no patch-state resource at
 * all, so the posture engine reports them as unmanaged / not-assessed rather
 * than implying they are compliant.
 */
async function collectSsmPatchStates(
  context: InventoryCollectionContext,
  region: string,
  client: SsmInventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  // 1. Enumerate SSM-managed EC2 instances (agent reporting in). On-prem managed
  //    nodes (mi-*) are skipped — this posture is EC2-instance scoped.
  const managed = new Map<string, SsmManagedInstance>();
  {
    let token: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const output = await client.describeInstanceInformation(
        token === undefined ? { MaxResults: 50 } : { MaxResults: 50, NextToken: token },
      );
      for (const info of output.InstanceInformationList ?? []) {
        const id = info.InstanceId;
        if (id === undefined || !id.startsWith("i-")) continue;
        managed.set(id, {
          ...(info.PingStatus === undefined ? {} : { pingStatus: info.PingStatus }),
          ...(info.PlatformType === undefined ? {} : { platformType: info.PlatformType }),
          ...(info.PlatformName === undefined ? {} : { platformName: info.PlatformName }),
          ...(info.PlatformVersion === undefined ? {} : { platformVersion: info.PlatformVersion }),
          ...(info.AgentVersion === undefined ? {} : { agentVersion: info.AgentVersion }),
        });
      }
      token = nextToken(output.NextToken, seen, "SSM DescribeInstanceInformation");
      if (token === undefined) break;
    }
  }

  // 2. Patch state for the managed instances, batched at the API's 50-id limit.
  const patchStates = new Map<string, InstancePatchState>();
  const managedIds = [...managed.keys()];
  for (let offset = 0; offset < managedIds.length; offset += MAX_SSM_PATCH_STATE_BATCH) {
    const batch = managedIds.slice(offset, offset + MAX_SSM_PATCH_STATE_BATCH);
    let token: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const output = await client.describeInstancePatchStates(
        token === undefined
          ? { InstanceIds: batch }
          : { InstanceIds: batch, NextToken: token },
      );
      for (const patchState of output.InstancePatchStates ?? []) {
        if (patchState.InstanceId !== undefined) {
          patchStates.set(patchState.InstanceId, patchState);
        }
      }
      token = nextToken(output.NextToken, seen, "SSM DescribeInstancePatchStates");
      if (token === undefined) break;
    }
  }

  // 3. One patch-state resource per managed instance. Non-compliant hosts get a
  //    bounded missing-patch detail list for the generated remediation runbook.
  let missingDetailBudget = MAX_SSM_MISSING_PATCH_INSTANCES;
  const resources: NormalizedAwsResource[] = [];
  for (const id of managedIds) {
    const info = managed.get(id) ?? {};
    const patchState = patchStates.get(id);
    const nonCompliant =
      patchState !== undefined &&
      ((patchState.MissingCount ?? 0) > 0 ||
        (patchState.FailedCount ?? 0) > 0 ||
        (patchState.CriticalNonCompliantCount ?? 0) > 0 ||
        (patchState.SecurityNonCompliantCount ?? 0) > 0);
    let missingPatches: SafeJsonObject[] = [];
    if (nonCompliant && missingDetailBudget > 0) {
      missingDetailBudget -= 1;
      missingPatches = await collectMissingPatchDetail(client, id);
    }
    resources.push(
      resourceFromApi(
        context,
        observedAt,
        region,
        "ssm",
        "aws.ssm.patch-state",
        id,
        undefined,
        "ssm:DescribeInstancePatchStates",
        compact({
          instanceId: id,
          managed: true,
          patchStateAvailable: patchState !== undefined,
          pingStatus: info.pingStatus,
          platformType: info.platformType,
          platformName: info.platformName,
          platformVersion: info.platformVersion,
          agentVersion: info.agentVersion,
          patchGroup: patchState?.PatchGroup,
          baselineId: patchState?.BaselineId,
          operation: patchState?.Operation,
          operationStartTime: iso(patchState?.OperationStartTime),
          lastScanAt: iso(patchState?.OperationEndTime),
          installedCount: patchState?.InstalledCount,
          installedOtherCount: patchState?.InstalledOtherCount,
          installedPendingRebootCount: patchState?.InstalledPendingRebootCount,
          installedRejectedCount: patchState?.InstalledRejectedCount,
          missingCount: patchState?.MissingCount,
          failedCount: patchState?.FailedCount,
          notApplicableCount: patchState?.NotApplicableCount,
          criticalMissingCount: patchState?.CriticalNonCompliantCount,
          securityMissingCount: patchState?.SecurityNonCompliantCount,
          otherNonCompliantCount: patchState?.OtherNonCompliantCount,
          ...(missingPatches.length > 0 ? { missingPatches } : {}),
        }),
      ),
    );
  }
  await state.emit({ resources, evidence: [] });
  state.observePage(resources.length);
}

async function collectMissingPatchDetail(
  client: SsmInventoryClient,
  instanceId: string,
): Promise<SafeJsonObject[]> {
  const patches: SafeJsonObject[] = [];
  let token: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.describeInstancePatches(
      token === undefined
        ? { InstanceId: instanceId, Filters: [{ Key: "State", Values: ["Missing"] }], MaxResults: 100 }
        : { InstanceId: instanceId, Filters: [{ Key: "State", Values: ["Missing"] }], MaxResults: 100, NextToken: token },
    );
    for (const patch of output.Patches ?? []) {
      if (patches.length >= MAX_SSM_MISSING_PATCHES_PER_INSTANCE) return patches;
      patches.push(
        compact({
          title: patch.Title,
          kbId: patch.KBId,
          classification: patch.Classification,
          severity: patch.Severity,
        }),
      );
    }
    token = nextToken(output.NextToken, seen, "SSM DescribeInstancePatches");
    if (token === undefined) break;
  }
  return patches;
}

async function collectLoadBalancers(
  context: InventoryCollectionContext,
  region: string,
  client: Elbv2InventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  let marker: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.describeLoadBalancers(
      marker === undefined ? { PageSize: 400 } : { PageSize: 400, Marker: marker },
    );
    const resources = (output.LoadBalancers ?? []).flatMap((loadBalancer) => {
      const arn = loadBalancer.LoadBalancerArn;
      if (arn === undefined) return [];
      return [resourceFromApi(
        context,
        observedAt,
        region,
        "elasticloadbalancing",
        "aws.elasticloadbalancingv2.load-balancer",
        arn,
        arn,
        "elasticloadbalancing:DescribeLoadBalancers",
        compact({
          name: loadBalancer.LoadBalancerName,
          type: loadBalancer.Type,
          scheme: loadBalancer.Scheme,
          state: loadBalancer.State?.Code,
          vpcId: loadBalancer.VpcId,
          dnsName: loadBalancer.DNSName,
          canonicalHostedZoneId: loadBalancer.CanonicalHostedZoneId,
          ipAddressType: loadBalancer.IpAddressType,
          securityGroupIds: strings(loadBalancer.SecurityGroups ?? []),
          subnetIds: strings(
            (loadBalancer.AvailabilityZones ?? []).map((zone) => zone.SubnetId),
          ),
          availabilityZones: strings(
            (loadBalancer.AvailabilityZones ?? []).map((zone) => zone.ZoneName),
          ),
          createdAt: iso(loadBalancer.CreatedTime),
        }),
      )];
    });
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    // Listeners are the ingress side of the balancer — the ports/protocols the
    // internet can reach. Collected per load balancer (the ELBv2 API scopes
    // listeners to a LoadBalancerArn) so aws-network-exposure sees which ports
    // are actually served, not just that a balancer exists.
    for (const loadBalancer of output.LoadBalancers ?? []) {
      if (loadBalancer.LoadBalancerArn !== undefined) {
        await collectListenersForLoadBalancer(
          context, region, client, observedAt, state, loadBalancer.LoadBalancerArn,
        );
      }
    }
    marker = nextToken(output.NextMarker, seen, "ELBv2 DescribeLoadBalancers");
    if (marker === undefined) return;
  }
  throw new InventoryProtocolError("ELBv2 DescribeLoadBalancers exceeded pagination limit");
}

async function collectListenersForLoadBalancer(
  context: InventoryCollectionContext,
  region: string,
  client: Elbv2InventoryClient,
  observedAt: string,
  state: TaskCollectionState,
  loadBalancerArn: string,
): Promise<void> {
  let marker: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.describeListeners(
      marker === undefined
        ? { LoadBalancerArn: loadBalancerArn, PageSize: 400 }
        : { LoadBalancerArn: loadBalancerArn, PageSize: 400, Marker: marker },
    );
    const resources = (output.Listeners ?? []).flatMap((listener) => {
      const arn = listener.ListenerArn;
      if (arn === undefined) return [];
      const certificates = listener.Certificates ?? [];
      return [resourceFromApi(
        context,
        observedAt,
        region,
        "elasticloadbalancing",
        "aws.elasticloadbalancingv2.listener",
        arn,
        arn,
        "elasticloadbalancing:DescribeListeners",
        compact({
          loadBalancerArn: listener.LoadBalancerArn,
          port: listener.Port,
          protocol: listener.Protocol,
          sslPolicy: listener.SslPolicy,
          certificateCount: certificates.length,
          defaultActionTypes: strings((listener.DefaultActions ?? []).map((action) => action.Type)),
          alpnPolicy: strings(listener.AlpnPolicy ?? []),
        }),
      )];
    });
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    marker = nextToken(output.NextMarker, seen, "ELBv2 DescribeListeners");
    if (marker === undefined) return;
  }
  throw new InventoryProtocolError("ELBv2 DescribeListeners exceeded pagination limit");
}

async function collectTargetGroups(
  context: InventoryCollectionContext,
  region: string,
  client: Elbv2InventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  let marker: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.describeTargetGroups(
      marker === undefined ? { PageSize: 400 } : { PageSize: 400, Marker: marker },
    );
    const resources: NormalizedAwsResource[] = [];
    for (const group of output.TargetGroups ?? []) {
      const arn = group.TargetGroupArn;
      if (arn === undefined) continue;
      // Registered targets are the load balancer's actual backends — the hop
      // that makes a private instance internet-reachable via an internet-facing
      // balancer. Health is recorded as a fact, never used to hide a target.
      const health = await client.describeTargetHealth({ TargetGroupArn: arn });
      const targets = (health.TargetHealthDescriptions ?? []).flatMap((description) =>
        description.Target?.Id === undefined ? [] : [compact({
          id: description.Target.Id,
          port: description.Target.Port,
          state: description.TargetHealth?.State,
        })]);
      resources.push(resourceFromApi(
        context,
        observedAt,
        region,
        "elasticloadbalancing",
        "aws.elasticloadbalancingv2.target-group",
        arn,
        arn,
        "elasticloadbalancing:DescribeTargetGroups",
        compact({
          name: group.TargetGroupName,
          targetType: group.TargetType,
          protocol: group.Protocol,
          port: group.Port,
          vpcId: group.VpcId,
          loadBalancerArns: strings(group.LoadBalancerArns ?? []),
          targets,
        }),
      ));
    }
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    marker = nextToken(output.NextMarker, seen, "ELBv2 DescribeTargetGroups");
    if (marker === undefined) return;
  }
  throw new InventoryProtocolError("ELBv2 DescribeTargetGroups exceeded pagination limit");
}

async function collectKmsKeys(
  context: InventoryCollectionContext,
  region: string,
  client: KmsInventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  const aliasesByKeyId = new Map<string, string[]>();
  let aliasMarker: string | undefined;
  const seenAliasMarkers = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.listAliases(
      aliasMarker === undefined ? { Limit: 100 } : { Limit: 100, Marker: aliasMarker },
    );
    for (const alias of output.Aliases ?? []) {
      if (alias.TargetKeyId === undefined || alias.AliasName === undefined) continue;
      const safeAlias = safeNativeText(alias.AliasName, 256);
      if (safeAlias === undefined) continue;
      const values = aliasesByKeyId.get(alias.TargetKeyId) ?? [];
      if (values.length < 100 && !values.includes(safeAlias)) values.push(safeAlias);
      aliasesByKeyId.set(alias.TargetKeyId, values);
    }
    state.observePage();
    aliasMarker = nextToken(output.NextMarker, seenAliasMarkers, "KMS ListAliases");
    if (aliasMarker === undefined) break;
  }
  if (aliasMarker !== undefined) {
    throw new InventoryProtocolError("KMS ListAliases exceeded pagination limit");
  }

  let keyMarker: string | undefined;
  const seenKeyMarkers = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.listKeys(
      keyMarker === undefined ? { Limit: 100 } : { Limit: 100, Marker: keyMarker },
    );
    const resources: NormalizedAwsResource[] = [];
    for (const listed of output.Keys ?? []) {
      if (listed.KeyId === undefined) continue;
      const described = await client.describeKey({ KeyId: listed.KeyId });
      const key = described.KeyMetadata;
      if (key?.KeyId === undefined) continue;
      resources.push(resourceFromApi(
        context,
        observedAt,
        region,
        "kms",
        "aws.kms.key",
        key.KeyId,
        key.Arn,
        "kms:ListKeys+kms:DescribeKey+kms:ListAliases",
        compact({
          state: key.KeyState,
          enabled: key.Enabled,
          keyManager: key.KeyManager,
          origin: key.Origin,
          keySpec: key.KeySpec,
          keyUsage: key.KeyUsage,
          multiRegion: key.MultiRegion,
          creationDate: iso(key.CreationDate),
          deletionDate: iso(key.DeletionDate),
          validTo: iso(key.ValidTo),
          aliases: aliasesByKeyId.get(key.KeyId) ?? [],
        }),
      ));
    }
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    keyMarker = nextToken(output.NextMarker, seenKeyMarkers, "KMS ListKeys");
    if (keyMarker === undefined) return;
  }
  throw new InventoryProtocolError("KMS ListKeys exceeded pagination limit");
}

async function collectDynamoDbTables(
  context: InventoryCollectionContext,
  region: string,
  client: DynamoDbInventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  let startName: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.listTables(
      startName === undefined
        ? { Limit: 100 }
        : { Limit: 100, ExclusiveStartTableName: startName },
    );
    const resources: NormalizedAwsResource[] = [];
    for (const tableName of output.TableNames ?? []) {
      const described = await client.describeTable({ TableName: tableName });
      const table = described.Table;
      if (table?.TableName === undefined) continue;
      resources.push(resourceFromApi(
        context,
        observedAt,
        region,
        "dynamodb",
        "aws.dynamodb.table",
        table.TableName,
        table.TableArn,
        "dynamodb:ListTables+dynamodb:DescribeTable",
        compact({
          state: table.TableStatus,
          creationDate: iso(table.CreationDateTime),
          billingMode: table.BillingModeSummary?.BillingMode,
          itemCount: table.ItemCount,
          tableSizeBytes: table.TableSizeBytes,
          tableClass: table.TableClassSummary?.TableClass,
          deletionProtectionEnabled: table.DeletionProtectionEnabled,
          latestStreamArn: table.LatestStreamArn,
          latestStreamLabel: table.LatestStreamLabel,
          sseStatus: table.SSEDescription?.Status,
          sseType: table.SSEDescription?.SSEType,
          kmsKeyId: table.SSEDescription?.KMSMasterKeyArn,
          replicaRegions: strings((table.Replicas ?? []).map((replica) => replica.RegionName)),
        }),
      ));
    }
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    startName = nextToken(output.LastEvaluatedTableName, seen, "DynamoDB ListTables");
    if (startName === undefined) return;
  }
  throw new InventoryProtocolError("DynamoDB ListTables exceeded pagination limit");
}

async function collectEcrRepositories(
  context: InventoryCollectionContext,
  region: string,
  client: EcrInventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  let token: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.describeRepositories(
      token === undefined ? { maxResults: 1000 } : { maxResults: 1000, nextToken: token },
    );
    const resources = (output.repositories ?? []).flatMap((repository) =>
      repository.repositoryName === undefined
        ? []
        : [resourceFromApi(
            context,
            observedAt,
            region,
            "ecr",
            "aws.ecr.repository",
            repository.repositoryName,
            repository.repositoryArn,
            "ecr:DescribeRepositories",
            compact({
              registryId: repository.registryId,
              repositoryUri: repository.repositoryUri,
              createdAt: iso(repository.createdAt),
              imageTagMutability: repository.imageTagMutability,
              scanOnPush: repository.imageScanningConfiguration?.scanOnPush,
              encryptionType: repository.encryptionConfiguration?.encryptionType,
              kmsKeyId: repository.encryptionConfiguration?.kmsKey,
            }),
          )],
    );
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    token = nextToken(output.nextToken, seen, "ECR DescribeRepositories");
    if (token === undefined) return;
  }
  throw new InventoryProtocolError("ECR DescribeRepositories exceeded pagination limit");
}

async function collectEksClusters(
  context: InventoryCollectionContext,
  region: string,
  client: EksInventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  let token: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const listed = await client.listClusters(
      token === undefined ? { maxResults: 100 } : { maxResults: 100, nextToken: token },
    );
    const resources: NormalizedAwsResource[] = [];
    for (const clusterName of listed.clusters ?? []) {
      if (
        typeof clusterName !== "string" || clusterName.length === 0 ||
        clusterName.length > 100 || /[\u0000-\u001f\u007f]/u.test(clusterName)
      ) continue;
      const described = await client.describeCluster({ name: clusterName });
      const cluster = described.cluster;
      if (cluster?.name === undefined) continue;
      const enabledLogTypes = (cluster.logging?.clusterLogging ?? [])
        .filter((entry) => entry.enabled === true)
        .flatMap((entry) => entry.types ?? []);
      const encryptionResources = (cluster.encryptionConfig ?? [])
        .flatMap((entry) => entry.resources ?? []);
      resources.push(resourceFromApi(
        context,
        observedAt,
        region,
        "eks",
        "aws.eks.cluster",
        cluster.name,
        cluster.arn,
        "eks:ListClusters+eks:DescribeCluster",
        compact({
          state: cluster.status,
          clusterName: cluster.name,
          kubernetesVersion: cluster.version,
          platformVersion: cluster.platformVersion,
          createdAt: iso(cluster.createdAt),
          roleArn: cluster.roleArn,
          endpointPublicAccess: cluster.resourcesVpcConfig?.endpointPublicAccess,
          endpointPrivateAccess: cluster.resourcesVpcConfig?.endpointPrivateAccess,
          publicAccessCidrs: strings(cluster.resourcesVpcConfig?.publicAccessCidrs ?? []),
          vpcId: cluster.resourcesVpcConfig?.vpcId,
          subnetIds: strings(cluster.resourcesVpcConfig?.subnetIds ?? []),
          securityGroupIds: strings(cluster.resourcesVpcConfig?.securityGroupIds ?? []),
          clusterSecurityGroupId: cluster.resourcesVpcConfig?.clusterSecurityGroupId,
          enabledLogTypes: strings(enabledLogTypes),
          encryptionResources: strings(encryptionResources),
          encryptionProviderKeyArn: cluster.encryptionConfig?.[0]?.provider?.keyArn,
          authenticationMode: cluster.accessConfig?.authenticationMode,
          bootstrapClusterCreatorAdminPermissions:
            cluster.accessConfig?.bootstrapClusterCreatorAdminPermissions,
          upgradeSupportType: cluster.upgradePolicy?.supportType,
          deletionProtection: cluster.deletionProtection,
        }),
        Object.entries(cluster.tags ?? {}).map(([Key, Value]) => ({ Key, Value })),
      ));
    }
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    token = nextToken(listed.nextToken, seen, "EKS ListClusters");
    if (token === undefined) return;
  }
  throw new InventoryProtocolError("EKS ListClusters exceeded pagination limit");
}

async function collectS3(
  context: InventoryCollectionContext,
  region: string,
  client: S3InventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  let continuationToken: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // BucketRegion is a server-side scope boundary. Do not enumerate bucket
    // names from Regions the customer did not select for this connection.
    const output = await client.listBuckets(
      continuationToken === undefined
        ? { MaxBuckets: 1000, BucketRegion: region }
        : { MaxBuckets: 1000, BucketRegion: region, ContinuationToken: continuationToken },
    );
    state.observePage();
    for (const bucket of output.Buckets ?? []) {
      if (bucket.Name === undefined) continue;
      const resourceRecord = resource(
        context,
        observedAt,
        region,
        "s3",
        "aws.s3.bucket",
        bucket.Name,
        `arn:${context.partition}:s3:::${bucket.Name}`,
        compact({
          creationDate: iso(bucket.CreationDate),
          bucketRegion: region,
        }),
      );

      let blockStatus: InventoryEvidenceStatus = "CONFIGURED";
      let blockData: SafeJsonObject;
      try {
        const block = await client.getPublicAccessBlock({
          Bucket: bucket.Name,
        });
        blockData = publicAccessBlockData(block);
        if (!publicAccessBlockFullyConfigured(blockData)) {
          blockStatus = "NOT_CONFIGURED";
        }
      } catch (error: unknown) {
        if (isNamedError(error, "NoSuchPublicAccessBlockConfiguration")) {
          blockStatus = "NOT_CONFIGURED";
          blockData = {
            blockPublicAcls: false,
            ignorePublicAcls: false,
            blockPublicPolicy: false,
            restrictPublicBuckets: false,
          };
        } else {
          state.markPartial(error);
          blockStatus = "ERROR";
          blockData = { errorName: safeErrorName(error) };
        }
      }

      await state.emit({
        resources: [resourceRecord],
        evidence: [
          evidence(
            context,
            observedAt,
            region,
            "s3",
            "S3_PUBLIC_ACCESS_BLOCK",
            bucket.Name,
            blockStatus,
            blockData,
          ),
        ],
      });
      state.observeItems(1);
    }
    continuationToken = nextToken(
      output.ContinuationToken,
      seen,
      "S3 ListBuckets",
    );
    if (continuationToken === undefined) return;
  }
  throw new InventoryProtocolError("S3 ListBuckets exceeded pagination limit");
}

async function collectBedrockGuardrails(
  context: InventoryCollectionContext,
  region: string,
  client: BedrockInventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  let token: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.listGuardrails(
      token === undefined ? { maxResults: 100 } : { maxResults: 100, nextToken: token },
    );
    const resources: NormalizedAwsResource[] = [];
    for (const summary of output.guardrails ?? []) {
      if (summary.id === undefined || summary.version === undefined) continue;
      const detail = await client.getGuardrail({
        guardrailIdentifier: summary.id,
        guardrailVersion: summary.version,
      });
      if (
        detail.guardrailId !== undefined &&
        detail.guardrailId !== summary.id
      ) {
        throw new InventoryProtocolError("Bedrock GetGuardrail returned a different guardrail id");
      }
      if (
        detail.version !== undefined &&
        detail.version !== summary.version
      ) {
        throw new InventoryProtocolError("Bedrock GetGuardrail returned a different guardrail version");
      }

      const contentFilters = detail.contentPolicy?.filters ?? [];
      const piiEntities = detail.sensitiveInformationPolicy?.piiEntities ?? [];
      const groundingFilters = detail.contextualGroundingPolicy?.filters ?? [];
      resources.push(resourceFromApi(
        context,
        observedAt,
        region,
        "bedrock",
        "aws.bedrock.guardrail",
        `${summary.id}:${summary.version}`,
        summary.arn ?? detail.guardrailArn,
        "bedrock:ListGuardrails+GetGuardrail",
        compact({
          name: summary.name ?? detail.name,
          guardrailId: summary.id,
          version: summary.version,
          status: summary.status ?? detail.status,
          createdAt: iso(summary.createdAt),
          updatedAt: iso(summary.updatedAt),
          kmsKeyId: detail.kmsKeyArn,
          crossRegionProfileConfigured:
            detail.crossRegionDetails?.guardrailProfileArn !== undefined ||
            detail.crossRegionDetails?.guardrailProfileId !== undefined,
          contentPolicy: {
            filterCount: contentFilters.length,
            standardTier: detail.contentPolicy?.tier?.tierName === "STANDARD",
            filters: contentFilters.map((filter) => compact({
              type: filter.type,
              inputStrength: filter.inputStrength,
              outputStrength: filter.outputStrength,
              inputAction: filter.inputAction,
              outputAction: filter.outputAction,
              inputEnabled: filter.inputEnabled,
              outputEnabled: filter.outputEnabled,
            })),
          },
          sensitiveInformationPolicy: {
            piiEntityCount: piiEntities.length,
            piiEntities: piiEntities.map((entity) => compact({
              type: entity.type,
              inputAction: entity.inputAction ?? entity.action,
              outputAction: entity.outputAction ?? entity.action,
              inputEnabled: entity.inputEnabled,
              outputEnabled: entity.outputEnabled,
            })),
            // Regex names, descriptions, and patterns can disclose customer
            // secrets or identifiers; only the count crosses the boundary.
            regexCount: detail.sensitiveInformationPolicy?.regexes?.length ?? 0,
          },
          deniedTopicCount: detail.topicPolicy?.topics?.length ?? 0,
          wordFilterCount: detail.wordPolicy?.words?.length ?? 0,
          managedWordListCount: detail.wordPolicy?.managedWordLists?.length ?? 0,
          contextualGroundingPolicy: {
            filterCount: groundingFilters.length,
            filters: groundingFilters.map((filter) => compact({
              type: filter.type,
              threshold: finiteNumber(filter.threshold),
              action: filter.action,
              enabled: filter.enabled,
            })),
          },
          automatedReasoningPolicyCount:
            detail.automatedReasoningPolicy?.policies?.length ?? 0,
          automatedReasoningConfidenceThreshold:
            finiteNumber(detail.automatedReasoningPolicy?.confidenceThreshold),
        }),
      ));
    }
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    token = nextToken(output.nextToken, seen, "Bedrock ListGuardrails");
    if (token === undefined) return;
  }
  throw new InventoryProtocolError("Bedrock ListGuardrails exceeded pagination limit");
}

async function collectBedrockAccountPosture(
  context: InventoryCollectionContext,
  region: string,
  client: BedrockInventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  const [logging, retention] = await Promise.all([
    client.getModelInvocationLoggingConfiguration(),
    client.getAccountDataRetention(),
  ]);
  if (retention.mode === undefined) {
    throw new InventoryProtocolError("Bedrock account data retention response omitted mode");
  }
  const config = logging.loggingConfig;
  await state.emit({
    resources: [],
    evidence: [
      evidence(
        context,
        observedAt,
        region,
        "bedrock",
        "BEDROCK_MODEL_INVOCATION_LOGGING",
        context.accountId,
        config === undefined ? "NOT_CONFIGURED" : "CONFIGURED",
        config === undefined
          ? {}
          : compact({
            cloudWatchDestinationConfigured: config.cloudWatchConfig !== undefined,
            s3DestinationConfigured: config.s3Config !== undefined,
            largeDataS3DestinationConfigured:
              config.cloudWatchConfig?.largeDataDeliveryS3Config !== undefined,
            textDataDeliveryEnabled: config.textDataDeliveryEnabled,
            imageDataDeliveryEnabled: config.imageDataDeliveryEnabled,
            embeddingDataDeliveryEnabled: config.embeddingDataDeliveryEnabled,
            videoDataDeliveryEnabled: config.videoDataDeliveryEnabled,
            audioDataDeliveryEnabled: config.audioDataDeliveryEnabled,
          }),
      ),
      evidence(
        context,
        observedAt,
        region,
        "bedrock",
        "BEDROCK_ACCOUNT_DATA_RETENTION",
        context.accountId,
        "CONFIGURED",
        compact({
          mode: retention.mode,
          updatedAt: iso(retention.updatedAt),
        }),
      ),
    ],
  });
  state.observePage(2);
}

async function collectRds(
  context: InventoryCollectionContext,
  region: string,
  client: RdsInventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  let marker: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.describeDBInstances(
      marker === undefined ? { MaxRecords: 100 } : { MaxRecords: 100, Marker: marker },
    );
    const resources = (output.DBInstances ?? []).flatMap((database) =>
      database.DBInstanceIdentifier === undefined
        ? []
        : [
            resource(
              context,
              observedAt,
              region,
              "rds",
              "aws.rds.db-instance",
              database.DBInstanceIdentifier,
              database.DBInstanceArn,
              compact({
                status: database.DBInstanceStatus,
                engine: database.Engine,
                engineVersion: database.EngineVersion,
                instanceClass: database.DBInstanceClass,
                storageType: database.StorageType,
                allocatedStorageGiB: database.AllocatedStorage,
                storageEncrypted: database.StorageEncrypted,
                publiclyAccessible: database.PubliclyAccessible,
                multiAz: database.MultiAZ,
                vpcId: database.DBSubnetGroup?.VpcId,
                endpointAddress: database.Endpoint?.Address,
                endpointPort: database.Endpoint?.Port,
                securityGroupIds: strings(
                  (database.VpcSecurityGroups ?? []).map((group) => group.VpcSecurityGroupId),
                ),
                kmsKeyId: database.KmsKeyId,
              }),
              database.TagList,
            ),
          ],
    );
    await state.emit({ resources, evidence: [] });
    state.observePage(resources.length);
    marker = nextToken(output.Marker, seen, "RDS DescribeDBInstances");
    if (marker === undefined) return;
  }
  throw new InventoryProtocolError("RDS DescribeDBInstances exceeded pagination limit");
}

async function collectIamSummary(
  context: InventoryCollectionContext,
  client: IamInventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  const output = await client.getAccountSummary();
  const summary: Record<string, SafeJsonValue> = {};
  for (const [key, value] of Object.entries(output.SummaryMap ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (typeof value === "number" && Number.isFinite(value)) summary[key] = value;
  }
  await state.emit({
    resources: [
      resource(
        context,
        observedAt,
        "global",
        "iam",
        "aws.iam.account",
        context.accountId,
        `arn:${context.partition}:iam::${context.accountId}:root`,
        { summary },
      ),
    ],
    evidence: [],
  });
  state.observePage(1);
}

async function collectIamPasswordPolicy(
  context: InventoryCollectionContext,
  client: IamInventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  try {
    const output = await client.getAccountPasswordPolicy();
    const policy = output.PasswordPolicy;
    await state.emit({
      resources: [],
      evidence: [
        evidence(
          context,
          observedAt,
          "global",
          "iam",
          "IAM_ACCOUNT_PASSWORD_POLICY",
          context.accountId,
          "CONFIGURED",
          compact({
            minimumPasswordLength: policy?.MinimumPasswordLength,
            requireSymbols: policy?.RequireSymbols,
            requireNumbers: policy?.RequireNumbers,
            requireUppercaseCharacters: policy?.RequireUppercaseCharacters,
            requireLowercaseCharacters: policy?.RequireLowercaseCharacters,
            allowUsersToChangePassword: policy?.AllowUsersToChangePassword,
            expirePasswords: policy?.ExpirePasswords,
            maxPasswordAge: policy?.MaxPasswordAge,
            passwordReusePrevention: policy?.PasswordReusePrevention,
            hardExpiry: policy?.HardExpiry,
          }),
        ),
      ],
    });
    state.observePage(1);
  } catch (error: unknown) {
    if (
      !isNamedError(error, "NoSuchEntity") &&
      !isNamedError(error, "NoSuchEntityException")
    ) {
      throw error;
    }
    await state.emit({
      resources: [],
      evidence: [
        evidence(
          context,
          observedAt,
          "global",
          "iam",
          "IAM_ACCOUNT_PASSWORD_POLICY",
          context.accountId,
          "NOT_CONFIGURED",
          {},
        ),
      ],
    });
    state.observePage(1);
  }
}

type CloudTrailDescription = NonNullable<DescribeTrailsCommandOutput["trailList"]>[number];

interface ObservedCloudTrail {
  readonly identity: string;
  readonly trailId: string;
  readonly homeRegion: string;
  readonly trail: CloudTrailDescription;
}

/**
 * CloudTrail returns shadow copies of multi-Region trails outside their home
 * Region. Coordinate all regional tasks so a shadow copy contributes coverage
 * without becoming a second CMDB resource or causing a second status call.
 */
function createCloudTrailCollector(
  context: InventoryCollectionContext,
  observedAt: string,
  clients: AwsInventoryClientFactory,
): (
  region: string,
  client: CloudTrailInventoryClient,
  state: TaskCollectionState,
) => Promise<void> {
  const statusClients = new Map<string, CloudTrailInventoryClient>();
  const statuses = new Map<string, Promise<GetTrailStatusCommandOutput>>();
  const emittedTrailResources = new Set<string>();

  const statusFor = (
    observed: ObservedCloudTrail,
  ): Promise<GetTrailStatusCommandOutput> => {
    const cached = statuses.get(observed.identity);
    if (cached !== undefined) return cached;
    let statusClient = statusClients.get(observed.homeRegion);
    if (statusClient === undefined) {
      statusClient = clients.cloudTrail(observed.homeRegion, context.credentials);
      statusClients.set(observed.homeRegion, statusClient);
    }
    const operation = statusClient.getTrailStatus({ Name: observed.trailId })
      .then((status) => {
        if (typeof status.IsLogging !== "boolean") {
          throw new InventoryProtocolError("CloudTrail status omitted IsLogging");
        }
        return status;
      });
    statuses.set(observed.identity, operation);
    return operation;
  };

  return async (region, client, state) => {
    if (!statusClients.has(region)) statusClients.set(region, client);
    const output = await client.describeTrails({ includeShadowTrails: true });
    state.observePage();

    const observedByIdentity = new Map<string, ObservedCloudTrail>();
    for (const trail of output.trailList ?? []) {
      const trailId = trail.TrailARN ?? trail.Name;
      if (trailId === undefined) continue;
      const homeRegion =
        trail.HomeRegion !== undefined && REGION.test(trail.HomeRegion)
          ? trail.HomeRegion
          : region;
      const identity = trail.TrailARN ?? `${homeRegion}:${trail.Name ?? trailId}`;
      if (!observedByIdentity.has(identity)) {
        observedByIdentity.set(identity, { identity, trailId, homeRegion, trail });
      }
    }

    const observations = [...observedByIdentity.values()];
    const withStatus = await Promise.all(
      observations.map(async (observed) => ({
        observed,
        status: await statusFor(observed),
      })),
    );
    const applicable = withStatus.filter(
      ({ observed }) =>
        observed.trail.IsMultiRegionTrail === true || observed.homeRegion === region,
    );
    const logging = applicable.filter(({ status }) => status.IsLogging === true);
    const resources: NormalizedAwsResource[] = [];

    for (const { observed, status } of withStatus) {
      if (emittedTrailResources.has(observed.identity)) continue;
      emittedTrailResources.add(observed.identity);
      const trail = observed.trail;
      resources.push(
        resource(
          context,
          observedAt,
          observed.homeRegion,
          "cloudtrail",
          "aws.cloudtrail.trail",
          observed.trailId,
          trail.TrailARN,
          compact({
            name: trail.Name,
            homeRegion: observed.homeRegion,
            isMultiRegionTrail: trail.IsMultiRegionTrail,
            isOrganizationTrail: trail.IsOrganizationTrail,
            includeGlobalServiceEvents: trail.IncludeGlobalServiceEvents,
            logFileValidationEnabled: trail.LogFileValidationEnabled,
            hasCustomEventSelectors: trail.HasCustomEventSelectors,
            hasInsightSelectors: trail.HasInsightSelectors,
            s3BucketName: trail.S3BucketName,
            kmsKeyId: trail.KmsKeyId,
            cloudWatchLogsLogGroupArn: trail.CloudWatchLogsLogGroupArn,
            isLogging: status.IsLogging,
            latestDeliveryTime: iso(status.LatestDeliveryTime),
            latestDigestDeliveryTime: iso(status.LatestDigestDeliveryTime),
            startLoggingTime: iso(status.StartLoggingTime),
            stopLoggingTime: iso(status.StopLoggingTime),
          }),
        ),
      );
    }

    const coverageBasis = logging.some(
      ({ observed }) => observed.trail.IsMultiRegionTrail === true,
    )
      ? "multi-region-trail"
      : logging.length > 0
        ? "regional-trail"
        : applicable.length > 0
          ? "applicable-trails-not-logging"
          : "no-applicable-trail";
    await state.emit({
      resources,
      evidence: [
        evidence(
          context,
          observedAt,
          region,
          "cloudtrail",
          "CLOUDTRAIL_LOGGING_STATUS",
          context.accountId,
          logging.length > 0 ? "ENABLED" : "DISABLED",
          {
            trailsObserved: observations.length,
            applicableTrailsObserved: applicable.length,
            loggingTrailsObserved: logging.length,
            coverageBasis,
          },
        ),
      ],
    });
    state.observeItems(applicable.length);
  };
}

async function collectGuardDuty(
  context: InventoryCollectionContext,
  region: string,
  client: GuardDutyInventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  let token: string | undefined;
  const seen = new Set<string>();
  let detectorCount = 0;
  let enabledCount = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.listDetectors(
      token === undefined ? { MaxResults: 50 } : { MaxResults: 50, NextToken: token },
    );
    state.observePage();
    const resources: NormalizedAwsResource[] = [];
    for (const detectorId of output.DetectorIds ?? []) {
      const detector = await client.getDetector({ DetectorId: detectorId });
      detectorCount += 1;
      if (detector.Status === "ENABLED") enabledCount += 1;
      resources.push(
        resource(
          context,
          observedAt,
          region,
          "guardduty",
          "aws.guardduty.detector",
          detectorId,
          `arn:${context.partition}:guardduty:${region}:${context.accountId}:detector/${detectorId}`,
          compact({
            status: detector.Status,
            findingPublishingFrequency: detector.FindingPublishingFrequency,
            serviceRole: detector.ServiceRole,
            createdAt: detector.CreatedAt,
            updatedAt: detector.UpdatedAt,
          }),
        ),
      );
    }
    await state.emit({ resources, evidence: [] });
    state.observeItems(resources.length);
    token = nextToken(output.NextToken, seen, "GuardDuty ListDetectors");
    if (token === undefined) break;
    if (page === MAX_PAGES - 1) {
      throw new InventoryProtocolError("GuardDuty ListDetectors exceeded pagination limit");
    }
  }

  await state.emit({
    resources: [],
    evidence: [
      evidence(
        context,
        observedAt,
        region,
        "guardduty",
        "GUARDDUTY_ENABLEMENT",
        context.accountId,
        enabledCount > 0 ? "ENABLED" : "DISABLED",
        { detectorCount, enabledDetectorCount: enabledCount },
      ),
    ],
  });
}

async function collectSecurityHub(
  context: InventoryCollectionContext,
  region: string,
  client: SecurityHubInventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  try {
    const hub = await client.describeHub();
    const hubId = hub.HubArn ?? `${context.accountId}:${region}:hub`;
    await state.emit({
      resources: [
        resource(
          context,
          observedAt,
          region,
          "securityhub",
          "aws.securityhub.hub",
          hubId,
          hub.HubArn,
          compact({
            subscribedAt: hub.SubscribedAt,
            autoEnableControls: hub.AutoEnableControls,
            controlFindingGenerator: hub.ControlFindingGenerator,
          }),
        ),
      ],
      evidence: [
        evidence(
          context,
          observedAt,
          region,
          "securityhub",
          "SECURITY_HUB_ENABLEMENT",
          context.accountId,
          "ENABLED",
          {},
        ),
      ],
    });
    state.observePage(1);
  } catch (error: unknown) {
    if (!isNamedError(error, "InvalidAccessException")) throw error;
    await state.emit({
      resources: [],
      evidence: [
        evidence(
          context,
          observedAt,
          region,
          "securityhub",
          "SECURITY_HUB_ENABLEMENT",
          context.accountId,
          "DISABLED",
          {},
        ),
      ],
    });
    state.observePage();
  }
}

async function collectGuardDutyFindings(
  context: InventoryCollectionContext,
  region: string,
  client: GuardDutyInventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  const detectorIds: string[] = [];
  let detectorToken: string | undefined;
  const seenDetectorTokens = new Set<string>();
  for (let page = 0; page < MAX_NATIVE_FINDING_PAGES; page += 1) {
    const output = await client.listDetectors(
      detectorToken === undefined
        ? { MaxResults: 50 }
        : { MaxResults: 50, NextToken: detectorToken },
    );
    state.observePage();
    for (const detectorId of output.DetectorIds ?? []) {
      if (safeNativeIdentifier(detectorId, 300) !== null) detectorIds.push(detectorId);
    }
    detectorToken = nextToken(
      output.NextToken,
      seenDetectorTokens,
      "GuardDuty ListDetectors for native findings",
    );
    if (detectorToken === undefined) break;
    if (page === MAX_NATIVE_FINDING_PAGES - 1) {
      throw new InventoryProtocolError(
        "GuardDuty detector discovery exceeded the native finding pagination limit",
      );
    }
  }

  let enabledDetectorCount = 0;
  const enabledDetectorIds: string[] = [];
  for (const detectorId of [...new Set(detectorIds)]) {
    const detector = await client.getDetector({ DetectorId: detectorId });
    if (detector.Status === "ENABLED") {
      enabledDetectorCount += 1;
      enabledDetectorIds.push(detectorId);
    }
  }

  if (enabledDetectorIds.length === 0) {
    await emitNativeFindingsAvailability(
      context,
      observedAt,
      region,
      "guardduty",
      "DISABLED",
      {
        nativeService: "AWS GuardDuty",
        detectorCount: detectorIds.length,
        enabledDetectorCount,
        importMode: "existing-findings-only",
      },
      state,
    );
    return;
  }

  let importedFindings = 0;
  for (const detectorId of enabledDetectorIds) {
    let token: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_NATIVE_FINDING_PAGES; page += 1) {
      const output = await client.listFindings(
        token === undefined
          ? { DetectorId: detectorId, MaxResults: 50 }
          : { DetectorId: detectorId, MaxResults: 50, NextToken: token },
      );
      state.observePage();
      const remaining = MAX_NATIVE_FINDINGS_PER_SERVICE_REGION - importedFindings;
      const pageFindingIds = [...new Set(output.FindingIds ?? [])]
        .filter((findingId) => safeNativeIdentifier(findingId, 512) !== null);
      const pageWasTruncated = pageFindingIds.length > Math.max(0, remaining);
      const findingIds = pageFindingIds.slice(0, Math.max(0, remaining));
      if (findingIds.length > 0) {
        const findings = await client.getFindings({
          DetectorId: detectorId,
          FindingIds: findingIds,
        });
        const normalized = (findings.Findings ?? []).map((finding) =>
          normalizeGuardDutyFinding(context, region, observedAt, finding),
        );
        await state.emit({ resources: [], evidence: normalized });
        state.observeItems(normalized.length);
        importedFindings += normalized.length;
      }
      token = nextToken(
        output.NextToken,
        seen,
        "GuardDuty ListFindings",
      );
      if (pageWasTruncated) {
        throw new InventoryProtocolError(
          "GuardDuty native finding import exceeded its bounded collection limit",
        );
      }
      if (token === undefined) break;
      if (
        importedFindings >= MAX_NATIVE_FINDINGS_PER_SERVICE_REGION ||
        page === MAX_NATIVE_FINDING_PAGES - 1
      ) {
        throw new InventoryProtocolError(
          "GuardDuty native finding import exceeded its bounded collection limit",
        );
      }
    }
  }

  await emitNativeFindingsAvailability(
    context,
    observedAt,
    region,
    "guardduty",
    "ENABLED",
    {
      nativeService: "AWS GuardDuty",
      detectorCount: detectorIds.length,
      enabledDetectorCount,
      importedFindings,
      importMode: "existing-findings-only",
    },
    state,
  );
}

async function collectSecurityHubFindings(
  context: InventoryCollectionContext,
  region: string,
  client: SecurityHubInventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  try {
    await client.describeHub();
    state.observePage();
  } catch (error: unknown) {
    if (!isNamedError(error, "InvalidAccessException")) throw error;
    await emitNativeFindingsAvailability(
      context,
      observedAt,
      region,
      "securityhub",
      "DISABLED",
      {
        nativeService: "AWS Security Hub",
        reason: "NOT_SUBSCRIBED",
        importMode: "existing-findings-only",
      },
      state,
    );
    return;
  }

  let token: string | undefined;
  const seen = new Set<string>();
  let importedFindings = 0;
  for (let page = 0; page < MAX_NATIVE_FINDING_PAGES; page += 1) {
    const output = await client.getFindings({
      Filters: {
        AwsAccountId: [{ Value: context.accountId, Comparison: "EQUALS" }],
        Region: [{ Value: region, Comparison: "EQUALS" }],
      },
      MaxResults: 100,
      ...(token === undefined ? {} : { NextToken: token }),
    });
    state.observePage();
    const remaining = MAX_NATIVE_FINDINGS_PER_SERVICE_REGION - importedFindings;
    const pageFindings = output.Findings ?? [];
    const pageWasTruncated = pageFindings.length > Math.max(0, remaining);
    const normalized = pageFindings
      .slice(0, Math.max(0, remaining))
      .map((finding) =>
        normalizeSecurityHubFinding(context, region, observedAt, finding),
      );
    await state.emit({ resources: [], evidence: normalized });
    state.observeItems(normalized.length);
    importedFindings += normalized.length;
    token = nextToken(output.NextToken, seen, "Security Hub GetFindings");
    if (pageWasTruncated) {
      throw new InventoryProtocolError(
        "Security Hub native finding import exceeded its bounded collection limit",
      );
    }
    if (token === undefined) break;
    if (
      importedFindings >= MAX_NATIVE_FINDINGS_PER_SERVICE_REGION ||
      page === MAX_NATIVE_FINDING_PAGES - 1
    ) {
      throw new InventoryProtocolError(
        "Security Hub native finding import exceeded its bounded collection limit",
      );
    }
  }

  await emitNativeFindingsAvailability(
    context,
    observedAt,
    region,
    "securityhub",
    "ENABLED",
    {
      nativeService: "AWS Security Hub",
      importedFindings,
      importMode: "existing-findings-only",
    },
    state,
  );
}

async function collectInspectorFindings(
  context: InventoryCollectionContext,
  region: string,
  client: InspectorInventoryClient,
  observedAt: string,
  state: TaskCollectionState,
): Promise<void> {
  const accountStatus = await client.batchGetAccountStatus({
    accountIds: [context.accountId],
  });
  state.observePage();
  if ((accountStatus.failedAccounts ?? []).length > 0) {
    throw new InventoryProtocolError(
      "Amazon Inspector account status could not be established",
    );
  }
  const account = (accountStatus.accounts ?? []).find(
    (candidate) => candidate.accountId === context.accountId,
  );
  if (account === undefined || account.state?.status === undefined) {
    throw new InventoryProtocolError(
      "Amazon Inspector account status omitted the requested account",
    );
  }
  const inspectorStatus = account.state.status;
  if (inspectorStatus !== "ENABLED") {
    await emitNativeFindingsAvailability(
      context,
      observedAt,
      region,
      "inspector2",
      "DISABLED",
      compact({
        nativeService: "Amazon Inspector",
        accountStatus: inspectorStatus,
        ec2Status: account.resourceState?.ec2?.status,
        ecrStatus: account.resourceState?.ecr?.status,
        lambdaStatus: account.resourceState?.lambda?.status,
        lambdaCodeStatus: account.resourceState?.lambdaCode?.status,
        importMode: "existing-findings-only",
      }),
      state,
    );
    return;
  }

  let token: string | undefined;
  const seen = new Set<string>();
  let importedFindings = 0;
  for (let page = 0; page < MAX_NATIVE_FINDING_PAGES; page += 1) {
    const output = await client.listFindings({
      maxResults: 100,
      filterCriteria: {
        awsAccountId: [{ comparison: "EQUALS", value: context.accountId }],
      },
      ...(token === undefined ? {} : { nextToken: token }),
    });
    state.observePage();
    const remaining = MAX_NATIVE_FINDINGS_PER_SERVICE_REGION - importedFindings;
    const pageFindings = output.findings ?? [];
    const pageWasTruncated = pageFindings.length > Math.max(0, remaining);
    const normalized = pageFindings
      .slice(0, Math.max(0, remaining))
      .map((finding) => normalizeInspectorFinding(context, region, observedAt, finding));
    await state.emit({ resources: [], evidence: normalized });
    state.observeItems(normalized.length);
    importedFindings += normalized.length;
    token = nextToken(output.nextToken, seen, "Amazon Inspector ListFindings");
    if (pageWasTruncated) {
      throw new InventoryProtocolError(
        "Amazon Inspector native finding import exceeded its bounded collection limit",
      );
    }
    if (token === undefined) break;
    if (
      importedFindings >= MAX_NATIVE_FINDINGS_PER_SERVICE_REGION ||
      page === MAX_NATIVE_FINDING_PAGES - 1
    ) {
      throw new InventoryProtocolError(
        "Amazon Inspector native finding import exceeded its bounded collection limit",
      );
    }
  }

  await emitNativeFindingsAvailability(
    context,
    observedAt,
    region,
    "inspector2",
    "ENABLED",
    compact({
      nativeService: "Amazon Inspector",
      accountStatus: inspectorStatus,
      ec2Status: account.resourceState?.ec2?.status,
      ecrStatus: account.resourceState?.ecr?.status,
      lambdaStatus: account.resourceState?.lambda?.status,
      lambdaCodeStatus: account.resourceState?.lambdaCode?.status,
      importedFindings,
      importMode: "existing-findings-only",
    }),
    state,
  );
}

function normalizeGuardDutyFinding(
  context: InventoryCollectionContext,
  region: string,
  observedAt: string,
  finding: GuardDutyFinding,
): NormalizedAwsEvidence {
  if (finding.AccountId !== context.accountId || finding.Region !== region) {
    throw new InventoryProtocolError(
      "GuardDuty returned a finding outside the scoped account or Region",
    );
  }
  const nativeFindingId = requiredNativeIdentifier(finding.Id, "GuardDuty finding ID");
  const resourceIds = guardDutyResourceIds(finding);
  return nativeFindingEvidence(
    context,
    observedAt,
    region,
    "guardduty",
    nativeFindingId,
    resourceIds,
    compact({
      origin: "aws-native-finding",
      nativeService: "AWS GuardDuty",
      nativeFindingId,
      nativeFindingArn: safeNativeIdentifier(finding.Arn, 2_048) ?? undefined,
      nativeType: safeNativeText(finding.Type, 256),
      nativeSeverity: finiteNumber(finding.Severity),
      normalizedSeverity: guardDutySeverity(finding.Severity),
      normalizedStatus: finding.Service?.Archived === true ? "resolved" : "open",
      title: safeNativeText(finding.Title, 180) ?? "AWS GuardDuty finding",
      summary: safeNativeText(finding.Description, 1_200) ??
        "AWS GuardDuty reported a native security finding.",
      remediation: "Review the finding in AWS GuardDuty, validate the affected resource, and follow the customer-approved response runbook.",
      resourceIds,
      resourceType: safeNativeText(finding.Resource?.ResourceType, 128),
      createdAt: safeIso(finding.CreatedAt),
      updatedAt: safeIso(finding.UpdatedAt),
      firstObservedAt: safeIso(finding.Service?.EventFirstSeen),
      lastObservedAt: safeIso(finding.Service?.EventLastSeen),
      archived: finding.Service?.Archived,
    }),
  );
}

function normalizeSecurityHubFinding(
  context: InventoryCollectionContext,
  region: string,
  observedAt: string,
  finding: AwsSecurityFinding,
): NormalizedAwsEvidence {
  if (finding.AwsAccountId !== context.accountId || finding.Region !== region) {
    throw new InventoryProtocolError(
      "Security Hub returned a finding outside the scoped account or Region",
    );
  }
  const nativeFindingId = requiredNativeIdentifier(
    finding.Id,
    "Security Hub finding ID",
  );
  const resources = (finding.Resources ?? [])
    .slice(0, MAX_NATIVE_FINDING_RESOURCES)
    .flatMap((resource) => {
      const id = safeNativeIdentifier(resource.Id, 2_048);
      if (id === null) return [];
      return [compact({
        id,
        type: safeNativeText(resource.Type, 256),
        region: safeRegion(resource.Region),
        partition: safeNativeText(resource.Partition, 32),
      })];
    });
  const resourceIds = resources.flatMap((resource) =>
    typeof resource.id === "string" ? [resource.id] : [],
  );
  return nativeFindingEvidence(
    context,
    observedAt,
    region,
    "securityhub",
    nativeFindingId,
    resourceIds,
    compact({
      origin: "aws-native-finding",
      nativeService: "AWS Security Hub",
      nativeFindingId,
      nativeProductArn: safeNativeIdentifier(finding.ProductArn, 2_048) ?? undefined,
      nativeProductName: safeNativeText(finding.ProductName, 128),
      nativeGeneratorId: safeNativeIdentifier(finding.GeneratorId, 512) ?? undefined,
      nativeTypes: safeNativeStrings(finding.Types, 10, 256),
      nativeSeverity: safeNativeText(finding.Severity?.Label, 32),
      normalizedSeverity: securityHubSeverity(
        finding.Severity?.Label,
        finding.Severity?.Normalized,
      ),
      normalizedStatus: securityHubStatus(
        finding.Workflow?.Status,
        finding.RecordState,
        finding.Compliance?.Status,
      ),
      title: safeNativeText(finding.Title, 180) ?? "AWS Security Hub finding",
      summary: safeNativeText(finding.Description, 1_200) ??
        "AWS Security Hub reported a native security finding.",
      remediation: safeNativeText(finding.Remediation?.Recommendation?.Text, 2_000) ??
        "Review the finding in AWS Security Hub and follow the customer-approved remediation runbook.",
      resourceIds,
      resources,
      workflowStatus: safeNativeText(finding.Workflow?.Status, 32),
      recordState: safeNativeText(finding.RecordState, 32),
      complianceStatus: safeNativeText(finding.Compliance?.Status, 32),
      controlId: safeNativeIdentifier(finding.Compliance?.SecurityControlId, 512) ?? undefined,
      firstObservedAt: safeIso(finding.FirstObservedAt),
      lastObservedAt: safeIso(finding.LastObservedAt),
      createdAt: safeIso(finding.CreatedAt),
      updatedAt: safeIso(finding.UpdatedAt),
    }),
  );
}

function normalizeInspectorFinding(
  context: InventoryCollectionContext,
  region: string,
  observedAt: string,
  finding: InspectorFinding,
): NormalizedAwsEvidence {
  if (finding.awsAccountId !== context.accountId) {
    throw new InventoryProtocolError(
      "Amazon Inspector returned a finding outside the scoped account",
    );
  }
  const nativeFindingId = requiredNativeIdentifier(
    finding.findingArn,
    "Amazon Inspector finding ARN",
  );
  const resources = (finding.resources ?? [])
    .slice(0, MAX_NATIVE_FINDING_RESOURCES)
    .flatMap((resource) => {
      const id = safeNativeIdentifier(resource.id, 2_048);
      if (id === null) return [];
      if (resource.region !== undefined && resource.region !== region) {
        throw new InventoryProtocolError(
          "Amazon Inspector returned a finding resource outside the scoped Region",
        );
      }
      return [compact({
        id,
        type: safeNativeText(resource.type, 128),
        region: safeRegion(resource.region),
        partition: safeNativeText(resource.partition, 32),
      })];
    });
  const resourceIds = resources.flatMap((resource) =>
    typeof resource.id === "string" ? [resource.id] : [],
  );
  return nativeFindingEvidence(
    context,
    observedAt,
    region,
    "inspector2",
    nativeFindingId,
    resourceIds,
    compact({
      origin: "aws-native-finding",
      nativeService: "Amazon Inspector",
      nativeFindingId,
      nativeType: safeNativeText(finding.type, 128),
      nativeSeverity: safeNativeText(finding.severity, 32),
      normalizedSeverity: inspectorSeverity(finding.severity),
      normalizedStatus: inspectorStatus(finding.status),
      title: safeNativeText(finding.title, 180) ?? "Amazon Inspector finding",
      summary: safeNativeText(finding.description, 1_200) ??
        "Amazon Inspector reported a native security finding.",
      remediation: safeNativeText(finding.remediation?.recommendation?.text, 2_000) ??
        "Review the finding in Amazon Inspector and follow the customer-approved remediation runbook.",
      resourceIds,
      resources,
      inspectorScore: finiteNumber(finding.inspectorScore),
      fixAvailable: safeNativeText(finding.fixAvailable, 32),
      exploitAvailable: safeNativeText(finding.exploitAvailable, 32),
      firstObservedAt: safeIso(finding.firstObservedAt),
      lastObservedAt: safeIso(finding.lastObservedAt),
      updatedAt: safeIso(finding.updatedAt),
    }),
  );
}

async function emitNativeFindingsAvailability(
  context: InventoryCollectionContext,
  observedAt: string,
  region: string,
  service: "guardduty" | "securityhub" | "inspector2",
  status: "ENABLED" | "DISABLED",
  data: SafeJsonObject,
  state: TaskCollectionState,
): Promise<void> {
  await state.emit({
    resources: [],
    evidence: [
      evidence(
        context,
        observedAt,
        region,
        service,
        "AWS_NATIVE_FINDINGS_AVAILABILITY",
        context.accountId,
        status,
        data,
      ),
    ],
  });
}

function nativeFindingEvidence(
  context: InventoryCollectionContext,
  observedAt: string,
  region: string,
  service: "guardduty" | "securityhub" | "inspector2",
  nativeFindingId: string,
  resourceIds: readonly string[],
  data: SafeJsonObject,
): NormalizedAwsEvidence {
  const digest = createHash("sha256")
    .update(`${service}\u0000${nativeFindingId}`, "utf8")
    .digest("hex");
  return {
    schemaVersion: 1,
    provider: "aws",
    evidenceKey: `${context.partition}:${context.accountId}:${region}:${service}:AWS_NATIVE_FINDING:${digest}`,
    accountId: context.accountId,
    region,
    service,
    evidenceType: "AWS_NATIVE_FINDING",
    subjectId: resourceIds[0] ?? digest,
    status: "OBSERVED",
    observedAt,
    data,
  };
}

function guardDutyResourceIds(finding: GuardDutyFinding): readonly string[] {
  const resource = finding.Resource;
  return uniqueNativeIds([
    resource?.InstanceDetails?.InstanceId,
    resource?.EcsClusterDetails?.Arn,
    resource?.EcsClusterDetails?.Name,
    resource?.EksClusterDetails?.Arn,
    resource?.EksClusterDetails?.Name,
    resource?.LambdaDetails?.FunctionArn,
    resource?.LambdaDetails?.FunctionName,
    resource?.RdsDbInstanceDetails?.DbInstanceArn,
    resource?.RdsDbInstanceDetails?.DbInstanceIdentifier,
    ...(resource?.S3BucketDetails ?? []).flatMap((bucket) => [bucket.Arn, bucket.Name]),
  ]);
}

function uniqueNativeIds(values: readonly (string | undefined)[]): readonly string[] {
  const result: string[] = [];
  for (const value of values) {
    const safe = safeNativeIdentifier(value, 2_048);
    if (safe !== null && !result.includes(safe)) result.push(safe);
    if (result.length >= MAX_NATIVE_FINDING_RESOURCES) break;
  }
  return result;
}

function requiredNativeIdentifier(value: string | undefined, label: string): string {
  const safe = safeNativeIdentifier(value, 2_048);
  if (safe === null) {
    throw new InventoryProtocolError(`${label} was missing or unsafe`);
  }
  return safe;
}

function safeNativeIdentifier(value: string | undefined, maxLength: number): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    HIGH_CONFIDENCE_SECRET_VALUE.test(value) ||
    CREDENTIAL_URI_OR_SIGNED_URL.test(value)
  ) {
    return null;
  }
  return value;
}

function safeNativeText(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (
    HIGH_CONFIDENCE_SECRET_VALUE.test(value) ||
    CREDENTIAL_URI_OR_SIGNED_URL.test(value)
  ) {
    return "[redacted by Sutra]";
  }
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return normalized.length === 0 ? undefined : normalized.slice(0, maxLength);
}

function safeNativeStrings(
  values: readonly string[] | undefined,
  maxItems: number,
  maxLength: number,
): readonly string[] {
  return (values ?? [])
    .flatMap((value) => {
      const safe = safeNativeText(value, maxLength);
      return safe === undefined ? [] : [safe];
    })
    .slice(0, maxItems);
}

function safeIso(value: string | Date | undefined): string | undefined {
  if (value instanceof Date) return iso(value);
  if (typeof value !== "string" || value.length > 64) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function safeRegion(value: string | undefined): string | undefined {
  return typeof value === "string" && REGION.test(value) ? value : undefined;
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function guardDutySeverity(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "informational";
  }
  if (value >= 7) return "high";
  if (value >= 4) return "medium";
  return "low";
}

function securityHubSeverity(label: string | undefined, normalized: number | undefined): string {
  if (label === "CRITICAL") return "critical";
  if (label === "HIGH") return "high";
  if (label === "MEDIUM") return "medium";
  if (label === "LOW") return "low";
  if (typeof normalized === "number" && Number.isFinite(normalized)) {
    if (normalized >= 90) return "critical";
    if (normalized >= 70) return "high";
    if (normalized >= 40) return "medium";
    if (normalized > 0) return "low";
  }
  return "informational";
}

function securityHubStatus(
  workflow: string | undefined,
  recordState: string | undefined,
  complianceStatus: string | undefined,
): string {
  if (workflow === "SUPPRESSED") return "suppressed";
  if (workflow === "RESOLVED" || recordState === "ARCHIVED" || complianceStatus === "PASSED") {
    return "resolved";
  }
  if (workflow === "NOTIFIED") return "acknowledged";
  return "open";
}

function inspectorSeverity(value: string | undefined): string {
  if (value === "CRITICAL") return "critical";
  if (value === "HIGH") return "high";
  if (value === "MEDIUM") return "medium";
  if (value === "LOW") return "low";
  return "informational";
}

function inspectorStatus(value: string | undefined): string {
  if (value === "SUPPRESSED") return "suppressed";
  if (value === "CLOSED") return "resolved";
  return "open";
}

class BatchState {
  public resourcesObserved = 0;
  public evidenceObserved = 0;
  private writeTail: Promise<void> = Promise.resolve();

  public constructor(private readonly sink: AwsInventorySink) {}

  public async emit(batch: AwsInventoryBatch): Promise<void> {
    if (batch.resources.length === 0 && batch.evidence.length === 0) return;
    const operation = this.writeTail.then(() => this.sink.writeBatch(batch));
    this.writeTail = operation.catch(() => undefined);
    try {
      await operation;
    } catch {
      throw new InventorySinkWriteError();
    }
    this.resourcesObserved += batch.resources.length;
    this.evidenceObserved += batch.evidence.length;
  }
}

class TaskCollectionState {
  private itemsObserved = 0;
  private pagesObserved = 0;
  private partialErrorCode: string | undefined;
  private emittedObservations = false;

  public constructor(
    private readonly parent: BatchState,
    private readonly task: CollectionTask,
  ) {}

  public async emit(batch: AwsInventoryBatch): Promise<void> {
    await this.parent.emit(batch);
    if (batch.resources.length > 0 || batch.evidence.length > 0) {
      this.emittedObservations = true;
    }
  }

  /** Record one successfully returned primary list/describe page. */
  public observePage(itemsObserved = 0): void {
    this.pagesObserved += 1;
    this.observeItems(itemsObserved);
  }

  /** Record normalized collector items only after their sink write succeeds. */
  public observeItems(itemsObserved: number): void {
    if (!Number.isSafeInteger(itemsObserved) || itemsObserved < 0) {
      throw new InventoryProtocolError("Collector produced an invalid item count");
    }
    this.itemsObserved += itemsObserved;
  }

  public markPartial(error: unknown): void {
    this.partialErrorCode ??= coverageErrorCode(error);
  }

  /** Retry only a pristine task so normalized observations can never be duplicated. */
  public canRetry(error: unknown): boolean {
    return (
      this.itemsObserved === 0 &&
      this.pagesObserved === 0 &&
      this.partialErrorCode === undefined &&
      !this.emittedObservations &&
      RETRYABLE_TASK_ERRORS.has(safeErrorName(error))
    );
  }

  public finish(error?: unknown): InventoryCollectorCoverage {
    if (error !== undefined) {
      const timedOut = coverageErrorCode(error) === "COLLECTION_TIMEOUT";
      return {
        collectorKey: this.task.collectorKey,
        region: this.task.region,
        status:
          timedOut || this.pagesObserved > 0 || this.itemsObserved > 0
            ? "PARTIAL"
            : "FAILED",
        itemsObserved: this.itemsObserved,
        pagesObserved: this.pagesObserved,
        errorCode: coverageErrorCode(error),
        message:
          timedOut
            ? "The read-only AWS collector reached its bounded deadline."
            : this.pagesObserved > 0 || this.itemsObserved > 0
            ? "The read-only AWS collector returned only partial coverage."
            : "The read-only AWS collector did not return a usable page.",
      };
    }
    if (this.partialErrorCode !== undefined) {
      return {
        collectorKey: this.task.collectorKey,
        region: this.task.region,
        status: "PARTIAL",
        itemsObserved: this.itemsObserved,
        pagesObserved: this.pagesObserved,
        errorCode: this.partialErrorCode,
        message: "One or more read-only AWS API calls did not complete.",
      };
    }
    return {
      collectorKey: this.task.collectorKey,
      region: this.task.region,
      status: "SUCCEEDED",
      itemsObserved: this.itemsObserved,
      pagesObserved: this.pagesObserved,
    };
  }
}

class InventorySinkWriteError extends Error {
  public constructor() {
    super("Normalized AWS inventory sink write failed");
    this.name = "InventorySinkWriteError";
  }
}

export class InventoryConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InventoryConfigurationError";
  }
}

export class InventoryProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InventoryProtocolError";
  }
}

function task(
  collectorKey: string,
  service: string,
  subject: string,
  region: string,
  run: (state: TaskCollectionState) => Promise<void>,
): CollectionTask {
  return { collectorKey, service, subject, region, run };
}

function resource(
  context: InventoryCollectionContext,
  observedAt: string,
  region: string,
  service: string,
  resourceType: string,
  resourceId: string,
  arn: string | undefined,
  configuration: SafeJsonObject,
  rawTags: readonly { readonly Key?: string | undefined; readonly Value?: string | undefined }[] = [],
): NormalizedAwsResource {
  const base = {
    schemaVersion: 1 as const,
    provider: "aws" as const,
    resourceKey: `${context.partition}:${context.accountId}:${region}:${service}:${resourceType}:${resourceId}`,
    accountId: context.accountId,
    region,
    service,
    resourceType,
    resourceId,
    observedAt,
    tags: normalizeTags(rawTags),
    configuration,
  };
  return arn === undefined ? base : { ...base, arn };
}

function resourceFromApi(
  context: InventoryCollectionContext,
  observedAt: string,
  region: string,
  service: string,
  resourceType: string,
  resourceId: string,
  arn: string | undefined,
  sourceApi: string,
  configuration: SafeJsonObject,
  rawTags: readonly { readonly Key?: string | undefined; readonly Value?: string | undefined }[] = [],
): NormalizedAwsResource {
  return {
    ...resource(
      context,
      observedAt,
      region,
      service,
      resourceType,
      resourceId,
      arn,
      configuration,
      rawTags,
    ),
    sourceApi,
  };
}

function normalizeTags(
  values: readonly { readonly Key?: string | undefined; readonly Value?: string | undefined }[],
): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const tag of values.slice(0, 50)) {
    const key = tag.Key;
    const value = tag.Value;
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.length > 128 ||
      typeof value !== "string" ||
      value.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(value) ||
      HIGH_CONFIDENCE_SECRET_VALUE.test(value) ||
      CREDENTIAL_URI_OR_SIGNED_URL.test(value) ||
      LONG_OPAQUE_TAG_TOKEN.test(value) ||
      DANGEROUS_TAG_KEYS.has(key.toLowerCase()) ||
      !SAFE_TAG_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/gu, "")) ||
      /(?:secret|password|passwd|token|credential|private[_. -]?key|api[_. -]?key)/iu.test(key)
    ) {
      continue;
    }
    result[key] = value;
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function evidence(
  context: InventoryCollectionContext,
  observedAt: string,
  region: string,
  service: string,
  evidenceType: string,
  subjectId: string,
  status: InventoryEvidenceStatus,
  data: SafeJsonObject,
): NormalizedAwsEvidence {
  return {
    schemaVersion: 1,
    provider: "aws",
    evidenceKey: `${context.partition}:${context.accountId}:${region}:${service}:${evidenceType}:${subjectId}`,
    accountId: context.accountId,
    region,
    service,
    evidenceType,
    subjectId,
    status,
    observedAt,
    data,
  };
}

function normalizeIpPermission(permission: IpPermission): SafeJsonObject {
  return compact({
    protocol: permission.IpProtocol,
    fromPort: permission.FromPort,
    toPort: permission.ToPort,
    ipv4Cidrs: strings((permission.IpRanges ?? []).map((range) => range.CidrIp)),
    ipv6Cidrs: strings((permission.Ipv6Ranges ?? []).map((range) => range.CidrIpv6)),
    prefixListIds: strings(
      (permission.PrefixListIds ?? []).map((prefix) => prefix.PrefixListId),
    ),
    referencedSecurityGroupIds: strings(
      (permission.UserIdGroupPairs ?? []).map((pair) => pair.GroupId),
    ),
  });
}

function publicAccessBlockData(output: GetPublicAccessBlockCommandOutput): SafeJsonObject {
  return {
    blockPublicAcls: output.PublicAccessBlockConfiguration?.BlockPublicAcls ?? false,
    ignorePublicAcls: output.PublicAccessBlockConfiguration?.IgnorePublicAcls ?? false,
    blockPublicPolicy: output.PublicAccessBlockConfiguration?.BlockPublicPolicy ?? false,
    restrictPublicBuckets:
      output.PublicAccessBlockConfiguration?.RestrictPublicBuckets ?? false,
  };
}

function publicAccessBlockFullyConfigured(data: SafeJsonObject): boolean {
  return data.blockPublicAcls === true &&
    data.ignorePublicAcls === true &&
    data.blockPublicPolicy === true &&
    data.restrictPublicBuckets === true;
}

function compact(
  values: Readonly<Record<string, SafeJsonValue | undefined>>,
): SafeJsonObject {
  const result: Record<string, SafeJsonValue> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function strings(values: readonly (string | undefined)[]): readonly string[] {
  return values.filter((value): value is string => value !== undefined);
}

function iso(value: Date | undefined): string | undefined {
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString()
    : undefined;
}

function nextToken(
  value: string | undefined,
  seen: Set<string>,
  operation: string,
): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (seen.has(value)) {
    throw new InventoryProtocolError(`${operation} returned a repeated pagination token`);
  }
  seen.add(value);
  return value;
}

function normalizeRegions(values: readonly string[]): readonly string[] {
  const regions = [...new Set(values)].sort();
  if (
    regions.length === 0 ||
    regions.length > MAX_REGIONS ||
    regions.some((region) => !REGION.test(region))
  ) {
    throw new InventoryConfigurationError("Selected AWS Regions are invalid");
  }
  return regions;
}

function normalizeDiscoveredRegions(values: readonly string[]): readonly string[] {
  const regions = [...new Set(values)].sort();
  if (
    regions.length > MAX_REGIONS ||
    regions.some((region) => !REGION.test(region))
  ) {
    throw new InventoryConfigurationError("AWS returned invalid enabled Region data");
  }
  return regions;
}

function validateConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    throw new InventoryConfigurationError("Inventory concurrency must be between 1 and 16");
  }
  return value;
}

function validateMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new InventoryConfigurationError("AWS SDK max attempts must be between 1 and 10");
  }
  return value;
}

function validateDeadline(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 15 * 60_000) {
    throw new InventoryConfigurationError(`${label} must be between 1 ms and 15 minutes`);
  }
  return value;
}

class InventoryDeadlineError extends Error {
  public constructor(public readonly scope: "command" | "collection") {
    super("The bounded AWS inventory deadline was reached");
    this.name = scope === "command"
      ? "InventoryCommandDeadlineError"
      : "InventoryCollectionDeadlineError";
  }
}

async function runWithCommandDeadline<T>(
  overallSignal: AbortSignal,
  commandDeadlineMs: number,
  operation: (signal: AbortSignal) => Promise<T> | T,
): Promise<T> {
  if (overallSignal.aborted) {
    throw overallSignal.reason instanceof InventoryDeadlineError
      ? overallSignal.reason
      : new InventoryDeadlineError("collection");
  }

  const commandController = new AbortController();
  const forwardOverallAbort = () => {
    commandController.abort(
      overallSignal.reason instanceof InventoryDeadlineError
        ? overallSignal.reason
        : new InventoryDeadlineError("collection"),
    );
  };
  overallSignal.addEventListener("abort", forwardOverallAbort, { once: true });
  const commandTimer = setTimeout(
    () => commandController.abort(new InventoryDeadlineError("command")),
    commandDeadlineMs,
  );

  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        callback();
      };
      const rejectForAbort = () => {
        const reason = commandController.signal.reason;
        finish(() => reject(
          reason instanceof InventoryDeadlineError
            ? reason
            : new InventoryDeadlineError(
              overallSignal.aborted ? "collection" : "command",
            ),
        ));
      };
      commandController.signal.addEventListener("abort", rejectForAbort, { once: true });
      Promise.resolve()
        .then(() => operation(commandController.signal))
        .then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(
            commandController.signal.aborted
              ? commandController.signal.reason
              : error,
          )),
        );
    });
  } finally {
    clearTimeout(commandTimer);
    overallSignal.removeEventListener("abort", forwardOverallAbort);
  }
}

async function runBounded<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        const value = values[index];
        if (value === undefined) return;
        await worker(value);
      }
    },
  );
  const results = await Promise.allSettled(workers);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure !== undefined) throw failure.reason;
}

function isNamedError(error: unknown, name: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === name
  );
}

function safeErrorName(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    /^[A-Za-z0-9_.-]{1,80}$/.test(error.name)
  ) {
    return error.name;
  }
  return "UnknownError";
}

function coverageErrorCode(error: unknown): string {
  if (error instanceof InventoryDeadlineError || isNamedError(error, "AbortError")) {
    return "COLLECTION_TIMEOUT";
  }
  if (error instanceof InventoryProtocolError) return "COLLECTOR_PROTOCOL_ERROR";
  const name = safeErrorName(error);
  return name === "Error" || name === "UnknownError" ? "AWS_API_ERROR" : name;
}

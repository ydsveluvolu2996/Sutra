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
  DescribeInstancesCommand,
  DescribeRegionsCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
  type DescribeInstancesCommandInput,
  type DescribeInstancesCommandOutput,
  type DescribeRegionsCommandOutput,
  type DescribeSecurityGroupsCommandInput,
  type DescribeSecurityGroupsCommandOutput,
  type DescribeSubnetsCommandInput,
  type DescribeSubnetsCommandOutput,
  type DescribeVpcsCommandInput,
  type DescribeVpcsCommandOutput,
  type IpPermission,
} from "@aws-sdk/client-ec2";
import {
  GetDetectorCommand,
  GuardDutyClient,
  ListDetectorsCommand,
  type GetDetectorCommandInput,
  type GetDetectorCommandOutput,
  type ListDetectorsCommandInput,
  type ListDetectorsCommandOutput,
} from "@aws-sdk/client-guardduty";
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
  SecurityHubClient,
  type DescribeHubCommandOutput,
} from "@aws-sdk/client-securityhub";

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

const REGION = /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]+$/;
const MAX_REGIONS = 64;
const MAX_PAGES = 10_000;
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
  ): Promise<readonly string[]> | readonly string[];
}

export class StaticInventoryRegionSelector implements InventoryRegionSelector {
  public constructor(private readonly regions: readonly string[]) {}

  public selectRegions(): readonly string[] {
    return this.regions;
  }
}

export interface AwsRegionDiscoveryClient {
  describeRegions(): Promise<DescribeRegionsCommandOutput>;
}

export interface AwsEnabledRegionSelectorOptions {
  readonly controlRegion: string;
  readonly requestedRegions: readonly string[];
  readonly maxAttempts?: number;
  readonly clientFactory?: (
    controlRegion: string,
    credentials: AwsTemporaryCredentials,
  ) => AwsRegionDiscoveryClient;
}

/** Discovers account-enabled Regions and refuses to silently skip a requested Region. */
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
  ): Promise<readonly string[]> {
    const client = this.options.clientFactory?.(
      this.options.controlRegion,
      context.credentials,
    ) ?? this.createClient(context.credentials);
    const output = await client.describeRegions();
    const enabled = new Set(
      (output.Regions ?? []).flatMap((region) =>
        typeof region.RegionName === "string" &&
        (region.OptInStatus === "opted-in" || region.OptInStatus === "opt-in-not-required")
          ? [region.RegionName]
          : [],
      ),
    );
    const requested = normalizeRegions(this.options.requestedRegions);
    const unavailable = requested.filter((region) => !enabled.has(region));
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
      describeRegions: () =>
        client.send(new DescribeRegionsCommand({ AllRegions: true })),
    };
  }
}

export interface Ec2InventoryClient {
  describeInstances(
    input: DescribeInstancesCommandInput,
  ): Promise<DescribeInstancesCommandOutput>;
  describeVpcs(input: DescribeVpcsCommandInput): Promise<DescribeVpcsCommandOutput>;
  describeSubnets(
    input: DescribeSubnetsCommandInput,
  ): Promise<DescribeSubnetsCommandOutput>;
  describeSecurityGroups(
    input: DescribeSecurityGroupsCommandInput,
  ): Promise<DescribeSecurityGroupsCommandOutput>;
}

export interface S3InventoryClient {
  listBuckets(input: ListBucketsCommandInput): Promise<ListBucketsCommandOutput>;
  getPublicAccessBlock(
    input: GetPublicAccessBlockCommandInput,
  ): Promise<GetPublicAccessBlockCommandOutput>;
}

export interface RdsInventoryClient {
  describeDBInstances(
    input: DescribeDBInstancesCommandInput,
  ): Promise<DescribeDBInstancesCommandOutput>;
}

export interface IamInventoryClient {
  getAccountSummary(): Promise<GetAccountSummaryCommandOutput>;
  getAccountPasswordPolicy(): Promise<GetAccountPasswordPolicyCommandOutput>;
}

export interface CloudTrailInventoryClient {
  describeTrails(input: DescribeTrailsCommandInput): Promise<DescribeTrailsCommandOutput>;
  getTrailStatus(
    input: GetTrailStatusCommandInput,
  ): Promise<GetTrailStatusCommandOutput>;
}

export interface GuardDutyInventoryClient {
  listDetectors(input: ListDetectorsCommandInput): Promise<ListDetectorsCommandOutput>;
  getDetector(input: GetDetectorCommandInput): Promise<GetDetectorCommandOutput>;
}

export interface SecurityHubInventoryClient {
  describeHub(): Promise<DescribeHubCommandOutput>;
}

export interface AwsInventoryClientFactory {
  ec2(region: string, credentials: AwsTemporaryCredentials): Ec2InventoryClient;
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
}

export interface AwsSdkInventoryClientFactoryOptions {
  readonly maxAttempts?: number;
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
      describeInstances: (input) => client.send(new DescribeInstancesCommand(input)),
      describeVpcs: (input) => client.send(new DescribeVpcsCommand(input)),
      describeSubnets: (input) => client.send(new DescribeSubnetsCommand(input)),
      describeSecurityGroups: (input) =>
        client.send(new DescribeSecurityGroupsCommand(input)),
    };
  }

  public s3(region: string, credentials: AwsTemporaryCredentials): S3InventoryClient {
    const client = new S3Client(this.clientConfig(region, credentials));
    return {
      listBuckets: (input) => client.send(new ListBucketsCommand(input)),
      getPublicAccessBlock: (input) =>
        client.send(new GetPublicAccessBlockCommand(input)),
    };
  }

  public rds(region: string, credentials: AwsTemporaryCredentials): RdsInventoryClient {
    const client = new RDSClient(this.clientConfig(region, credentials));
    return {
      describeDBInstances: (input) =>
        client.send(new DescribeDBInstancesCommand(input)),
    };
  }

  public iam(region: string, credentials: AwsTemporaryCredentials): IamInventoryClient {
    const client = new IAMClient(this.clientConfig(region, credentials));
    return {
      getAccountSummary: () => client.send(new GetAccountSummaryCommand({})),
      getAccountPasswordPolicy: () =>
        client.send(new GetAccountPasswordPolicyCommand({})),
    };
  }

  public cloudTrail(
    region: string,
    credentials: AwsTemporaryCredentials,
  ): CloudTrailInventoryClient {
    const client = new CloudTrailClient(this.clientConfig(region, credentials));
    return {
      describeTrails: (input) => client.send(new DescribeTrailsCommand(input)),
      getTrailStatus: (input) => client.send(new GetTrailStatusCommand(input)),
    };
  }

  public guardDuty(
    region: string,
    credentials: AwsTemporaryCredentials,
  ): GuardDutyInventoryClient {
    const client = new GuardDutyClient(this.clientConfig(region, credentials));
    return {
      listDetectors: (input) => client.send(new ListDetectorsCommand(input)),
      getDetector: (input) => client.send(new GetDetectorCommand(input)),
    };
  }

  public securityHub(
    region: string,
    credentials: AwsTemporaryCredentials,
  ): SecurityHubInventoryClient {
    const client = new SecurityHubClient(this.clientConfig(region, credentials));
    return {
      describeHub: () => client.send(new DescribeHubCommand({})),
    };
  }

  private clientConfig(region: string, credentials: AwsTemporaryCredentials) {
    return {
      region,
      credentials,
      retryMode: "standard" as const,
      maxAttempts: this.maxAttempts,
    };
  }
}

export interface SingleAccountAwsInventoryRunnerDependencies {
  readonly clients: AwsInventoryClientFactory;
  readonly sink: AwsInventorySink;
  readonly regionSelector: InventoryRegionSelector;
  readonly globalControlRegion?: string;
  readonly maxConcurrency?: number;
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
  private readonly now: () => Date;

  public constructor(
    private readonly dependencies: SingleAccountAwsInventoryRunnerDependencies,
  ) {
    this.maxConcurrency = validateConcurrency(dependencies.maxConcurrency ?? 4);
    this.now = dependencies.now ?? (() => new Date());
  }

  public async collect(
    context: InventoryCollectionContext,
  ): Promise<InventoryCollectionResult> {
    const regions = normalizeRegions(
      await this.dependencies.regionSelector.selectRegions({
        tenantId: context.tenantId,
        connectionId: context.connectionId,
        accountId: context.accountId,
        partition: context.partition,
        credentials: context.credentials,
      }),
    );
    const controlRegion = this.dependencies.globalControlRegion ?? regions[0];
    if (controlRegion === undefined || !REGION.test(controlRegion)) {
      throw new InventoryConfigurationError("A valid global control Region is required");
    }

    const observedAt = this.now().toISOString();
    const state = new BatchState(this.dependencies.sink);
    const tasks = this.buildTasks(context, regions, controlRegion, observedAt);
    const collectorCoverage = new Array<InventoryCollectorCoverage>(tasks.length);

    await runBounded(tasks.map((value, index) => ({ value, index })), this.maxConcurrency, async ({ value: task, index }) => {
      const taskState = new TaskCollectionState(state, task);
      try {
        await task.run(taskState);
        collectorCoverage[index] = taskState.finish();
      } catch (error: unknown) {
        if (error instanceof InventorySinkWriteError) {
          throw error;
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
      }
    });

    const partial = collectorCoverage.some((entry) => entry.status !== "SUCCEEDED");

    return {
      resourcesObserved: state.resourcesObserved,
      findingsObserved: state.evidenceObserved,
      coverage: partial ? "PARTIAL" : "COMPLETE",
      collectorCoverage,
    };
  }

  private buildTasks(
    context: InventoryCollectionContext,
    regions: readonly string[],
    controlRegion: string,
    observedAt: string,
  ): CollectionTask[] {
    const credentials = context.credentials;
    const tasks: CollectionTask[] = [];
    const iam = this.dependencies.clients.iam(controlRegion, credentials);
    const collectCloudTrailRegion = createCloudTrailCollector(
      context,
      observedAt,
      this.dependencies.clients,
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
      const ec2 = this.dependencies.clients.ec2(region, credentials);
      const rds = this.dependencies.clients.rds(region, credentials);
      const cloudTrail = this.dependencies.clients.cloudTrail(region, credentials);
      const guardDuty = this.dependencies.clients.guardDuty(region, credentials);
      const securityHub = this.dependencies.clients.securityHub(region, credentials);
      const s3 = this.dependencies.clients.s3(region, credentials);

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
        task("rds.db-instances", "rds", "db-instances", region, (state) =>
          collectRds(context, region, rds, observedAt, state),
        ),
        task("cloudtrail.trails", "cloudtrail", "trails", region, (state) =>
          collectCloudTrailRegion(region, cloudTrail, state),
        ),
        task("guardduty.detectors", "guardduty", "detectors", region, (state) =>
          collectGuardDuty(context, region, guardDuty, observedAt, state),
        ),
        task("securityhub.hub", "securityhub", "hub", region, (state) =>
          collectSecurityHub(context, region, securityHub, observedAt, state),
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
    if (!isNamedError(error, "NoSuchEntity")) throw error;
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

  public constructor(
    private readonly parent: BatchState,
    private readonly task: CollectionTask,
  ) {}

  public emit(batch: AwsInventoryBatch): Promise<void> {
    return this.parent.emit(batch);
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

  public finish(error?: unknown): InventoryCollectorCoverage {
    if (error !== undefined) {
      return {
        collectorKey: this.task.collectorKey,
        region: this.task.region,
        status:
          this.pagesObserved > 0 || this.itemsObserved > 0 ? "PARTIAL" : "FAILED",
        itemsObserved: this.itemsObserved,
        pagesObserved: this.pagesObserved,
        errorCode: coverageErrorCode(error),
        message:
          this.pagesObserved > 0 || this.itemsObserved > 0
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
  await Promise.all(workers);
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
  if (error instanceof InventoryProtocolError) return "COLLECTOR_PROTOCOL_ERROR";
  const name = safeErrorName(error);
  return name === "Error" || name === "UnknownError" ? "AWS_API_ERROR" : name;
}

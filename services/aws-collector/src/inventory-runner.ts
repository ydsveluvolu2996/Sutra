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
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
  type DescribeInstancesCommandInput,
  type DescribeInstancesCommandOutput,
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
  GetBucketLocationCommand,
  GetPublicAccessBlockCommand,
  ListBucketsCommand,
  S3Client,
  type GetBucketLocationCommandInput,
  type GetBucketLocationCommandOutput,
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

export interface InventorySelectionContext {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: string;
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
  getBucketLocation(
    input: GetBucketLocationCommandInput,
  ): Promise<GetBucketLocationCommandOutput>;
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
      getBucketLocation: (input) => client.send(new GetBucketLocationCommand(input)),
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
  readonly service: string;
  readonly subject: string;
  readonly region: string;
  run(): Promise<void>;
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
      }),
    );
    const controlRegion = this.dependencies.globalControlRegion ?? regions[0];
    if (controlRegion === undefined || !REGION.test(controlRegion)) {
      throw new InventoryConfigurationError("A valid global control Region is required");
    }

    const observedAt = this.now().toISOString();
    const state = new BatchState(this.dependencies.sink);
    const tasks = this.buildTasks(context, regions, controlRegion, observedAt, state);

    await runBounded(tasks, this.maxConcurrency, async (task) => {
      try {
        await task.run();
      } catch (error: unknown) {
        if (error instanceof InventorySinkWriteError) {
          throw error;
        }
        state.markPartial();
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
      }
    });

    return {
      resourcesObserved: state.resourcesObserved,
      findingsObserved: state.evidenceObserved,
      coverage: state.partial ? "PARTIAL" : "COMPLETE",
    };
  }

  private buildTasks(
    context: InventoryCollectionContext,
    regions: readonly string[],
    controlRegion: string,
    observedAt: string,
    state: BatchState,
  ): CollectionTask[] {
    const credentials = context.credentials;
    const tasks: CollectionTask[] = [];
    const iam = this.dependencies.clients.iam(controlRegion, credentials);
    const s3 = this.dependencies.clients.s3(controlRegion, credentials);
    const s3ByRegion = new Map<string, S3InventoryClient>([[controlRegion, s3]]);
    const s3ForRegion = (region: string): S3InventoryClient => {
      const existing = s3ByRegion.get(region);
      if (existing !== undefined) return existing;
      const created = this.dependencies.clients.s3(region, credentials);
      s3ByRegion.set(region, created);
      return created;
    };

    tasks.push(
      task("iam", "account-summary", "global", () =>
        collectIamSummary(context, iam, observedAt, state),
      ),
      task("iam", "password-policy", "global", () =>
        collectIamPasswordPolicy(context, iam, observedAt, state),
      ),
      task("s3", "buckets", "global", () =>
        collectS3(
          context,
          s3,
          s3ForRegion,
          observedAt,
          state,
        ),
      ),
    );

    for (const region of regions) {
      const ec2 = this.dependencies.clients.ec2(region, credentials);
      const rds = this.dependencies.clients.rds(region, credentials);
      const cloudTrail = this.dependencies.clients.cloudTrail(region, credentials);
      const guardDuty = this.dependencies.clients.guardDuty(region, credentials);
      const securityHub = this.dependencies.clients.securityHub(region, credentials);

      tasks.push(
        task("ec2", "instances", region, () =>
          collectEc2Instances(context, region, ec2, observedAt, state),
        ),
        task("ec2", "vpcs", region, () =>
          collectVpcs(context, region, ec2, observedAt, state),
        ),
        task("ec2", "subnets", region, () =>
          collectSubnets(context, region, ec2, observedAt, state),
        ),
        task("ec2", "security-groups", region, () =>
          collectSecurityGroups(context, region, ec2, observedAt, state),
        ),
        task("rds", "db-instances", region, () =>
          collectRds(context, region, rds, observedAt, state),
        ),
        task("cloudtrail", "trails", region, () =>
          collectCloudTrail(context, region, cloudTrail, observedAt, state),
        ),
        task("guardduty", "detectors", region, () =>
          collectGuardDuty(context, region, guardDuty, observedAt, state),
        ),
        task("securityhub", "hub", region, () =>
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
  state: BatchState,
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
          ),
        );
      }
    }
    await state.emit({ resources, evidence: [] });
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
  state: BatchState,
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
            ),
          ],
    );
    await state.emit({ resources, evidence: [] });
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
  state: BatchState,
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
            ),
          ],
    );
    await state.emit({ resources, evidence: [] });
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
  state: BatchState,
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
            ),
          ],
    );
    await state.emit({ resources, evidence: [] });
    token = nextToken(output.NextToken, seen, "EC2 DescribeSecurityGroups");
    if (token === undefined) return;
  }
  throw new InventoryProtocolError("EC2 DescribeSecurityGroups exceeded pagination limit");
}

async function collectS3(
  context: InventoryCollectionContext,
  listClient: S3InventoryClient,
  clientForRegion: (region: string) => S3InventoryClient,
  observedAt: string,
  state: BatchState,
): Promise<void> {
  let continuationToken: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await listClient.listBuckets(
      continuationToken === undefined
        ? { MaxBuckets: 1000 }
        : { MaxBuckets: 1000, ContinuationToken: continuationToken },
    );
    for (const bucket of output.Buckets ?? []) {
      if (bucket.Name === undefined) continue;
      const locationOutput = await listClient.getBucketLocation({ Bucket: bucket.Name });
      const bucketRegion = normalizeBucketRegion(locationOutput.LocationConstraint);
      const resourceRecord = resource(
        context,
        observedAt,
        bucketRegion,
        "s3",
        "aws.s3.bucket",
        bucket.Name,
        `arn:${context.partition}:s3:::${bucket.Name}`,
        compact({
          creationDate: iso(bucket.CreationDate),
          bucketRegion,
        }),
      );

      let blockStatus: InventoryEvidenceStatus = "CONFIGURED";
      let blockData: SafeJsonObject;
      try {
        const block = await clientForRegion(bucketRegion).getPublicAccessBlock({
          Bucket: bucket.Name,
        });
        blockData = publicAccessBlockData(block);
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
          state.markPartial();
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
            bucketRegion,
            "s3",
            "S3_PUBLIC_ACCESS_BLOCK",
            bucket.Name,
            blockStatus,
            blockData,
          ),
        ],
      });
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
  state: BatchState,
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
            ),
          ],
    );
    await state.emit({ resources, evidence: [] });
    marker = nextToken(output.Marker, seen, "RDS DescribeDBInstances");
    if (marker === undefined) return;
  }
  throw new InventoryProtocolError("RDS DescribeDBInstances exceeded pagination limit");
}

async function collectIamSummary(
  context: InventoryCollectionContext,
  client: IamInventoryClient,
  observedAt: string,
  state: BatchState,
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
}

async function collectIamPasswordPolicy(
  context: InventoryCollectionContext,
  client: IamInventoryClient,
  observedAt: string,
  state: BatchState,
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
  }
}

async function collectCloudTrail(
  context: InventoryCollectionContext,
  region: string,
  client: CloudTrailInventoryClient,
  observedAt: string,
  state: BatchState,
): Promise<void> {
  const output = await client.describeTrails({ includeShadowTrails: false });
  const resources: NormalizedAwsResource[] = [];
  const trailEvidence: NormalizedAwsEvidence[] = [];
  for (const trail of output.trailList ?? []) {
    const trailId = trail.TrailARN ?? trail.Name;
    if (trailId === undefined) continue;
    const status = await client.getTrailStatus({ Name: trailId });
    resources.push(
      resource(
        context,
        observedAt,
        region,
        "cloudtrail",
        "aws.cloudtrail.trail",
        trailId,
        trail.TrailARN,
        compact({
          name: trail.Name,
          homeRegion: trail.HomeRegion,
          isMultiRegionTrail: trail.IsMultiRegionTrail,
          includeGlobalServiceEvents: trail.IncludeGlobalServiceEvents,
          logFileValidationEnabled: trail.LogFileValidationEnabled,
          hasCustomEventSelectors: trail.HasCustomEventSelectors,
          hasInsightSelectors: trail.HasInsightSelectors,
          s3BucketName: trail.S3BucketName,
          kmsKeyId: trail.KmsKeyId,
          cloudWatchLogsLogGroupArn: trail.CloudWatchLogsLogGroupArn,
        }),
      ),
    );
    trailEvidence.push(
      evidence(
        context,
        observedAt,
        region,
        "cloudtrail",
        "CLOUDTRAIL_LOGGING_STATUS",
        trailId,
        status.IsLogging === true ? "ENABLED" : "DISABLED",
        compact({
          isLogging: status.IsLogging,
          latestDeliveryTime: iso(status.LatestDeliveryTime),
          latestDigestDeliveryTime: iso(status.LatestDigestDeliveryTime),
          startLoggingTime: iso(status.StartLoggingTime),
          stopLoggingTime: iso(status.StopLoggingTime),
        }),
      ),
    );
  }
  await state.emit({ resources, evidence: trailEvidence });
}

async function collectGuardDuty(
  context: InventoryCollectionContext,
  region: string,
  client: GuardDutyInventoryClient,
  observedAt: string,
  state: BatchState,
): Promise<void> {
  let token: string | undefined;
  const seen = new Set<string>();
  let detectorCount = 0;
  let enabledCount = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const output = await client.listDetectors(
      token === undefined ? { MaxResults: 50 } : { MaxResults: 50, NextToken: token },
    );
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
  state: BatchState,
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
  }
}

class BatchState {
  public resourcesObserved = 0;
  public evidenceObserved = 0;
  public partial = false;
  private writeTail: Promise<void> = Promise.resolve();

  public constructor(private readonly sink: AwsInventorySink) {}

  public markPartial(): void {
    this.partial = true;
  }

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
  service: string,
  subject: string,
  region: string,
  run: () => Promise<void>,
): CollectionTask {
  return { service, subject, region, run };
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
    configuration,
  };
  return arn === undefined ? base : { ...base, arn };
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

function normalizeBucketRegion(value: string | undefined): string {
  if (value === undefined || value.length === 0) return "us-east-1";
  if (value === "EU") return "eu-west-1";
  return value;
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

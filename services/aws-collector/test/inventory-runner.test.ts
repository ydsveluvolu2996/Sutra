import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import { test } from "node:test";

import {
  AWS_INVENTORY_CONNECTION_TIMEOUT_MS,
  AWS_INVENTORY_REQUEST_TIMEOUT_MS,
  AwsEnabledRegionSelector,
  SingleAccountAwsInventoryRunner,
  StaticInventoryRegionSelector,
  awsInventorySdkClientConfig,
  type AwsInventoryClientFactory,
  type CloudTrailInventoryClient,
  type DynamoDbInventoryClient,
  type Ec2InventoryClient,
  type EcrInventoryClient,
  type EksInventoryClient,
  type Elbv2InventoryClient,
  type GuardDutyInventoryClient,
  type IamInventoryClient,
  type InspectorInventoryClient,
  type KmsInventoryClient,
  type RdsInventoryClient,
  type S3InventoryClient,
  type SecurityHubInventoryClient,
} from "../src/inventory-runner.js";
import { normalizeLiveSnapshot } from "../src/local-server.js";
import type {
  AwsInventoryBatch,
  AwsInventorySink,
  InventoryCollectionContext,
} from "../src/types.js";
import { ALL_ENABLED_AWS_REGIONS } from "../src/aws-region-selection.js";
import {
  LIVE_AWS_COVERAGE_ROW_LIMIT,
  LIVE_AWS_GLOBAL_COLLECTOR_COUNT,
  LIVE_AWS_MAX_REGIONS,
  LIVE_AWS_REGIONAL_COLLECTOR_COUNT,
} from "../src/live-collection-limits.js";

test("real AWS inventory clients bound each transport attempt inside the command deadline", () => {
  const credentials = context().credentials;
  assert.deepEqual(awsInventorySdkClientConfig("us-east-1", credentials, 4), {
    region: "us-east-1",
    credentials,
    retryMode: "standard",
    maxAttempts: 4,
    requestHandler: {
      connectionTimeout: AWS_INVENTORY_CONNECTION_TIMEOUT_MS,
      requestTimeout: AWS_INVENTORY_REQUEST_TIMEOUT_MS,
    },
  });
  assert.equal(AWS_INVENTORY_CONNECTION_TIMEOUT_MS, 5_000);
  assert.equal(AWS_INVENTORY_REQUEST_TIMEOUT_MS, 10_000);
});

test("discovers enabled AWS Regions and rejects disabled selections", async () => {
  const calls: string[] = [];
  const selector = new AwsEnabledRegionSelector({
    controlRegion: "us-east-1",
    requestedRegions: ["us-west-2", "us-east-1"],
    clientFactory: (region) => ({
      describeRegions: async () => {
        calls.push(region);
        return {
          $metadata: {},
          Regions: [
            { RegionName: "us-west-2", OptInStatus: "opt-in-not-required" },
            { RegionName: "us-east-1", OptInStatus: "opted-in" },
            { RegionName: "ap-east-1", OptInStatus: "not-opted-in" },
          ],
        };
      },
    }),
  });

  assert.deepEqual(await selector.selectRegions(context()), ["us-east-1", "us-west-2"]);
  assert.deepEqual(calls, ["us-east-1"]);

  const disabled = new AwsEnabledRegionSelector({
    controlRegion: "us-east-1",
    requestedRegions: ["ap-east-1"],
    clientFactory: () => ({
      describeRegions: async () => ({
        $metadata: {},
        Regions: [{ RegionName: "ap-east-1", OptInStatus: "not-opted-in" }],
      }),
    }),
  });
  await assert.rejects(
    () => disabled.selectRegions(context()),
    /Selected AWS Regions are not enabled: ap-east-1/,
  );

  const allEnabled = new AwsEnabledRegionSelector({
    controlRegion: "us-east-1",
    requestedRegions: [ALL_ENABLED_AWS_REGIONS],
    clientFactory: () => ({
      describeRegions: async () => ({
        $metadata: {},
        Regions: [
          { RegionName: "us-west-2", OptInStatus: "opted-in" },
          { RegionName: "ap-east-1", OptInStatus: "not-opted-in" },
          { RegionName: "us-east-1", OptInStatus: "opt-in-not-required" },
        ],
      }),
    }),
  });
  assert.deepEqual(await allEnabled.selectRegions(context()), ["us-east-1", "us-west-2"]);
  assert.equal((await allEnabled.selectRegions(context())).includes(ALL_ENABLED_AWS_REGIONS), false);

  const mixed = new AwsEnabledRegionSelector({
    controlRegion: "us-east-1",
    requestedRegions: [ALL_ENABLED_AWS_REGIONS, "us-east-1"],
    clientFactory: () => ({
      describeRegions: async () => ({
        $metadata: {},
        Regions: [{ RegionName: "us-east-1", OptInStatus: "opt-in-not-required" }],
      }),
    }),
  });
  await assert.rejects(
    () => mixed.selectRegions(context()),
    /cannot be combined with an explicit Region/u,
  );
});

class CapturingSink implements AwsInventorySink {
  public readonly batches: AwsInventoryBatch[] = [];

  public async writeBatch(batch: AwsInventoryBatch): Promise<void> {
    this.batches.push(structuredClone(batch));
  }
}

class ConcurrencyTracker {
  public active = 0;
  public maximum = 0;

  public async run<T>(operation: () => T): Promise<T> {
    this.active += 1;
    this.maximum = Math.max(this.maximum, this.active);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return operation();
    } finally {
      this.active -= 1;
    }
  }
}

class FakeClientFactory implements AwsInventoryClientFactory {
  public readonly tracker = new ConcurrencyTracker();
  public readonly instanceTokens: Record<string, (string | undefined)[]> = {};
  public readonly rdsMarkers: Record<string, (string | undefined)[]> = {};
  public readonly guardDutyTokens: Record<string, (string | undefined)[]> = {};
  public readonly bucketTokens: string[] = [];

  public constructor(private readonly failRdsRegion?: string) {}

  public ec2(region: string): Ec2InventoryClient {
    return {
      describeInstances: (input) =>
        this.tracker.run(() => {
          (this.instanceTokens[region] ??= []).push(input.NextToken);
          if (region === "us-east-1" && input.NextToken === undefined) {
            return {
              $metadata: {},
              NextToken: "instances-next",
              Reservations: [
                {
                  Instances: [
                    {
                      InstanceId: "i-east-1",
                      InstanceType: "t3.small",
                      State: { Name: "running" },
                      VpcId: "vpc-east",
                      SubnetId: "subnet-east",
                      SecurityGroups: [{ GroupId: "sg-east" }],
                      Tags: [
                        { Key: "Environment", Value: "demo" },
                        { Key: "secret", Value: "must-not-be-normalized" },
                        { Key: "constructor", Value: "must-not-cross-json-boundary" },
                        { Key: "UnapprovedCustomTag", Value: "not-in-allowlist" },
                        { Key: "Name", Value: ["AKIA", "ABCDEFGHIJKLMNOP"].join("") },
                        { Key: "Owner", Value: ["gh", "p_", "opaqueRepositoryTokenValue123456789"].join("") },
                        { Key: "Project", Value: ["eyJhbGciOiJIUzI1NiJ9", ".eyJzdWIiOiJjdXN0b21lciJ9", ".signaturePart123456"].join("") },
                        { Key: "Application", Value: ["postgres", "ql://demo:credential@db.internal/sutra"].join("") },
                        { Key: "Team", Value: ["https://example.invalid/object?X-Amz-", "Signature=deadbeef"].join("") },
                        { Key: "ManagedBy", Value: "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0" },
                      ],
                    },
                  ],
                },
              ],
            };
          }
          const instanceId =
            region === "us-east-1" ? "i-east-2" : "i-west-1";
          return {
            $metadata: {},
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: instanceId,
                    InstanceType: "t3.micro",
                    State: { Name: "stopped" },
                    VpcId: region === "us-east-1" ? "vpc-east" : "vpc-west",
                  },
                ],
              },
            ],
          };
        }),
      describeVpcs: () =>
        this.tracker.run(() => ({
          $metadata: {},
          Vpcs: [
            {
              VpcId: region === "us-east-1" ? "vpc-east" : "vpc-west",
              CidrBlock: region === "us-east-1" ? "10.0.0.0/16" : "10.1.0.0/16",
              State: "available",
              IsDefault: false,
            },
          ],
        })),
      describeSubnets: () =>
        this.tracker.run(() => ({
          $metadata: {},
          Subnets: [
            {
              SubnetId: region === "us-east-1" ? "subnet-east" : "subnet-west",
              VpcId: region === "us-east-1" ? "vpc-east" : "vpc-west",
              CidrBlock: region === "us-east-1" ? "10.0.1.0/24" : "10.1.1.0/24",
              State: "available",
              MapPublicIpOnLaunch: true,
            },
          ],
        })),
      describeSecurityGroups: () =>
        this.tracker.run(() => ({
          $metadata: {},
          SecurityGroups: [
            {
              GroupId: region === "us-east-1" ? "sg-east" : "sg-west",
              GroupName: "web",
              VpcId: region === "us-east-1" ? "vpc-east" : "vpc-west",
              IpPermissions: [
                {
                  IpProtocol: "tcp",
                  FromPort: 443,
                  ToPort: 443,
                  IpRanges: [
                    { CidrIp: "0.0.0.0/0", Description: "must-not-be-normalized" },
                  ],
                },
              ],
              IpPermissionsEgress: [],
            },
          ],
        })),
      describeVolumes: () => this.tracker.run(() => ({ $metadata: {}, Volumes: [] })),
      describeNetworkInterfaces: () =>
        this.tracker.run(() => ({ $metadata: {}, NetworkInterfaces: [] })),
      describeRouteTables: () => this.tracker.run(() => ({ $metadata: {}, RouteTables: [] })),
      describeInternetGateways: () =>
        this.tracker.run(() => ({ $metadata: {}, InternetGateways: [] })),
      describeNetworkAcls: () => this.tracker.run(() => ({ $metadata: {}, NetworkAcls: [] })),
    };
  }

  public elbv2(_region: string): Elbv2InventoryClient {
    void _region;
    return {
      describeLoadBalancers: () =>
        this.tracker.run(() => ({ $metadata: {}, LoadBalancers: [] })),
      describeListeners: () => this.tracker.run(() => ({ $metadata: {}, Listeners: [] })),
    };
  }

  public kms(_region: string): KmsInventoryClient {
    void _region;
    return {
      listKeys: () => this.tracker.run(() => ({ $metadata: {}, Keys: [] })),
      listAliases: () => this.tracker.run(() => ({ $metadata: {}, Aliases: [] })),
      describeKey: () => {
        throw new Error("describeKey must not run without a listed key");
      },
    };
  }

  public dynamodb(_region: string): DynamoDbInventoryClient {
    void _region;
    return {
      listTables: () => this.tracker.run(() => ({ $metadata: {}, TableNames: [] })),
      describeTable: () => {
        throw new Error("describeTable must not run without a listed table");
      },
    };
  }

  public ecr(_region: string): EcrInventoryClient {
    void _region;
    return {
      describeRepositories: () =>
        this.tracker.run(() => ({ $metadata: {}, repositories: [] })),
    };
  }

  public s3(region: string): S3InventoryClient {
    return {
      listBuckets: (input) =>
        this.tracker.run(() => {
          this.bucketTokens.push(`${input.BucketRegion ?? "missing"}:${input.ContinuationToken ?? "first"}`);
          if (input.ContinuationToken === undefined) {
            return {
              $metadata: {},
              ContinuationToken: `${region}-buckets-next`,
              Buckets: [
                {
                  Name: region === "us-east-1" ? "bucket-east" : "bucket-west",
                  CreationDate: new Date("2026-01-01T00:00:00Z"),
                },
              ],
            };
          }
          return {
            $metadata: {},
            Buckets: [],
          };
        }),
      getPublicAccessBlock: (input) =>
        this.tracker.run(() => {
          if (input.Bucket === "bucket-west") {
            const error = new Error("not configured");
            error.name = "NoSuchPublicAccessBlockConfiguration";
            throw error;
          }
          assert.equal(region, "us-east-1");
          return {
            $metadata: {},
            PublicAccessBlockConfiguration: {
              BlockPublicAcls: true,
              IgnorePublicAcls: true,
              BlockPublicPolicy: true,
              RestrictPublicBuckets: true,
            },
          };
        }),
    };
  }

  public rds(region: string): RdsInventoryClient {
    return {
      describeDBInstances: (input) =>
        this.tracker.run(() => {
          (this.rdsMarkers[region] ??= []).push(input.Marker);
          if (this.failRdsRegion === region) {
            const error = new Error("message-with-sensitive-context");
            error.name = "RequestLimitExceeded";
            throw error;
          }
          if (region === "us-east-1" && input.Marker === undefined) {
            return {
              $metadata: {},
              Marker: "rds-next",
              DBInstances: [database("db-east-1", region)],
            };
          }
          return {
            $metadata: {},
            DBInstances: [
              database(region === "us-east-1" ? "db-east-2" : "db-west-1", region),
            ],
          };
        }),
    };
  }

  public iam(): IamInventoryClient {
    return {
      getAccountSummary: () =>
        this.tracker.run(() => ({
          $metadata: {},
          SummaryMap: { Users: 5, Roles: 10, AccountMFAEnabled: 1 },
        })),
      getAccountPasswordPolicy: () =>
        this.tracker.run(() => ({
          $metadata: {},
          PasswordPolicy: {
            MinimumPasswordLength: 14,
            RequireSymbols: true,
            RequireNumbers: true,
            RequireUppercaseCharacters: true,
            RequireLowercaseCharacters: true,
          },
        })),
    };
  }

  public cloudTrail(
    region: string,
  ): CloudTrailInventoryClient {
    const trailArn = `arn:aws:cloudtrail:${region}:123456789012:trail/main-${region}`;
    return {
      describeTrails: () =>
        this.tracker.run(() => ({
          $metadata: {},
          trailList: [
            {
              Name: `main-${region}`,
              TrailARN: trailArn,
              HomeRegion: region,
              IsMultiRegionTrail: region === "us-east-1",
              IncludeGlobalServiceEvents: true,
              LogFileValidationEnabled: true,
              S3BucketName: "audit-logs",
            },
          ],
        })),
      getTrailStatus: () =>
        this.tracker.run(() => ({
          $metadata: {},
          IsLogging: true,
          LatestDeliveryTime: new Date("2026-07-15T10:00:00Z"),
        })),
    };
  }

  public guardDuty(
    region: string,
  ): GuardDutyInventoryClient {
    return {
      listDetectors: (input) =>
        this.tracker.run(() => {
          (this.guardDutyTokens[region] ??= []).push(input.NextToken);
          if (region === "us-west-2") {
            return { $metadata: {}, DetectorIds: [] };
          }
          return input.NextToken === undefined
            ? { $metadata: {}, DetectorIds: ["detector-1"], NextToken: "gd-next" }
            : { $metadata: {}, DetectorIds: ["detector-2"] };
        }),
      getDetector: (input) =>
        this.tracker.run(() => ({
          $metadata: {},
          Status: input.DetectorId === "detector-1" ? "ENABLED" : "DISABLED",
          ServiceRole: "service-role",
          FindingPublishingFrequency: "SIX_HOURS",
          CreatedAt: "2026-01-01T00:00:00Z",
          UpdatedAt: "2026-07-01T00:00:00Z",
        })),
      listFindings: (input) =>
        this.tracker.run(() => ({
          $metadata: {},
          FindingIds: [],
          NextToken: undefined,
          DetectorId: input.DetectorId,
        })),
      getFindings: () =>
        this.tracker.run(() => ({ $metadata: {}, Findings: [] })),
    };
  }

  public securityHub(
    region: string,
  ): SecurityHubInventoryClient {
    return {
      describeHub: () =>
        this.tracker.run(() => {
          if (region === "us-west-2") {
            const error = new Error("hub disabled");
            error.name = "InvalidAccessException";
            throw error;
          }
          return {
            $metadata: {},
            HubArn: `arn:aws:securityhub:${region}:123456789012:hub/default`,
            SubscribedAt: "2026-01-01T00:00:00Z",
            AutoEnableControls: true,
            ControlFindingGenerator: "SECURITY_CONTROL",
          };
        }),
      getFindings: () =>
        this.tracker.run(() => ({ $metadata: {}, Findings: [] })),
    };
  }

  public inspector(_region: string): InspectorInventoryClient {
    void _region;
    return {
      batchGetAccountStatus: (input) =>
        this.tracker.run(() => ({
          $metadata: {},
          accounts: [{
            accountId: input.accountIds?.[0],
            state: { status: "DISABLED", errorCode: undefined, errorMessage: undefined },
            resourceState: {
              ec2: { status: "DISABLED", errorCode: undefined, errorMessage: undefined },
              ecr: { status: "DISABLED", errorCode: undefined, errorMessage: undefined },
            },
          }],
          failedAccounts: [],
        })),
      listFindings: () => {
        throw new Error("listFindings must not run when Inspector is disabled");
      },
    };
  }
}

function database(identifier: string, region: string) {
  return {
    DBInstanceIdentifier: identifier,
    DBInstanceArn: `arn:aws:rds:${region}:123456789012:db:${identifier}`,
    DBInstanceStatus: "available",
    Engine: "postgres",
    EngineVersion: "16.3",
    DBInstanceClass: "db.t4g.small",
    StorageEncrypted: true,
    PubliclyAccessible: false,
    MultiAZ: true,
    MasterUsername: "must-not-be-normalized",
    TagList: [{ Key: "Service", Value: "orders" }],
  };
}

class ExpandedInventoryClientFactory extends FakeClientFactory {
  public readonly tokens = new Map<string, (string | undefined)[]>();

  private record(key: string, token: string | undefined): void {
    const values = this.tokens.get(key) ?? [];
    values.push(token);
    this.tokens.set(key, values);
  }

  public override ec2(region: string): Ec2InventoryClient {
    const base = super.ec2(region);
    return {
      ...base,
      describeVolumes: async (input) => {
        this.record("volumes", input.NextToken);
        return input.NextToken === undefined
          ? {
              $metadata: {},
              NextToken: "volumes-next",
              Volumes: [{
                VolumeId: "vol-expanded",
                State: "in-use",
                VolumeType: "gp3",
                Size: 100,
                Encrypted: true,
                KmsKeyId: `arn:aws:kms:${region}:123456789012:key/key-expanded`,
                AvailabilityZone: `${region}a`,
                Attachments: [{ InstanceId: "i-east-1", Device: "/dev/xvda", State: "attached" }],
              }],
            }
          : { $metadata: {}, Volumes: [] };
      },
      describeNetworkInterfaces: async (input) => {
        this.record("network-interfaces", input.NextToken);
        return input.NextToken === undefined
          ? {
              $metadata: {},
              NextToken: "eni-next",
              NetworkInterfaces: [{
                NetworkInterfaceId: "eni-expanded",
                Status: "in-use",
                InterfaceType: "interface",
                VpcId: "vpc-east",
                SubnetId: "subnet-east",
                PrivateIpAddress: "10.0.1.25",
                Groups: [{ GroupId: "sg-east" }],
                Attachment: { InstanceId: "i-east-1", Status: "attached" },
              }],
            }
          : { $metadata: {}, NetworkInterfaces: [] };
      },
      describeRouteTables: async (input) => {
        this.record("route-tables", input.NextToken);
        return input.NextToken === undefined
          ? {
              $metadata: {},
              NextToken: "route-tables-next",
              RouteTables: [{
                RouteTableId: "rtb-expanded",
                VpcId: "vpc-east",
                Associations: [{ Main: false, SubnetId: "subnet-east" }],
                Routes: [
                  { DestinationCidrBlock: "10.0.0.0/16", GatewayId: "local" },
                  { DestinationCidrBlock: "0.0.0.0/0", GatewayId: "igw-east" },
                ],
              }],
            }
          : { $metadata: {}, RouteTables: [] };
      },
      describeInternetGateways: async (input) => {
        this.record("internet-gateways", input.NextToken);
        return input.NextToken === undefined
          ? {
              $metadata: {},
              NextToken: "internet-gateways-next",
              InternetGateways: [{
                InternetGatewayId: "igw-east",
                Attachments: [{ VpcId: "vpc-east", State: "attached" }],
              }],
            }
          : { $metadata: {}, InternetGateways: [] };
      },
      describeNetworkAcls: async (input) => {
        this.record("network-acls", input.NextToken);
        return input.NextToken === undefined
          ? {
              $metadata: {},
              NextToken: "network-acls-next",
              NetworkAcls: [{
                NetworkAclId: "acl-east",
                VpcId: "vpc-east",
                IsDefault: true,
                Associations: [{ SubnetId: "subnet-east", NetworkAclAssociationId: "aclassoc-1" }],
                Entries: [
                  { RuleNumber: 100, Egress: false, Protocol: "-1", RuleAction: "allow", CidrBlock: "0.0.0.0/0" },
                  { RuleNumber: 32767, Egress: false, Protocol: "-1", RuleAction: "deny", CidrBlock: "0.0.0.0/0" },
                ],
              }],
            }
          : { $metadata: {}, NetworkAcls: [] };
      },
    };
  }

  public override elbv2(region: string): Elbv2InventoryClient {
    return {
      describeLoadBalancers: async (input) => {
        this.record("load-balancers", input.Marker);
        return input.Marker === undefined
          ? {
              $metadata: {},
              NextMarker: "load-balancers-next",
              LoadBalancers: [{
                LoadBalancerArn: `arn:aws:elasticloadbalancing:${region}:123456789012:loadbalancer/app/demo/1234`,
                LoadBalancerName: "demo",
                Type: "application",
                Scheme: "internet-facing",
                State: { Code: "active" },
                VpcId: "vpc-east",
                SecurityGroups: ["sg-east"],
                AvailabilityZones: [{ ZoneName: `${region}a`, SubnetId: "subnet-east" }],
              }],
            }
          : { $metadata: {}, LoadBalancers: [] };
      },
      describeListeners: async (input) => {
        this.record("listeners", input.Marker);
        return input.Marker === undefined
          ? {
              $metadata: {},
              NextMarker: "listeners-next",
              Listeners: [{
                ListenerArn: `${input.LoadBalancerArn}/listener/443`,
                LoadBalancerArn: input.LoadBalancerArn,
                Port: 443,
                Protocol: "HTTPS",
                SslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
                Certificates: [{ CertificateArn: `arn:aws:acm:${region}:123456789012:certificate/demo` }],
                DefaultActions: [{ Type: "forward" }],
              }],
            }
          : { $metadata: {}, Listeners: [] };
      },
    };
  }

  public override kms(region: string): KmsInventoryClient {
    return {
      listAliases: async (input) => {
        this.record("kms-aliases", input.Marker);
        return input.Marker === undefined
          ? {
              $metadata: {},
              NextMarker: "aliases-next",
              Aliases: [{ AliasName: "alias/sutra-demo", TargetKeyId: "key-expanded" }],
            }
          : { $metadata: {}, Aliases: [] };
      },
      listKeys: async (input) => {
        this.record("kms-keys", input.Marker);
        return input.Marker === undefined
          ? {
              $metadata: {},
              NextMarker: "keys-next",
              Keys: [{ KeyId: "key-expanded" }],
            }
          : { $metadata: {}, Keys: [] };
      },
      describeKey: async (input) => ({
        $metadata: {},
        KeyMetadata: {
          AWSAccountId: "123456789012",
          KeyId: input.KeyId,
          Arn: `arn:aws:kms:${region}:123456789012:key/${input.KeyId}`,
          CreationDate: new Date("2026-01-01T00:00:00Z"),
          Enabled: true,
          KeyState: "Enabled",
          KeyManager: "CUSTOMER",
          Origin: "AWS_KMS",
          KeyUsage: "ENCRYPT_DECRYPT",
          KeySpec: "SYMMETRIC_DEFAULT",
        },
      }),
    };
  }

  public override dynamodb(region: string): DynamoDbInventoryClient {
    return {
      listTables: async (input) => {
        this.record("dynamodb", input.ExclusiveStartTableName);
        return input.ExclusiveStartTableName === undefined
          ? {
              $metadata: {},
              LastEvaluatedTableName: "orders",
              TableNames: ["orders"],
            }
          : { $metadata: {}, TableNames: [] };
      },
      describeTable: async (input) => ({
        $metadata: {},
        Table: {
          TableName: input.TableName,
          TableArn: `arn:aws:dynamodb:${region}:123456789012:table/${input.TableName}`,
          TableStatus: "ACTIVE",
          ItemCount: 42,
          SSEDescription: {
            Status: "ENABLED",
            SSEType: "KMS",
            KMSMasterKeyArn: `arn:aws:kms:${region}:123456789012:key/key-expanded`,
          },
        },
      }),
    };
  }

  public override ecr(region: string): EcrInventoryClient {
    return {
      describeRepositories: async (input) => {
        this.record("ecr", input.nextToken);
        return input.nextToken === undefined
          ? {
              $metadata: {},
              nextToken: "ecr-next",
              repositories: [{
                repositoryName: "orders",
                repositoryArn: `arn:aws:ecr:${region}:123456789012:repository/orders`,
                repositoryUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/orders",
                imageTagMutability: "IMMUTABLE",
                imageScanningConfiguration: { scanOnPush: true },
                encryptionConfiguration: {
                  encryptionType: "KMS",
                  kmsKey: `arn:aws:kms:${region}:123456789012:key/key-expanded`,
                },
              }],
            }
          : { $metadata: {}, repositories: [] };
      },
    };
  }

  public eks(region: string): EksInventoryClient {
    return {
      listClusters: async (input) => {
        this.record("eks", input.nextToken);
        return input.nextToken === undefined
          ? { $metadata: {}, clusters: ["production"], nextToken: "eks-next" }
          : { $metadata: {}, clusters: [] };
      },
      describeCluster: async (input) => ({
        $metadata: {},
        cluster: {
          name: input.name,
          arn: `arn:aws:eks:${region}:123456789012:cluster/${input.name}`,
          status: "ACTIVE",
          version: "1.33",
          platformVersion: "eks.16",
          roleArn: "arn:aws:iam::123456789012:role/eks-control-plane",
          resourcesVpcConfig: {
            vpcId: "vpc-east",
            subnetIds: ["subnet-east"],
            securityGroupIds: ["sg-east"],
            endpointPublicAccess: false,
            endpointPrivateAccess: true,
            publicAccessCidrs: [],
          },
          logging: {
            clusterLogging: [{
              enabled: true,
              types: ["api", "audit", "authenticator"],
            }],
          },
          encryptionConfig: [{
            resources: ["secrets"],
            provider: { keyArn: `arn:aws:kms:${region}:123456789012:key/key-expanded` },
          }],
          accessConfig: {
            authenticationMode: "API",
            bootstrapClusterCreatorAdminPermissions: false,
          },
          tags: { Environment: "production" },
        },
      }),
    };
  }
}

test("expanded CMDB families paginate, preserve API provenance, and create safe graph edges", async () => {
  const sink = new CapturingSink();
  const clients = new ExpandedInventoryClientFactory();
  const completedAt = new Date("2026-07-16T12:00:00Z");
  const runner = new SingleAccountAwsInventoryRunner({
    clients,
    sink,
    regionSelector: new StaticInventoryRegionSelector(["us-east-1"]),
    globalControlRegion: "us-east-1",
    maxConcurrency: 4,
    now: () => completedAt,
  });
  const collection = await runner.collect(context());
  const resources = sink.batches.flatMap((batch) => batch.resources);
  const expandedTypes = [
    "aws.ec2.volume",
    "aws.ec2.network-interface",
    "aws.ec2.route-table",
    "aws.ec2.internet-gateway",
    "aws.ec2.network-acl",
    "aws.elasticloadbalancingv2.load-balancer",
    "aws.elasticloadbalancingv2.listener",
    "aws.kms.key",
    "aws.dynamodb.table",
    "aws.ecr.repository",
    "aws.eks.cluster",
  ];

  assert.equal(collection.coverage, "COMPLETE");
  for (const resourceType of expandedTypes) {
    const observed = resources.find((resource) => resource.resourceType === resourceType);
    assert.ok(observed, resourceType);
    assert.match(observed.sourceApi ?? "", /^[a-z0-9]+:/u);
  }
  for (const key of ["volumes", "network-interfaces", "route-tables", "internet-gateways", "network-acls", "load-balancers", "listeners", "kms-aliases", "kms-keys", "dynamodb", "ecr", "eks"]) {
    assert.equal(clients.tokens.get(key)?.length, 2, key);
  }
  // Route table exposing 0.0.0.0/0 -> igw is the fact aws-network-exposure needs:
  // record the routed-to-IGW flag and associated subnets, never infer beyond it.
  const routeTable = resources.find((resource) => resource.resourceType === "aws.ec2.route-table");
  assert.deepEqual(routeTable?.configuration, {
    vpcId: "vpc-east",
    main: false,
    routeCount: 2,
    associationCount: 1,
    associatedSubnetIds: ["subnet-east"],
    routesToInternetGateway: true,
    routesToNatGateway: false,
    routes: [
      { destination: "10.0.0.0/16", target: "local" },
      { destination: "0.0.0.0/0", target: "igw-east" },
    ],
    propagatingVgws: [],
  });
  const internetGateway = resources.find((resource) => resource.resourceType === "aws.ec2.internet-gateway");
  assert.deepEqual(internetGateway?.configuration, {
    attachedVpcIds: ["vpc-east"],
    attachmentStates: ["attached"],
    attached: true,
  });
  // NACL entries (ordered rule/action/CIDR) are the subnet-boundary port-filter evidence.
  const networkAcl = resources.find((resource) => resource.resourceType === "aws.ec2.network-acl");
  assert.deepEqual(networkAcl?.configuration, {
    vpcId: "vpc-east",
    isDefault: true,
    associatedSubnetIds: ["subnet-east"],
    entries: [
      { ruleNumber: 100, egress: false, protocol: "-1", ruleAction: "allow", cidr: "0.0.0.0/0" },
      { ruleNumber: 32767, egress: false, protocol: "-1", ruleAction: "deny", cidr: "0.0.0.0/0" },
    ],
  });
  // Listener records the served ingress port/protocol — the network-exposure fact.
  const listener = resources.find((resource) => resource.resourceType === "aws.elasticloadbalancingv2.listener");
  assert.deepEqual(listener?.configuration, {
    loadBalancerArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/demo/1234",
    port: 443,
    protocol: "HTTPS",
    sslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
    certificateCount: 1,
    defaultActionTypes: ["forward"],
    alpnPolicy: [],
  });
  const eks = resources.find((resource) => resource.resourceType === "aws.eks.cluster");
  assert.deepEqual(eks?.configuration, {
    state: "ACTIVE",
    clusterName: "production",
    kubernetesVersion: "1.33",
    platformVersion: "eks.16",
    roleArn: "arn:aws:iam::123456789012:role/eks-control-plane",
    endpointPublicAccess: false,
    endpointPrivateAccess: true,
    publicAccessCidrs: [],
    vpcId: "vpc-east",
    subnetIds: ["subnet-east"],
    securityGroupIds: ["sg-east"],
    enabledLogTypes: ["api", "audit", "authenticator"],
    encryptionResources: ["secrets"],
    encryptionProviderKeyArn: "arn:aws:kms:us-east-1:123456789012:key/key-expanded",
    authenticationMode: "API",
    bootstrapClusterCreatorAdminPermissions: false,
  });

  const connection = {
    tenantId: "tenant-01",
    connectionId: "conn-01",
    expectedAccountId: "123456789012",
    partition: "aws" as const,
    roleArn: "arn:aws:iam::123456789012:role/sutra/SutraReadOnlyRole",
    externalId: "sutra_external_id_1234567890abcd",
    status: "ACTIVE" as const,
    permissionPackVersion: "live-demo-2026-07.3" as const,
    enabledRegions: ["us-east-1"],
    createdAt: completedAt.toISOString(),
    updatedAt: completedAt.toISOString(),
  };
  const snapshot = normalizeLiveSnapshot(
    connection,
    "job-expanded-inventory",
    "sutra-job-expanded-inventory",
    resources,
    sink.batches.flatMap((batch) => batch.evidence),
    collection.coverage,
    collection.collectorCoverage,
    completedAt,
  );
  const byNativeId = new Map(snapshot.resources.map((resource) => [resource.nativeId, resource.resourceKey]));
  const hasEdge = (from: string, to: string, relationType: string) =>
    snapshot.relationships.some((edge) =>
      edge.fromResourceKey === byNativeId.get(from) &&
      edge.toResourceKey === byNativeId.get(to) &&
      edge.relationType === relationType,
    );
  assert.equal(hasEdge("vol-expanded", "i-east-1", "attached_to"), true);
  assert.equal(hasEdge("eni-expanded", "subnet-east", "runs_in"), true);
  assert.equal(hasEdge("orders", "key-expanded", "encrypted_by"), true);
});

class ExpandedPartialFailureClientFactory extends ExpandedInventoryClientFactory {
  public override ecr(_region: string): EcrInventoryClient {
    void _region;
    return {
      describeRepositories: async () => {
        const error = new Error("customer-specific detail must not cross the boundary");
        error.name = "AccessDeniedException";
        throw error;
      },
    };
  }
}

test("an expanded-family denial is isolated as partial coverage without discarding successful families", async () => {
  const sink = new CapturingSink();
  const runner = new SingleAccountAwsInventoryRunner({
    clients: new ExpandedPartialFailureClientFactory(),
    sink,
    regionSelector: new StaticInventoryRegionSelector(["us-east-1"]),
    globalControlRegion: "us-east-1",
    maxConcurrency: 4,
    now: () => new Date("2026-07-16T12:00:00Z"),
  });

  const collection = await runner.collect(context());
  const denied = collection.collectorCoverage.find((entry) => entry.collectorKey === "ecr.repositories");
  const volumes = collection.collectorCoverage.find((entry) => entry.collectorKey === "ec2.volumes");
  const serialized = JSON.stringify({ collection, batches: sink.batches });

  assert.equal(collection.coverage, "PARTIAL");
  assert.deepEqual(denied, {
    collectorKey: "ecr.repositories",
    region: "us-east-1",
    status: "FAILED",
    itemsObserved: 0,
    pagesObserved: 0,
    errorCode: "AccessDeniedException",
    message: "The read-only AWS collector did not return a usable page.",
  });
  assert.equal(volumes?.status, "SUCCEEDED");
  assert.equal(
    sink.batches.some((batch) => batch.resources.some((resource) => resource.resourceType === "aws.ec2.volume")),
    true,
  );
  assert.equal(serialized.includes("customer-specific detail"), false);
});

class PostureEdgeCaseClientFactory extends FakeClientFactory {
  public override s3(region: string): S3InventoryClient {
    return {
      listBuckets: async (input) => {
        assert.equal(input.BucketRegion, region);
        return {
          $metadata: {},
          Buckets: [{ Name: `partial-block-${region}` }],
        };
      },
      getPublicAccessBlock: async () => ({
        $metadata: {},
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: false,
          RestrictPublicBuckets: true,
        },
      }),
    };
  }

  public override cloudTrail(): CloudTrailInventoryClient {
    return {
      describeTrails: async () => ({ $metadata: {}, trailList: [] }),
      getTrailStatus: async () => {
        throw new Error("getTrailStatus must not run when no trails exist");
      },
    };
  }
}

class MultiRegionCloudTrailClientFactory extends FakeClientFactory {
  public readonly describeInputs: {
    readonly region: string;
    readonly includeShadowTrails: boolean | undefined;
  }[] = [];
  public readonly statusCalls: { readonly region: string; readonly name: string | undefined }[] = [];

  public override cloudTrail(region: string): CloudTrailInventoryClient {
    const trailArn = "arn:aws:cloudtrail:us-east-1:123456789012:trail/organization-audit";
    const trail = {
      Name: "organization-audit",
      TrailARN: trailArn,
      HomeRegion: "us-east-1",
      IsMultiRegionTrail: true,
      IsOrganizationTrail: true,
      IncludeGlobalServiceEvents: true,
      LogFileValidationEnabled: true,
      S3BucketName: "audit-logs",
    };
    return {
      describeTrails: async (input) => {
        this.describeInputs.push({
          region,
          includeShadowTrails: input.includeShadowTrails,
        });
        return {
          $metadata: {},
          // The home endpoint repeats the descriptor to exercise page-level
          // de-duplication; the west endpoint returns its AWS shadow copy.
          trailList: region === "us-east-1" ? [trail, { ...trail }] : [{ ...trail }],
        };
      },
      getTrailStatus: async (input) => {
        this.statusCalls.push({ region, name: input.Name });
        return {
          $metadata: {},
          IsLogging: true,
          LatestDeliveryTime: new Date("2026-07-15T10:00:00Z"),
        };
      },
    };
  }
}

class RegionalAccountSignalClientFactory extends FakeClientFactory {
  public override cloudTrail(): CloudTrailInventoryClient {
    const trailArn = "arn:aws:cloudtrail:us-east-1:123456789012:trail/east-only";
    return {
      describeTrails: async (input) => {
        assert.equal(input.includeShadowTrails, true);
        return {
          $metadata: {},
          trailList: [
            {
              Name: "east-only",
              TrailARN: trailArn,
              HomeRegion: "us-east-1",
              IsMultiRegionTrail: false,
              IncludeGlobalServiceEvents: true,
              LogFileValidationEnabled: true,
            },
          ],
        };
      },
      getTrailStatus: async () => ({ $metadata: {}, IsLogging: true }),
    };
  }

  public override guardDuty(): GuardDutyInventoryClient {
    return {
      listDetectors: async () => ({ $metadata: {}, DetectorIds: [] }),
      getDetector: async () => {
        throw new Error("getDetector must not run without a detector");
      },
      listFindings: async () => {
        throw new Error("listFindings must not run without a detector");
      },
      getFindings: async () => {
        throw new Error("getFindings must not run without a detector");
      },
    };
  }

  public override securityHub(): SecurityHubInventoryClient {
    return {
      describeHub: async () => {
        const error = new Error("hub disabled");
        error.name = "InvalidAccessException";
        throw error;
      },
      getFindings: async () => {
        throw new Error("getFindings must not run when Security Hub is disabled");
      },
    };
  }
}

class NativeFindingsClientFactory extends FakeClientFactory {
  public readonly guardDutyFindingTokens: (string | undefined)[] = [];
  public readonly securityHubFindingTokens: (string | undefined)[] = [];
  public readonly inspectorFindingTokens: (string | undefined)[] = [];
  public readonly securityHubFilters: unknown[] = [];

  public override guardDuty(region: string): GuardDutyInventoryClient {
    return {
      listDetectors: async () => ({ $metadata: {}, DetectorIds: ["detector-native"] }),
      getDetector: async () => ({
        $metadata: {},
        Status: "ENABLED",
        ServiceRole: "service-role",
      }),
      listFindings: async (input) => {
        this.guardDutyFindingTokens.push(input.NextToken);
        return input.NextToken === undefined
          ? { $metadata: {}, FindingIds: ["gd-native-1"], NextToken: "gd-native-next" }
          : { $metadata: {}, FindingIds: [] };
      },
      getFindings: async () => ({
        $metadata: {},
        Findings: [{
          AccountId: "123456789012",
          Arn: `arn:aws:guardduty:${region}:123456789012:detector/detector-native/finding/gd-native-1`,
          CreatedAt: "2026-07-01T00:00:00Z",
          Description: "password=must-not-cross-native-finding-boundary",
          Id: "gd-native-1",
          Partition: "aws",
          Region: region,
          Resource: {
            ResourceType: "Instance",
            InstanceDetails: { InstanceId: "i-east-1" },
            AccessKeyDetails: { AccessKeyId: "INVALID_TEST_ACCESS_KEY" },
          },
          SchemaVersion: "2.0",
          Service: {
            Archived: false,
            EventFirstSeen: "2026-07-01T00:00:00Z",
            EventLastSeen: "2026-07-15T00:00:00Z",
          },
          Severity: 8,
          Title: "GuardDuty native threat",
          Type: "UnauthorizedAccess:EC2/SSHBruteForce",
          UpdatedAt: "2026-07-15T00:00:00Z",
        }],
      }),
    };
  }

  public override securityHub(region: string): SecurityHubInventoryClient {
    return {
      describeHub: async () => ({
        $metadata: {},
        HubArn: `arn:aws:securityhub:${region}:123456789012:hub/default`,
      }),
      getFindings: async (input) => {
        this.securityHubFindingTokens.push(input.NextToken);
        this.securityHubFilters.push(input.Filters);
        return input.NextToken === undefined
          ? {
              $metadata: {},
              NextToken: "securityhub-native-next",
              Findings: [{
                SchemaVersion: "2018-10-08",
                Id: `arn:aws:securityhub:${region}:123456789012:subscription/cis-aws-foundations-benchmark/v/1.4.0/1.1`,
                ProductArn: `arn:aws:securityhub:${region}::product/aws/securityhub`,
                ProductName: "Security Hub",
                CompanyName: "AWS",
                Region: region,
                GeneratorId: "security-control/IAM.1",
                AwsAccountId: "123456789012",
                Types: ["Software and Configuration Checks/Industry and Regulatory Standards"],
                FirstObservedAt: "2026-07-01T00:00:00Z",
                LastObservedAt: "2026-07-15T00:00:00Z",
                CreatedAt: "2026-07-01T00:00:00Z",
                UpdatedAt: "2026-07-15T00:00:00Z",
                Severity: { Label: "CRITICAL", Normalized: 95 },
                Title: "Security Hub native control failure",
                Description: "An AWS-native Security Hub control failed.",
                Remediation: { Recommendation: { Text: "Apply the approved IAM remediation." } },
                Resources: [{
                  Type: "AwsEc2Instance",
                  Id: `arn:aws:ec2:${region}:123456789012:instance/i-east-1`,
                  Partition: "aws",
                  Region: region,
                }],
                Workflow: { Status: "SUPPRESSED" },
                RecordState: "ACTIVE",
                Compliance: { Status: "FAILED", SecurityControlId: "IAM.1" },
              }],
            }
          : { $metadata: {}, Findings: [] };
      },
    };
  }

  public override inspector(region: string): InspectorInventoryClient {
    return {
      batchGetAccountStatus: async (input) => ({
        $metadata: {},
        accounts: [{
          accountId: input.accountIds?.[0],
          state: { status: "ENABLED", errorCode: undefined, errorMessage: undefined },
          resourceState: {
            ec2: { status: "ENABLED", errorCode: undefined, errorMessage: undefined },
            ecr: { status: "ENABLED", errorCode: undefined, errorMessage: undefined },
          },
        }],
        failedAccounts: [],
      }),
      listFindings: async (input) => {
        this.inspectorFindingTokens.push(input.nextToken);
        return input.nextToken === undefined
          ? {
              $metadata: {},
              nextToken: "inspector-native-next",
              findings: [{
                findingArn: `arn:aws:inspector2:${region}:123456789012:finding/inspector-native-1`,
                awsAccountId: "123456789012",
                type: "PACKAGE_VULNERABILITY",
                description: "Amazon Inspector identified a package vulnerability.",
                title: "Inspector native package vulnerability",
                remediation: { recommendation: { text: "Upgrade to the fixed package version." } },
                severity: "MEDIUM",
                firstObservedAt: new Date("2026-07-01T00:00:00Z"),
                lastObservedAt: new Date("2026-07-15T00:00:00Z"),
                updatedAt: new Date("2026-07-15T00:00:00Z"),
                status: "CLOSED",
                resources: [{
                  type: "AWS_EC2_INSTANCE",
                  id: "i-east-1",
                  partition: "aws",
                  region,
                }],
                inspectorScore: 6.5,
                fixAvailable: "YES",
                exploitAvailable: "NO",
              }],
            }
          : { $metadata: {}, findings: [] };
      },
    };
  }
}

class RepeatedNativeFindingTokenClientFactory extends FakeClientFactory {
  public override securityHub(region: string): SecurityHubInventoryClient {
    return {
      describeHub: async () => ({
        $metadata: {},
        HubArn: `arn:aws:securityhub:${region}:123456789012:hub/default`,
      }),
      getFindings: async () => ({
        $metadata: {},
        Findings: [],
        NextToken: "repeated-native-token",
      }),
    };
  }
}

class FinalPageOverflowNativeFindingsClientFactory extends FakeClientFactory {
  public override guardDuty(region: string): GuardDutyInventoryClient {
    return {
      listDetectors: async () => ({
        $metadata: {},
        DetectorIds: ["detector-final-page-overflow"],
      }),
      getDetector: async () => ({
        $metadata: {},
        Status: "ENABLED",
        ServiceRole: "service-role",
      }),
      listFindings: async (input) => {
        const page = input.NextToken === undefined ? 0 : Number(input.NextToken);
        assert.ok(Number.isInteger(page) && page >= 0 && page <= 20);
        const finalPage = page === 20;
        return {
          $metadata: {},
          FindingIds: Array.from(
            { length: finalPage ? 1 : 50 },
            (_, index) => `gd-overflow-${page}-${index}`,
          ),
          ...(finalPage ? {} : { NextToken: String(page + 1) }),
        };
      },
      getFindings: async (input) => ({
        $metadata: {},
        Findings: (input.FindingIds ?? []).map((findingId) => ({
          AccountId: "123456789012",
          Arn: `arn:aws:guardduty:${region}:123456789012:detector/detector-final-page-overflow/finding/${findingId}`,
          CreatedAt: "2026-07-01T00:00:00Z",
          Description: "GuardDuty bounded import regression evidence.",
          Id: findingId,
          Partition: "aws",
          Region: region,
          Resource: { ResourceType: "Instance" },
          SchemaVersion: "2.0",
          Service: { Archived: false },
          Severity: 5,
          Title: "GuardDuty bounded import regression",
          Type: "Recon:EC2/PortProbeUnprotectedPort",
          UpdatedAt: "2026-07-15T00:00:00Z",
        })),
      }),
    };
  }

  public override securityHub(region: string): SecurityHubInventoryClient {
    return {
      describeHub: async () => ({
        $metadata: {},
        HubArn: `arn:aws:securityhub:${region}:123456789012:hub/default`,
      }),
      getFindings: async (input) => {
        const page = input.NextToken === undefined ? 0 : Number(input.NextToken);
        assert.ok(Number.isInteger(page) && page >= 0 && page <= 10);
        const finalPage = page === 10;
        return {
          $metadata: {},
          Findings: Array.from(
            { length: finalPage ? 1 : 100 },
            (_, index) => ({
              SchemaVersion: "2018-10-08",
              Id: `securityhub-overflow-${page}-${index}`,
              ProductArn: `arn:aws:securityhub:${region}::product/aws/securityhub`,
              ProductName: "Security Hub",
              CompanyName: "AWS",
              Region: region,
              GeneratorId: "security-control/IAM.1",
              AwsAccountId: "123456789012",
              Types: ["Software and Configuration Checks"],
              FirstObservedAt: "2026-07-01T00:00:00Z",
              LastObservedAt: "2026-07-15T00:00:00Z",
              CreatedAt: "2026-07-01T00:00:00Z",
              UpdatedAt: "2026-07-15T00:00:00Z",
              Severity: { Label: "MEDIUM" as const, Normalized: 50 },
              Title: "Security Hub bounded import regression",
              Description: "Security Hub bounded import regression evidence.",
              Resources: [],
              Workflow: { Status: "NEW" as const },
              RecordState: "ACTIVE" as const,
            }),
          ),
          ...(finalPage ? {} : { NextToken: String(page + 1) }),
        };
      },
    };
  }

  public override inspector(region: string): InspectorInventoryClient {
    return {
      batchGetAccountStatus: async (input) => ({
        $metadata: {},
        accounts: [{
          accountId: input.accountIds?.[0],
          state: { status: "ENABLED", errorCode: undefined, errorMessage: undefined },
          resourceState: {
            ec2: { status: "ENABLED", errorCode: undefined, errorMessage: undefined },
            ecr: { status: "ENABLED", errorCode: undefined, errorMessage: undefined },
          },
        }],
        failedAccounts: [],
      }),
      listFindings: async (input) => {
        const page = input.nextToken === undefined ? 0 : Number(input.nextToken);
        assert.ok(Number.isInteger(page) && page >= 0 && page <= 10);
        const finalPage = page === 10;
        return {
          $metadata: {},
          findings: Array.from(
            { length: finalPage ? 1 : 100 },
            (_, index) => ({
              findingArn: `arn:aws:inspector2:${region}:123456789012:finding/inspector-overflow-${page}-${index}`,
              awsAccountId: "123456789012",
              type: "PACKAGE_VULNERABILITY" as const,
              description: "Inspector bounded import regression evidence.",
              title: "Inspector bounded import regression",
              remediation: { recommendation: { text: "Apply the approved update." } },
              severity: "MEDIUM" as const,
              firstObservedAt: new Date("2026-07-01T00:00:00Z"),
              lastObservedAt: new Date("2026-07-15T00:00:00Z"),
              updatedAt: new Date("2026-07-15T00:00:00Z"),
              status: "ACTIVE" as const,
              resources: [],
              inspectorScore: 5,
              fixAvailable: "YES" as const,
              exploitAvailable: "NO" as const,
            }),
          ),
          ...(finalPage ? {} : { nextToken: String(page + 1) }),
        };
      },
    };
  }
}

function context(): InventoryCollectionContext {
  return {
    tenantId: "tenant-01",
    connectionId: "conn-01",
    jobId: "job-01",
    accountId: "123456789012",
    partition: "aws",
    roleSessionName: "mspcmdb-job-01",
    credentials: {
      accessKeyId: "ASIA-DO-NOT-RETURN",
      secretAccessKey: "SECRET-DO-NOT-RETURN",
      sessionToken: "TOKEN-DO-NOT-RETURN",
      expiration: new Date("2099-01-01T00:00:00Z"),
    },
  };
}

test("collects, paginates, normalizes, and bounds regional concurrency", async () => {
  const sink = new CapturingSink();
  const clients = new FakeClientFactory();
  const runner = new SingleAccountAwsInventoryRunner({
    clients,
    sink,
    regionSelector: new StaticInventoryRegionSelector(["us-west-2", "us-east-1"]),
    globalControlRegion: "us-east-1",
    maxConcurrency: 2,
    now: () => new Date("2026-07-15T12:00:00Z"),
  });

  const result = await runner.collect(context());
  const resources = sink.batches.flatMap((batch) => batch.resources);
  const evidence = sink.batches.flatMap((batch) => batch.evidence);
  const serialized = JSON.stringify({ result, resources, evidence });

  const { collectorCoverage, ...summary } = result;
  assert.deepEqual(summary, {
    resourcesObserved: 20,
    findingsObserved: 15,
    coverage: "COMPLETE",
  });
  assert.equal(
    collectorCoverage.length,
    LIVE_AWS_GLOBAL_COLLECTOR_COUNT + LIVE_AWS_REGIONAL_COLLECTOR_COUNT * 2,
  );
  assert.ok(collectorCoverage.every((entry) => entry.status === "SUCCEEDED"));
  assert.deepEqual(
    collectorCoverage.find(
      (entry) => entry.collectorKey === "ec2.instances" && entry.region === "us-east-1",
    ),
    {
      collectorKey: "ec2.instances",
      region: "us-east-1",
      status: "SUCCEEDED",
      itemsObserved: 2,
      pagesObserved: 2,
    },
  );
  assert.deepEqual(
    collectorCoverage.find(
      (entry) => entry.collectorKey === "s3.buckets" && entry.region === "us-east-1",
    ),
    {
      collectorKey: "s3.buckets",
      region: "us-east-1",
      status: "SUCCEEDED",
      itemsObserved: 1,
      pagesObserved: 2,
    },
  );
  assert.deepEqual(clients.instanceTokens["us-east-1"], [undefined, "instances-next"]);
  assert.deepEqual(clients.bucketTokens.sort(), [
    "us-east-1:first",
    "us-east-1:us-east-1-buckets-next",
    "us-west-2:first",
    "us-west-2:us-west-2-buckets-next",
  ]);
  assert.deepEqual(clients.rdsMarkers["us-east-1"], [undefined, "rds-next"]);
  assert.deepEqual(clients.guardDutyTokens["us-east-1"], [
    undefined,
    undefined,
    "gd-next",
    "gd-next",
  ]);
  assert.equal(clients.tracker.maximum, 2);

  assert.equal(
    resources.filter((item) => item.resourceType === "aws.ec2.instance").length,
    3,
  );
  assert.equal(
    evidence.find(
      (item) =>
        item.evidenceType === "SECURITY_HUB_ENABLEMENT" &&
        item.region === "us-west-2",
    )?.status,
    "DISABLED",
  );
  assert.equal(
    evidence.find(
      (item) =>
        item.evidenceType === "S3_PUBLIC_ACCESS_BLOCK" &&
        item.subjectId === "bucket-west",
    )?.status,
    "NOT_CONFIGURED",
  );
  assert.deepEqual(
    resources.find((item) => item.resourceId === "i-east-1")?.tags,
    { Environment: "demo" },
  );
  assert.deepEqual(
    resources.find((item) => item.resourceId === "db-east-1")?.tags,
    { Service: "orders" },
  );

  for (const forbidden of [
    "ASIA-DO-NOT-RETURN",
    "SECRET-DO-NOT-RETURN",
    "TOKEN-DO-NOT-RETURN",
    "must-not-be-normalized",
    "must-not-cross-json-boundary",
    "not-in-allowlist",
    ["AKIA", "ABCDEFGHIJKLMNOP"].join(""),
    ["gh", "p_", "opaqueRepositoryTokenValue123456789"].join(""),
    ["eyJhbGciOiJIUzI1NiJ9", ".eyJzdWIiOiJjdXN0b21lciJ9", ".signaturePart123456"].join(""),
    ["postgres", "ql://demo:credential@db.internal/sutra"].join(""),
    ["https://example.invalid/object?X-Amz-", "Signature=deadbeef"].join(""),
    "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0",
    "MasterUsername",
    "Tags",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `leaked forbidden value: ${forbidden}`);
  }
});

test("imports sanitized AWS-native findings with stable severity, status, fingerprints, and resource links", async () => {
  const sink = new CapturingSink();
  const clients = new NativeFindingsClientFactory();
  const now = new Date("2026-07-15T12:00:00Z");
  const runner = new SingleAccountAwsInventoryRunner({
    clients,
    sink,
    regionSelector: new StaticInventoryRegionSelector(["us-east-1"]),
    globalControlRegion: "us-east-1",
    maxConcurrency: 3,
    now: () => now,
  });

  const collection = await runner.collect(context());
  const normalized = sink.batches.flatMap((batch) => batch.resources);
  const evidence = sink.batches.flatMap((batch) => batch.evidence);
  const nativeEvidence = evidence.filter(
    (item) => item.evidenceType === "AWS_NATIVE_FINDING",
  );
  const availability = evidence.filter(
    (item) => item.evidenceType === "AWS_NATIVE_FINDINGS_AVAILABILITY",
  );

  assert.equal(collection.coverage, "COMPLETE");
  assert.equal(nativeEvidence.length, 3);
  assert.deepEqual(
    collection.collectorCoverage
      .filter((entry) => entry.collectorKey.endsWith(".findings"))
      .map((entry) => ({
        key: entry.collectorKey,
        status: entry.status,
        items: entry.itemsObserved,
      })),
    [
      { key: "guardduty.findings", status: "SUCCEEDED", items: 1 },
      { key: "securityhub.findings", status: "SUCCEEDED", items: 1 },
      { key: "inspector2.findings", status: "SUCCEEDED", items: 1 },
    ],
  );
  assert.deepEqual(clients.guardDutyFindingTokens, [undefined, "gd-native-next"]);
  assert.deepEqual(clients.securityHubFindingTokens, [undefined, "securityhub-native-next"]);
  assert.deepEqual(clients.inspectorFindingTokens, [undefined, "inspector-native-next"]);
  assert.deepEqual(clients.securityHubFilters, [
    {
      AwsAccountId: [{ Value: "123456789012", Comparison: "EQUALS" }],
      Region: [{ Value: "us-east-1", Comparison: "EQUALS" }],
    },
    {
      AwsAccountId: [{ Value: "123456789012", Comparison: "EQUALS" }],
      Region: [{ Value: "us-east-1", Comparison: "EQUALS" }],
    },
  ]);
  assert.equal(availability.length, 3);
  assert.ok(availability.every((item) => item.status === "ENABLED"));
  assert.equal(
    JSON.stringify(nativeEvidence).includes("must-not-cross-native-finding-boundary"),
    false,
  );
  assert.equal(JSON.stringify(nativeEvidence).includes("INVALID_TEST_ACCESS_KEY"), false);
  assert.match(JSON.stringify(nativeEvidence), /\[redacted by Sutra\]/u);

  const connection = {
    tenantId: "tenant-01",
    connectionId: "conn-01",
    expectedAccountId: "123456789012",
    partition: "aws" as const,
    roleArn: "arn:aws:iam::123456789012:role/sutra/SutraReadOnlyRole",
    externalId: "sutra_external_id_1234567890abcd",
    status: "ACTIVE" as const,
    permissionPackVersion: "live-demo-2026-07.3" as const,
    enabledRegions: ["us-east-1"],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const snapshot = normalizeLiveSnapshot(
    connection,
    "job-native-findings-01",
    "sutra-job-native-findings-01",
    normalized,
    evidence,
    collection.coverage,
    collection.collectorCoverage,
    now,
  );
  const nativeFindings = snapshot.findings.filter((finding) =>
    finding.controlKey.startsWith("AWS.NATIVE."),
  );
  assert.deepEqual(
    nativeFindings
      .map((finding) => ({
        controlKey: finding.controlKey,
        severity: finding.severity,
        status: finding.status,
        linked: finding.resourceKey?.includes("i-east-1") ?? false,
      }))
      .sort((left, right) => left.controlKey.localeCompare(right.controlKey)),
    [
      {
        controlKey: "AWS.NATIVE.GUARDDUTY.FINDING",
        severity: "high",
        status: "open",
        linked: true,
      },
      {
        controlKey: "AWS.NATIVE.INSPECTOR2.FINDING",
        severity: "medium",
        status: "resolved",
        linked: true,
      },
      {
        controlKey: "AWS.NATIVE.SECURITYHUB.FINDING",
        severity: "critical",
        status: "suppressed",
        linked: true,
      },
    ],
  );
  const laterSnapshot = normalizeLiveSnapshot(
    connection,
    "job-native-findings-02",
    "sutra-job-native-findings-02",
    normalized,
    evidence,
    collection.coverage,
    collection.collectorCoverage,
    new Date("2026-07-16T12:00:00Z"),
  );
  assert.deepEqual(
    laterSnapshot.findings
      .filter((finding) => finding.controlKey.startsWith("AWS.NATIVE."))
      .map((finding) => finding.fingerprint),
    nativeFindings.map((finding) => finding.fingerprint),
  );
});

test("disabled native services are complete observations and repeated native pagination is partial", async () => {
  const disabledSink = new CapturingSink();
  const disabledRunner = new SingleAccountAwsInventoryRunner({
    clients: new RegionalAccountSignalClientFactory(),
    sink: disabledSink,
    regionSelector: new StaticInventoryRegionSelector(["us-east-1"]),
    globalControlRegion: "us-east-1",
  });
  const disabled = await disabledRunner.collect(context());
  const disabledAvailability = disabledSink.batches
    .flatMap((batch) => batch.evidence)
    .filter((item) => item.evidenceType === "AWS_NATIVE_FINDINGS_AVAILABILITY");
  assert.equal(disabled.coverage, "COMPLETE");
  assert.equal(disabledAvailability.length, 3);
  assert.ok(disabledAvailability.every((item) => item.status === "DISABLED"));
  assert.ok(
    disabled.collectorCoverage
      .filter((entry) => entry.collectorKey.endsWith(".findings"))
      .every((entry) => entry.status === "SUCCEEDED" && entry.itemsObserved === 0),
  );

  const partialSink = new CapturingSink();
  const partialRunner = new SingleAccountAwsInventoryRunner({
    clients: new RepeatedNativeFindingTokenClientFactory(),
    sink: partialSink,
    regionSelector: new StaticInventoryRegionSelector(["us-east-1"]),
    globalControlRegion: "us-east-1",
  });
  const partial = await partialRunner.collect(context());
  assert.equal(partial.coverage, "PARTIAL");
  assert.deepEqual(
    partial.collectorCoverage.find(
      (entry) => entry.collectorKey === "securityhub.findings",
    ),
    {
      collectorKey: "securityhub.findings",
      region: "us-east-1",
      status: "PARTIAL",
      itemsObserved: 0,
      pagesObserved: 3,
      errorCode: "COLLECTOR_PROTOCOL_ERROR",
      message: "The read-only AWS collector returned only partial coverage.",
    },
  );
});

test("native finding adapters mark a final over-cap page partial even without a continuation token", async () => {
  const sink = new CapturingSink();
  const runner = new SingleAccountAwsInventoryRunner({
    clients: new FinalPageOverflowNativeFindingsClientFactory(),
    sink,
    regionSelector: new StaticInventoryRegionSelector(["us-east-1"]),
    globalControlRegion: "us-east-1",
    maxConcurrency: 3,
    now: () => new Date("2026-07-15T12:00:00Z"),
  });

  const result = await runner.collect(context());
  const nativeCoverage = result.collectorCoverage
    .filter((entry) => entry.collectorKey.endsWith(".findings"))
    .map((entry) => ({
      collectorKey: entry.collectorKey,
      status: entry.status,
      itemsObserved: entry.itemsObserved,
      errorCode: entry.errorCode,
    }));

  assert.equal(result.coverage, "PARTIAL");
  assert.deepEqual(nativeCoverage, [
    {
      collectorKey: "guardduty.findings",
      status: "PARTIAL",
      itemsObserved: 1_000,
      errorCode: "COLLECTOR_PROTOCOL_ERROR",
    },
    {
      collectorKey: "securityhub.findings",
      status: "PARTIAL",
      itemsObserved: 1_000,
      errorCode: "COLLECTOR_PROTOCOL_ERROR",
    },
    {
      collectorKey: "inspector2.findings",
      status: "PARTIAL",
      itemsObserved: 1_000,
      errorCode: "COLLECTOR_PROTOCOL_ERROR",
    },
  ]);
  assert.equal(
    sink.batches
      .flatMap((batch) => batch.evidence)
      .filter((item) => item.evidenceType === "AWS_NATIVE_FINDING")
      .length,
    3_000,
  );
});

test("partial S3 blocking and absent CloudTrail produce explicit noncompliant evidence", async () => {
  const sink = new CapturingSink();
  const runner = new SingleAccountAwsInventoryRunner({
    clients: new PostureEdgeCaseClientFactory(),
    sink,
    regionSelector: new StaticInventoryRegionSelector(["us-east-1"]),
    globalControlRegion: "us-east-1",
    maxConcurrency: 2,
    now: () => new Date("2026-07-15T12:00:00Z"),
  });

  const result = await runner.collect(context());
  const evidence = sink.batches.flatMap((batch) => batch.evidence);
  const s3 = evidence.find((item) => item.evidenceType === "S3_PUBLIC_ACCESS_BLOCK");
  const cloudTrail = evidence.find(
    (item) => item.evidenceType === "CLOUDTRAIL_LOGGING_STATUS" && item.subjectId === context().accountId,
  );

  assert.equal(result.coverage, "COMPLETE");
  assert.equal(s3?.status, "NOT_CONFIGURED");
  assert.equal(s3?.data.blockPublicPolicy, false);
  assert.equal(cloudTrail?.status, "DISABLED");
  assert.equal(cloudTrail?.data.trailsObserved, 0);
  assert.equal(cloudTrail?.data.applicableTrailsObserved, 0);
  assert.equal(cloudTrail?.data.loggingTrailsObserved, 0);
  assert.equal(cloudTrail?.data.coverageBasis, "no-applicable-trail");
  assert.ok(
    result.collectorCoverage.some(
      (entry) => entry.collectorKey === "s3.buckets" && entry.region === "us-east-1",
    ),
  );
});

test("multi-Region CloudTrail shadow copies provide coverage without duplicate resources", async () => {
  const sink = new CapturingSink();
  const clients = new MultiRegionCloudTrailClientFactory();
  const runner = new SingleAccountAwsInventoryRunner({
    clients,
    sink,
    regionSelector: new StaticInventoryRegionSelector(["us-east-1", "us-west-2"]),
    globalControlRegion: "us-east-1",
    maxConcurrency: 4,
    now: () => new Date("2026-07-15T12:00:00Z"),
  });

  const result = await runner.collect(context());
  const trails = sink.batches
    .flatMap((batch) => batch.resources)
    .filter((item) => item.resourceType === "aws.cloudtrail.trail");
  const signals = sink.batches
    .flatMap((batch) => batch.evidence)
    .filter((item) => item.evidenceType === "CLOUDTRAIL_LOGGING_STATUS")
    .sort((left, right) => left.region.localeCompare(right.region));

  assert.deepEqual(clients.describeInputs, [
    { region: "us-east-1", includeShadowTrails: true },
    { region: "us-west-2", includeShadowTrails: true },
  ]);
  assert.equal(clients.statusCalls.length, 1);
  assert.deepEqual(clients.statusCalls[0], {
    region: "us-east-1",
    name: "arn:aws:cloudtrail:us-east-1:123456789012:trail/organization-audit",
  });
  assert.equal(trails.length, 1);
  assert.equal(trails[0]?.region, "us-east-1");
  assert.equal(trails[0]?.configuration.homeRegion, "us-east-1");
  assert.equal(trails[0]?.configuration.isMultiRegionTrail, true);
  assert.equal(trails[0]?.configuration.isOrganizationTrail, true);
  assert.equal(trails[0]?.configuration.isLogging, true);
  assert.deepEqual(
    signals.map((item) => ({
      region: item.region,
      status: item.status,
      coverageBasis: item.data.coverageBasis,
      applicableTrailsObserved: item.data.applicableTrailsObserved,
      loggingTrailsObserved: item.data.loggingTrailsObserved,
    })),
    [
      {
        region: "us-east-1",
        status: "ENABLED",
        coverageBasis: "multi-region-trail",
        applicableTrailsObserved: 1,
        loggingTrailsObserved: 1,
      },
      {
        region: "us-west-2",
        status: "ENABLED",
        coverageBasis: "multi-region-trail",
        applicableTrailsObserved: 1,
        loggingTrailsObserved: 1,
      },
    ],
  );
  assert.deepEqual(
    result.collectorCoverage
      .filter((entry) => entry.collectorKey === "cloudtrail.trails")
      .map((entry) => ({ region: entry.region, itemsObserved: entry.itemsObserved })),
    [
      { region: "us-east-1", itemsObserved: 1 },
      { region: "us-west-2", itemsObserved: 1 },
    ],
  );
});

test("regional account findings are unique and the live multi-Region snapshot passes the control-plane boundary", async () => {
  const sink = new CapturingSink();
  const now = new Date();
  const runner = new SingleAccountAwsInventoryRunner({
    clients: new RegionalAccountSignalClientFactory(),
    sink,
    regionSelector: new StaticInventoryRegionSelector(["us-east-1", "us-west-2"]),
    globalControlRegion: "us-east-1",
    maxConcurrency: 4,
    now: () => now,
  });
  const collection = await runner.collect(context());
  const normalized = sink.batches.flatMap((batch) => batch.resources);
  const evidence = sink.batches.flatMap((batch) => batch.evidence);
  const cloudTrailSignals = evidence
    .filter((item) => item.evidenceType === "CLOUDTRAIL_LOGGING_STATUS")
    .sort((left, right) => left.region.localeCompare(right.region));

  assert.deepEqual(
    cloudTrailSignals.map((item) => ({
      region: item.region,
      status: item.status,
      coverageBasis: item.data.coverageBasis,
    })),
    [
      { region: "us-east-1", status: "ENABLED", coverageBasis: "regional-trail" },
      { region: "us-west-2", status: "DISABLED", coverageBasis: "no-applicable-trail" },
    ],
  );

  const connection = {
    tenantId: "tenant-01",
    connectionId: "conn-01",
    expectedAccountId: "123456789012",
    partition: "aws" as const,
    roleArn: "arn:aws:iam::123456789012:role/sutra/SutraReadOnlyRole",
    externalId: "sutra_external_id_1234567890abcd",
    status: "ACTIVE" as const,
    permissionPackVersion: "live-demo-2026-07.3" as const,
    enabledRegions: ["us-east-1", "us-west-2"],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const snapshot = normalizeLiveSnapshot(
    connection,
    "job-multiregion-parse-01",
    "sutra-job-multiregion-parse-01",
    normalized,
    evidence,
    collection.coverage,
    collection.collectorCoverage,
    now,
  );
  const accountFindings = snapshot.findings.filter((finding) => finding.resourceKey === null);
  assert.equal(
    new Set(snapshot.findings.map((finding) => finding.fingerprint)).size,
    snapshot.findings.length,
  );
  assert.equal(
    accountFindings.filter((finding) => finding.controlKey === "SUTRA.AWS.GUARDDUTY.ENABLED").length,
    2,
  );
  assert.deepEqual(
    accountFindings
      .filter((finding) => finding.controlKey === "SUTRA.AWS.GUARDDUTY.ENABLED")
      .map((finding) => finding.evidence.region)
      .sort(),
    ["us-east-1", "us-west-2"],
  );
  assert.equal(
    accountFindings.filter((finding) => finding.controlKey === "SUTRA.AWS.SECURITYHUB.ENABLED").length,
    2,
  );
  assert.equal(
    accountFindings.filter((finding) => finding.controlKey === "SUTRA.AWS.CLOUDTRAIL.LOGGING").length,
    1,
  );

  const boundaryModule = await import(
    new URL("../../../../lib/pilot-boundary.ts", import.meta.url).href
  ) as {
    readonly parsePilotSnapshot: (
      value: unknown,
      expected: {
        readonly jobId: string;
        readonly connectionId: string;
        readonly accountId: string;
        readonly partition: "aws";
      },
    ) => Promise<unknown>;
  };
  await boundaryModule.parsePilotSnapshot(snapshot, {
    jobId: "job-multiregion-parse-01",
    connectionId: "conn-01",
    accountId: "123456789012",
    partition: "aws",
  });
});

test("service errors produce sanitized partial-coverage evidence and preserve other data", async () => {
  const sink = new CapturingSink();
  const clients = new FakeClientFactory("us-west-2");
  const runner = new SingleAccountAwsInventoryRunner({
    clients,
    sink,
    regionSelector: new StaticInventoryRegionSelector(["us-east-1", "us-west-2"]),
    maxConcurrency: 3,
    now: () => new Date("2026-07-15T12:00:00Z"),
  });

  const result = await runner.collect(context());
  const resources = sink.batches.flatMap((batch) => batch.resources);
  const evidence = sink.batches.flatMap((batch) => batch.evidence);
  const failure = evidence.find(
    (item) =>
      item.evidenceType === "COLLECTION_ERROR" &&
      item.service === "rds" &&
      item.region === "us-west-2",
  );

  assert.equal(result.coverage, "PARTIAL");
  assert.equal(
    result.collectorCoverage.filter((entry) => entry.status !== "SUCCEEDED").length,
    1,
  );
  assert.deepEqual(
    result.collectorCoverage.find(
      (entry) => entry.collectorKey === "rds.db-instances" && entry.region === "us-west-2",
    ),
    {
      collectorKey: "rds.db-instances",
      region: "us-west-2",
      status: "FAILED",
      itemsObserved: 0,
      pagesObserved: 0,
      errorCode: "RequestLimitExceeded",
      message: "The read-only AWS collector did not return a usable page.",
    },
  );
  assert.equal(
    result.collectorCoverage.find(
      (entry) => entry.collectorKey === "rds.db-instances" && entry.region === "us-east-1",
    )?.status,
    "SUCCEEDED",
  );
  assert.ok(resources.some((item) => item.resourceId === "db-east-1"));
  assert.deepEqual(failure?.data, { errorName: "RequestLimitExceeded" });
  assert.equal(JSON.stringify({ failure, result }).includes("message-with-sensitive-context"), false);
});

class RepeatedPaginationTokenClientFactory extends FakeClientFactory {
  public override ec2(region: string): Ec2InventoryClient {
    const client = super.ec2(region);
    if (region !== "us-east-1") return client;
    return {
      ...client,
      describeInstances: async (input) => ({
        ...(await client.describeInstances(input)),
        NextToken: "repeated-token",
      }),
    };
  }
}

test("a repeated pagination token marks only that adapter partial and retains completed pages", async () => {
  const sink = new CapturingSink();
  const runner = new SingleAccountAwsInventoryRunner({
    clients: new RepeatedPaginationTokenClientFactory(),
    sink,
    regionSelector: new StaticInventoryRegionSelector(["us-east-1", "us-west-2"]),
    maxConcurrency: 4,
    now: () => new Date("2026-07-15T12:00:00Z"),
  });

  const result = await runner.collect(context());
  const coverage = result.collectorCoverage.find(
    (entry) => entry.collectorKey === "ec2.instances" && entry.region === "us-east-1",
  );

  assert.equal(result.coverage, "PARTIAL");
  assert.deepEqual(coverage, {
    collectorKey: "ec2.instances",
    region: "us-east-1",
    status: "PARTIAL",
    itemsObserved: 2,
    pagesObserved: 2,
    errorCode: "COLLECTOR_PROTOCOL_ERROR",
    message: "The read-only AWS collector returned only partial coverage.",
  });
  assert.equal(
    result.collectorCoverage.filter((entry) => entry.status !== "SUCCEEDED").length,
    1,
  );
  assert.equal(
    result.collectorCoverage.find(
      (entry) => entry.collectorKey === "ec2.instances" && entry.region === "us-west-2",
    )?.status,
    "SUCCEEDED",
  );
  assert.equal(
    sink.batches
      .flatMap((batch) => batch.resources)
      .filter((resource) => resource.resourceType === "aws.ec2.instance" && resource.region === "us-east-1")
      .length,
    2,
  );
  assert.equal(JSON.stringify(result).includes("pagination token"), false);
});

class DeadlineRdsClientFactory extends FakeClientFactory {
  public commandWasAborted = false;

  public override rds(region: string): RdsInventoryClient {
    if (region !== "us-east-1") return super.rds(region);
    return {
      describeDBInstances: (_input, abortSignal) => new Promise((resolve, reject) => {
        void resolve;
        abortSignal?.addEventListener("abort", () => {
          this.commandWasAborted = true;
          reject(abortSignal.reason);
        }, { once: true });
      }),
    };
  }
}

class RetryableOnceRdsClientFactory extends FakeClientFactory {
  public calls = 0;

  public override rds(region: string): RdsInventoryClient {
    if (region !== "us-east-1") return super.rds(region);
    return {
      describeDBInstances: async () => {
        this.calls += 1;
        if (this.calls === 1) {
          const error = new Error("transient transport timeout");
          error.name = "TimeoutError";
          throw error;
        }
        return { $metadata: {}, DBInstances: [] };
      },
    };
  }
}

test("a pristine collector retries one exhausted transient transport failure", async () => {
  const sink = new CapturingSink();
  const clients = new RetryableOnceRdsClientFactory();
  const runner = new SingleAccountAwsInventoryRunner({
    clients,
    sink,
    regionSelector: new StaticInventoryRegionSelector(["us-east-1"]),
    maxConcurrency: 4,
    now: () => new Date("2026-07-15T12:00:00Z"),
  });

  const result = await runner.collect(context());
  const rds = result.collectorCoverage.find(
    (entry) => entry.collectorKey === "rds.db-instances",
  );

  assert.equal(clients.calls, 2);
  assert.equal(result.coverage, "COMPLETE");
  assert.equal(rds?.status, "SUCCEEDED");
  assert.equal(
    sink.batches
      .flatMap((batch) => batch.evidence)
      .some((item) => item.evidenceType === "COLLECTION_ERROR" && item.service === "rds"),
    false,
  );
});

test("a per-command deadline aborts AWS work and publishes sanitized partial coverage", async () => {
  const sink = new CapturingSink();
  const clients = new DeadlineRdsClientFactory();
  const runner = new SingleAccountAwsInventoryRunner({
    clients,
    sink,
    regionSelector: new StaticInventoryRegionSelector(["us-east-1"]),
    commandDeadlineMs: 20,
    collectionDeadlineMs: 1_000,
    maxConcurrency: 4,
    now: () => new Date("2026-07-15T12:00:00Z"),
  });

  const result = await runner.collect(context());
  const timedOut = result.collectorCoverage.find(
    (entry) => entry.collectorKey === "rds.db-instances",
  );
  const errorEvidence = sink.batches
    .flatMap((batch) => batch.evidence)
    .find((item) => item.evidenceType === "COLLECTION_ERROR" && item.service === "rds");

  assert.equal(clients.commandWasAborted, true);
  assert.equal(result.coverage, "PARTIAL");
  assert.deepEqual(timedOut, {
    collectorKey: "rds.db-instances",
    region: "us-east-1",
    status: "PARTIAL",
    itemsObserved: 0,
    pagesObserved: 0,
    errorCode: "COLLECTION_TIMEOUT",
    message: "The read-only AWS collector reached its bounded deadline.",
  });
  assert.deepEqual(errorEvidence?.data, {
    errorName: "InventoryCommandDeadlineError",
  });
  assert.equal(JSON.stringify({ result, errorEvidence }).includes("deadline was reached"), false);
});

class OverallDeadlineRdsClientFactory extends FakeClientFactory {
  public commandWasAborted = false;
  private page = 0;

  public override rds(region: string): RdsInventoryClient {
    if (region !== "us-east-1") return super.rds(region);
    return {
      describeDBInstances: (_input, abortSignal) => new Promise((resolve, reject) => {
        if (this.page === 0) {
          this.page = 1;
          resolve({
            $metadata: {},
            Marker: "page-1",
            DBInstances: [database("overall-1", region)],
          });
          return;
        }
        const timer = setTimeout(() => {
          this.page += 1;
          resolve({
            $metadata: {},
            Marker: `page-${this.page}`,
            DBInstances: [database(`overall-${this.page}`, region)],
          });
        }, 30);
        abortSignal?.addEventListener("abort", () => {
          clearTimeout(timer);
          this.commandWasAborted = true;
          reject(abortSignal.reason);
        }, { once: true });
      }),
    };
  }
}

test("the shared overall deadline aborts a multi-page adapter without publishing complete", async () => {
  const sink = new CapturingSink();
  const clients = new OverallDeadlineRdsClientFactory();
  const runner = new SingleAccountAwsInventoryRunner({
    clients,
    sink,
    regionSelector: new StaticInventoryRegionSelector(["us-east-1"]),
    commandDeadlineMs: 50,
    collectionDeadlineMs: 85,
    maxConcurrency: 4,
    now: () => new Date("2026-07-15T12:00:00Z"),
  });

  const result = await runner.collect(context());
  const timedOut = result.collectorCoverage.find(
    (entry) => entry.collectorKey === "rds.db-instances",
  );
  assert.equal(clients.commandWasAborted, true);
  assert.equal(result.coverage, "PARTIAL");
  assert.equal(timedOut?.status, "PARTIAL");
  assert.equal(timedOut?.errorCode, "COLLECTION_TIMEOUT");
  assert.ok((timedOut?.pagesObserved ?? 0) >= 1);
  assert.deepEqual(
    result.collectorCoverage.find(
      (entry) => entry.collectorKey === "sutra.collection-deadline",
    ),
    {
      collectorKey: "sutra.collection-deadline",
      region: "global",
      status: "PARTIAL",
      itemsObserved: 0,
      pagesObserved: 0,
      errorCode: "COLLECTION_TIMEOUT",
      message: "The bounded AWS collection reached its overall deadline.",
    },
  );
});

class SlowIamClientFactory extends FakeClientFactory {
  public slowWorkerSettled = false;

  public override iam(): IamInventoryClient {
    const client = super.iam();
    return {
      getAccountSummary: (signal) => client.getAccountSummary(signal),
      getAccountPasswordPolicy: async (signal) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        const output = await client.getAccountPasswordPolicy(signal);
        this.slowWorkerSettled = true;
        return output;
      },
    };
  }
}

class FailFirstSink implements AwsInventorySink {
  private failed = false;

  public async writeBatch(batch: AwsInventoryBatch): Promise<void> {
    void batch;
    if (!this.failed) {
      this.failed = true;
      throw new Error("private sink detail");
    }
  }
}

test("sink failure is propagated only after every bounded worker settles", async () => {
  const clients = new SlowIamClientFactory();
  const runner = new SingleAccountAwsInventoryRunner({
    clients,
    sink: new FailFirstSink(),
    regionSelector: new StaticInventoryRegionSelector(["us-east-1"]),
    maxConcurrency: 2,
  });

  await assert.rejects(
    runner.collect(context()),
    /Normalized AWS inventory sink write failed/u,
  );
  assert.equal(clients.slowWorkerSettled, true);
});

test("Region capacity cannot exceed the 500-row signed coverage boundary", async () => {
  assert.ok(
    LIVE_AWS_GLOBAL_COLLECTOR_COUNT +
      LIVE_AWS_REGIONAL_COLLECTOR_COUNT * LIVE_AWS_MAX_REGIONS <=
      LIVE_AWS_COVERAGE_ROW_LIMIT,
  );
  assert.ok(
    LIVE_AWS_GLOBAL_COLLECTOR_COUNT +
      LIVE_AWS_REGIONAL_COLLECTOR_COUNT * (LIVE_AWS_MAX_REGIONS + 1) >
      LIVE_AWS_COVERAGE_ROW_LIMIT,
  );
  const regions = Array.from(
    { length: LIVE_AWS_MAX_REGIONS + 1 },
    (_, index) => `us-test-${index + 1}`,
  );
  const runner = new SingleAccountAwsInventoryRunner({
    clients: new FakeClientFactory(),
    sink: new CapturingSink(),
    regionSelector: new StaticInventoryRegionSelector(regions),
  });
  await assert.rejects(
    runner.collect(context()),
    /Selected AWS Regions are invalid/u,
  );
});

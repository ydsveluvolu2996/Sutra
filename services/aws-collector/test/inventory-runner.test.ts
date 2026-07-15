import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import { test } from "node:test";

import {
  SingleAccountAwsInventoryRunner,
  StaticInventoryRegionSelector,
  type AwsInventoryClientFactory,
  type CloudTrailInventoryClient,
  type Ec2InventoryClient,
  type GuardDutyInventoryClient,
  type IamInventoryClient,
  type RdsInventoryClient,
  type S3InventoryClient,
  type SecurityHubInventoryClient,
} from "../src/inventory-runner.js";
import type {
  AwsInventoryBatch,
  AwsInventorySink,
  InventoryCollectionContext,
} from "../src/types.js";

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
  public readonly bucketTokens: (string | undefined)[] = [];

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
                      Tags: [{ Key: "secret", Value: "must-not-be-normalized" }],
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
    };
  }

  public s3(region: string): S3InventoryClient {
    return {
      listBuckets: (input) =>
        this.tracker.run(() => {
          this.bucketTokens.push(input.ContinuationToken);
          if (input.ContinuationToken === undefined) {
            return {
              $metadata: {},
              ContinuationToken: "buckets-next",
              Buckets: [
                { Name: "bucket-east", CreationDate: new Date("2026-01-01T00:00:00Z") },
              ],
            };
          }
          return {
            $metadata: {},
            Buckets: [
              { Name: "bucket-eu", CreationDate: new Date("2026-02-01T00:00:00Z") },
            ],
          };
        }),
      getBucketLocation: (input) =>
        this.tracker.run(() =>
          input.Bucket === "bucket-eu"
            ? { $metadata: {}, LocationConstraint: "eu-west-1" }
            : { $metadata: {} },
        ),
      getPublicAccessBlock: (input) =>
        this.tracker.run(() => {
          if (input.Bucket === "bucket-eu") {
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
  };
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

  assert.deepEqual(result, {
    resourcesObserved: 20,
    findingsObserved: 9,
    coverage: "COMPLETE",
  });
  assert.deepEqual(clients.instanceTokens["us-east-1"], [undefined, "instances-next"]);
  assert.deepEqual(clients.bucketTokens, [undefined, "buckets-next"]);
  assert.deepEqual(clients.rdsMarkers["us-east-1"], [undefined, "rds-next"]);
  assert.deepEqual(clients.guardDutyTokens["us-east-1"], [undefined, "gd-next"]);
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
        item.subjectId === "bucket-eu",
    )?.status,
    "NOT_CONFIGURED",
  );

  for (const forbidden of [
    "ASIA-DO-NOT-RETURN",
    "SECRET-DO-NOT-RETURN",
    "TOKEN-DO-NOT-RETURN",
    "must-not-be-normalized",
    "MasterUsername",
    "Tags",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `leaked forbidden value: ${forbidden}`);
  }
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
  assert.ok(resources.some((item) => item.resourceId === "db-east-1"));
  assert.deepEqual(failure?.data, { errorName: "RequestLimitExceeded" });
  assert.equal(JSON.stringify(failure).includes("message-with-sensitive-context"), false);
});

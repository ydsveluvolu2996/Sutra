import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import { test } from "node:test";

import {
  AwsEnabledRegionSelector,
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
import { normalizeLiveSnapshot } from "../src/local-server.js";
import type {
  AwsInventoryBatch,
  AwsInventorySink,
  InventoryCollectionContext,
} from "../src/types.js";

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
    TagList: [{ Key: "Service", Value: "orders" }],
  };
}

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
    };
  }

  public override securityHub(): SecurityHubInventoryClient {
    return {
      describeHub: async () => {
        const error = new Error("hub disabled");
        error.name = "InvalidAccessException";
        throw error;
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
    findingsObserved: 9,
    coverage: "COMPLETE",
  });
  assert.equal(collectorCoverage.length, 20);
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

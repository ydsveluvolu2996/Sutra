import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createExtendedSupportAwsSdkReader } from
  "../src/extended-support-aws-sdk-reader.js";
import { EXTENDED_SUPPORT_PROVIDER_OPERATIONS } from
  "../src/extended-support-provider-adapter.js";

const NOW = Date.parse("2026-08-02T00:00:00.000Z");
const BOUNDARY = Object.freeze({
  scope: Object.freeze({
    orgId: "org_extended",
    customerId: "customer_extended",
    connectionId: `conn_${"a".repeat(32)}`,
  }),
  managementAccountId: "111122223333",
  partition: "aws" as const,
  accountIds: Object.freeze(["111122223333"]),
  regions: Object.freeze(["us-east-1"]),
});
const CREDENTIALS = Object.freeze({
  accessKeyId: "ASIAEXAMPLE",
  secretAccessKey: "never-returned",
  sessionToken: "never-returned",
  expiration: new Date(NOW + 900_000),
});

function fixture(options: { readonly repeatEksToken?: boolean; readonly failEks?: boolean } = {}) {
  const commands: string[] = [];
  let listClustersCalls = 0;
  const send = async (command: { constructor: { name: string } }) => {
    const name = command.constructor.name;
    commands.push(name);
    if (options.failEks && name === "ListClustersCommand") throw new Error("secret diagnostic");
    switch (name) {
      case "ListClustersCommand":
        listClustersCalls += 1;
        return options.repeatEksToken
          ? { clusters: [], nextToken: "same-token" }
          : { clusters: ["cluster-a"] };
      case "DescribeClusterCommand":
        return { cluster: {
          arn: "arn:aws:eks:us-east-1:111122223333:cluster/cluster-a",
          version: "1.31", upgradePolicy: { supportType: "STANDARD" },
        } };
      case "DescribeClusterVersionsCommand":
        return { clusterVersions: [{
          clusterVersion: "1.31",
          endOfStandardSupportDate: new Date("2026-09-01T00:00:00.000Z"),
          endOfExtendedSupportDate: new Date("2027-09-01T00:00:00.000Z"),
          versionStatus: "STANDARD_SUPPORT",
        }] };
      case "DescribeDBInstancesCommand":
        return { DBInstances: [{
          DBInstanceArn: "arn:aws:rds:us-east-1:111122223333:db:pg-a",
          DBInstanceIdentifier: "pg-a", Engine: "postgres", EngineVersion: "14.9",
          EngineLifecycleSupport: "open-source-rds-extended-support",
          DBInstanceClass: "db.r6g.large",
        }] };
      case "DescribeDBClustersCommand":
        return { DBClusters: [{
          DBClusterArn: "arn:aws:rds:us-east-1:111122223333:cluster:aurora-a",
          DBClusterIdentifier: "aurora-a", Engine: "aurora-postgresql",
          EngineVersion: "14.9", EngineLifecycleSupport: "open-source-rds-extended-support",
          DBClusterMembers: [{}],
        }] };
      case "DescribeDBMajorEngineVersionsCommand":
        return { DBMajorEngineVersions: [{
          Engine: "postgres", MajorEngineVersion: "14",
          SupportedEngineLifecycles: [{
            LifecycleSupportName: "open-source-rds-standard-support",
            LifecycleSupportEndDate: new Date("2026-10-01T00:00:00.000Z"),
          }, {
            LifecycleSupportName: "open-source-rds-extended-support",
            LifecycleSupportStartDate: new Date("2026-10-01T00:00:00.000Z"),
            LifecycleSupportEndDate: new Date("2029-10-01T00:00:00.000Z"),
          }],
        }, { Engine: "aurora-postgresql", MajorEngineVersion: "14" }] };
      case "DescribeOrderableDBInstanceOptionsCommand":
        return { OrderableDBInstanceOptions: [] };
      case "ListDomainNamesCommand":
        return { DomainNames: [{ DomainName: "search-a" }] };
      case "DescribeDomainCommand":
        return { DomainStatus: { DomainName: "search-a" } };
      case "DescribeDomainsCommand":
        return { DomainStatusList: [{
          ARN: "arn:aws:es:us-east-1:111122223333:domain/search-a",
          DomainName: "search-a", EngineVersion: "OpenSearch_2.11", ClusterConfig: {},
        }] };
      case "DescribeCacheClustersCommand":
        return { CacheClusters: [{
          ARN: "arn:aws:elasticache:us-east-1:111122223333:cluster:redis-a",
          CacheClusterId: "redis-a", Engine: "redis", EngineVersion: "6.2",
          CacheNodeType: "cache.r6g.large", NumCacheNodes: 2,
        }] };
      case "DescribeReplicationGroupsCommand": return { ReplicationGroups: [] };
      case "DescribeCacheEngineVersionsCommand": return { CacheEngineVersions: [] };
      case "GetProductsCommand": return { PriceList: [] };
      default: throw new Error(`unexpected command ${name}`);
    }
  };
  const clients = {
    eks: { send }, rds: { send }, openSearch: { send }, elastiCache: { send }, pricing: { send },
  };
  return { commands, clients, listClustersCalls: () => listClustersCalls };
}

describe("Extended Support default AWS SDK reader", () => {
  it("executes the exact fourteen-operation contract and emits normalized evidence", async () => {
    const mock = fixture();
    let supplementPricingValidated: boolean | null = null;
    const reader = createExtendedSupportAwsSdkReader({
      boundary: BOUNDARY,
      sessionForAccount: async () => CREDENTIALS,
      clientFactory: () => mock.clients as never,
      supplementLoader: { load: async (input) => {
        supplementPricingValidated = input.pricingPermissionValidated;
        return {
          schemaVersion: "sutra.extended-support-provider-supplement.v1",
          scope: input.boundary.scope, calendars: [], rates: [], observedCharges: [],
        };
      } },
      now: () => NOW,
    });
    const region = await reader.collectRegion({
      boundary: BOUNDARY, accountId: BOUNDARY.managementAccountId,
      region: "us-east-1", operations: EXTENDED_SUPPORT_PROVIDER_OPERATIONS,
      signal: new AbortController().signal,
    });
    const pages = [];
    for await (const page of region.pages) pages.push(page);
    const coverage = await region.coverage;
    const supplement = await reader.collectSupplement({
      boundary: BOUNDARY,
      observedResourceKeys: pages[0]!.observations.map((_, index) => `resource-${index}`),
      signal: new AbortController().signal,
    });
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.finalPage, true);
    assert.equal(pages[0]!.observations.length, 5);
    assert.equal(coverage.length, 5);
    assert.ok(coverage.every((entry) => entry.status === "SUCCEEDED"));
    assert.equal(supplementPricingValidated, true);
    assert.deepEqual(supplement.scope, BOUNDARY.scope);
    const operationByCommand = new Map([
      ["ListClustersCommand", "eks:ListClusters"],
      ["DescribeClusterCommand", "eks:DescribeCluster"],
      ["DescribeClusterVersionsCommand", "eks:DescribeClusterVersions"],
      ["DescribeDBInstancesCommand", "rds:DescribeDBInstances"],
      ["DescribeDBClustersCommand", "rds:DescribeDBClusters"],
      ["DescribeDBMajorEngineVersionsCommand", "rds:DescribeDBMajorEngineVersions"],
      ["DescribeOrderableDBInstanceOptionsCommand", "rds:DescribeOrderableDBInstanceOptions"],
      ["ListDomainNamesCommand", "es:ListDomainNames"],
      ["DescribeDomainCommand", "es:DescribeDomain"],
      ["DescribeDomainsCommand", "es:DescribeDomains"],
      ["DescribeCacheClustersCommand", "elasticache:DescribeCacheClusters"],
      ["DescribeReplicationGroupsCommand", "elasticache:DescribeReplicationGroups"],
      ["DescribeCacheEngineVersionsCommand", "elasticache:DescribeCacheEngineVersions"],
      ["GetProductsCommand", "pricing:GetProducts"],
    ]);
    assert.deepEqual([...new Set(mock.commands)].map((name) => operationByCommand.get(name)),
      EXTENDED_SUPPORT_PROVIDER_OPERATIONS);
    assert.doesNotMatch(JSON.stringify({ pages, coverage, supplement }),
      /ASIAEXAMPLE|never-returned|secret diagnostic/u);
  });

  it("contains provider failures and rejects replayed pagination tokens", async () => {
    for (const options of [{ failEks: true }, { repeatEksToken: true }]) {
      const mock = fixture(options);
      const reader = createExtendedSupportAwsSdkReader({
        boundary: BOUNDARY, sessionForAccount: async () => CREDENTIALS,
        clientFactory: () => mock.clients as never, now: () => NOW,
      });
      const result = await reader.collectRegion({
        boundary: BOUNDARY, accountId: BOUNDARY.managementAccountId,
        region: "us-east-1", operations: EXTENDED_SUPPORT_PROVIDER_OPERATIONS,
        signal: new AbortController().signal,
      });
      const coverage = await result.coverage;
      assert.deepEqual(coverage.find(({ service }) => service === "EKS"), {
        service: "EKS", status: "FAILED", readPermissionsValidated: false,
        errorCode: "PROVIDER_UNAVAILABLE",
      });
      assert.ok(coverage.filter(({ service }) => service !== "EKS")
        .every(({ status }) => status === "SUCCEEDED"));
      if (options.repeatEksToken) assert.equal(mock.listClustersCalls(), 2);
    }
  });
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AWS_CMDB_CATALOG,
  findAwsCatalogResourceTypeByNormalizedType,
  findAwsCatalogService,
} from "../lib/aws-cmdb-catalog.ts";

test("canonical AWS catalog preserves captured provenance without manufacturing a resource type", async () => {
  assert.equal(AWS_CMDB_CATALOG.categories.length, 18);
  assert.equal(AWS_CMDB_CATALOG.services.length, 114);
  assert.equal(AWS_CMDB_CATALOG.source.capturedResourceCoverageRecordCount, 978);
  assert.equal(AWS_CMDB_CATALOG.source.usableResourceCoverageTypeCount, 977);
  assert.equal(AWS_CMDB_CATALOG.source.taggableResourceTypeCount, 317);
  assert.equal(AWS_CMDB_CATALOG.source.unionResourceTypeCount, 986);
  assert.equal(AWS_CMDB_CATALOG.resourceTypes.length, 987);
  assert.equal(AWS_CMDB_CATALOG.resourceTypes.filter((type) => type.origin === "sutra_extension").length, 1);
  assert.equal(AWS_CMDB_CATALOG.resourceTypes.filter((type) => type.taggable).length, 317);
  assert.equal(AWS_CMDB_CATALOG.resourceTypes.some((type) => type.name === "AWS Resource Coverage"), false);

  const [coverage, taggable, navigator] = await Promise.all([
    readFile(new URL("../docs/research/cloudaware-aws-product-map/raw/aws-resource-coverage.txt", import.meta.url)),
    readFile(new URL("../docs/research/cloudaware-aws-product-map/raw/aws-taggable-resource-types.txt", import.meta.url)),
    readFile(new URL("../docs/research/cloudaware-aws-product-map/raw/aws-navigator-routes.json", import.meta.url)),
  ]);
  const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  assert.equal(AWS_CMDB_CATALOG.source.resourceCoverageSha256, hash(coverage));
  assert.equal(AWS_CMDB_CATALOG.source.taggableResourceTypesSha256, hash(taggable));
  assert.equal(AWS_CMDB_CATALOG.source.navigatorRoutesSha256, hash(navigator));
});

test("all catalog rows have one category/service route and explicit independent maturity flags", () => {
  const scopedIds = new Set<string>();
  for (const category of AWS_CMDB_CATALOG.categories) {
    assert.match(category.id, /^aws\./u);
    for (const service of category.services) {
      assert.equal(service.categoryId, category.id);
      assert.ok(service.href.startsWith("/cmdb/navigator/"));
      for (const type of service.resourceTypes) {
        const scopedId = `${service.id}/${type.id}`;
        assert.equal(scopedIds.has(scopedId), false, scopedId);
        scopedIds.add(scopedId);
        assert.equal(type.categoryId, category.id);
        assert.equal(type.serviceId, service.id);
        assert.equal(type.maturity.cataloged, true);
        assert.equal(typeof type.maturity.adapterPlanned, "boolean");
        assert.equal(typeof type.maturity.implemented, "boolean");
        assert.equal(typeof type.maturity.externallyAccepted, "boolean");
        assert.equal(typeof type.maturity.unavailable, "boolean");
        if (!type.maturity.implemented) {
          assert.equal(type.normalizedResourceType, null);
          assert.equal(type.collectorKey, null);
          assert.equal(type.requirementsState, "not_assessed");
        }
      }
    }
  }
  assert.equal(scopedIds.size, 987);
});

test("existing normalized CMDB types are explicitly bound and Cloud WAN tag-only types remain visible", () => {
  const implemented = AWS_CMDB_CATALOG.resourceTypes.filter((type) => type.maturity.implemented);
  assert.equal(implemented.length, 32);
  assert.equal(new Set(implemented.map((type) => type.normalizedResourceType)).size, 32);
  assert.ok(implemented.every((type) => type.collectorKey !== null && type.requiredOperations.length > 0));
  assert.equal(findAwsCatalogResourceTypeByNormalizedType("aws.ec2.vpc")?.name, "AWS VPC");
  assert.deepEqual(
    [
      "aws.ec2.route",
      "aws.ec2.route-table-association",
      "aws.ec2.network-acl-entry",
      "aws.ec2.network-acl-association",
      "aws.ec2.internet-gateway-attachment",
    ].map((resourceType) => ({
      resourceType,
      catalog: findAwsCatalogResourceTypeByNormalizedType(resourceType),
    })).map(({ resourceType, catalog }) => ({
      resourceType,
      collectorKey: catalog?.collectorKey,
      operations: catalog?.requiredOperations,
    })),
    [
      { resourceType: "aws.ec2.route", collectorKey: "ec2.route-tables", operations: ["ec2:DescribeRouteTables"] },
      { resourceType: "aws.ec2.route-table-association", collectorKey: "ec2.route-tables", operations: ["ec2:DescribeRouteTables"] },
      { resourceType: "aws.ec2.network-acl-entry", collectorKey: "ec2.network-acls", operations: ["ec2:DescribeNetworkAcls"] },
      { resourceType: "aws.ec2.network-acl-association", collectorKey: "ec2.network-acls", operations: ["ec2:DescribeNetworkAcls"] },
      { resourceType: "aws.ec2.internet-gateway-attachment", collectorKey: "ec2.internet-gateways", operations: ["ec2:DescribeInternetGateways"] },
    ],
  );
  assert.equal(findAwsCatalogResourceTypeByNormalizedType("aws.ssm.patch-state")?.origin, "sutra_extension");

  const cloudWan = findAwsCatalogService("aws-cloud-wan");
  assert.ok(cloudWan);
  assert.equal(cloudWan.resourceTypes.length, 9);
  assert.ok(cloudWan.resourceTypes.every((type) => type.taggable && !type.referenceCoverage));
});

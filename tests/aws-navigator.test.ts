import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAwsNavigatorStateBoundary,
  buildAwsNavigatorEnvelope,
  coverageForAwsCatalogType,
} from "../lib/aws-navigator.ts";
import {
  findAwsCatalogResourceType,
  findAwsCatalogResourceTypeByNormalizedType,
  findAwsCatalogService,
} from "../lib/aws-cmdb-catalog.ts";
import type { PilotCoverageEntry, PilotResource, PilotState } from "../lib/pilot-types.ts";

const NOW = Date.parse("2026-08-21T06:00:00.000Z");
const CONNECTION_ID = `conn_${"a".repeat(32)}`;

function coverage(collectorKey: string, status: PilotCoverageEntry["status"] = "succeeded", errorCode?: string): PilotCoverageEntry {
  return {
    collectorKey,
    region: "us-east-1",
    status,
    itemsObserved: status === "succeeded" ? 1 : 0,
    pagesObserved: 1,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function resource(resourceType: string, id: string, lifecycleState: PilotResource["lifecycleState"] = "active", region = "us-east-1"): PilotResource {
  return {
    resourceKey: `aws:111122223333:${region}:${resourceType}:${id}`,
    service: resourceType.split(".")[1] ?? "aws",
    resourceType,
    nativeId: id,
    arn: null,
    name: id,
    region,
    state: "available",
    tags: { Name: id },
    configuration: {},
    source: { api: "test:List", accountId: "111122223333", collectedAt: "2026-08-21T05:00:00.000Z" },
    contentSha256: "b".repeat(64),
    lifecycleState,
    consecutiveCompleteMisses: lifecycleState === "retirement_pending" ? 1 : 0,
    evidenceSnapshot: { id: "snap_a", snapshotSha256: "c".repeat(64) },
  };
}

function state(overrides: Partial<PilotState> = {}): PilotState {
  return {
    mode: "live",
    connection: {
      id: CONNECTION_ID,
      customerId: "customer_a",
      customerName: "Acme",
      sourceKind: "aws_trust_role",
      fixtureId: null,
      fixtureVersion: null,
      partition: "aws",
      awsAccountId: "111122223333",
      roleArn: "arn:aws:iam::111122223333:role/SutraReadOnly",
      status: "active",
      enabledRegions: ["us-east-1", "us-west-2"],
      permissionPackVersion: "2026-08.12",
      roleProvisioningMode: "sutra_template",
      expectedRolePath: "/sutra/",
      expectedRoleName: "SutraReadOnly",
      permissionCapabilities: null,
      lastValidatedAt: "2026-08-21T04:00:00.000Z",
      lastSuccessfulSyncAt: "2026-08-21T05:00:00.000Z",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-21T05:00:00.000Z",
    },
    resources: [],
    relationships: [],
    findings: [],
    coverage: [],
    latestRunCoverage: null,
    syncRuns: [{ id: "run_complete", connectionId: CONNECTION_ID, status: "succeeded", coverageState: "complete", totals: {}, startedAt: "2026-08-21T04:59:00.000Z", finishedAt: "2026-08-21T05:01:00.000Z", createdAt: "2026-08-21T04:59:00.000Z" }],
    activeSnapshot: { id: "snap_a", collectedAt: "2026-08-21T05:00:00.000Z", coverageState: "complete", snapshotSha256: "c".repeat(64), origin: { kind: "aws_live", fixtureId: null, fixtureVersion: null } },
    ...overrides,
  };
}

test("type counts become numeric only for a complete exact collector/Region boundary", () => {
  const vpc = findAwsCatalogResourceTypeByNormalizedType("aws.ec2.vpc");
  const subnet = findAwsCatalogResourceTypeByNormalizedType("aws.ec2.subnet");
  const route = findAwsCatalogResourceTypeByNormalizedType("aws.ec2.route");
  assert.ok(vpc && subnet && route);
  const current = state({
    resources: [
      resource("aws.ec2.vpc", "vpc-current"),
      resource("aws.ec2.vpc", "vpc-retained", "retirement_pending"),
      resource("aws.ec2.route", "rtb-a/route/0.0.0.0%2F0"),
    ],
    coverage: [coverage("ec2.vpcs"), coverage("ec2.subnets"), coverage("ec2.route-tables")],
  });
  assert.deepEqual(coverageForAwsCatalogType(current, vpc, "us-east-1", NOW), {
    state: "complete",
    authoritativeCount: 1,
    lastKnownCount: null,
    retirementPendingCount: 1,
    message: "The selected collector boundary succeeded; zero is authoritative when shown.",
  });
  const zero = coverageForAwsCatalogType(current, subnet, "us-east-1", NOW);
  assert.equal(zero.state, "complete");
  assert.equal(zero.authoritativeCount, 0);
  const routeCoverage = coverageForAwsCatalogType(current, route, "us-east-1", NOW);
  assert.equal(routeCoverage.state, "complete");
  assert.equal(routeCoverage.authoritativeCount, 1);

  const west = coverageForAwsCatalogType(current, vpc, "us-west-2", NOW);
  assert.equal(west.state, "not_collected");
  assert.equal(west.authoritativeCount, null);

  const allRegions = coverageForAwsCatalogType(current, vpc, "all", NOW);
  assert.equal(allRegions.state, "partial");
  assert.equal(allRegions.authoritativeCount, null);
});

test("catalog-only, permission-denied, retained, and stale states never become truthful zero", () => {
  const vpc = findAwsCatalogResourceTypeByNormalizedType("aws.ec2.vpc");
  const vpcService = findAwsCatalogService("aws-vpc");
  const nat = vpcService && findAwsCatalogResourceType(vpcService.id, "aws-vpc-nat-gateway");
  assert.ok(vpc && nat);
  const catalogOnly = coverageForAwsCatalogType(state(), nat, "all", NOW);
  assert.equal(catalogOnly.authoritativeCount, null);
  assert.equal(catalogOnly.lastKnownCount, null);
  assert.equal(catalogOnly.state, "not_collected");

  const denied = state({
    activeSnapshot: null,
    syncRuns: [{ id: "run_denied", connectionId: CONNECTION_ID, status: "failed", coverageState: "partial", totals: {}, startedAt: "2026-08-21T05:30:00.000Z", finishedAt: "2026-08-21T05:31:00.000Z", createdAt: "2026-08-21T05:30:00.000Z" }],
    latestRunCoverage: { syncRunId: "run_denied", entries: [coverage("ec2.vpcs", "failed", "AccessDeniedException")] },
  });
  assert.equal(coverageForAwsCatalogType(denied, vpc, "us-east-1", NOW).state, "permission_required");
  assert.equal(coverageForAwsCatalogType(denied, vpc, "us-east-1", NOW).authoritativeCount, null);

  const retained = state({
    resources: [resource("aws.ec2.vpc", "vpc-last-good")],
    coverage: [coverage("ec2.vpcs")],
    syncRuns: [{ id: "run_later", connectionId: CONNECTION_ID, status: "partial", coverageState: "partial", totals: {}, startedAt: "2026-08-21T05:30:00.000Z", finishedAt: "2026-08-21T05:31:00.000Z", createdAt: "2026-08-21T05:30:00.000Z" }],
    latestRunCoverage: { syncRunId: "run_later", entries: [coverage("ec2.vpcs", "partial")] },
  });
  const retainedCoverage = coverageForAwsCatalogType(retained, vpc, "us-east-1", NOW);
  assert.equal(retainedCoverage.state, "partial");
  assert.equal(retainedCoverage.authoritativeCount, null);
  assert.equal(retainedCoverage.lastKnownCount, 1);

  const stale = state({
    resources: [resource("aws.ec2.vpc", "vpc-old")],
    coverage: [coverage("ec2.vpcs")],
    activeSnapshot: { id: "snap_old", collectedAt: "2026-08-18T05:00:00.000Z", coverageState: "complete", snapshotSha256: "d".repeat(64), origin: { kind: "aws_live", fixtureId: null, fixtureVersion: null } },
    syncRuns: [],
  });
  const staleCoverage = coverageForAwsCatalogType(stale, vpc, "us-east-1", NOW);
  assert.equal(staleCoverage.state, "stale");
  assert.equal(staleCoverage.authoritativeCount, null);
  assert.equal(staleCoverage.lastKnownCount, 1);
});

test("Navigator routes all catalog services, scopes search by Region, and rejects wrong-tenant state substitution", () => {
  const current = state({
    resources: [resource("aws.ec2.route", "only-west-route-secret", "active", "us-west-2")],
    coverage: [coverage("ec2.route-tables"), { ...coverage("ec2.route-tables"), region: "us-west-2" }],
  });
  const root = buildAwsNavigatorEnvelope({ state: current, nowMs: NOW });
  assert.equal(root.categories.length, 18);
  assert.equal(root.catalog.serviceCount, 114);
  assert.equal(root.catalog.referenceTypeCount, 986);
  assert.equal(root.scope.connectionId, CONNECTION_ID);

  const service = buildAwsNavigatorEnvelope({ state: current, segments: ["aws-vpc"], region: "us-east-1", query: "only-west-route-secret", nowMs: NOW });
  assert.equal(service.destination.kind, "service");
  assert.equal(service.resourceTypes.length, findAwsCatalogService("aws-vpc")?.resourceTypes.length);
  assert.equal(service.searchResults.some((result) => result.kind === "resource"), false);

  const empty = buildAwsNavigatorEnvelope({ state: { ...state(), mode: "empty", connection: null, activeSnapshot: null, resources: [], syncRuns: [] }, nowMs: NOW });
  assert.equal(empty.scope.connectionId, null);
  assert.ok(empty.categories.every((category) => category.observedInCoveredTypes === null));

  assert.doesNotThrow(() => assertAwsNavigatorStateBoundary(current.connection!, current));
  assert.throws(() => assertAwsNavigatorStateBoundary({ ...current.connection!, customerId: "customer_other" }, current), /AWS Navigator request rejected/u);
  assert.throws(() => assertAwsNavigatorStateBoundary({ ...current.connection!, awsAccountId: "999900001111" }, current), /AWS Navigator request rejected/u);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  COST_ALLOCATABLE_RESOURCE_TYPES,
  buildTagGovernanceInputs,
} from "../lib/finops-tag-governance-inputs.ts";
import type { JsonValue, PilotResource } from "../lib/pilot-types.ts";

function resource(over: Partial<PilotResource> & { resourceType: string; nativeId: string }): PilotResource {
  return {
    resourceKey: over.resourceKey ?? `aws:1:us-east-1:svc:${over.resourceType}:${over.nativeId}`,
    service: over.service ?? "ec2",
    resourceType: over.resourceType,
    nativeId: over.nativeId,
    arn: over.arn ?? null,
    name: over.name ?? null,
    region: over.region ?? "us-east-1",
    state: over.state ?? "available",
    tags: over.tags ?? {},
    configuration: (over.configuration ?? {}) as Readonly<Record<string, JsonValue>>,
    source: over.source ?? { api: "ec2:Describe", accountId: "111122223333", collectedAt: "2026-07-01T00:00:00.000Z" },
    contentSha256: over.contentSha256 ?? "0".repeat(64),
  };
}

test("keeps only cost-allocatable resource types and drops network / posture metadata", () => {
  const input = buildTagGovernanceInputs({
    resources: [
      resource({ resourceType: "aws.ec2.instance", nativeId: "i-1", tags: { Owner: "a" } }),
      resource({ resourceType: "aws.rds.db-instance", nativeId: "db-1", tags: {} }),
      resource({ resourceType: "aws.s3.bucket", nativeId: "b-1", service: "s3", tags: {} }),
      // Excluded: network + posture-only records carry no directly attributable spend.
      resource({ resourceType: "aws.ec2.security-group", nativeId: "sg-1", tags: {} }),
      resource({ resourceType: "aws.iam.account", nativeId: "acct", service: "iam", tags: {} }),
      resource({ resourceType: "aws.guardduty.detector", nativeId: "det", service: "guardduty", tags: {} }),
    ],
  });
  const keys = input.resources.map((r) => r.resourceKey);
  assert.equal(input.resources.length, 3);
  assert.ok(keys.some((k) => k.includes("aws.ec2.instance")));
  assert.ok(keys.some((k) => k.includes("aws.rds.db-instance")));
  assert.ok(keys.some((k) => k.includes("aws.s3.bucket")));
  assert.equal(keys.some((k) => k.includes("security-group")), false);
  assert.equal(keys.some((k) => k.includes("iam.account")), false);
});

test("passes collected tags through verbatim and threads curLines + requiredTags", () => {
  const input = buildTagGovernanceInputs({
    resources: [resource({ resourceType: "aws.ec2.volume", nativeId: "vol-1", tags: { CostCenter: "cc-9" } })],
    curLines: [{
      lineItemId: "l-1",
      usageAccountId: "111122223333",
      service: "AmazonEC2",
      chargeCategory: "Usage",
      usageStartIso: "2026-07-01T00:00:00.000Z",
      amountMicros: "1000000",
      currency: "USD",
      region: null,
      amortizedMicros: null,
      commitmentType: null,
      commitmentId: null,
      commitmentExpiry: null,
      usageType: null,
      usageAmountMicros: null,
      usageUnit: null,
      tags: {},
    }],
    requiredTags: ["CostCenter"],
  });
  assert.deepEqual(input.resources[0].tags, { CostCenter: "cc-9" });
  assert.equal(input.curLines?.length, 1);
  assert.deepEqual([...(input.requiredTags ?? [])], ["CostCenter"]);
});

test("honours a custom cost-allocatable suffix override", () => {
  const input = buildTagGovernanceInputs({
    resources: [
      resource({ resourceType: "aws.ec2.instance", nativeId: "i-1" }),
      resource({ resourceType: "aws.dynamodb.table", nativeId: "t-1", service: "dynamodb" }),
    ],
    includeResourceTypeSuffixes: ["dynamodb.table"],
  });
  assert.equal(input.resources.length, 1);
  assert.ok(input.resources[0].resourceKey.includes("dynamodb.table"));
});

test("the default cost-allocatable set includes the new waste resource types", () => {
  assert.ok(COST_ALLOCATABLE_RESOURCE_TYPES.includes("ec2.snapshot"));
  assert.ok(COST_ALLOCATABLE_RESOURCE_TYPES.includes("ec2.elastic-ip"));
});

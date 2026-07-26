import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_REQUIRED_TAGS,
  buildTagGovernance,
  type TagGovernanceResource,
} from "../lib/finops-tag-governance.ts";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";

const units = (whole: number): string => String(whole * 1_000_000);

function res(resourceKey: string, tags: Record<string, string>): TagGovernanceResource {
  return { resourceKey, service: "ec2", region: "us-east-1", tags };
}

test("defaults to CostCenter/Owner/Environment and reports per-tag resource coverage", () => {
  const report = buildTagGovernance({
    resources: [
      res("r-full", { CostCenter: "cc-1", Owner: "team-a", Environment: "prod" }),
      res("r-partial", { CostCenter: "cc-2" }),
      res("r-none", {}),
    ],
  });
  assert.deepEqual([...report.requiredTags], [...DEFAULT_REQUIRED_TAGS]);
  const costCenter = report.resourceCoverage.find((c) => c.tag === "CostCenter");
  assert.equal(costCenter?.resourcesWithTag, 2);
  assert.equal(costCenter?.resourcesTotal, 3);
  const owner = report.resourceCoverage.find((c) => c.tag === "Owner");
  assert.equal(owner?.resourcesWithTag, 1);
  assert.deepEqual(owner?.missingResourceKeys, ["r-none", "r-partial"]);
  assert.equal(report.summary.resourcesFullyTagged, 1);
  assert.equal(report.summary.resourcesMissingAnyTag, 2);
});

test("lists each resource with exactly the required tags it is missing", () => {
  const report = buildTagGovernance({
    resources: [res("r-partial", { CostCenter: "cc-2" })],
  });
  assert.deepEqual(report.missingByResource, [
    { resourceKey: "r-partial", service: "ec2", region: "us-east-1", missingTags: ["Owner", "Environment"] },
  ]);
});

test("matches required tags case-insensitively and only when the value is non-empty", () => {
  const report = buildTagGovernance({
    resources: [res("r", { costcenter: "cc", owner: "", Environment: "prod" })],
  });
  const missing = report.missingByResource[0]?.missingTags;
  // costcenter matches (case-insensitive); owner present but empty => still missing.
  assert.deepEqual(missing, ["Owner"]);
});

test("computes untagged spend per currency from CUR line tags using the same join as allocation", () => {
  const lines: NormalizedCurLine[] = [
    curLine({ amount: 100, currency: "USD", tags: { CostCenter: "a", Owner: "b", Environment: "prod" } }),
    curLine({ amount: 40, currency: "USD", tags: { CostCenter: "a" } }), // missing Owner + Environment
    curLine({ amount: 10, currency: "USD", tags: {} }), // missing all -> unattributable
  ];
  const report = buildTagGovernance({ resources: [], curLines: lines });
  const usd = report.spendByCurrency.find((s) => s.currency === "USD");
  assert.equal(usd?.totalMicros, units(150));
  assert.equal(usd?.untaggedMicros, units(50)); // 40 + 10
  assert.equal(usd?.unattributableMicros, units(10));
  assert.equal(usd?.untaggedPercent, Number(((50 / 150) * 100).toFixed(2)));
  assert.equal(usd?.perTagMissingMicros.Owner, units(50));
  assert.equal(usd?.perTagMissingMicros.CostCenter, units(10));
});

test("never sums spend across currencies", () => {
  const report = buildTagGovernance({
    resources: [],
    curLines: [
      curLine({ amount: 100, currency: "USD", tags: {} }),
      curLine({ amount: 200, currency: "EUR", tags: {} }),
    ],
  });
  assert.equal(report.spendByCurrency.length, 2);
  assert.equal(report.spendByCurrency.find((s) => s.currency === "USD")?.totalMicros, units(100));
  assert.equal(report.spendByCurrency.find((s) => s.currency === "EUR")?.totalMicros, units(200));
});

test("honours a custom required-tag policy", () => {
  const report = buildTagGovernance({
    resources: [res("r", { team: "x" })],
    requiredTags: ["Team", "Project"],
  });
  assert.deepEqual([...report.requiredTags], ["Team", "Project"]);
  assert.deepEqual(report.missingByResource[0]?.missingTags, ["Project"]);
});

function curLine(over: { amount: number; currency: string; tags: Record<string, string> }): NormalizedCurLine {
  return {
    lineItemId: `${over.currency}-${over.amount}`,
    usageAccountId: "111122223333",
    service: "AmazonEC2",
    chargeCategory: "Usage",
    usageStartIso: "2026-07-01T00:00:00.000Z",
    amountMicros: units(over.amount),
    currency: over.currency,
    region: null,
    tags: over.tags,
  };
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCurCsv, type CanonicalCurLine } from "../lib/finops-cur.ts";
import {
  evaluateFinopsKpis,
  FINOPS_KPI_FORMULAS,
  FINOPS_KPI_IDS,
  type FinopsKpiGoalVersion,
  type FinopsKpiId,
  type FinopsKpiInput,
  type FinopsKpiResourceAgeEvidence,
  type FinopsKpiSavingsAssumption,
} from "../lib/finops-kpi.ts";
import type {
  FinopsReconciliationScope,
  ScopedCanonicalBillingRow,
} from "../lib/finops-reconciliation.ts";

const SCOPE: FinopsReconciliationScope = {
  organizationId: "org_kpi",
  customerId: "customer_kpi",
  connectionId: "conn_kpi",
  exportName: "aws-cur",
  billingPeriod: "2026-07",
  generationId: `fbg_${"4".repeat(64)}`,
};
const TENANT_SCOPE = {
  organizationId: SCOPE.organizationId,
  customerId: SCOPE.customerId,
  connectionId: SCOPE.connectionId,
} as const;

function parseLine(
  id: string,
  account: string,
  service: string,
  charge: string,
  usageType: string,
  cost: string,
  currency = "USD",
  quantity = "1",
  unit = "Hrs",
): CanonicalCurLine {
  const parsed = parseCurCsv([
    "line_item_id,line_item_usage_account_id,product_servicecode,line_item_line_item_type,line_item_usage_start_date,line_item_unblended_cost,line_item_currency_code,line_item_usage_type,line_item_usage_amount,pricing_unit",
    [id, account, service, charge, "2026-07-10T00:00:00Z", cost, currency, usageType, quantity, unit].join(","),
  ].join("\n"));
  if ("error" in parsed) throw new Error(parsed.error);
  assert.equal(parsed.lines.length, 1);
  return parsed.lines[0];
}

function allKpiLines(): readonly CanonicalCurLine[] {
  return [
    parseLine("ec2-old", "111", "AmazonEC2", "Usage", "USE1-BoxUsage:m4.large", "10"),
    parseLine("ec2-grav", "111", "AmazonEC2", "Usage", "USE1-BoxUsage:m7g.large", "8"),
    { ...parseLine("ec2-amd", "111", "AmazonEC2", "Usage", "USE1-BoxUsage:m6a.large", "7"), pricingTerm: "OnDemand" },
    { ...parseLine("ec2-spot", "111", "AmazonEC2", "SpotUsage", "USE1-BoxUsage:c7g.large", "2"), pricingTerm: "Spot" },
    parseLine("ebs-gp3", "111", "AmazonEC2", "Usage", "EBS:VolumeUsage.gp3", "3", "USD", "100", "GB-Mo"),
    { ...parseLine("snapshot-old", "111", "AmazonEC2", "Usage", "EBS:SnapshotUsage", "4", "USD", "100", "GB-Mo"), resourceId: "snap-old" },
    parseLine("s3-standard", "111", "AmazonS3", "Usage", "TimedStorage-ByteHrs:StandardStorage", "5", "USD", "1000", "GB-Mo"),
    { ...parseLine("rds-grav", "111", "AmazonRDS", "Usage", "InstanceUsage:db.r7g.large:PostgreSQL", "9"), pricingTerm: "OnDemand" },
    { ...parseLine("rds-x86", "111", "AmazonRDS", "Usage", "InstanceUsage:db.r6i.large:Oracle", "11"), commitmentType: "reserved" },
    { ...parseLine("cache-grav", "111", "AmazonElastiCache", "Usage", "NodeUsage:cache.r7g.large", "6"), pricingTerm: "OnDemand" },
    { ...parseLine("search-grav", "111", "AmazonOpenSearch", "Usage", "NodeUsage:r7g.large", "6"), pricingTerm: "OnDemand" },
    parseLine("lambda-grav", "111", "AWSLambda", "Usage", "Lambda-GB-Second-arm64", "1", "USD", "100", "GB-Second"),
    { ...parseLine("sagemaker-od", "111", "AmazonSageMaker", "Usage", "InstanceUsage:ml.m6i.large", "5"), pricingTerm: "OnDemand" },
    { ...parseLine("redshift-od", "111", "AmazonRedshift", "Usage", "NodeUsage:ra3.xlplus", "5"), pricingTerm: "OnDemand" },
    parseLine("dynamo-od", "111", "AmazonDynamoDB", "Usage", "PayPerRequest-Thruput", "2", "USD", "100", "Requests"),
  ];
}

function scoped(lines: readonly CanonicalCurLine[]): readonly ScopedCanonicalBillingRow[] {
  return lines.map((line) => ({ ...SCOPE, line }));
}

function baseInput(
  rows = scoped(allKpiLines()),
  overrides: Partial<FinopsKpiInput> = {},
): FinopsKpiInput {
  return {
    scope: SCOPE,
    rows,
    evidenceWindow: {
      startIso: "2026-07-01T00:00:00Z",
      endIso: "2026-08-01T00:00:00Z",
      evaluatedAtIso: "2026-08-01T01:00:00Z",
      sourceEvidenceId: "s3://sutra-billing/cur/manifest#v1",
      manifestSha256: "8".repeat(64),
    },
    resourceAgeEvidence: [{
      ...TENANT_SCOPE,
      resourceId: "snap-old",
      createdAtIso: "2026-01-01T00:00:00Z",
      observedAtIso: "2026-08-01T00:00:00Z",
      source: "aws_ec2_describe_snapshots",
      sourceEvidenceId: "aws://ec2/describe-snapshots/2026-08-01",
    }],
    ...overrides,
  };
}

function validGoal(
  kpiId: FinopsKpiId,
  overrides: Partial<FinopsKpiGoalVersion> = {},
): FinopsKpiGoalVersion {
  const formula = FINOPS_KPI_FORMULAS.find(({ id }) => id === kpiId);
  if (formula === undefined) throw new Error("formula missing");
  return {
    ...TENANT_SCOPE,
    id: `goal-${kpiId}-v1`,
    version: 1,
    kpiId,
    targetDirection: formula.targetDirection,
    targetBasisPoints: 5_000,
    effectiveFromIso: "2026-07-01T00:00:00Z",
    effectiveToIso: null,
    actorId: "admin-1",
    auditReference: "audit://goal/change-1",
    rbacDecision: {
      decisionId: "decision-1",
      decision: "allow",
      action: "finops:kpi-goal:write",
      resource: [
        "finops-kpi",
        SCOPE.organizationId,
        SCOPE.customerId,
        SCOPE.connectionId,
        kpiId,
      ].join(":"),
      actorId: "admin-1",
      decidedAtIso: "2026-06-30T00:00:00Z",
      policyVersion: "rbac-v3",
      evidenceReference: "audit://rbac/decision-1",
    },
    ...overrides,
  };
}

describe("Foundational FinOps KPI engine", () => {
  it("registers and evaluates every required KPI formula deterministically", () => {
    assert.deepEqual(FINOPS_KPI_FORMULAS.map(({ id }) => id), FINOPS_KPI_IDS);
    assert.equal(new Set(FINOPS_KPI_IDS).size, 19);
    const result = evaluateFinopsKpis(baseInput());
    assert.equal(result.ok, true);
    assert.deepEqual(result.measurements.map(({ kpiId }) => kpiId), FINOPS_KPI_IDS);
    for (const measurement of result.measurements) {
      assert.equal(measurement.state, "measured", measurement.kpiId);
      assert.ok(measurement.segments.length > 0, measurement.kpiId);
      assert.equal(measurement.findingKind, "candidate_estimate");
      assert.equal(measurement.validationRequired, true);
    }
  });

  it("validates audited RBAC goals, selects the effective version, and rejects overlap", () => {
    const earlier = validGoal("ec2_graviton_share", {
      id: "goal-graviton-v1",
      version: 1,
      effectiveFromIso: "2026-07-01T00:00:00Z",
      effectiveToIso: "2026-07-15T00:00:00Z",
    });
    const current = validGoal("ec2_graviton_share", {
      id: "goal-graviton-v2",
      version: 2,
      effectiveFromIso: "2026-07-15T00:00:00Z",
      targetBasisPoints: 7_500,
    });
    const result = evaluateFinopsKpis(baseInput(undefined, {
      goals: [current, earlier],
    }));
    assert.equal(result.ok, true);
    const graviton = result.measurements.find(({ kpiId }) =>
      kpiId === "ec2_graviton_share");
    assert.equal(graviton?.selectedGoal?.id, "goal-graviton-v2");
    assert.equal(graviton?.selectedGoal?.rbacDecisionId, "decision-1");
    assert.equal(graviton?.segments[0]?.currentBasisPoints, 5_000);
    assert.equal(graviton?.segments[0]?.goalStatus, "not_met");
    assert.equal(graviton?.segments[0]?.gapBasisPoints, 2_500);

    const correctedScope = {
      ...SCOPE,
      generationId: `fbg_${"9".repeat(64)}`,
    };
    const correctedRows = allKpiLines().map((line) => ({
      ...correctedScope,
      line,
    }));
    const persistedAcrossDelivery = evaluateFinopsKpis(baseInput(
      correctedRows,
      {
        scope: correctedScope,
        goals: [current, earlier],
      },
    ));
    assert.equal(persistedAcrossDelivery.ok, true);
    assert.equal(
      persistedAcrossDelivery.measurements.find(({ kpiId }) =>
        kpiId === "ec2_graviton_share")?.selectedGoal?.id,
      "goal-graviton-v2",
      "tenant KPI goals persist across corrected billing generations",
    );

    const overlapping = evaluateFinopsKpis(baseInput(undefined, {
      goals: [
        earlier,
        validGoal("ec2_graviton_share", {
          id: "goal-overlap",
          version: 2,
          effectiveFromIso: "2026-07-10T00:00:00Z",
        }),
      ],
    }));
    assert.equal(overlapping.ok, false);
    assert.equal(overlapping.failures[0]?.code, "OVERLAPPING_GOALS");

    const denied = evaluateFinopsKpis(baseInput(undefined, {
      goals: [validGoal("ec2_spot_share", {
        rbacDecision: {
          ...validGoal("ec2_spot_share").rbacDecision,
          decision: "deny",
        },
      })],
    }));
    assert.equal(denied.ok, false);
    assert.equal(denied.failures[0]?.code, "GOAL_RBAC_DENIED");

    const invalid = evaluateFinopsKpis(baseInput(undefined, {
      goals: [validGoal("ec2_spot_share", {
        targetBasisPoints: 10_001,
      })],
    }));
    assert.equal(invalid.ok, false);
    assert.equal(invalid.failures[0]?.code, "INVALID_GOAL");
  });

  it("never combines currencies or incompatible usage units", () => {
    const usdHours = {
      ...parseLine("usd-hours", "111", "AmazonEC2", "Usage", "BoxUsage:m7g.large", "10", "USD", "2", "Hrs"),
      usageAmountMicros: "90000000000000000000000000000000000000",
    };
    const usdSeconds = parseLine("usd-seconds", "111", "AmazonEC2", "Usage", "BoxUsage:m6i.large", "5", "USD", "3600", "seconds");
    const usdUnknownUnit = parseLine("usd-unknown-unit", "111", "AmazonEC2", "Usage", "BoxUsage:m7g.large", "4", "USD", "99", "");
    const eurHours = parseLine("eur-hours", "111", "AmazonEC2", "Usage", "BoxUsage:m6i.large", "6", "EUR", "1", "Hrs");
    const result = evaluateFinopsKpis(baseInput(scoped([
      usdHours,
      usdSeconds,
      usdUnknownUnit,
      eurHours,
    ]), { resourceAgeEvidence: [] }));
    assert.equal(result.ok, true);
    const graviton = result.measurements.find(({ kpiId }) =>
      kpiId === "ec2_graviton_share");
    assert.deepEqual(
      graviton?.segments.map(({ currency, usageUnit, numerator, denominator }) => ({
        currency,
        usageUnit,
        numerator,
        denominator,
      })),
      [
        { currency: "USD", usageUnit: null, numerator: "4000000", denominator: "4000000" },
        { currency: "EUR", usageUnit: "Hrs", numerator: "0", denominator: "1000000" },
        {
          currency: "USD",
          usageUnit: "Hrs",
          numerator: "90000000000000000000000000000000000000",
          denominator: "90000000000000000000000000000000000000",
        },
        { currency: "USD", usageUnit: "seconds", numerator: "0", denominator: "3600000000" },
      ],
    );
  });

  it("withholds snapshot age findings and architecture compatibility when evidence is absent", () => {
    const [snapshot] = allKpiLines().filter(({ lineItemId }) =>
      lineItemId === "snapshot-old");
    const result = evaluateFinopsKpis(baseInput(scoped([snapshot]), {
      resourceAgeEvidence: [],
    }));
    assert.equal(result.ok, true);
    const aged = result.measurements.find(({ kpiId }) => kpiId === "aged_snapshots");
    assert.equal(aged?.state, "insufficient_evidence");
    assert.deepEqual(aged?.segments, []);
    assert.ok(aged?.reasonCodes.includes(
      "AUTHORITATIVE_SNAPSHOT_AGE_EVIDENCE_MISSING",
    ));
    assert.equal(
      result.measurements.find(({ kpiId }) =>
        kpiId === "ec2_graviton_share")?.state,
      "not_applicable",
    );

    const unknown = parseLine(
      "ec2-unknown",
      "111",
      "AmazonEC2",
      "Usage",
      "ComputeUsage",
      "3",
    );
    const architecture = evaluateFinopsKpis(baseInput(scoped([unknown]), {
      resourceAgeEvidence: [],
    }));
    assert.equal(architecture.ok, true);
    const graviton = architecture.measurements.find(({ kpiId }) =>
      kpiId === "ec2_graviton_share");
    assert.equal(graviton?.state, "insufficient_evidence");
    assert.equal(architecture.opportunities.some(({ kpiId }) =>
      kpiId === "ec2_graviton_share"), false);

    const empty = evaluateFinopsKpis(baseInput([], {
      resourceAgeEvidence: [],
    }));
    assert.equal(empty.ok, true);
    assert.ok(empty.measurements.every(({ state }) => state === "missing"));
  });

  it("withholds savings without compatible evidence and discloses exact rate math when supplied", () => {
    const [old] = allKpiLines();
    const without = evaluateFinopsKpis(baseInput(scoped([old]), {
      resourceAgeEvidence: [],
    }));
    assert.equal(without.ok, true);
    const noSavings = without.opportunities.find(({ kpiId }) =>
      kpiId === "ec2_previous_generation");
    assert.equal(noSavings?.estimatedSavingsMicros, null);
    assert.deepEqual(noSavings?.assumptionIds, []);
    assert.equal(noSavings?.validationRequired, true);

    const assumption: FinopsKpiSavingsAssumption = {
      ...TENANT_SCOPE,
      id: "assumption-previous-gen-usd-v1",
      version: 1,
      kpiId: "ec2_previous_generation",
      currency: "USD",
      basis: "unblended_cost",
      savingsRateBasisPoints: 1_501,
      effectiveFromIso: "2026-07-01T00:00:00Z",
      effectiveToIso: null,
      sourceReference: "pricing://validated/rate-card-v7",
      compatibleEvidenceReference: "inventory://validated/ec2-old",
      actorId: "finops-analyst",
      auditReference: "audit://assumption/change-9",
    };
    const withEvidence = evaluateFinopsKpis(baseInput(scoped([old]), {
      resourceAgeEvidence: [],
      savingsAssumptions: [assumption],
    }));
    assert.equal(withEvidence.ok, true);
    const estimated = withEvidence.opportunities.find(({ kpiId }) =>
      kpiId === "ec2_previous_generation");
    assert.equal(estimated?.estimatedSavingsMicros, "1501000");
    assert.equal(estimated?.rateApplicationRemainder, "0");
    assert.deepEqual(estimated?.assumptionIds, [assumption.id]);
    assert.ok(estimated?.assumptionReferences.includes(
      assumption.compatibleEvidenceReference,
    ));
  });

  it("rejects cross-tenant configuration and every cross-generation billing row", () => {
    const [line] = allKpiLines();
    for (const mismatch of [
      { organizationId: "org_attacker" },
      { customerId: "customer_attacker" },
      { connectionId: "conn_attacker" },
      { exportName: "other-export" },
      { billingPeriod: "2026-06" },
      { generationId: `fbg_${"5".repeat(64)}` },
    ] as const) {
      const result = evaluateFinopsKpis(baseInput([
        { ...SCOPE, ...mismatch, line },
      ]));
      assert.equal(result.ok, false);
      assert.equal(result.failures[0]?.code, "ROW_SCOPE_MISMATCH");
    }

    const goal = validGoal("ec2_spot_share", { customerId: "customer_attacker" });
    const goalResult = evaluateFinopsKpis(baseInput(scoped([line]), {
      goals: [goal],
    }));
    assert.equal(goalResult.ok, false);
    assert.equal(goalResult.failures[0]?.code, "GOAL_SCOPE_MISMATCH");

    const age: FinopsKpiResourceAgeEvidence = {
      ...TENANT_SCOPE,
      customerId: "customer_attacker",
      resourceId: "snap-old",
      createdAtIso: "2026-01-01T00:00:00Z",
      observedAtIso: "2026-08-01T00:00:00Z",
      source: "aws_ec2_describe_snapshots",
      sourceEvidenceId: "aws://snapshots",
    };
    const ageResult = evaluateFinopsKpis(baseInput(scoped([line]), {
      resourceAgeEvidence: [age],
    }));
    assert.equal(ageResult.ok, false);
    assert.equal(
      ageResult.failures[0]?.code,
      "RESOURCE_EVIDENCE_SCOPE_MISMATCH",
    );
  });

  it("excludes tax, credit, refund, fee, discount, and adjustment rows from KPI ratios", () => {
    const charges = [
      "Tax",
      "Credit",
      "Refund",
      "Fee",
      "Discount",
      "Adjustment",
    ].map((charge, index) => parseLine(
      `excluded-${charge}`,
      "111",
      "AmazonEC2",
      charge,
      "BoxUsage:m4.large",
      String(index + 1),
    ));
    const usage = parseLine(
      "included",
      "111",
      "AmazonEC2",
      "Usage",
      "BoxUsage:m7g.large",
      "1",
    );
    const result = evaluateFinopsKpis(baseInput(scoped([...charges, usage]), {
      resourceAgeEvidence: [],
    }));
    assert.equal(result.ok, true);
    const previous = result.measurements.find(({ kpiId }) =>
      kpiId === "ec2_previous_generation");
    assert.equal(previous?.eligibleLineCount, 1);
    assert.equal(previous?.segments[0]?.currentBasisPoints, 0);
  });

  it("returns deterministic bounded output independent of input ordering", () => {
    const rows = scoped(allKpiLines());
    const forward = evaluateFinopsKpis(baseInput(rows, { maxOpportunities: 3 }));
    const reverse = evaluateFinopsKpis(baseInput([...rows].reverse(), {
      maxOpportunities: 3,
    }));
    assert.equal(forward.ok, true);
    assert.equal(reverse.ok, true);
    assert.equal(JSON.stringify(forward), JSON.stringify(reverse));
    assert.ok(forward.opportunities.length <= 3);
    assert.equal(
      forward.opportunitiesTruncated,
      allKpiLines().length > forward.opportunities.length,
    );
  });
});

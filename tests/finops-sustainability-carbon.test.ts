import assert from "node:assert/strict";
import test from "node:test";

import {
  AWS_CARBON_DATA_EXPORT_ACCESS_IAM_ACTIONS,
  AWS_CARBON_EMISSIONS_COLUMNS,
  AWS_SUSTAINABILITY_API_READ_IAM_ACTIONS,
  buildSustainabilityCarbonDashboard,
  normalizeSustainabilityCarbonCapture,
  SustainabilityCarbonError,
  sustainabilityCarbonSourceEvidence,
  type SustainabilityCarbonCapture,
  type SustainabilityScope,
} from "../lib/finops-sustainability-carbon.ts";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const PAYER = "111111111111";
const MEMBER = "222222222222";
const SCOPE: SustainabilityScope = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: `conn_${"a".repeat(32)}`,
  accountId: PAYER,
  partition: "aws",
};

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function carbonRow() {
  return {
    lastRefreshTimestampIso: "2026-07-21T10:00:00.000Z",
    location: "US East (N. Virginia)",
    modelVersion: "v3.0.1",
    payerAccountId: PAYER,
    productCode: "AmazonEC2",
    regionCode: "us-east-1",
    totalLbmEmissionsUnit: "MTCO2e" as const,
    totalLbmEmissionsValue: "0.000010",
    totalMbmEmissionsUnit: "MTCO2e" as const,
    totalMbmEmissionsValue: "0.000008",
    totalScope1EmissionsValue: "0.000001",
    totalScope1EmissionsUnit: "MTCO2e" as const,
    totalScope2LbmEmissionsValue: "0.000004",
    totalScope2LbmEmissionsUnit: "MTCO2e" as const,
    totalScope2MbmEmissionsValue: "0.000002",
    totalScope2MbmEmissionsUnit: "MTCO2e" as const,
    totalScope3LbmEmissionsValue: "0.000005",
    totalScope3LbmEmissionsUnit: "MTCO2e" as const,
    totalScope3MbmEmissionsValue: "0.000005",
    totalScope3MbmEmissionsUnit: "MTCO2e" as const,
    usageAccountId: MEMBER,
    usagePeriodEndIso: "2026-07-01T00:00:00.000Z",
    usagePeriodStartIso: "2026-06-01T00:00:00.000Z",
  };
}

function capture(): Mutable<SustainabilityCarbonCapture> {
  const objectKey = "tenant-carbon/model_version=v3.0.1/usage_period=2026-06/report.csv.gz";
  return {
    schemaVersion: "sutra.sustainability-carbon.v1",
    scope: { ...SCOPE },
    captureId: `sustainability_${"b".repeat(64)}`,
    startedAtIso: "2026-07-31T11:50:00.000Z",
    completedAtIso: "2026-07-31T12:00:00.000Z",
    allowedUsageAccountIds: [PAYER, MEMBER],
    configuration: {
      cur2Configured: true,
      carbonExportConfigured: true,
      carbonExportAccessValidated: true,
    },
    proxyEvidence: {
      source: "AWS_CUR2_ACTIVE_GENERATION",
      generationId: `fbg_${"c".repeat(64)}`,
      manifestSha256: "d".repeat(64),
      dataThroughAtIso: "2026-07-31T10:00:00.000Z",
      rowsExhausted: true,
      rows: [{
        lineItemId: "line-ec2-001",
        usageAccountId: MEMBER,
        service: "Amazon Elastic Compute Cloud",
        region: "us-east-1",
        resourceId: "i-0123456789abcdef0",
        usageStartIso: "2026-07-31T09:00:00.000Z",
        usageEndIso: "2026-07-31T10:00:00.000Z",
        usageType: "USE1-BoxUsage:m7g.xlarge",
        sourceUsageUnit: "Hrs",
        sourceUsageQuantityMicros: "1500000",
        metric: "COMPUTE_VCPU_HOURS",
        normalization: {
          kind: "PINNED_MULTIPLIER",
          numerator: "4",
          denominator: "1",
          evidenceSource: "AWS_EC2_INSTANCE_TYPE_INFO",
          evidenceVersion: "ec2-instance-types-2026-07-31",
        },
        workloadTagKey: "workloadId",
        workloadTagValue: "payments",
      }, {
        lineItemId: "line-dt-001",
        usageAccountId: MEMBER,
        service: "AWS Data Transfer",
        region: "us-east-1",
        resourceId: null,
        usageStartIso: "2026-07-31T09:00:00.000Z",
        usageEndIso: "2026-07-31T10:00:00.000Z",
        usageType: "DataTransfer-Out-Bytes",
        sourceUsageUnit: "GB",
        sourceUsageQuantityMicros: "1250000",
        metric: "DATA_TRANSFER_GB",
        normalization: {
          kind: "IDENTITY",
          numerator: "1",
          denominator: "1",
          evidenceSource: null,
          evidenceVersion: null,
        },
        workloadTagKey: null,
        workloadTagValue: null,
      }],
    },
    carbonEvidence: {
      source: "AWS_SUSTAINABILITY_CARBON_DATA_EXPORT",
      tableName: "CARBON_EMISSIONS",
      exportName: "sutra_carbon_monthly",
      exportArn: `arn:aws:bcm-data-exports:us-east-1:${PAYER}:export/sutra_carbon_monthly`,
      exportRegion: "us-east-1",
      bucket: "sutra-carbon-evidence-111111111111",
      prefix: "tenant-carbon",
      generationId: `fbg_${"e".repeat(64)}`,
      manifestSha256: "f".repeat(64),
      schemaColumns: [...AWS_CARBON_EMISSIONS_COLUMNS],
      publicationKind: "MONTHLY",
      publishedAtIso: "2026-07-21T12:00:00.000Z",
      allowedUsageAccountIds: [PAYER, MEMBER],
      expectedUsagePeriods: ["2026-06"],
      objectsExhausted: true,
      objects: [{
        bucket: "sutra-carbon-evidence-111111111111",
        key: objectKey,
        eTag: "etag-carbon-001",
        versionId: "version-carbon-001",
        sha256: "1".repeat(64),
        sizeBytes: 4096,
      }],
      rowsExhausted: true,
      periods: [{
        usagePeriod: "2026-06",
        selectedModelVersion: "v3.0.1",
        deliveryState: "DELIVERED_ROWS",
        objectKeys: [objectKey],
        complete: true,
      }],
      rows: [carbonRow()],
    },
  };
}

test("pins the current carbon schema and exact read-only Sustainability permissions", () => {
  assert.equal(AWS_CARBON_EMISSIONS_COLUMNS.length, 23);
  assert.deepEqual(AWS_CARBON_DATA_EXPORT_ACCESS_IAM_ACTIONS, [
    "sustainability:GetCarbonFootprintSummary",
  ]);
  assert.deepEqual(AWS_SUSTAINABILITY_API_READ_IAM_ACTIONS, [
    "sustainability:GetEstimatedCarbonEmissions",
    "sustainability:GetEstimatedCarbonEmissionsDimensionValues",
  ]);
  assert.equal([...AWS_CARBON_DATA_EXPORT_ACCESS_IAM_ACTIONS, ...AWS_SUSTAINABILITY_API_READ_IAM_ACTIONS]
    .every((action) => action.startsWith("sustainability:Get")), true);
});

test("keeps normalized CUR2 proxies and AWS provider carbon as separate evidence planes", () => {
  const snapshot = normalizeSustainabilityCarbonCapture(capture(), SCOPE, NOW);
  assert.equal(snapshot.state, "current");
  assert.equal(snapshot.complete, true);
  const compute = snapshot.proxy.rows.find((row) => row.metric === "COMPUTE_VCPU_HOURS");
  assert.equal(compute?.metricValueMicros, "6000000");
  assert.equal(compute?.metricUnit, "vCPU-hours");
  assert.equal(snapshot.providerCarbon.rows[0]?.totalLbmEmissionsValue, "0.000010");

  const dashboard = buildSustainabilityCarbonDashboard(snapshot, NOW);
  const computeSeries = dashboard.proxySeries.find((row) => row.metric === "COMPUTE_VCPU_HOURS");
  assert.equal(computeSeries?.valueMicros, "6000000");
  assert.equal(computeSeries?.unit, "vCPU-hours");
  assert.equal(dashboard.providerCarbonSeries[0]?.totalLbmMicroMtco2e, "10");
  assert.equal(dashboard.providerCarbonSeries[0]?.totalMbmMicroMtco2e, "8");
  assert.equal(dashboard.providerCarbonSeries[0]?.scope1MicroMtco2e, "1");
  assert.equal(dashboard.lineage.carbonModelVersions[0], "v3.0.1");
  assert.match(dashboard.limitations.join(" "), /never converts them to MTCO2e/u);
  assert.equal(Object.hasOwn(dashboard.proxySeries[0] ?? {}, "carbon"), false);
});

test("preserves missing provider totals as null instead of manufacturing zero", () => {
  const input = capture();
  input.carbonEvidence!.rows[0]!.totalLbmEmissionsUnit = null;
  input.carbonEvidence!.rows[0]!.totalLbmEmissionsValue = null;
  const dashboard = buildSustainabilityCarbonDashboard(
    normalizeSustainabilityCarbonCapture(input, SCOPE, NOW),
    NOW,
  );
  assert.equal(dashboard.providerCarbonSeries[0]?.totalLbmMicroMtco2e, null);
  assert.match(dashboard.limitations.join(" "), /remain null/u);
});

test("rejects tenant scope and payer ARN substitutions", () => {
  const tenant = capture();
  tenant.scope.customerId = "customer_beta";
  assert.throws(
    () => normalizeSustainabilityCarbonCapture(tenant, SCOPE, NOW),
    (error: unknown) => error instanceof SustainabilityCarbonError && error.code === "SCOPE_MISMATCH",
  );

  const payer = capture();
  payer.carbonEvidence!.exportArn = "arn:aws:bcm-data-exports:us-east-1:999999999999:export/sutra_carbon_monthly";
  assert.throws(
    () => normalizeSustainabilityCarbonCapture(payer, SCOPE, NOW),
    (error: unknown) => error instanceof SustainabilityCarbonError && error.code === "SCOPE_MISMATCH",
  );
});

test("accepts the documented Data Exports name-plus-UUID ARN form", () => {
  const input = capture();
  input.carbonEvidence!.exportArn = `arn:aws:bcm-data-exports:us-east-1:${SCOPE.accountId}:export/sutra_carbon_monthly-12345678-1234-4123-8123-123456789abc`;
  assert.equal(normalizeSustainabilityCarbonCapture(input, SCOPE, NOW).providerCarbon.rows.length, 1);
});

test("rejects usage accounts outside the authenticated account boundary", () => {
  const input = capture();
  input.proxyEvidence!.rows[0]!.usageAccountId = "333333333333";
  assert.throws(
    () => normalizeSustainabilityCarbonCapture(input, SCOPE, NOW),
    (error: unknown) => error instanceof SustainabilityCarbonError && error.code === "SCOPE_MISMATCH",
  );
});

test("fails closed for carbon exports outside the documented commercial partition", () => {
  const input = capture();
  input.scope.partition = "aws-us-gov";
  const expected = { ...SCOPE, partition: "aws-us-gov" as const };
  assert.throws(
    () => normalizeSustainabilityCarbonCapture(input, expected, NOW),
    (error: unknown) => error instanceof SustainabilityCarbonError && error.code === "UNSUPPORTED_PARTITION",
  );
});

test("requires the complete current schema and exact selected model version per month", () => {
  const schema = capture();
  schema.carbonEvidence!.schemaColumns.pop();
  assert.throws(
    () => normalizeSustainabilityCarbonCapture(schema, SCOPE, NOW),
    (error: unknown) => error instanceof SustainabilityCarbonError && error.code === "INCOMPLETE_LINEAGE",
  );

  const model = capture();
  model.carbonEvidence!.rows[0]!.modelVersion = "v3.0.0";
  assert.throws(
    () => normalizeSustainabilityCarbonCapture(model, SCOPE, NOW),
    (error: unknown) => error instanceof SustainabilityCarbonError && error.code === "INCOMPLETE_LINEAGE",
  );
});

test("requires exact proxy unit/factor lineage and rejects lossy rational normalization", () => {
  const mislabeled = capture();
  mislabeled.proxyEvidence!.rows[0]!.normalization.kind = "IDENTITY";
  mislabeled.proxyEvidence!.rows[0]!.normalization.numerator = "1";
  mislabeled.proxyEvidence!.rows[0]!.normalization.evidenceSource = null;
  mislabeled.proxyEvidence!.rows[0]!.normalization.evidenceVersion = null;
  assert.throws(
    () => normalizeSustainabilityCarbonCapture(mislabeled, SCOPE, NOW),
    (error: unknown) => error instanceof SustainabilityCarbonError && error.code === "INCOMPLETE_LINEAGE",
  );

  const lossy = capture();
  lossy.proxyEvidence!.rows[0]!.normalization.numerator = "1";
  lossy.proxyEvidence!.rows[0]!.normalization.denominator = "7";
  assert.throws(
    () => normalizeSustainabilityCarbonCapture(lossy, SCOPE, NOW),
    (error: unknown) => error instanceof SustainabilityCarbonError && error.code === "INVALID_INPUT",
  );
});

test("models a complete empty AWS delivery as empty evidence, never zero emissions", () => {
  const input = capture();
  input.proxyEvidence!.rows = [];
  input.carbonEvidence!.rows = [];
  input.carbonEvidence!.periods[0]!.deliveryState = "DELIVERED_EMPTY";
  input.carbonEvidence!.objects[0]!.sizeBytes = 0;
  const snapshot = normalizeSustainabilityCarbonCapture(input, SCOPE, NOW);
  assert.equal(snapshot.state, "empty");
  assert.equal(snapshot.providerCarbon.state, "empty");
  assert.equal(buildSustainabilityCarbonDashboard(snapshot, NOW).providerCarbonSeries.length, 0);
  assert.match(snapshot.limitations.join(" "), /not a zero-emissions claim/u);
});

test("reports partial and stale channels without relabeling them current", () => {
  const partial = capture();
  partial.carbonEvidence!.periods[0]!.complete = false;
  assert.equal(normalizeSustainabilityCarbonCapture(partial, SCOPE, NOW).state, "partial");

  const stale = capture();
  stale.proxyEvidence!.dataThroughAtIso = "2026-07-01T00:00:00.000Z";
  for (const row of stale.proxyEvidence!.rows) {
    row.usageStartIso = "2026-06-30T22:00:00.000Z";
    row.usageEndIso = "2026-06-30T23:00:00.000Z";
  }
  assert.equal(normalizeSustainabilityCarbonCapture(stale, SCOPE, NOW).state, "stale");
});

test("reports configured sources awaiting first delivery without fabricated records", () => {
  const input = capture();
  input.proxyEvidence = null;
  input.carbonEvidence = null;
  const snapshot = normalizeSustainabilityCarbonCapture(input, SCOPE, NOW);
  assert.equal(snapshot.state, "waiting_first_delivery");
  assert.equal(snapshot.proxy.rows.length, 0);
  assert.equal(snapshot.providerCarbon.rows.length, 0);
});

test("emits tenant-scoped source health evidence with monthly data-through lineage", () => {
  const snapshot = normalizeSustainabilityCarbonCapture(capture(), SCOPE, NOW);
  const evidence = sustainabilityCarbonSourceEvidence(snapshot);
  assert.deepEqual(evidence.scope, SCOPE);
  assert.equal(evidence.sourceId, "aws_carbon_footprint");
  assert.equal(evidence.coverage.assessment, "complete");
  assert.equal(evidence.coverage.acceptedRecords, 1);
  assert.equal(evidence.dataThroughAt, "2026-07-01T00:00:00.000Z");
  assert.match(evidence.evidenceBasis, /CARBON_EMISSIONS/u);
});

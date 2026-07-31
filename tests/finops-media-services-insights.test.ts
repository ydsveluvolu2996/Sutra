import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMediaServicesDashboard,
  createMediaServicesQueryService,
  MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS,
  MediaServicesInsightsError,
  MediaServicesQueryError,
  mediaServicesSourceEvidence,
  normalizeMediaServicesCapture,
  type MediaProvider,
  type MediaProviderCollection,
  type MediaServicesCapture,
  type MediaServicesScope,
} from "../lib/finops-media-services-insights.ts";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const ACCOUNT_ID = "123456789012";
const FLOW_ARN = `arn:aws:mediaconnect:us-east-1:${ACCOUNT_ID}:flow:flow-123:live-news`;
const SCOPE: MediaServicesScope = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: `conn_${"a".repeat(32)}`,
  accountId: ACCOUNT_ID,
  partition: "aws",
  region: "us-east-1",
};

type DeepMutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends object ? DeepMutable<T[Key]> : T[Key];
};

const PROVIDERS: readonly MediaProvider[] = [
  "MEDIACONNECT",
  "MEDIACONVERT",
  "MEDIALIVE",
  "MEDIAPACKAGE_V1",
  "MEDIAPACKAGE_V2",
  "MEDIATAILOR",
];

function emptyCollection(provider: MediaProvider): MediaProviderCollection {
  return {
    provider,
    configured: true,
    regionSupported: true,
    readPermissionsValidated: true,
    paginationExhausted: true,
    apiCallCount: 1,
    failureCode: null,
    resources: [],
  };
}

function capture(): DeepMutable<MediaServicesCapture> {
  const collections = PROVIDERS.map(emptyCollection) as DeepMutable<MediaProviderCollection>[];
  collections[0] = {
    provider: "MEDIACONNECT",
    configured: true,
    regionSupported: true,
    readPermissionsValidated: true,
    paginationExhausted: true,
    apiCallCount: 3,
    failureCode: null,
    resources: [{
      provider: "MEDIACONNECT",
      service: "MEDIACONNECT",
      resourceType: "FLOW",
      resourceArn: FLOW_ARN,
      resourceId: "flow-123",
      name: "live-news",
      state: "ACTIVE",
      observedAtIso: "2026-07-31T11:58:00.000Z",
      tags: [{ key: "CostCenter", value: "broadcast" }],
      attributes: [
        { key: "output_count", value: "2" },
        { key: "source_count", value: "1" },
      ],
    }],
  };
  return {
    schemaVersion: "sutra.media-services-insights.v1",
    scope: SCOPE,
    captureId: `media_${"b".repeat(64)}`,
    startedAtIso: "2026-07-31T11:55:00.000Z",
    completedAtIso: "2026-07-31T12:00:00.000Z",
    execution: { concurrencyLimit: 4, observedPeakConcurrency: 3 },
    collections,
    costEvidence: {
      source: "AWS_CUR2_ACTIVE_GENERATION",
      generationId: `fbg_${"c".repeat(64)}`,
      manifestSha256: "d".repeat(64),
      dataThroughAtIso: "2026-07-31T10:00:00.000Z",
      costBasis: "NET_AMORTIZED",
      currency: "USD",
      rowsExhausted: true,
      rows: [{
        rowId: "row-flow",
        service: "MEDIACONNECT",
        accountId: ACCOUNT_ID,
        region: "us-east-1",
        resourceArn: FLOW_ARN,
        chargePeriodStartIso: "2026-07-31T09:00:00.000Z",
        chargePeriodEndIso: "2026-07-31T10:00:00.000Z",
        operation: "RunFlow",
        usageType: "USE1-ActiveFlowHours",
        usageUnit: "Hrs",
        usageQuantityMicros: "1000000",
        costMicros: "2500000",
        chargeCategory: "USAGE",
      }, {
        rowId: "row-live-unattributed",
        service: "MEDIALIVE",
        accountId: ACCOUNT_ID,
        region: "us-east-1",
        resourceArn: null,
        chargePeriodStartIso: "2026-07-31T09:00:00.000Z",
        chargePeriodEndIso: "2026-07-31T10:00:00.000Z",
        operation: null,
        usageType: "USE1-HD-Channel-Hours",
        usageUnit: "Hrs",
        usageQuantityMicros: "2000000",
        costMicros: "-500000",
        chargeCategory: "CREDIT",
      }],
    },
  };
}

test("normalizes complete tenant-pinned inventory and immutable CUR2 evidence", () => {
  const snapshot = normalizeMediaServicesCapture(capture(), SCOPE, NOW.getTime());
  assert.equal(snapshot.state, "current");
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.resources.length, 1);
  assert.equal(snapshot.costEvidence.rows.length, 2);
  assert.equal(snapshot.collections.find((item) => item.provider === "MEDIACONNECT")?.state, "current");
  assert.equal(snapshot.collections.find((item) => item.provider === "MEDIALIVE")?.state, "empty");
  assert.match(snapshot.limitations.join(" "), /resource ARN/u);

  const evidence = mediaServicesSourceEvidence(snapshot);
  assert.equal(evidence.sourceId, "media_services_telemetry");
  assert.equal(evidence.coverage.assessment, "complete");
  assert.equal(evidence.coverage.acceptedRecords, 3);
  assert.equal(evidence.dataThroughAt, "2026-07-31T10:00:00.000Z");
});

test("projects exact-ARN attribution and never spreads service-level rows", () => {
  const dashboard = buildMediaServicesDashboard(
    normalizeMediaServicesCapture(capture(), SCOPE, NOW.getTime()),
    NOW.getTime(),
  );
  assert.equal(dashboard.lineage.costBasis, "NET_AMORTIZED");
  assert.equal(dashboard.resources[0]?.exactArnCostMicros, "2500000");
  assert.equal(dashboard.resources[0]?.exactArnCostRowCount, 1);
  const connect = dashboard.serviceSummary.find((item) => item.service === "MEDIACONNECT");
  assert.equal(connect?.costMicros, "2500000");
  assert.equal(connect?.attributedCostMicros, "2500000");
  assert.equal(connect?.unattributedCostMicros, "0");
  const live = dashboard.serviceSummary.find((item) => item.service === "MEDIALIVE");
  assert.equal(live?.costMicros, "-500000");
  assert.equal(live?.attributedCostMicros, "0");
  assert.equal(live?.unattributedCostMicros, "-500000");
  assert.deepEqual(dashboard.usage.map((item) => item.unit), ["Hrs", "Hrs"]);
});

test("keeps unlike billing usage dimensions in independent groups", () => {
  const input = capture();
  input.costEvidence.rows.push({
    ...input.costEvidence.rows[0]!,
    rowId: "row-flow-bytes",
    usageType: "USE1-DataTransfer-Out-Bytes",
    usageUnit: "GB",
    usageQuantityMicros: "9000000",
    costMicros: "100000",
  });
  const dashboard = buildMediaServicesDashboard(
    normalizeMediaServicesCapture(input, SCOPE, NOW.getTime()),
    NOW.getTime(),
  );
  assert.equal(dashboard.usage.length, 3);
  assert.deepEqual(new Set(dashboard.usage.map((item) => item.unit)), new Set(["Hrs", "GB"]));
});

test("rejects tenant, connection, account, partition, and Region substitution", () => {
  const replacements: MediaServicesScope[] = [
    { ...SCOPE, orgId: "org_attacker" },
    { ...SCOPE, connectionId: `conn_${"f".repeat(32)}` },
    { ...SCOPE, accountId: "999988887777" },
    { ...SCOPE, partition: "aws-us-gov" },
    { ...SCOPE, region: "eu-west-1" },
  ];
  for (const expected of replacements) {
    assert.throws(
      () => normalizeMediaServicesCapture(capture(), expected, NOW.getTime()),
      (error) => error instanceof MediaServicesInsightsError && error.code === "SCOPE_MISMATCH",
    );
  }
});

test("rejects a provider ARN or CUR2 row belonging to another service/scope", () => {
  const providerMismatch = capture();
  providerMismatch.collections[0]!.resources[0]!.resourceArn =
    `arn:aws:medialive:us-east-1:${ACCOUNT_ID}:channel:123`;
  assert.throws(
    () => normalizeMediaServicesCapture(providerMismatch, SCOPE, NOW.getTime()),
    (error) => error instanceof MediaServicesInsightsError && error.code === "SCOPE_MISMATCH",
  );

  const costMismatch = capture();
  costMismatch.costEvidence.rows[0]!.service = "MEDIALIVE";
  assert.throws(
    () => normalizeMediaServicesCapture(costMismatch, SCOPE, NOW.getTime()),
    (error) => error instanceof MediaServicesInsightsError && error.code === "SCOPE_MISMATCH",
  );
});

test("fails closed on duplicate providers and conflicting cost-row IDs", () => {
  const duplicateProvider = capture();
  duplicateProvider.collections[1] = duplicateProvider.collections[0]!;
  assert.throws(
    () => normalizeMediaServicesCapture(duplicateProvider, SCOPE, NOW.getTime()),
    (error) => error instanceof MediaServicesInsightsError && error.code === "CONFLICTING_DUPLICATE",
  );

  const duplicateRow = capture();
  duplicateRow.costEvidence.rows.push({
    ...duplicateRow.costEvidence.rows[0]!,
    costMicros: "1",
  });
  assert.throws(
    () => normalizeMediaServicesCapture(duplicateRow, SCOPE, NOW.getTime()),
    (error) => error instanceof MediaServicesInsightsError && error.code === "CONFLICTING_DUPLICATE",
  );
});

test("represents configuration, unsupported Region, partial, and stale states honestly", () => {
  const unconfigured = capture();
  unconfigured.collections[1] = {
    provider: "MEDIACONVERT",
    configured: false,
    regionSupported: true,
    readPermissionsValidated: false,
    paginationExhausted: false,
    apiCallCount: 0,
    failureCode: null,
    resources: [],
  };
  assert.equal(normalizeMediaServicesCapture(unconfigured, SCOPE, NOW.getTime()).state, "configuration_required");

  const unsupported = capture();
  unsupported.collections[4] = {
    provider: "MEDIAPACKAGE_V2",
    configured: true,
    regionSupported: false,
    readPermissionsValidated: false,
    paginationExhausted: false,
    apiCallCount: 0,
    failureCode: "REGION_UNAVAILABLE",
    resources: [],
  };
  const unsupportedSnapshot = normalizeMediaServicesCapture(unsupported, SCOPE, NOW.getTime());
  assert.equal(unsupportedSnapshot.collections.find((item) => item.provider === "MEDIAPACKAGE_V2")?.state, "unsupported");
  assert.equal(unsupportedSnapshot.state, "current");

  const partial = capture();
  partial.costEvidence.rowsExhausted = false;
  assert.equal(normalizeMediaServicesCapture(partial, SCOPE, NOW.getTime()).state, "partial");

  const stale = capture();
  assert.equal(normalizeMediaServicesCapture(stale, SCOPE, NOW.getTime() + 49 * 3_600_000).state, "stale");
});

test("rejects hidden collection results when collection could not run", () => {
  const input = capture();
  input.collections[0]!.readPermissionsValidated = false;
  input.collections[0]!.failureCode = "ACCESS_DENIED";
  assert.throws(
    () => normalizeMediaServicesCapture(input, SCOPE, NOW.getTime()),
    (error) => error instanceof MediaServicesInsightsError && error.code === "INVALID_INPUT",
  );
});

test("declares only exact read/list operations with no write surface", () => {
  const operations = Object.values(MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS).flat();
  assert.equal(operations.length, 46);
  assert.ok(operations.every((item) => /:(?:Describe|Get|List)/u.test(item)));
  assert.ok(operations.every((item) => !/(?:Create|Delete|Put|Start|Stop|Update|TagResource)/u.test(item)));
  assert.ok(operations.includes("mediapackagev2:GetOriginEndpoint"));
  assert.ok(operations.includes("medialive:DescribeReservation"));
  assert.ok(operations.includes("medialive:DescribeOffering"));
});

test("query service pins scope/operations and maps transport/evidence failures to generic errors", async () => {
  let observedScope: MediaServicesScope | null = null;
  const service = createMediaServicesQueryService(SCOPE, {
    async collect(request) {
      observedScope = request.scope;
      assert.equal(request.requiredBillingSource, "AWS_CUR2_ACTIVE_GENERATION");
      assert.equal(request.operations, MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS);
      return capture();
    },
  }, () => NOW.getTime());
  assert.equal((await service.query()).state, "current");
  assert.deepEqual(observedScope, SCOPE);

  await assert.rejects(
    createMediaServicesQueryService(SCOPE, { collect: async () => { throw new Error("secret"); } }).query(),
    (error) => error instanceof MediaServicesQueryError && error.code === "SOURCE_UNAVAILABLE" && !error.message.includes("secret"),
  );
  await assert.rejects(
    createMediaServicesQueryService(SCOPE, { collect: async () => ({ ...capture(), scope: { ...SCOPE, orgId: "org_attacker" } }) }, () => NOW.getTime()).query(),
    (error) => error instanceof MediaServicesQueryError && error.code === "INVALID_EVIDENCE",
  );
});

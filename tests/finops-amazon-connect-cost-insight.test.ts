import assert from "node:assert/strict";
import test from "node:test";

import {
  AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS,
  amazonConnectCostInsightSourceEvidence,
  AmazonConnectCostInsightError,
  AmazonConnectCostInsightQueryError,
  buildAmazonConnectContactDrilldown,
  buildAmazonConnectCostInsightDashboard,
  createAmazonConnectCostInsightQueryService,
  normalizeAmazonConnectCostInsightCapture,
  type AmazonConnectCostInsightCapture,
  type AmazonConnectScope,
  type AmazonConnectSensitiveDrilldownGrant,
} from "../lib/finops-amazon-connect-cost-insight.ts";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const ACCOUNT_ID = "123456789012";
const INSTANCE_ID = "12345678-1234-1234-1234-123456789abc";
const INSTANCE_ARN = `arn:aws:connect:us-east-1:${ACCOUNT_ID}:instance/${INSTANCE_ID}`;
const CONTACT_TOKEN = `ctk_${"c".repeat(64)}`;
const ENDPOINT_TOKEN = `epk_${"e".repeat(64)}`;

const SCOPE: AmazonConnectScope = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: `conn_${"a".repeat(32)}`,
  accountId: ACCOUNT_ID,
  partition: "aws",
  region: "us-east-1",
  instanceArns: [INSTANCE_ARN],
};

type DeepMutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends object ? DeepMutable<T[Key]> : T[Key];
};

function capture(): DeepMutable<AmazonConnectCostInsightCapture> {
  return {
    schemaVersion: "sutra.amazon-connect-cost-insight.v1",
    scope: { ...SCOPE, instanceArns: [...SCOPE.instanceArns] },
    captureId: `connect_${"b".repeat(64)}`,
    startedAtIso: "2026-07-31T11:55:00.000Z",
    completedAtIso: NOW.toISOString(),
    execution: { concurrencyLimit: 4, observedPeakConcurrency: 2 },
    privacy: {
      rawContactRecordsAccepted: false,
      rawPhoneNumbersAccepted: false,
      tokenization: "HMAC_SHA256_TENANT_SCOPED_ROTATING",
      tokenKeyVersion: "key_2026_07",
      contactDrilldownEnabled: true,
    },
    collections: [{
      instanceArn: INSTANCE_ARN,
      configured: true,
      regionSupported: true,
      permissionsValidated: true,
      pagesExhausted: true,
      apiCallCount: 3,
      phoneRecordsScanned: 3,
      failureCode: null,
      instance: {
        instanceArn: INSTANCE_ARN,
        instanceId: INSTANCE_ID,
        alias: "support-prod",
        status: "ACTIVE",
        inboundCallsEnabled: true,
        outboundCallsEnabled: true,
        observedAtIso: "2026-07-31T11:58:00.000Z",
      },
      phoneInventory: [{
        instanceArn: INSTANCE_ARN,
        countryCode: "US",
        phoneNumberType: "DID",
        status: "CLAIMED",
        count: 2,
      }, {
        instanceArn: INSTANCE_ARN,
        countryCode: "US",
        phoneNumberType: "TOLL_FREE",
        status: "CLAIMED",
        count: 1,
      }],
    }],
    costEvidence: {
      source: "AWS_CUR2_ACTIVE_GENERATION",
      generationId: `fbg_${"d".repeat(64)}`,
      manifestSha256: "f".repeat(64),
      dataThroughAtIso: "2026-07-31T11:00:00.000Z",
      costBasis: "NET_AMORTIZED",
      currency: "USD",
      rowsExhausted: true,
      contactResourceIdsIncluded: true,
      activatedSystemTags: [
        "aws:connect:instanceId",
        "aws:connect:systemEndpoint",
      ],
      rows: [{
        rowId: "row-inbound",
        accountId: ACCOUNT_ID,
        region: "us-east-1",
        instanceArn: INSTANCE_ARN,
        contactToken: CONTACT_TOKEN,
        endpointToken: ENDPOINT_TOKEN,
        chargePeriodStartIso: "2026-07-31T09:00:00.000Z",
        chargePeriodEndIso: "2026-07-31T10:00:00.000Z",
        service: "CONTACT_CENTER_TELECOM",
        chargeFamily: "TELEPHONY_INBOUND",
        channel: "VOICE",
        direction: "INBOUND",
        countryCode: "US",
        phoneNumberType: "DID",
        operation: "InboundCall",
        usageType: "USE1-US-Inbound-Minutes",
        usageUnit: "Minutes",
        usageQuantityMicros: "5000000",
        costMicros: "2500000",
        chargeCategory: "USAGE",
        classificationBasis: "AWS_ACTIVATED_SYSTEM_TAGS",
      }, {
        rowId: "row-connect-credit",
        accountId: ACCOUNT_ID,
        region: "us-east-1",
        instanceArn: null,
        contactToken: null,
        endpointToken: null,
        chargePeriodStartIso: "2026-07-31T10:00:00.000Z",
        chargePeriodEndIso: "2026-07-31T11:00:00.000Z",
        service: "AMAZON_CONNECT",
        chargeFamily: "CHAT",
        channel: "CHAT",
        direction: "UNKNOWN",
        countryCode: null,
        phoneNumberType: null,
        operation: null,
        usageType: "USE1-ChatMessages",
        usageUnit: "Messages",
        usageQuantityMicros: "2000000",
        costMicros: "-500000",
        chargeCategory: "CREDIT",
        classificationBasis: "UNATTRIBUTED",
      }],
    },
  };
}

function grant(overrides: Partial<AmazonConnectSensitiveDrilldownGrant> = {}): AmazonConnectSensitiveDrilldownGrant {
  return {
    schemaVersion: "sutra.amazon-connect-sensitive-grant.v1",
    grantId: `grant_${"1".repeat(32)}`,
    auditEventId: `audit_${"2".repeat(32)}`,
    scope: SCOPE,
    subjectHash: "3".repeat(64),
    purposeCode: "FINOPS_COST_INVESTIGATION",
    issuedAtIso: "2026-07-31T11:45:00.000Z",
    expiresAtIso: "2026-07-31T12:15:00.000Z",
    allowTokenizedContactDrilldown: true,
    ...overrides,
  };
}

test("projects all seven Connect cost-view foundations without exposing contact or phone tokens", () => {
  const snapshot = normalizeAmazonConnectCostInsightCapture(capture(), SCOPE, NOW.getTime());
  const dashboard = buildAmazonConnectCostInsightDashboard(snapshot, NOW.getTime());
  assert.equal(snapshot.state, "current");
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.contactDetailCoverage, "TOKENIZED_PARTIAL");
  assert.deepEqual(dashboard.overview, {
    instanceCount: 1,
    phoneNumberCount: 3,
    costMicros: "2000000",
    unattributedCostMicros: "-500000",
    usageRowCount: 2,
    tokenizedContactCount: 1,
  });
  assert.equal(dashboard.instances[0]?.costMicros, "2500000");
  assert.equal(dashboard.telecom[0]?.quantityMicros, "5000000");
  assert.equal(dashboard.telecom[0]?.unit, "Minutes");
  assert.equal(dashboard.dailyUsage.length, 2);
  assert.equal(dashboard.callPatterns.find((item) => item.channel === "VOICE")?.contactCount, 1);
  const rendered = JSON.stringify(dashboard);
  assert.ok(!rendered.includes(CONTACT_TOKEN));
  assert.ok(!rendered.includes(ENDPOINT_TOKEN));
  assert.ok(!rendered.includes("+1"));

  const evidence = amazonConnectCostInsightSourceEvidence(snapshot);
  assert.equal(evidence.sourceId, "amazon_connect_telemetry");
  assert.equal(evidence.coverage.assessment, "complete");
  assert.equal(evidence.coverage.acceptedRecords, 5);
});

test("keeps currencies, units, directions, number types, and signed corrections exact", () => {
  const input = capture();
  input.costEvidence.rows.push({
    ...input.costEvidence.rows[0]!,
    rowId: "row-inbound-hours",
    usageUnit: "Hours",
    usageQuantityMicros: "1000000",
    costMicros: "-250000",
    chargeCategory: "REFUND",
  });
  const dashboard = buildAmazonConnectCostInsightDashboard(
    normalizeAmazonConnectCostInsightCapture(input, SCOPE, NOW.getTime()),
    NOW.getTime(),
  );
  assert.deepEqual(new Set(dashboard.telecom.map((item) => item.unit)), new Set(["Minutes", "Hours"]));
  assert.equal(dashboard.overview.costMicros, "1750000");
  assert.equal(dashboard.lineage.currency, "USD");
  assert.equal(dashboard.lineage.costBasis, "NET_AMORTIZED");
});

test("fails closed on tenant, connection, account, partition, Region, and instance substitution", () => {
  const scopes: AmazonConnectScope[] = [
    { ...SCOPE, orgId: "org_attacker" },
    { ...SCOPE, customerId: "customer_attacker" },
    { ...SCOPE, connectionId: `conn_${"9".repeat(32)}` },
    { ...SCOPE, accountId: "999988887777" },
    { ...SCOPE, partition: "aws-us-gov" },
    { ...SCOPE, region: "eu-west-1" },
    { ...SCOPE, instanceArns: [`arn:aws:connect:us-east-1:${ACCOUNT_ID}:instance/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`] },
  ];
  for (const expected of scopes) {
    assert.throws(
      () => normalizeAmazonConnectCostInsightCapture(capture(), expected, NOW.getTime()),
      (error) => error instanceof AmazonConnectCostInsightError && error.code === "SCOPE_MISMATCH",
    );
  }

  const crossInstance = capture();
  crossInstance.costEvidence.rows[0]!.instanceArn = `arn:aws:connect:us-east-1:${ACCOUNT_ID}:instance/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
  assert.throws(
    () => normalizeAmazonConnectCostInsightCapture(crossInstance, SCOPE, NOW.getTime()),
    (error) => error instanceof AmazonConnectCostInsightError && error.code === "SCOPE_MISMATCH",
  );
});

test("rejects raw identifiers, hidden phone fields, and inconsistent privacy claims", () => {
  const rawContact = capture();
  rawContact.costEvidence.rows[0]!.contactToken = INSTANCE_ID;
  assert.throws(
    () => normalizeAmazonConnectCostInsightCapture(rawContact, SCOPE, NOW.getTime()),
    (error) => error instanceof AmazonConnectCostInsightError && error.code === "INVALID_INPUT",
  );

  const rawPhone = capture() as unknown as { collections: { phoneInventory: unknown[] }[] };
  rawPhone.collections[0]!.phoneInventory[0] = {
    instanceArn: INSTANCE_ARN,
    countryCode: "US",
    phoneNumberType: "DID",
    status: "CLAIMED",
    count: 2,
    phoneNumber: "+12065550100",
  };
  assert.throws(() => normalizeAmazonConnectCostInsightCapture(rawPhone as never, SCOPE, NOW.getTime()));

  const disabled = capture();
  disabled.privacy.contactDrilldownEnabled = false;
  assert.throws(() => normalizeAmazonConnectCostInsightCapture(disabled, SCOPE, NOW.getTime()));

  const missingTag = capture();
  missingTag.costEvidence.activatedSystemTags = ["aws:connect:instanceId"];
  assert.throws(() => normalizeAmazonConnectCostInsightCapture(missingTag, SCOPE, NOW.getTime()));
});

test("exposes only masked billing facts after an expiring, tenant-pinned audited grant", () => {
  const snapshot = normalizeAmazonConnectCostInsightCapture(capture(), SCOPE, NOW.getTime());
  const result = buildAmazonConnectContactDrilldown(snapshot, CONTACT_TOKEN, grant(), NOW.getTime());
  assert.equal(result.displayContactToken, `contact-${"c".repeat(12)}`);
  assert.equal(result.auditEventId, `audit_${"2".repeat(32)}`);
  assert.equal(result.totalCostMicros, "2500000");
  assert.equal(result.rows.length, 1);
  const rendered = JSON.stringify(result);
  assert.ok(!rendered.includes(CONTACT_TOKEN));
  assert.ok(!rendered.includes(ENDPOINT_TOKEN));
  assert.ok(!rendered.includes("contactToken"));
  assert.ok(!rendered.includes("endpointToken"));

  assert.throws(
    () => buildAmazonConnectContactDrilldown(snapshot, CONTACT_TOKEN, grant({ expiresAtIso: NOW.toISOString() }), NOW.getTime()),
    (error) => error instanceof AmazonConnectCostInsightError && error.code === "SENSITIVE_ACCESS_DENIED",
  );
  assert.throws(
    () => buildAmazonConnectContactDrilldown(snapshot, CONTACT_TOKEN, grant({ scope: { ...SCOPE, orgId: "org_attacker" } }), NOW.getTime()),
    (error) => error instanceof AmazonConnectCostInsightError && error.code === "SENSITIVE_ACCESS_DENIED",
  );
});

test("reports partial, stale, and configuration-required source states honestly", () => {
  const partial = capture();
  partial.collections[0]!.pagesExhausted = false;
  partial.collections[0]!.failureCode = "BOUND_REACHED";
  assert.equal(normalizeAmazonConnectCostInsightCapture(partial, SCOPE, NOW.getTime()).state, "partial");

  assert.equal(normalizeAmazonConnectCostInsightCapture(capture(), SCOPE, NOW.getTime() + 49 * 3_600_000).state, "stale");

  const emptyScope: AmazonConnectScope = { ...SCOPE, instanceArns: [] };
  const unconfigured = capture();
  unconfigured.scope = { ...emptyScope, instanceArns: [] };
  unconfigured.collections = [];
  unconfigured.costEvidence.rows = [];
  assert.equal(normalizeAmazonConnectCostInsightCapture(unconfigured, emptyScope, NOW.getTime()).state, "configuration_required");
});

test("fails on conflicting duplicates and phone aggregate count mismatches", () => {
  const duplicate = capture();
  duplicate.costEvidence.rows.push({ ...duplicate.costEvidence.rows[0]!, costMicros: "1" });
  assert.throws(
    () => normalizeAmazonConnectCostInsightCapture(duplicate, SCOPE, NOW.getTime()),
    (error) => error instanceof AmazonConnectCostInsightError && error.code === "CONFLICTING_DUPLICATE",
  );

  const mismatch = capture();
  mismatch.collections[0]!.phoneRecordsScanned = 99;
  assert.throws(
    () => normalizeAmazonConnectCostInsightCapture(mismatch, SCOPE, NOW.getTime()),
    (error) => error instanceof AmazonConnectCostInsightError && error.code === "CONFLICTING_DUPLICATE",
  );
});

test("declares only the two Connect reads and required Directory Service dependency", () => {
  assert.deepEqual(AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS, [
    "connect:DescribeInstance",
    "connect:ListPhoneNumbersV2",
    "ds:DescribeDirectories",
  ]);
  assert.ok(AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS.every((item) => /:(?:Describe|List)/u.test(item)));
  assert.ok(AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS.every((item) => !/(?:SearchContacts|DescribeContact|GetMetricData|Create|Delete|Update|Put|Tag)/u.test(item)));
});

test("query service pins scope, operations, billing source, bounds, and privacy contract", async () => {
  let observedScope: AmazonConnectScope | null = null;
  const service = createAmazonConnectCostInsightQueryService(SCOPE, {
    async collect(request) {
      observedScope = request.scope;
      assert.equal(request.operations, AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS);
      assert.equal(request.requiredBillingSource, "AWS_CUR2_ACTIVE_GENERATION");
      assert.equal(request.privacy.rawContactRecordsAccepted, false);
      assert.equal(request.privacy.rawPhoneNumbersAccepted, false);
      return capture();
    },
  }, () => NOW.getTime());
  assert.equal((await service.query()).state, "current");
  assert.deepEqual(observedScope, SCOPE);

  await assert.rejects(
    createAmazonConnectCostInsightQueryService(SCOPE, { collect: async () => { throw new Error("secret"); } }).query(),
    (error) => error instanceof AmazonConnectCostInsightQueryError && error.code === "SOURCE_UNAVAILABLE" && !error.message.includes("secret"),
  );
  await assert.rejects(
    createAmazonConnectCostInsightQueryService(SCOPE, { collect: async () => ({ ...capture(), scope: { ...SCOPE, orgId: "org_attacker" } }) }, () => NOW.getTime()).query(),
    (error) => error instanceof AmazonConnectCostInsightQueryError && error.code === "INVALID_EVIDENCE",
  );
});

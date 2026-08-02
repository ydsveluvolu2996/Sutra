import assert from "node:assert/strict";
import test from "node:test";
import {
  AMAZON_CONNECT_COST_PROVIDER_ACTIONS,
  AMAZON_CONNECT_COST_PROVIDER_BOUNDS,
  collectAmazonConnectCostProviderEvidence,
  type AmazonConnectCostProviderRequest,
} from "../src/amazon-connect-cost-provider-adapter.js";
import {
  parseAmazonConnectCostProviderRequest,
  runAmazonConnectCostProviderRoute,
} from "../src/amazon-connect-cost-provider-route.js";

const ACCOUNT = "111122223333";
const CONNECTION = `conn_${"a".repeat(32)}`;
const INSTANCE_ID = "12345678-1234-1234-1234-123456789abc";
const INSTANCE_ARN = `arn:aws:connect:us-east-1:${ACCOUNT}:instance/${INSTANCE_ID}`;
const REQUEST: AmazonConnectCostProviderRequest = {
  schemaVersion: "sutra.amazon-connect-cost-runtime-request.v1",
  requestId: `acr_${"b".repeat(64)}`,
  expectedCaptureId: `connect_${"b".repeat(64)}`,
  scheduledWindow: "2026-08-02T00:00:00.000Z",
  scope: { orgId: "org_add11", customerId: "customer_add11", connectionId: CONNECTION,
    accountId: ACCOUNT, partition: "aws", region: "us-east-1", instanceArns: [INSTANCE_ARN] },
  credentials: "SERVER_OWNED_TRUST_ROLE_SESSION",
  operations: AMAZON_CONNECT_COST_PROVIDER_ACTIONS,
  permissionAttestation: { generationId: `fss_${"c".repeat(64)}`, contentSha256: "d".repeat(64),
    observedAtIso: "2026-08-02T00:00:00.000Z", operations: AMAZON_CONNECT_COST_PROVIDER_ACTIONS,
    resources: { describeInstanceArns: [INSTANCE_ARN],
      listPhoneNumbersArn: `arn:aws:connect:us-east-1:${ACCOUNT}:phone-number/*`,
      directoryServiceResource: "*" }, denyMutationOperations: true },
  providerReads: { describeOnlyAuthorizedInstanceArns: true, listPhoneNumbersTargetArnRequired: true,
    unscopedPhoneNumberListingForbidden: true, trafficDistributionGroupsIncluded: false,
    phonePageSize: 1_000, rejectPaginationTokenReplay: true,
    requirePerInstanceExhaustionEvidence: true },
  billing: { source: "AWS_CUR2_ACTIVE_GENERATION", state: "ACTIVE_RECONCILED",
    generationId: `fbg_${"e".repeat(64)}`, sourceEvidenceId: `fss_${"f".repeat(64)}`,
    manifestSha256: "1".repeat(64), dataThroughAtIso: "2026-08-02T00:00:00.000Z",
    costBasis: "NET_AMORTIZED", currency: "USD", rowsExhausted: true,
    contactResourceIdsIncluded: true,
    activatedSystemTags: ["aws:connect:instanceId", "aws:connect:systemEndpoint"],
    predicate: "PRODUCT_CODE_AMAZON_CONNECT_AND_CONTACT_CENTER_TELECOMMUNICATIONS",
    classificationContractVersion: "sutra-connect-cur2-v1",
    associatedServiceCoverage: "NOT_INCLUDED_SEPARATE_EVIDENCE_REQUIRED" },
  privacy: { rawContactRecordsAccepted: false, rawPhoneNumbersAccepted: false,
    rawPhoneArnsOrIdsAccepted: false, rawDescriptionsAccepted: false,
    rawCallerIdentityAccepted: false, rawEndpointAddressesAccepted: false,
    rawDirectoryDetailsAccepted: false, rawProviderErrorTextAccepted: false,
    tokenization: "HMAC_SHA256_TENANT_SCOPED_ROTATING", tokenKeyVersion: "key_2026_08",
    contactDrilldownEnabled: true },
  incompleteDisposition: "PERSIST_HISTORY_NEVER_ADVANCE_HEAD",
  bounds: AMAZON_CONNECT_COST_PROVIDER_BOUNDS,
  archiveMaximumBytes: AMAZON_CONNECT_COST_PROVIDER_BOUNDS.maximumDashboardBytes,
  maximumDurationMs: AMAZON_CONNECT_COST_PROVIDER_BOUNDS.maximumDurationMs,
};
const CUR2 = { source: "AWS_CUR2_ACTIVE_GENERATION" as const,
  generationId: REQUEST.billing.generationId, manifestSha256: REQUEST.billing.manifestSha256,
  dataThroughAtIso: REQUEST.billing.dataThroughAtIso, costBasis: REQUEST.billing.costBasis,
  currency: REQUEST.billing.currency, rowsExhausted: true as const,
  contactResourceIdsIncluded: true, activatedSystemTags: REQUEST.billing.activatedSystemTags,
  rows: [{ rowId: "row-1", accountId: ACCOUNT, region: "us-east-1", instanceArn: INSTANCE_ARN,
    rawContactResourceId: "contact-raw-secret", rawSystemEndpoint: "+12065550100",
    chargePeriodStartIso: "2026-08-01T23:00:00.000Z", chargePeriodEndIso: "2026-08-02T00:00:00.000Z",
    service: "AMAZON_CONNECT" as const, chargeFamily: "CONNECT_SERVICE", channel: "VOICE",
    direction: "INBOUND", countryCode: "US", phoneNumberType: "DID", operation: "Inbound",
    usageType: "USE1-Inbound-Minutes", usageUnit: "Minutes", usageQuantityMicros: "1000000",
    costMicros: "2000000", chargeCategory: "USAGE", classificationBasis: "AWS_CUR2_NATIVE" }] };

function reader(tokens: boolean) {
  let phoneCalls = 0;
  return { phoneCalls: () => phoneCalls, reader: {
    describeInstance: async (input: { readonly InstanceId: string }) => {
      assert.deepEqual(input, { InstanceId: INSTANCE_ID });
      return { Instance: { Id: INSTANCE_ID, Arn: INSTANCE_ARN, InstanceAlias: "support-prod",
        InstanceStatus: "ACTIVE", InboundCallsEnabled: true, OutboundCallsEnabled: true,
        DirectoryId: "d-secret", ServiceRole: "role-secret", AccessUrl: "https://secret" } };
    },
    listPhoneNumbersV2: async (input: { readonly TargetArn: string; readonly MaxResults: 1_000;
      readonly NextToken?: string }) => {
      assert.equal(input.TargetArn, INSTANCE_ARN);
      assert.equal(input.MaxResults, 1_000);
      phoneCalls += 1;
      if (phoneCalls === 1) return { ListPhoneNumbersSummaryList: [
        { PhoneNumberCountryCode: "US", PhoneNumberType: "DID", PhoneNumberStatus: "CLAIMED",
          PhoneNumber: "+12065550100", PhoneNumberArn: "secret", PhoneNumberId: "secret" },
      ], ...(tokens ? { NextToken: "opaque-token" } : {}) };
      return { ListPhoneNumbersSummaryList: [], ...(tokens ? { NextToken: "opaque-token" } : {}) };
    },
  } };
}

test("strict parser pins the exact instance set, wildcard IAM resource and compensating TargetArn", () => {
  assert.deepEqual(parseAmazonConnectCostProviderRequest(JSON.stringify(REQUEST)), REQUEST);
  assert.throws(() => parseAmazonConnectCostProviderRequest(JSON.stringify({ ...REQUEST,
    providerReads: { ...REQUEST.providerReads, unscopedPhoneNumberListingForbidden: false } })));
  assert.throws(() => parseAmazonConnectCostProviderRequest(JSON.stringify({ ...REQUEST,
    scope: { ...REQUEST.scope, instanceArns: [INSTANCE_ARN.replace(ACCOUNT, "999999999999")] } })));
});

test("collector aggregates raw phone inventory and tenant-tokenizes CUR2 before return", async () => {
  const fixture = reader(false);
  const capture = await collectAmazonConnectCostProviderEvidence({ request: REQUEST,
    reader: fixture.reader, cur2: CUR2, tokenKey: new Uint8Array(32).fill(7),
    signal: new AbortController().signal, now: () => Date.parse("2026-08-02T00:00:00.000Z") });
  assert.equal(capture.collections[0]?.phoneRecordsScanned, 1);
  assert.deepEqual(capture.collections[0]?.phoneInventory, [{ instanceArn: INSTANCE_ARN,
    countryCode: "US", phoneNumberType: "DID", status: "CLAIMED", count: 1 }]);
  const serialized = JSON.stringify(capture);
  assert.equal(serialized.includes("+12065550100"), false);
  assert.equal(serialized.includes("contact-raw-secret"), false);
  assert.equal(serialized.includes("d-secret"), false);
  assert.match(serialized, /ctk_[a-f0-9]{64}/u);
  assert.match(serialized, /epk_[a-f0-9]{64}/u);
});

test("pagination token replay becomes explicit incomplete evidence without leaking the token", async () => {
  const fixture = reader(true);
  const capture = await collectAmazonConnectCostProviderEvidence({ request: REQUEST,
    reader: fixture.reader, cur2: CUR2, tokenKey: new Uint8Array(32).fill(9),
    signal: new AbortController().signal, now: () => Date.parse("2026-08-02T00:00:00.000Z") });
  assert.equal(capture.collections[0]?.pagesExhausted, false);
  assert.equal(capture.collections[0]?.failureCode, "INVALID_PAGINATION");
  assert.equal(JSON.stringify(capture).includes("opaque-token"), false);
});

test("route rejects header substitution before assuming credentials", async () => {
  let assumed = 0;
  await assert.rejects(runAmazonConnectCostProviderRoute({ body: JSON.stringify(REQUEST),
    headers: { tenantId: "org_attacker", customerId: REQUEST.scope.customerId,
      connectionId: CONNECTION, requestId: REQUEST.requestId }, signal: new AbortController().signal }, {
    assumeReadOnlySession: async () => { assumed += 1; throw new Error("must not run"); },
    readerFactory: () => reader(false).reader,
    loadRawCur2Projection: async () => CUR2,
    loadTenantTokenKey: async () => new Uint8Array(32),
  }));
  assert.equal(assumed, 0);
});

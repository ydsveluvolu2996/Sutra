import assert from "node:assert/strict";
import test from "node:test";

import {
  AWS_MARKETPLACE_ACCOUNT_COVERAGE_IAM_ACTIONS,
  AWS_MARKETPLACE_BUYER_API_OPERATIONS,
  AWS_MARKETPLACE_BUYER_IAM_ACTIONS,
  AWS_MARKETPLACE_LICENSE_MANAGER_API_OPERATIONS,
  AWS_MARKETPLACE_LICENSE_MANAGER_IAM_ACTIONS,
  AWS_MARKETPLACE_SELLER_ONLY_EXCLUDED_ACTIONS,
  AwsMarketplaceSpgError,
  awsMarketplaceSpgSourceEvidence,
  normalizeAwsMarketplaceSpgCapture,
  type AwsMarketplaceSpgCapture,
  type AwsMarketplaceSpgScope,
} from "../lib/finops-marketplace-spg.ts";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const MANAGEMENT_ACCOUNT = "111111111111";
const MEMBER_ACCOUNT = "222222222222";
const LICENSE_ARN = `arn:aws:license-manager:us-east-1:${MANAGEMENT_ACCOUNT}:license:l-marketplace-001`;
const GRANT_ARN = `arn:aws:license-manager:us-east-1:${MANAGEMENT_ACCOUNT}:grant:g-marketplace-001`;
const SCOPE: AwsMarketplaceSpgScope = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: `conn_${"a".repeat(32)}`,
  accountId: MANAGEMENT_ACCOUNT,
  partition: "aws",
  awsOrganizationId: "o-abcdefghij12",
};

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
  ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
  : T;

function coverage(
  operation: AwsMarketplaceSpgCapture["operationCoverage"][number]["operation"],
  recordCount: number,
) {
  return {
    operation,
    state: "SUCCEEDED" as const,
    recordCount,
    pageCount: 1,
    failureCode: null,
  };
}

function capture(): Mutable<AwsMarketplaceSpgCapture> {
  return {
    schemaVersion: "sutra.aws-marketplace-spg.v1",
    scope: { ...SCOPE },
    captureId: `marketplace_${"b".repeat(64)}`,
    startedAt: "2026-07-31T11:50:00.000Z",
    completedAt: "2026-07-31T12:00:00.000Z",
    agreementRegion: "us-east-1",
    discoveryRegion: "us-east-1",
    licenseManagerRegion: "us-east-1",
    agreementParty: "Acceptor",
    agreementAccountCoverage: {
      basis: "AWS_ORGANIZATIONS_ACTIVE_ACCOUNTS",
      evidenceId: "organizations:accounts:20260731",
      observedAt: "2026-07-31T11:45:00.000Z",
      expectedAccountIds: [MANAGEMENT_ACCOUNT, MEMBER_ACCOUNT],
      capturedAgreementAccountIds: [MANAGEMENT_ACCOUNT, MEMBER_ACCOUNT],
    },
    licenseCollectionMode: "ORGANIZATION",
    licenseManagerSettings: {
      organizationIntegrationEnabled: true,
      crossAccountDiscoveryEnabled: true,
    },
    operationCoverage: [
      coverage("SearchAgreements", 1),
      coverage("DescribeAgreement", 1),
      coverage("GetAgreementTerms", 3),
      coverage("GetAgreementEntitlements", 1),
      coverage("ListAgreementCharges", 1),
      coverage("GetProduct", 1),
      coverage("GetServiceSettings", 1),
      {
        operation: "ListReceivedLicenses",
        state: "UNAVAILABLE",
        recordCount: 0,
        pageCount: 0,
        failureCode: "SERVICE_NOT_ENABLED",
      },
      {
        operation: "ListReceivedGrants",
        state: "UNAVAILABLE",
        recordCount: 0,
        pageCount: 0,
        failureCode: "SERVICE_NOT_ENABLED",
      },
      coverage("ListReceivedLicensesForOrganization", 1),
      coverage("ListReceivedGrantsForOrganization", 1),
    ],
    agreements: [{
      sourceAccountId: MEMBER_ACCOUNT,
      agreementId: "agmt-001",
      agreementType: "PurchaseAgreement",
      acceptorAccountId: MEMBER_ACCOUNT,
      status: "ACTIVE",
      acceptanceAt: "2026-01-01T00:00:00.000Z",
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-08-20T00:00:00.000Z",
      offerId: "offer-001",
      productId: "prod-001",
      estimatedCharges: { amount: "12000.50", currencyCode: "USD" },
      product: {
        productId: "prod-001",
        productName: "Enterprise Security",
        sellerDisplayName: "Example Seller",
        sellerProfileId: "seller-001",
        deployedOnAws: "DEPLOYED",
        fulfillmentTypes: ["SAAS"],
      },
      terms: [{
        termId: "term-legal",
        type: "LEGAL",
        legalDocumentTypes: ["CustomEula"],
        autoRenew: null,
        validity: null,
        pricingCurrency: null,
        committedAmount: null,
        dimensionCount: null,
        paymentSchedule: [],
      }, {
        termId: "term-renewal",
        type: "RENEWAL",
        legalDocumentTypes: [],
        autoRenew: true,
        validity: null,
        pricingCurrency: null,
        committedAmount: null,
        dimensionCount: null,
        paymentSchedule: [],
      }, {
        termId: "term-schedule",
        type: "PAYMENT_SCHEDULE",
        legalDocumentTypes: [],
        autoRenew: null,
        validity: null,
        pricingCurrency: "USD",
        committedAmount: "12000.50",
        dimensionCount: 1,
        paymentSchedule: [{ chargeAt: "2026-08-01T00:00:00.000Z", amount: "1000.25" }],
      }],
      entitlements: [{
        type: "License",
        status: "PROVISIONED",
        statusReasonCode: "AGREEMENT_ACTIVE",
        resourceType: "SaaSProduct",
        resourceId: "prod-001",
        licenseArn: LICENSE_ARN,
      }],
      charges: [{
        chargeId: "charge-001",
        revision: 1,
        chargeAt: "2026-08-01T00:00:00.000Z",
        money: { amount: "1000.25", currencyCode: "USD" },
      }],
    }],
    licenses: [{
      licenseArn: LICENSE_ARN,
      beneficiaryAccountId: MEMBER_ACCOUNT,
      homeRegion: "us-east-1",
      issuerName: "AWS/Marketplace",
      productSku: "sku-001",
      productName: "Enterprise Security",
      licenseName: "Enterprise Security annual",
      status: "AVAILABLE",
      receivedStatus: "ACTIVE",
      validity: {
        startAt: "2026-01-01T00:00:00.000Z",
        endAt: "2026-12-31T23:59:59.000Z",
      },
      entitlements: [{
        name: "Seats",
        unit: "Count",
        value: null,
        maxCount: "250",
        overageAllowed: false,
      }],
    }],
    grants: [{
      grantArn: GRANT_ARN,
      licenseArn: LICENSE_ARN,
      granteeAccountId: MEMBER_ACCOUNT,
      homeRegion: "us-east-1",
      status: "ACTIVE",
      version: "1",
      operations: ["CheckoutLicense"],
      activationOverrideBehavior: "DISTRIBUTED_GRANTS_ONLY",
    }],
    cur2: {
      scope: { ...SCOPE },
      generationId: "cur2_generation_20260731",
      sourceEvidenceId: "cur2:manifest:20260731",
      dataThroughAt: "2026-07-31T06:00:00.000Z",
      reconciliationState: "reconciled",
      predicate: "CUR2_BILLING_ENTITY_AWS_MARKETPLACE",
      rows: [{
        linkedAccountId: MEMBER_ACCOUNT,
        billingPeriod: "2026-07",
        invoiceId: "invoice-001",
        productCode: "prod-001",
        productName: "Enterprise Security",
        sellerName: "Example Seller",
        chargeCategory: "usage",
        currency: "USD",
        billedAmountMicros: "6250250000",
        amortizedAmountMicros: "6000000000",
      }, {
        linkedAccountId: MANAGEMENT_ACCOUNT,
        billingPeriod: "2026-07",
        invoiceId: null,
        productCode: "prod-002",
        productName: "Data Platform",
        sellerName: "Other Seller",
        chargeCategory: "credit",
        currency: "USD",
        billedAmountMicros: "-250000000",
        amortizedAmountMicros: null,
      }],
    },
  };
}

test("pins exact buyer reads and excludes seller-only entitlement and invoice reads", () => {
  assert.deepEqual(AWS_MARKETPLACE_BUYER_API_OPERATIONS, [
    "SearchAgreements",
    "DescribeAgreement",
    "GetAgreementTerms",
    "GetAgreementEntitlements",
    "ListAgreementCharges",
    "GetProduct",
  ]);
  assert.deepEqual(AWS_MARKETPLACE_BUYER_IAM_ACTIONS, [
    "aws-marketplace:SearchAgreements",
    "aws-marketplace:DescribeAgreement",
    "aws-marketplace:GetAgreementTerms",
    "aws-marketplace:GetAgreementEntitlements",
    "aws-marketplace:ListAgreementCharges",
    "aws-marketplace:GetProduct",
  ]);
  assert.equal(AWS_MARKETPLACE_LICENSE_MANAGER_API_OPERATIONS.length, 5);
  assert.equal(AWS_MARKETPLACE_LICENSE_MANAGER_IAM_ACTIONS.length, 5);
  assert.deepEqual(AWS_MARKETPLACE_ACCOUNT_COVERAGE_IAM_ACTIONS, [
    "organizations:DescribeOrganization",
    "organizations:ListAccounts",
  ]);
  assert.deepEqual(AWS_MARKETPLACE_SELLER_ONLY_EXCLUDED_ACTIONS, [
    "aws-marketplace:GetEntitlements",
    "aws-marketplace:ListAgreementInvoiceLineItems",
  ]);
});

test("normalizes organization buyer evidence, expiration, license grants and reconciled CUR2 spend", () => {
  const snapshot = normalizeAwsMarketplaceSpgCapture(capture(), SCOPE, NOW);
  assert.equal(snapshot.state, "READY");
  assert.equal(snapshot.organizationCoverage, "COMPLETE");
  assert.deepEqual(snapshot.channelStates, {
    agreements: "READY",
    licenses: "READY",
    spend: "READY",
  });
  assert.equal(snapshot.counts.expectedAgreementAccounts, 2);
  assert.equal(snapshot.counts.capturedAgreementAccounts, 2);
  assert.equal(snapshot.counts.expiringWithin90Days, 1);
  assert.equal(snapshot.counts.activeGrants, 1);
  assert.equal(snapshot.agreements[0]?.estimatedCharges?.amountMicros, "12000500000");
  assert.equal(
    snapshot.agreements[0]?.estimatedCharges?.meaning,
    "KNOWN_LIFECYCLE_COMMITMENT_NOT_USAGE_ACTUAL",
  );
  assert.equal(snapshot.agreements[0]?.terms[2]?.committedAmountMicros, "12000500000");
  assert.equal(snapshot.agreements[0]?.terms[2]?.paymentSchedule[0]?.amountMicros, "1000250000");
  assert.deepEqual(snapshot.spend.summaries, [{
    currency: "USD",
    billedAmountMicros: "6000250000",
    amortizedAmountMicros: "6000000000",
    rowCount: 2,
  }]);

  const evidence = awsMarketplaceSpgSourceEvidence(snapshot);
  assert.equal(evidence.sourceId, "aws_marketplace_intelligence");
  assert.equal(evidence.coverage.assessment, "complete");
  assert.equal(evidence.lastAttemptOutcome, "succeeded");
  assert.match(evidence.evidenceBasis, /cur2_generation_20260731/u);
});

test("never upgrades known agreement commitment into realized spend", () => {
  const sample = capture();
  sample.cur2 = null;
  const snapshot = normalizeAwsMarketplaceSpgCapture(sample, SCOPE, NOW);
  assert.equal(snapshot.state, "CONFIGURATION_REQUIRED");
  assert.equal(snapshot.channelStates.spend, "CONFIGURATION_REQUIRED");
  assert.equal(snapshot.spend.summaries.length, 0);
  assert.equal(snapshot.agreements[0]?.estimatedCharges?.amountMicros, "12000500000");
  assert.match(snapshot.limitations.join(" "), /must not be shown as realized spend/iu);
});

test("reports honest single-account scope without fabricating organization coverage", () => {
  const sample = capture();
  sample.agreementAccountCoverage = {
    basis: "SINGLE_CONNECTED_ACCOUNT",
    evidenceId: "connection:account",
    observedAt: "2026-07-31T11:45:00.000Z",
    expectedAccountIds: [MANAGEMENT_ACCOUNT],
    capturedAgreementAccountIds: [MANAGEMENT_ACCOUNT],
  };
  sample.licenseCollectionMode = "ACCOUNT";
  sample.agreements = [];
  sample.licenses = [];
  sample.grants = [];
  sample.cur2!.rows = sample.cur2!.rows.filter((row) => row.linkedAccountId === MANAGEMENT_ACCOUNT);
  const snapshot = normalizeAwsMarketplaceSpgCapture(sample, SCOPE, NOW);
  assert.equal(snapshot.organizationCoverage, "SINGLE_ACCOUNT_ONLY");
  assert.match(snapshot.limitations.join(" "), /only the connected account/iu);

  const approvedSubset = capture();
  approvedSubset.agreementAccountCoverage.basis = "OPERATOR_APPROVED_ACCOUNT_SET";
  const subsetSnapshot = normalizeAwsMarketplaceSpgCapture(approvedSubset, SCOPE, NOW);
  assert.equal(subsetSnapshot.organizationCoverage, "PARTIAL");
});

test("rejects tenant substitution and unregistered agreement accounts", () => {
  const attacker = capture();
  attacker.scope.customerId = "customer_attacker";
  assert.throws(
    () => normalizeAwsMarketplaceSpgCapture(attacker, SCOPE, NOW),
    (error) => error instanceof AwsMarketplaceSpgError && error.code === "SCOPE_MISMATCH",
  );

  const unknown = capture();
  unknown.agreements[0]!.sourceAccountId = "333333333333";
  unknown.agreements[0]!.acceptorAccountId = "333333333333";
  assert.throws(
    () => normalizeAwsMarketplaceSpgCapture(unknown, SCOPE, NOW),
    (error) => error instanceof AwsMarketplaceSpgError
      && error.code === "ACCOUNT_COVERAGE_MISMATCH",
  );
});

test("reports missing License Manager organization integration and rejects false organization data", () => {
  const sample = capture();
  sample.licenseManagerSettings.organizationIntegrationEnabled = false;
  sample.licenses = [];
  sample.grants = [];
  for (const entry of sample.operationCoverage) {
    if (entry.operation === "ListReceivedLicensesForOrganization"
      || entry.operation === "ListReceivedGrantsForOrganization") {
      entry.state = "CONFIGURATION_REQUIRED";
      entry.recordCount = 0;
      entry.pageCount = 0;
      entry.failureCode = "SERVICE_NOT_ENABLED";
    }
  }
  const snapshot = normalizeAwsMarketplaceSpgCapture(sample, SCOPE, NOW);
  assert.equal(snapshot.state, "CONFIGURATION_REQUIRED");
  assert.equal(snapshot.channelStates.licenses, "CONFIGURATION_REQUIRED");

  const falseClaim = capture();
  falseClaim.licenseManagerSettings.organizationIntegrationEnabled = false;
  assert.throws(
    () => normalizeAwsMarketplaceSpgCapture(falseClaim, SCOPE, NOW),
    (error) => error instanceof AwsMarketplaceSpgError
      && error.code === "COLLECTION_POLICY_VIOLATION",
  );
});

test("rejects short-lived registration tokens and purchase-order references at the boundary", () => {
  const registrationToken = capture();
  (registrationToken.agreements[0]!.entitlements[0] as unknown as Record<string, unknown>)
    .registrationToken = "must-not-cross";
  assert.throws(
    () => normalizeAwsMarketplaceSpgCapture(registrationToken, SCOPE, NOW),
    (error) => error instanceof AwsMarketplaceSpgError
      && error.code === "SENSITIVE_DATA_REJECTED",
  );

  const purchaseOrder = capture();
  (purchaseOrder.agreements[0]!.charges[0] as unknown as Record<string, unknown>)
    .purchaseOrderReference = "PO-secret";
  assert.throws(
    () => normalizeAwsMarketplaceSpgCapture(purchaseOrder, SCOPE, NOW),
    (error) => error instanceof AwsMarketplaceSpgError
      && error.code === "SENSITIVE_DATA_REJECTED",
  );
});

test("rejects seller/contact payloads and conflicting provider identifiers", () => {
  const contact = capture();
  (contact.agreements[0]!.product as unknown as Record<string, unknown>).supportEmail = "buyer@example.test";
  assert.throws(
    () => normalizeAwsMarketplaceSpgCapture(contact, SCOPE, NOW),
    (error) => error instanceof AwsMarketplaceSpgError
      && error.code === "SENSITIVE_DATA_REJECTED",
  );

  const duplicate = capture();
  duplicate.grants.push({ ...duplicate.grants[0]! });
  assert.throws(
    () => normalizeAwsMarketplaceSpgCapture(duplicate, SCOPE, NOW),
    (error) => error instanceof AwsMarketplaceSpgError
      && error.code === "CONFLICTING_DUPLICATE",
  );
});

test("keeps currencies separate and exact with signed integer micro-units", () => {
  const sample = capture();
  sample.cur2!.rows.push({
    linkedAccountId: MEMBER_ACCOUNT,
    billingPeriod: "2026-07",
    invoiceId: "invoice-eur",
    productCode: "prod-eur",
    productName: "European Product",
    sellerName: "EU Seller",
    chargeCategory: "subscription",
    currency: "EUR",
    billedAmountMicros: "1000000",
    amortizedAmountMicros: "900000",
  });
  const snapshot = normalizeAwsMarketplaceSpgCapture(sample, SCOPE, NOW);
  assert.deepEqual(snapshot.spend.summaries.map((entry) => entry.currency), ["EUR", "USD"]);
  assert.equal(snapshot.spend.summaries[0]?.billedAmountMicros, "1000000");
});

test("marks incomplete reads partial and old evidence stale", () => {
  const partial = capture();
  const productRead = partial.operationCoverage.find((entry) => entry.operation === "GetProduct")!;
  productRead.state = "ACCESS_DENIED";
  productRead.failureCode = "ACCESS_DENIED";
  const partialSnapshot = normalizeAwsMarketplaceSpgCapture(partial, SCOPE, NOW);
  assert.equal(partialSnapshot.state, "PARTIAL");
  assert.equal(partialSnapshot.channelStates.agreements, "PARTIAL");

  const stale = capture();
  stale.agreementAccountCoverage.observedAt = "2026-07-20T00:00:00.000Z";
  stale.cur2!.dataThroughAt = "2026-07-20T00:00:00.000Z";
  const staleSnapshot = normalizeAwsMarketplaceSpgCapture(stale, SCOPE, NOW);
  assert.equal(staleSnapshot.state, "STALE");
  assert.equal(staleSnapshot.freshness.status, "STALE");
});

test("fails closed on partitions without documented Marketplace Agreement availability", () => {
  const govScope: Mutable<AwsMarketplaceSpgScope> = {
    ...SCOPE,
    partition: "aws-us-gov",
  };
  const sample = capture();
  sample.scope = { ...govScope };
  assert.throws(
    () => normalizeAwsMarketplaceSpgCapture(sample, govScope, NOW),
    (error) => error instanceof AwsMarketplaceSpgError
      && error.code === "UNSUPPORTED_PARTITION",
  );
});

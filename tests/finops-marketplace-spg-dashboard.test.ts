import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKETPLACE_SPG_DASHBOARD_BOUNDS,
  projectMarketplaceSpgDashboard,
} from "../lib/finops-marketplace-spg-dashboard.ts";
import { MARKETPLACE_SPG_OFFICIAL_DEFINITION } from
  "../lib/finops-marketplace-spg-official-definition.ts";
import type { AwsMarketplaceSpgSnapshot } from
  "../lib/finops-marketplace-spg.ts";

const SNAPSHOT = {
  agreements: [{
    agreementId: "agreement-1",
    sourceAccountId: "111122223333",
    status: "ACTIVE",
    expirationState: "EXPIRING_60_DAYS",
    productId: "product-1",
    product: {
      productName: "Security Suite",
      sellerDisplayName: "Secure Seller",
      deployedOnAws: "DEPLOYED",
    },
    estimatedCharges: {
      currency: "USD",
      amountMicros: "12000000",
      meaning: "KNOWN_LIFECYCLE_COMMITMENT_NOT_USAGE_ACTUAL",
    },
    charges: [{
      chargeAt: "2026-07-15T00:00:00.000Z",
      money: { amount: "1.250001", currencyCode: "USD" },
    }],
  }],
  licenses: [{
    licenseArn: "arn:aws:license-manager:us-east-1:111122223333:license:l-1",
    beneficiaryAccountId: "111122223333",
    productName: "Security Suite",
    status: "AVAILABLE",
    validity: {
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-08-20T00:00:00.000Z",
    },
  }],
  grants: [{
    licenseArn: "arn:aws:license-manager:us-east-1:111122223333:license:l-1",
    status: "ACTIVE",
  }],
  spend: { rows: [{
    linkedAccountId: "111122223333",
    billingPeriod: "2026-07",
    invoiceId: "invoice-1",
    productName: "Security Suite",
    sellerName: "Secure Seller",
    currency: "USD",
    billedAmountMicros: "5000000",
    amortizedAmountMicros: "4000000",
  }, {
    linkedAccountId: "111122223333",
    billingPeriod: "2026-07",
    invoiceId: "invoice-1",
    productName: "Security Suite",
    sellerName: "Secure Seller",
    currency: "USD",
    billedAmountMicros: "-1000000",
    amortizedAmountMicros: null,
  }, {
    linkedAccountId: "222233334444",
    billingPeriod: "2026-07",
    invoiceId: null,
    productName: "Data Product",
    sellerName: "Data Seller",
    currency: "EUR",
    billedAmountMicros: "3000000",
    amortizedAmountMicros: null,
  }] },
} as unknown as AwsMarketplaceSpgSnapshot;

const FILTERS = {
  accountId: null, product: null, seller: null, currency: null,
  billingPeriod: null, agreementStatus: null, expirationState: null,
  licenseStatus: null,
};

test("official Marketplace definition pins the immutable source and 5-tab 23-area catalog", () => {
  const definition = MARKETPLACE_SPG_OFFICIAL_DEFINITION;
  assert.equal(definition.source.commit,
    "f9e36d88c47709f10e8fa784ad11d5cc0e728021");
  assert.equal(definition.source.sha256,
    "67aaab07865d8c5096379bd3baf962f92e2337762d365b75bbfb8cbc28276f5d");
  assert.equal(definition.source.quickSightDefinitionEmbedded, false);
  assert.equal(definition.source.quickSightControlInventory,
    "NOT_DISCLOSED_IN_IMMUTABLE_SOURCE");
  assert.equal(definition.source.quickSightVisualObjectCount, null);
  assert.equal(definition.tabs.length, 5);
  assert.equal(definition.tabs.reduce((count, tab) =>
    count + tab.areas.length, 0), 23);
  assert.deepEqual(definition.tabs.map((tab) => tab.label), [
    "Spend Summary",
    "Spend Deep Dive",
    "Bedrock 3P Foundational Model Spend",
    "Granted and Entitled Licenses",
    "Marketplace Agreements",
  ]);
  assert.equal(definition.tabs[2]?.areas.every((area) =>
    area.support === "UNAVAILABLE"), true);
});

test("dashboard projection builds official decision views without mixing evidence planes", () => {
  const result = projectMarketplaceSpgDashboard(
    SNAPSHOT, FILTERS, Date.parse("2026-08-02T00:00:00.000Z"),
  );
  assert.deepEqual(result.summaries, [{
    currency: "EUR", billedAmountMicros: "3000000",
    amortizedAmountMicros: null, rowCount: 1,
  }, {
    currency: "USD", billedAmountMicros: "4000000",
    amortizedAmountMicros: "4000000", rowCount: 2,
  }]);
  assert.deepEqual(result.spendBySeller.map((row) =>
    [row.key, row.currency, row.billedAmountMicros]), [
    ["Data Seller", "EUR", "3000000"],
    ["Secure Seller", "USD", "4000000"],
  ]);
  assert.deepEqual(result.agreementDeployment, [{
    status: "DEPLOYED",
    activeAgreementCount: 1,
    lifecycleCommitments: [{ currency: "USD", amountMicros: "12000000" }],
  }]);
  assert.deepEqual(result.agreementChargesByMonth, [{
    month: "2026-07", currency: "USD", amountMicros: "1250001",
  }]);
  assert.deepEqual(result.licenseExpirationSummary, [{
    state: "EXPIRING_30_DAYS", count: 1,
  }]);
  assert.equal(result.counts.activeGrants, 1);
});

test("dashboard filters apply independently to spend, agreements and licenses", () => {
  const result = projectMarketplaceSpgDashboard(SNAPSHOT, {
    ...FILTERS,
    seller: "data seller",
    agreementStatus: "EXPIRED",
    licenseStatus: "EXPIRED",
  }, Date.parse("2026-08-02T00:00:00.000Z"));
  assert.equal(result.spendRows.length, 1);
  assert.equal(result.spendRows[0]?.currency, "EUR");
  assert.equal(result.agreements.length, 0);
  assert.equal(result.licenses.length, 0);
  assert.equal(result.grants.length, 0);
});

test("dashboard bounds high-cardinality aggregate and filter output with disclosure", () => {
  const rows = Array.from({ length: MARKETPLACE_SPG_DASHBOARD_BOUNDS.filterOptions + 1 },
    (_, index) => ({
      ...SNAPSHOT.spend.rows[0],
      linkedAccountId: String(index).padStart(12, "0"),
      productName: `Product ${String(index).padStart(4, "0")}`,
      sellerName: `Seller ${String(index).padStart(4, "0")}`,
      invoiceId: `invoice-${index}`,
    }));
  const snapshot = { ...SNAPSHOT, spend: { rows } } as unknown as AwsMarketplaceSpgSnapshot;
  const result = projectMarketplaceSpgDashboard(snapshot, FILTERS);
  assert.equal(result.filterOptions.accounts.length,
    MARKETPLACE_SPG_DASHBOARD_BOUNDS.filterOptions);
  assert.equal(result.spendBySeller.length,
    MARKETPLACE_SPG_DASHBOARD_BOUNDS.rankedRows);
  assert.equal(result.projectionTruncation.filterOptions, true);
  assert.equal(result.projectionTruncation.spendRankings, true);
});

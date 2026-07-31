import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCsv, parseCurCsv, toMicros } from "../lib/finops-cur.ts";
import { buildAllocation, detectAnomalies, evaluateBudgets } from "../lib/finops-insights.ts";

const CUR_HEADER = "line_item_id,line_item_usage_account_id,product_servicecode,line_item_line_item_type,line_item_usage_start_date,line_item_unblended_cost,line_item_currency_code,resource_tags_user_env";

function curFile(rows: readonly string[]): string {
  return [CUR_HEADER, ...rows].join("\n");
}

function csvFile(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const encode = (value: string): string =>
    /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return [header, ...rows].map((row) => row.map(encode).join(",")).join("\n");
}

describe("toMicros", () => {
  it("parses decimals into integer micro-units without float drift", () => {
    assert.equal(toMicros("0.1"), "100000");
    assert.equal(toMicros("12.345678"), "12345678");
    assert.equal(toMicros("-3.5"), "-3500000");
    assert.equal(toMicros("1e5"), null);
    assert.equal(toMicros("NaN"), null);
  });
});

describe("parseCsv", () => {
  it("handles quoted fields, escaped quotes and CRLF", () => {
    const rows = parseCsv('a,"b,1","say ""hi"""\r\nc,d,e');
    assert.deepEqual(rows, [["a", "b,1", 'say "hi"'], ["c", "d", "e"]]);
  });
});

describe("parseCurCsv", () => {
  it("normalizes CUR 2.0 rows and keeps line-item identity", () => {
    const result = parseCurCsv(curFile([
      "li-1,111111111111,AmazonEC2,Usage,2026-07-01T00:00:00Z,10.50,USD,prod",
      "li-2,111111111111,AmazonS3,Usage,2026-07-01T00:00:00Z,0.25,USD,",
    ]));
    assert.equal("error" in result, false);
    if ("error" in result) return;
    assert.equal(result.dialect, "cur-2.0");
    assert.equal(result.lines.length, 2);
    assert.equal(result.lines[0].amountMicros, "10500000");
    assert.deepEqual(result.lines[0].tags, { env: "prod" });
    assert.deepEqual(result.lines[1].tags, {});
    assert.deepEqual(result.currencies, ["USD"]);
    // The header carries no region column, so region is null (not "").
    assert.equal(result.lines[0].region, null);
  });

  it("captures the region column for CUR 2.0 and FOCUS 1.0, null when absent", () => {
    const cur = parseCurCsv([
      "line_item_id,line_item_usage_account_id,product_servicecode,line_item_line_item_type,line_item_usage_start_date,line_item_unblended_cost,line_item_currency_code,product_region_code",
      "li-1,111111111111,AmazonEC2,Usage,2026-07-01T00:00:00Z,10.50,USD,us-east-1",
      "li-2,111111111111,AmazonS3,Usage,2026-07-01T00:00:00Z,0.25,USD,",
    ].join("\n"));
    if ("error" in cur) throw new Error(cur.error);
    assert.equal(cur.lines[0].region, "us-east-1");
    assert.equal(cur.lines[1].region, null); // empty region cell -> null, never ""
    const focus = parseCurCsv([
      "BillingAccountId,ServiceName,ChargeCategory,ChargePeriodStart,BilledCost,BillingCurrency,RegionId",
      "1,Amazon EC2,Usage,2026-07-01T00:00:00Z,5.00,USD,eu-west-1",
    ].join("\n"));
    if ("error" in focus) throw new Error(focus.error);
    assert.equal(focus.lines[0].region, "eu-west-1");
  });

  it("captures amortized cost + commitment attribution for CUR 2.0 (inferred) and FOCUS (verbatim)", () => {
    // CUR 2.0: net_amortized_cost + a savings-plan ARN => inferred savings_plan
    // classification, the ARN as the commitment id, and end-time as expiry.
    const cur = parseCurCsv([
      "line_item_id,line_item_usage_account_id,product_servicecode,line_item_line_item_type,line_item_usage_start_date,line_item_unblended_cost,line_item_currency_code,line_item_net_amortized_cost,savings_plan_savings_plan_a_r_n,savings_plan_end_time",
      "li-1,111111111111,AmazonEC2,SavingsPlanCoveredUsage,2026-07-01T00:00:00Z,10.00,USD,6.00,arn:aws:savingsplans::sp/abc,2027-01-01T00:00:00Z",
      "li-2,111111111111,AmazonS3,Usage,2026-07-01T00:00:00Z,0.25,USD,,,",
    ].join("\n"));
    if ("error" in cur) throw new Error(cur.error);
    assert.equal(cur.lines[0].amortizedMicros, "6000000");
    assert.equal(cur.lines[0].commitmentType, "savings_plan");
    assert.equal(cur.lines[0].commitmentId, "arn:aws:savingsplans::sp/abc");
    assert.equal(cur.lines[0].commitmentExpiry, "2027-01-01T00:00:00.000Z");
    // Plain usage row: on_demand inferred, no amortized/commitment id/expiry.
    assert.equal(cur.lines[1].amortizedMicros, null);
    assert.equal(cur.lines[1].commitmentType, "on_demand");
    assert.equal(cur.lines[1].commitmentId, null);
    assert.equal(cur.lines[1].commitmentExpiry, null);

    // FOCUS 1.0: EffectiveCost + CommitmentDiscount* columns are read verbatim.
    const focus = parseCurCsv([
      "BillingAccountId,ServiceName,ChargeCategory,ChargePeriodStart,BilledCost,BillingCurrency,EffectiveCost,CommitmentDiscountType,CommitmentDiscountId,CommitmentDiscountExpirationDate",
      "1,Amazon EC2,Usage,2026-07-01T00:00:00Z,0.00,USD,4.00,Reserved,ri-9,2026-12-31T00:00:00Z",
    ].join("\n"));
    if ("error" in focus) throw new Error(focus.error);
    assert.equal(focus.lines[0].amortizedMicros, "4000000");
    assert.equal(focus.lines[0].commitmentType, "Reserved");
    assert.equal(focus.lines[0].commitmentId, "ri-9");
    assert.equal(focus.lines[0].commitmentExpiry, "2026-12-31T00:00:00.000Z");
  });

  it("sums CUR reservation + savings-plan effective cost when there is no single amortized column", () => {
    const cur = parseCurCsv([
      "line_item_id,line_item_usage_account_id,product_servicecode,line_item_line_item_type,line_item_usage_start_date,line_item_unblended_cost,line_item_currency_code,reservation_effective_cost,savings_plan_effective_cost",
      "li-1,111111111111,AmazonEC2,DiscountedUsage,2026-07-01T00:00:00Z,0.00,USD,7.00,",
    ].join("\n"));
    if ("error" in cur) throw new Error(cur.error);
    assert.equal(cur.lines[0].amortizedMicros, "7000000");
    assert.equal(cur.lines[0].commitmentType, "reserved"); // DiscountedUsage => RI
  });

  it("rejects malformed rows with row numbers and reasons — never silently drops", () => {
    const result = parseCurCsv(curFile([
      "li-1,111111111111,AmazonEC2,Usage,2026-07-01T00:00:00Z,not-a-number,USD,",
      "li-2,111111111111,AmazonEC2,Usage,not-a-date,1.00,USD,",
      "li-3,111111111111,AmazonEC2,Usage,2026-07-01T00:00:00Z,1.00,US,",
      "li-4,,AmazonEC2,Usage,2026-07-01T00:00:00Z,1.00,USD,",
      "li-5,111111111111,AmazonEC2,Usage,2026-07-02T00:00:00Z,2.00,USD,",
    ]));
    if ("error" in result) throw new Error(result.error);
    assert.equal(result.lines.length, 1);
    assert.equal(result.rejected.length, 4);
    assert.equal(result.totalRows, 5);
    assert.match(result.rejected[0].reason, /not a decimal/);
    assert.match(result.rejected[1].reason, /not parseable/);
    assert.match(result.disclaimer, /never estimated/);
  });

  it("parses FOCUS 1.0 headers and refuses unknown formats explicitly", () => {
    const focus = [
      "BillingAccountId,SubAccountId,ServiceName,ChargeCategory,ChargePeriodStart,BilledCost,BillingCurrency,ChargeDescription",
      "1,2,Amazon EC2,Usage,2026-07-01T00:00:00Z,5.00,USD,compute",
    ].join("\n");
    const result = parseCurCsv(focus);
    if ("error" in result) throw new Error(result.error);
    assert.equal(result.dialect, "focus-1.0");
    assert.equal(result.sourceFormat, "focus");
    assert.equal(result.sourceVersion, "1.0");
    assert.equal(result.lines[0].sourceFormat, "focus");
    assert.equal(result.lines[0].sourceVersion, "1.0");
    assert.equal(result.lines[0].usageAccountId, "2");
    const unknown = parseCurCsv("foo,bar\n1,2");
    assert.equal("error" in unknown && unknown.error.includes("neither"), true);
  });

  it("retains CUR 2.0 payer, invoice, resource, product, pricing, legal, commitment, and category dimensions", () => {
    const header = [
      "line_item_id",
      "line_item_usage_account_id",
      "product_servicecode",
      "line_item_line_item_type",
      "line_item_usage_start_date",
      "line_item_unblended_cost",
      "line_item_currency_code",
      "line_item_usage_end_date",
      "bill_payer_account_id",
      "bill_payer_account_name",
      "bill_billing_period_start_date",
      "bill_billing_period_end_date",
      "bill_invoice_id",
      "bill_invoicing_entity",
      "bill_billing_entity",
      "bill_bill_type",
      "line_item_usage_account_name",
      "line_item_legal_entity",
      "line_item_line_item_description",
      "line_item_resource_id",
      "line_item_availability_zone",
      "line_item_operation",
      "line_item_product_code",
      "line_item_net_unblended_cost",
      "product_region_code",
      "reservation_effective_cost",
      "reservation_reservation_a_r_n",
      "reservation_start_time",
      "reservation_end_time",
      "reservation_total_reserved_units",
      "reservation_unit",
      "pricing_term",
      "pricing_currency",
      "pricing_public_on_demand_cost",
      "pricing_public_on_demand_rate",
      "pricing_purchase_option",
      "pricing_rate_id",
      "product_product_name",
      "product_product_family",
      "resource_tags_user_env",
      "cost_category_department",
      "line_item_usage_type",
      "line_item_usage_amount",
      "pricing_unit",
      "capacity_reservation_capacity_reservation_arn",
      "capacity_reservation_capacity_reservation_status",
    ];
    const result = parseCurCsv(csvFile(header, [[
      "li-rich",
      "222222222222",
      "AmazonEC2",
      "DiscountedUsage",
      "2026-07-01T00:00:00Z",
      "1.25",
      "USD",
      "2026-07-01T01:00:00Z",
      "111111111111",
      "Management",
      "2026-07-01T00:00:00Z",
      "2026-08-01T00:00:00Z",
      "INV-1",
      "Amazon Web Services, Inc.",
      "AWS",
      "Anniversary",
      "Workload",
      "Amazon Web Services, Inc.",
      "EC2 reserved usage",
      "i-012345",
      "us-east-1a",
      "RunInstances",
      "AmazonEC2",
      "1.10",
      "us-east-1",
      "0.95",
      "arn:aws:ec2:us-east-1:111111111111:reserved-instances/ri-1",
      "2026-01-01T00:00:00Z",
      "2027-01-01T00:00:00Z",
      "8",
      "Normalized Units",
      "Reserved",
      "USD",
      "4.50",
      "0.25",
      "Partial Upfront",
      "rate-1",
      "Amazon Elastic Compute Cloud",
      "Compute Instance",
      "prod",
      "Platform",
      "USE1-BoxUsage:m7g.large",
      "1",
      "Hrs",
      "arn:aws:ec2:us-east-1:111111111111:capacity-reservation/cr-1",
      "Used",
    ]]));
    if ("error" in result) throw new Error(result.error);
    assert.equal(result.dialect, "cur-2.0");
    assert.equal(result.sourceFormat, "aws-cur");
    assert.equal(result.sourceVersion, "2.0");
    const line = result.lines[0];
    assert.equal(line.sourceFormat, "aws-cur");
    assert.equal(line.sourceVersion, "2.0");
    assert.equal(line.payerAccountId, "111111111111");
    assert.equal(line.payerAccountName, "Management");
    assert.equal(line.usageAccountName, "Workload");
    assert.equal(line.billingPeriodStartIso, "2026-07-01T00:00:00.000Z");
    assert.equal(line.billingPeriodEndIso, "2026-08-01T00:00:00.000Z");
    assert.equal(line.usageEndIso, "2026-07-01T01:00:00.000Z");
    assert.equal(line.invoiceId, "INV-1");
    assert.equal(line.invoiceIssuerName, "Amazon Web Services, Inc.");
    assert.equal(line.billingEntity, "AWS");
    assert.equal(line.legalEntity, "Amazon Web Services, Inc.");
    assert.equal(line.resourceId, "i-012345");
    assert.equal(line.availabilityZone, "us-east-1a");
    assert.equal(line.operation, "RunInstances");
    assert.equal(line.productCode, "AmazonEC2");
    assert.equal(line.productName, "Amazon Elastic Compute Cloud");
    assert.equal(line.productFamily, "Compute Instance");
    assert.equal(line.netUnblendedCostMicros, "1100000");
    assert.equal(line.publicOnDemandCostMicros, "4500000");
    assert.equal(line.publicOnDemandRateMicros, "250000");
    assert.equal(line.pricingCurrency, "USD");
    assert.equal(line.pricingTerm, "Reserved");
    assert.equal(line.pricingRateId, "rate-1");
    assert.equal(line.commitmentType, "reserved");
    assert.match(line.commitmentId ?? "", /reserved-instances\/ri-1$/u);
    assert.equal(line.commitmentStart, "2026-01-01T00:00:00.000Z");
    assert.equal(line.commitmentExpiry, "2027-01-01T00:00:00.000Z");
    assert.equal(line.commitmentQuantityMicros, "8000000");
    assert.equal(line.commitmentUnit, "Normalized Units");
    assert.equal(line.commitmentPurchaseOption, "Partial Upfront");
    assert.match(line.capacityReservationId ?? "", /capacity-reservation\/cr-1$/u);
    assert.equal(line.capacityReservationStatus, "Used");
    assert.deepEqual(line.tags, { env: "prod" });
    assert.deepEqual(line.costCategories, { department: "Platform" });
  });

  it("detects FOCUS 1.2 and retains invoice, pricing-currency, capacity, and namespaced category data", () => {
    const header = [
      "BillingAccountId",
      "BillingAccountName",
      "BillingAccountType",
      "SubAccountId",
      "SubAccountName",
      "SubAccountType",
      "ServiceName",
      "ServiceCategory",
      "ServiceSubcategory",
      "ChargeCategory",
      "ChargeClass",
      "ChargeDescription",
      "ChargeFrequency",
      "ChargePeriodStart",
      "ChargePeriodEnd",
      "BillingPeriodStart",
      "BillingPeriodEnd",
      "BilledCost",
      "EffectiveCost",
      "ContractedCost",
      "ContractedUnitPrice",
      "ListCost",
      "ListUnitPrice",
      "BillingCurrency",
      "PricingCurrency",
      "PricingCurrencyEffectiveCost",
      "PricingCurrencyContractedUnitPrice",
      "PricingCurrencyListUnitPrice",
      "PricingCategory",
      "InvoiceId",
      "InvoiceIssuerId",
      "InvoiceIssuerName",
      "ProviderName",
      "PublisherName",
      "RegionId",
      "AvailabilityZone",
      "ResourceId",
      "ResourceName",
      "ResourceType",
      "x_Operation",
      "x_ServiceCode",
      "SkuMeter",
      "SkuPriceId",
      "ConsumedQuantity",
      "ConsumedUnit",
      "PricingUnit",
      "CommitmentDiscountType",
      "CommitmentDiscountId",
      "CommitmentDiscountName",
      "CommitmentDiscountCategory",
      "CommitmentDiscountStatus",
      "CommitmentDiscountQuantity",
      "CommitmentDiscountUnit",
      "CapacityReservationId",
      "CapacityReservationStatus",
      "Tags",
    ];
    const result = parseCurCsv(csvFile(header, [[
      "111111111111",
      "Management",
      "AWS Organization",
      "222222222222",
      "Payments",
      "Linked Account",
      "Amazon EC2",
      "Compute",
      "Virtual Machines",
      "Usage",
      "",
      "Reserved compute",
      "Usage-Based",
      "2026-07-01T00:00:00Z",
      "2026-07-01T01:00:00Z",
      "2026-07-01T00:00:00Z",
      "2026-08-01T00:00:00Z",
      "5.25",
      "4.75",
      "5.50",
      "0.55",
      "6.00",
      "0.60",
      "USD",
      "Credits",
      "475",
      "55",
      "60",
      "Committed",
      "INV-FOCUS-1",
      "issuer-1",
      "Amazon Web Services, Inc.",
      "AWS",
      "AWS Marketplace Seller",
      "us-east-1",
      "us-east-1a",
      "i-focus",
      "payments-api",
      "Virtual Machine",
      "RunInstances",
      "AmazonEC2",
      "USE1-BoxUsage:m7g.large",
      "sku-price-1",
      "1",
      "Hrs",
      "Hrs",
      "Reserved",
      "ri-focus",
      "Compute RI",
      "Usage",
      "Used",
      "8",
      "Normalized Units",
      "cr-focus",
      "Used",
      JSON.stringify({
        env: "prod",
        "aws:tags:CostCategory/BusinessUnit": "Payments",
      }),
    ]]));
    if ("error" in result) throw new Error(result.error);
    assert.equal(result.dialect, "focus-1.2");
    assert.equal(result.sourceFormat, "focus");
    assert.equal(result.sourceVersion, "1.2");
    const line = result.lines[0];
    assert.equal(line.sourceVersion, "1.2");
    assert.equal(line.payerAccountId, "111111111111");
    assert.equal(line.usageAccountId, "222222222222");
    assert.equal(line.billingPeriodStartIso, "2026-07-01T00:00:00.000Z");
    assert.equal(line.invoiceId, "INV-FOCUS-1");
    assert.equal(line.invoiceIssuerId, "issuer-1");
    assert.equal(line.invoiceIssuerName, "Amazon Web Services, Inc.");
    assert.equal(line.billingEntity, "AWS");
    assert.equal(line.legalEntity, "AWS Marketplace Seller");
    assert.equal(line.resourceId, "i-focus");
    assert.equal(line.resourceName, "payments-api");
    assert.equal(line.resourceType, "Virtual Machine");
    assert.equal(line.operation, "RunInstances");
    assert.equal(line.productCode, "AmazonEC2");
    assert.equal(line.serviceCategory, "Compute");
    assert.equal(line.serviceSubcategory, "Virtual Machines");
    assert.equal(line.listCostMicros, "6000000");
    assert.equal(line.contractedCostMicros, "5500000");
    assert.equal(line.listUnitPriceMicros, "600000");
    assert.equal(line.contractedUnitPriceMicros, "550000");
    assert.equal(line.pricingCurrency, "Credits");
    assert.equal(line.pricingCurrencyEffectiveCostMicros, "475000000");
    assert.equal(line.pricingCurrencyContractedUnitPriceMicros, "55000000");
    assert.equal(line.pricingCurrencyListUnitPriceMicros, "60000000");
    assert.equal(line.commitmentId, "ri-focus");
    assert.equal(line.commitmentName, "Compute RI");
    assert.equal(line.commitmentCategory, "Usage");
    assert.equal(line.commitmentStatus, "Used");
    assert.equal(line.commitmentQuantityMicros, "8000000");
    assert.equal(line.commitmentUnit, "Normalized Units");
    assert.equal(line.capacityReservationId, "cr-focus");
    assert.equal(line.capacityReservationStatus, "Used");
    assert.deepEqual(line.tags, {
      env: "prod",
      "aws:tags:CostCategory/BusinessUnit": "Payments",
    });
    assert.deepEqual(line.costCategories, { BusinessUnit: "Payments" });
  });

  it("classifies tax, credit, and refund amounts without turning absent kinds into zero", () => {
    const header = [
      "line_item_id",
      "line_item_usage_account_id",
      "product_servicecode",
      "line_item_line_item_type",
      "line_item_usage_start_date",
      "line_item_unblended_cost",
      "line_item_currency_code",
      "line_item_tax_type",
      "bill_bill_type",
    ];
    const result = parseCurCsv(csvFile(header, [
      ["tax-1", "1", "Tax", "Tax", "2026-07-01T00:00:00Z", "1.25", "USD", "VAT", "Anniversary"],
      ["credit-1", "1", "AWS", "Credit", "2026-07-01T00:00:00Z", "-2.00", "USD", "", "Anniversary"],
      ["refund-1", "1", "AWS", "Refund", "2026-07-01T00:00:00Z", "-3.00", "USD", "", "Refund"],
    ]));
    if ("error" in result) throw new Error(result.error);
    assert.deepEqual(result.lines.map((line) => line.chargeKind), ["tax", "credit", "refund"]);
    assert.equal(result.lines[0].taxMicros, "1250000");
    assert.equal(result.lines[0].creditMicros, null);
    assert.equal(result.lines[1].creditMicros, "-2000000");
    assert.equal(result.lines[1].refundMicros, null);
    assert.equal(result.lines[2].refundMicros, "-3000000");
    assert.equal(result.lines[2].taxMicros, null);
  });

  it("rejects invalid optional canonical values in a stable validation order", () => {
    const invalidMoney = parseCurCsv([
      "line_item_id,line_item_usage_account_id,product_servicecode,line_item_line_item_type,line_item_usage_start_date,line_item_unblended_cost,line_item_currency_code,line_item_net_unblended_cost,bill_billing_period_start_date",
      "li-1,1,AmazonEC2,Usage,2026-07-01T00:00:00Z,1.00,USD,bad,not-a-date",
    ].join("\n"));
    if ("error" in invalidMoney) throw new Error(invalidMoney.error);
    assert.deepEqual(invalidMoney.rejected, [
      { rowNumber: 1, reason: "net unblended cost 'bad' is not a decimal number" },
    ]);

    const invalidTags = parseCurCsv(csvFile([
      "BillingAccountId",
      "ServiceName",
      "ChargeCategory",
      "ChargePeriodStart",
      "BilledCost",
      "BillingCurrency",
      "Tags",
    ], [["1", "Amazon EC2", "Usage", "2026-07-01T00:00:00Z", "1.00", "USD", "not-json"]]));
    if ("error" in invalidTags) throw new Error(invalidTags.error);
    assert.deepEqual(invalidTags.rejected, [
      { rowNumber: 1, reason: "tags is not a JSON object" },
    ]);

    const duplicateHeader = parseCurCsv([
      `${CUR_HEADER},line_item_id`,
      "li-1,1,AmazonEC2,Usage,2026-07-01T00:00:00Z,1.00,USD,prod,li-duplicate",
    ].join("\n"));
    assert.deepEqual(duplicateHeader, { error: "The header contains duplicate column names" });
  });
});

describe("finops insights", () => {
  const parsed = parseCurCsv(curFile([
    "li-1,111111111111,AmazonEC2,Usage,2026-07-01T00:00:00Z,10.00,USD,prod",
    "li-2,222222222222,AmazonS3,Usage,2026-07-01T00:00:00Z,4.00,USD,prod",
    "li-3,111111111111,AmazonEC2,Usage,2026-07-01T02:00:00Z,6.00,USD,",
    "li-4,111111111111,AmazonEC2,Usage,2026-07-01T00:00:00Z,3.00,EUR,prod",
  ]));
  if ("error" in parsed) throw new Error(parsed.error);
  const lines = parsed.lines;

  it("allocates by tag per currency and discloses the unallocated remainder", () => {
    const results = buildAllocation(lines, "tag", "env");
    assert.equal(results.length, 2); // EUR and USD, never mixed
    const usd = results.find((entry) => entry.currency === "USD")!;
    assert.equal(usd.buckets[0].key, "prod");
    assert.equal(usd.buckets[0].amountMicros, "14000000");
    assert.equal(usd.unallocatedMicros, "6000000");
    assert.equal(usd.totalMicros, "20000000");
  });

  it("evaluates budgets with warning/breach thresholds and honest no-data", () => {
    const evaluations = evaluateBudgets(lines, [
      { id: "b1", name: "EC2 USD", currency: "USD", limitMicros: "20000000", filter: { dimension: "service", value: "AmazonEC2" } },
      { id: "b2", name: "GBP budget", currency: "GBP", limitMicros: "1000000" },
    ]);
    assert.equal(evaluations[0].state, "warning"); // 16 of 20 = 80%
    assert.equal(evaluations[0].spentMicros, "16000000");
    assert.equal(evaluations[1].state, "no-data");
    assert.equal(evaluations[1].utilizationPercent, null);
  });

  it("flags spikes only with enough history, above the noise floor", () => {
    const spikeLines = [
      ...["01", "02", "03", "04"].map((day, index) => ({
        lineItemId: `d${index}`, usageAccountId: "1", service: "AmazonEC2", chargeCategory: "Usage",
        usageStartIso: `2026-07-${day}T00:00:00.000Z`, amountMicros: "2000000", currency: "USD", region: null,
        amortizedMicros: null, commitmentType: null, commitmentId: null, commitmentExpiry: null, usageType: null, usageAmountMicros: null, usageUnit: null, tags: {},
      })),
      { lineItemId: "spike", usageAccountId: "1", service: "AmazonEC2", chargeCategory: "Usage", usageStartIso: "2026-07-05T00:00:00.000Z", amountMicros: "9000000", currency: "USD", region: null, amortizedMicros: null, commitmentType: null, commitmentId: null, commitmentExpiry: null, usageType: null, usageAmountMicros: null, usageUnit: null, tags: {} },
    ];
    const result = detectAnomalies(spikeLines);
    assert.equal(result.anomalies.length, 1);
    assert.equal(result.anomalies[0].dateIso, "2026-07-05");
    assert.equal(result.anomalies[0].ratio, 4.5);
    assert.match(result.disclaimer, /not billing truth/);
    // Two days of history is not enough to call anything anomalous.
    assert.equal(detectAnomalies(spikeLines.slice(2)).anomalies.length, 0);
  });
});

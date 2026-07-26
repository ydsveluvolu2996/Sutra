import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";
import { parseCurCsv } from "../lib/finops-cur.ts";
import {
  buildAiCostView,
  modelFromUsageType,
  tokenDirectionFromUsageType,
  tokenUnitMultiplier,
  UNATTRIBUTED_MODEL,
} from "../lib/finops-ai-cost.ts";

function line(over: Partial<NormalizedCurLine> & { amountMicros: string }): NormalizedCurLine {
  return {
    lineItemId: over.lineItemId ?? "li",
    usageAccountId: over.usageAccountId ?? "111111111111",
    service: over.service ?? "AmazonBedrock",
    chargeCategory: over.chargeCategory ?? "Usage",
    usageStartIso: over.usageStartIso ?? "2026-07-01T00:00:00.000Z",
    amountMicros: over.amountMicros,
    currency: over.currency ?? "USD",
    region: over.region ?? null,
    amortizedMicros: over.amortizedMicros ?? null,
    commitmentType: over.commitmentType ?? null,
    commitmentId: over.commitmentId ?? null,
    commitmentExpiry: over.commitmentExpiry ?? null,
    usageType: over.usageType ?? null,
    usageAmountMicros: over.usageAmountMicros ?? null,
    usageUnit: over.usageUnit ?? null,
    tags: over.tags ?? {},
  };
}

/** 1,000,000 tokens metered, expressed as an integer-micro quantity. */
function tokens(count: number): string {
  return (BigInt(count) * BigInt(1_000_000)).toString();
}

describe("usage-type parsing", () => {
  it("splits token direction, treating cache markers before plain input/output", () => {
    assert.equal(tokenDirectionFromUsageType("USE1-InputTokenCount-anthropic.claude-3-sonnet"), "input");
    assert.equal(tokenDirectionFromUsageType("USE1-OutputTokenCount-anthropic.claude-3-sonnet"), "output");
    assert.equal(tokenDirectionFromUsageType("USE1-CacheReadInputTokenCount-anthropic.claude-3-5-haiku"), "cache_read");
    assert.equal(tokenDirectionFromUsageType("USE1-CacheWriteInputTokens-anthropic.claude-3-5-haiku"), "cache_write");
    // A Bedrock line that is not token-metered (e.g. provisioned throughput).
    assert.equal(tokenDirectionFromUsageType("USE1-ModelUnits-anthropic.claude-3-sonnet"), null);
  });

  it("lifts the model identifier verbatim and returns null when none remains", () => {
    assert.equal(
      modelFromUsageType("USE1-InputTokenCount-anthropic.claude-3-sonnet-20240229-v1:0"),
      "anthropic.claude-3-sonnet-20240229-v1:0",
    );
    assert.equal(modelFromUsageType("APN1-Bedrock-OutputTokenCount-amazon.titan-text-lite-v1"), "amazon.titan-text-lite-v1");
    // No model in the usage type at all -> null, never a guessed model name.
    assert.equal(modelFromUsageType("USE1-InputTokenCount"), null);
  });

  it("accepts only explicitly recognised token units", () => {
    assert.equal(tokenUnitMultiplier("tokens"), BigInt(1));
    assert.equal(tokenUnitMultiplier("1K tokens"), BigInt(1000));
    assert.equal(tokenUnitMultiplier("1000 tokens"), BigInt(1000));
    assert.equal(tokenUnitMultiplier("1M tokens"), BigInt(1_000_000));
    // Unrecognised or absent units never fall back to "1 token".
    assert.equal(tokenUnitMultiplier("Requests"), null);
    assert.equal(tokenUnitMultiplier("ModelUnits-Hrs"), null);
    assert.equal(tokenUnitMultiplier(null), null);
  });
});

describe("buildAiCostView", () => {
  it("reports per-model spend, token volumes and cost per 1K tokens", () => {
    const view = buildAiCostView([
      // 2,000,000 input tokens of claude-3-sonnet for $6.00.
      line({
        amountMicros: "6000000",
        usageType: "USE1-InputTokenCount-anthropic.claude-3-sonnet-v1:0",
        usageAmountMicros: tokens(2000),
        usageUnit: "1K tokens",
      }),
      // 500,000 output tokens of the same model for $7.50.
      line({
        amountMicros: "7500000",
        usageType: "USE1-OutputTokenCount-anthropic.claude-3-sonnet-v1:0",
        usageAmountMicros: tokens(500),
        usageUnit: "1K tokens",
      }),
      // A cheaper model: 1,000,000 input tokens for $0.80.
      line({
        amountMicros: "800000",
        usageType: "USE1-InputTokenCount-amazon.titan-text-lite-v1",
        usageAmountMicros: tokens(1_000_000),
        usageUnit: "tokens",
      }),
      // A non-Bedrock line must not enter the AI view at all.
      line({ service: "AmazonEC2", amountMicros: "99000000", usageType: "USE1-BoxUsage:m5.large" }),
    ]);

    assert.equal(view.available, true);
    assert.equal(view.unavailableReason, null);
    assert.equal(view.currency, "USD");
    // Bedrock spend only: 6.00 + 7.50 + 0.80 = 14.30.
    assert.equal(view.spendMicros, "14300000");
    assert.equal(view.spendUnits, 14.3);
    assert.equal(view.lineCount, 3);

    const sonnet = view.byModel[0];
    assert.equal(sonnet.model, "anthropic.claude-3-sonnet-v1:0");
    assert.equal(sonnet.modelIdentified, true);
    assert.equal(sonnet.spendMicros, "13500000");
    assert.equal(sonnet.tokensDerivable, true);
    // 2,000,000 + 500,000 tokens, carried as an exact micro-scaled count.
    assert.equal(sonnet.tokensMicros, "2500000000000");
    assert.equal(sonnet.tokens, 2_500_000);
    // $13.50 for 2.5M tokens = $0.0054 per 1K tokens = 5400 micro-units.
    assert.equal(sonnet.costPer1kTokensMicros, "5400");
    assert.equal(sonnet.costPer1kTokensUnits, 0.0054);
    assert.equal(sonnet.tokensUnavailableReason, null);
    assert.deepEqual(sonnet.byDirection.map((row) => row.direction), ["output", "input"]);

    const titan = view.byModel[1];
    assert.equal(titan.model, "amazon.titan-text-lite-v1");
    assert.equal(titan.tokens, 1_000_000);
    // $0.80 for 1M tokens = $0.0008 per 1K = 800 micro-units.
    assert.equal(titan.costPer1kTokensMicros, "800");

    // Direction rollup across models: input 6.00 + 0.80, output 7.50.
    const byDirection = new Map(view.byDirection.map((row) => [row.direction, row.spendMicros]));
    assert.equal(byDirection.get("input"), "6800000");
    assert.equal(byDirection.get("output"), "7500000");
    assert.deepEqual(view.topModels, view.byModel);
  });

  it("discloses tokens as unavailable rather than guessing a token count", () => {
    const view = buildAiCostView([
      // Spend with a model but NO metered quantity at all.
      line({ amountMicros: "5000000", usageType: "USE1-InputTokenCount-anthropic.claude-3-haiku-v1:0" }),
      // Spend with a quantity but an unrecognised unit — must not be read as tokens.
      line({
        amountMicros: "3000000",
        usageType: "USE1-InputTokenCount-anthropic.claude-3-haiku-v1:0",
        usageAmountMicros: tokens(700),
        usageUnit: "Requests",
      }),
    ]);

    assert.equal(view.available, true);
    // Spend is exact even though tokens are unknown.
    assert.equal(view.spendMicros, "8000000");
    assert.equal(view.tokensMicros, null);
    assert.equal(view.tokens, null);
    assert.equal(view.tokenLineCount, 0);
    const model = view.byModel[0];
    assert.equal(model.tokensDerivable, false);
    assert.equal(model.tokensMicros, null);
    // Critically: no rate is emitted from a guessed denominator.
    assert.equal(model.costPer1kTokensMicros, null);
    assert.equal(model.costPer1kTokensUnits, null);
    assert.match(model.tokensUnavailableReason ?? "", /no line for this model carried a measured token quantity/iu);
  });

  it("withholds cost per 1K tokens when token coverage is only partial", () => {
    const view = buildAiCostView([
      line({
        amountMicros: "4000000",
        usageType: "USE1-InputTokenCount-anthropic.claude-3-haiku-v1:0",
        usageAmountMicros: tokens(1000),
        usageUnit: "tokens",
      }),
      // Same model, same direction, no metered quantity.
      line({ amountMicros: "4000000", usageType: "USE1-InputTokenCount-anthropic.claude-3-haiku-v1:0" }),
    ]);
    const model = view.byModel[0];
    assert.equal(model.lineCount, 2);
    assert.equal(model.tokenLineCount, 1);
    assert.equal(model.tokensDerivable, false);
    assert.equal(model.tokensMicros, null);
    assert.equal(model.costPer1kTokensMicros, null);
    assert.match(model.tokensUnavailableReason ?? "", /withheld/iu);
  });

  it("reports spend but no model split when the billing file has no usage-type column", () => {
    const view = buildAiCostView([
      line({ amountMicros: "12000000" }),
      line({ amountMicros: "3000000" }),
    ]);
    assert.equal(view.available, false);
    assert.equal(view.usageTypePresent, false);
    assert.match(view.unavailableReason ?? "", /no usage-type column/iu);
    // The exact spend survives; only the attribution is unavailable.
    assert.equal(view.spendMicros, "15000000");
    assert.deepEqual(view.byModel, []);
    assert.equal(view.tokensMicros, null);
  });

  it("buckets token spend whose usage type names no model as unattributed", () => {
    const view = buildAiCostView([
      line({ amountMicros: "2000000", usageType: "USE1-InputTokenCount", usageAmountMicros: tokens(400), usageUnit: "1K tokens" }),
    ]);
    assert.equal(view.byModel.length, 1);
    assert.equal(view.byModel[0].model, UNATTRIBUTED_MODEL);
    assert.equal(view.byModel[0].modelIdentified, false);
    // Tokens were still measured for this line, so they are reported.
    assert.equal(view.byModel[0].tokens, 400_000);
  });

  it("is honestly empty with no Bedrock lines", () => {
    const view = buildAiCostView([line({ service: "AmazonEC2", amountMicros: "50000000" })]);
    assert.equal(view.available, false);
    assert.equal(view.spendMicros, "0");
    assert.match(view.unavailableReason ?? "", /no amazon bedrock billing lines/iu);
  });

  it("never sums currencies: only the dominant currency is aggregated", () => {
    const view = buildAiCostView([
      line({ amountMicros: "10000000", currency: "USD", usageType: "USE1-InputTokenCount-anthropic.claude-3-sonnet-v1:0" }),
      line({ amountMicros: "40000000", currency: "EUR", usageType: "EUC1-InputTokenCount-anthropic.claude-3-sonnet-v1:0" }),
      line({ amountMicros: "5000000", currency: "EUR", usageType: "EUC1-OutputTokenCount-anthropic.claude-3-sonnet-v1:0" }),
    ]);
    assert.equal(view.currency, "EUR");
    assert.deepEqual(view.currenciesPresent, ["EUR", "USD"]);
    // 40 + 5 EUR only — the 10 USD line is excluded, never converted or added.
    assert.equal(view.spendMicros, "45000000");
    assert.equal(view.lineCount, 2);
  });

  it("keeps money exact at bigint magnitudes no float could hold", () => {
    const huge = "9007199254740993000000"; // > Number.MAX_SAFE_INTEGER micro-units
    const view = buildAiCostView([
      line({ amountMicros: huge, usageType: "USE1-InputTokenCount-anthropic.claude-3-sonnet-v1:0" }),
      line({ amountMicros: "1", usageType: "USE1-InputTokenCount-anthropic.claude-3-sonnet-v1:0" }),
    ]);
    assert.equal(view.spendMicros, "9007199254740993000001");
    assert.equal(view.byModel[0].spendMicros, "9007199254740993000001");
  });

  it("trends spend per billing month, ascending", () => {
    const view = buildAiCostView([
      line({ amountMicros: "3000000", usageStartIso: "2026-06-14T00:00:00.000Z", usageType: "USE1-InputTokenCount-m", usageAmountMicros: tokens(100), usageUnit: "tokens" }),
      line({ amountMicros: "4000000", usageStartIso: "2026-07-02T00:00:00.000Z", usageType: "USE1-InputTokenCount-m", usageAmountMicros: tokens(200), usageUnit: "tokens" }),
      line({ amountMicros: "1000000", usageStartIso: "2026-07-20T00:00:00.000Z", usageType: "USE1-InputTokenCount-m", usageAmountMicros: tokens(50), usageUnit: "tokens" }),
    ]);
    assert.deepEqual(view.trend.map((point) => point.period), ["2026-06", "2026-07"]);
    assert.equal(view.trend[1].spendMicros, "5000000");
    assert.equal(view.trend[1].tokens, 250);
  });

  it("is deterministic: the same input yields a byte-identical view", () => {
    const lines = [
      line({ amountMicros: "5000000", usageType: "USE1-InputTokenCount-a.model-v1", usageAmountMicros: tokens(10), usageUnit: "tokens" }),
      line({ amountMicros: "5000000", usageType: "USE1-OutputTokenCount-b.model-v1", usageAmountMicros: tokens(10), usageUnit: "tokens" }),
      line({ amountMicros: "5000000", usageType: "USE1-InputTokenCount-b.model-v1", usageAmountMicros: tokens(10), usageUnit: "tokens" }),
    ];
    assert.equal(JSON.stringify(buildAiCostView(lines)), JSON.stringify(buildAiCostView(lines)));
    // Equal spend must tie-break on the model name, not on input order.
    assert.deepEqual(buildAiCostView(lines).byModel.map((row) => row.model), ["b.model-v1", "a.model-v1"]);
  });

  it("works end-to-end from a real CUR CSV carrying Bedrock token line items", () => {
    const parsed = parseCurCsv([
      "line_item_id,line_item_usage_account_id,product_servicecode,line_item_line_item_type,line_item_usage_start_date,line_item_unblended_cost,line_item_currency_code,line_item_usage_type,line_item_usage_amount,pricing_unit",
      "li-1,111111111111,AmazonBedrock,Usage,2026-07-01T00:00:00Z,6.00,USD,USE1-InputTokenCount-anthropic.claude-3-sonnet-v1:0,2000,1K tokens",
      "li-2,111111111111,AmazonBedrock,Usage,2026-07-01T00:00:00Z,7.50,USD,USE1-OutputTokenCount-anthropic.claude-3-sonnet-v1:0,500,1K tokens",
      "li-3,111111111111,AmazonEC2,Usage,2026-07-01T00:00:00Z,20.00,USD,USE1-BoxUsage:m5.large,24,Hrs",
    ].join("\n"));
    if ("error" in parsed) throw new Error(parsed.error);
    assert.equal(parsed.lines[0].usageType, "USE1-InputTokenCount-anthropic.claude-3-sonnet-v1:0");
    assert.equal(parsed.lines[0].usageAmountMicros, "2000000000");
    assert.equal(parsed.lines[0].usageUnit, "1K tokens");
    const view = buildAiCostView(parsed.lines);
    assert.equal(view.available, true);
    assert.equal(view.spendMicros, "13500000");
    assert.equal(view.byModel[0].tokens, 2_500_000);
    assert.equal(view.byModel[0].costPer1kTokensMicros, "5400");
  });
});

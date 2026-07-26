import assert from "node:assert/strict";
import test from "node:test";
import {
  EXTERNAL_COST_MAX_ROWS,
  parseExternalCostCsv,
  parseExternalCostIngestBody,
  parseExternalCostJson,
  parseExternalCostRequest,
  summarizeExternalCosts,
  validateExternalCostMapping,
  type ExternalCostMapping,
} from "../lib/finops-external-cost.ts";

const CONNECTION = `conn_${"a".repeat(32)}`;

const MAPPING_SUBSET: ExternalCostMapping = { period: "Month", amount: "Total", currency: "Cur", source: "Bill" };

const MAPPING: ExternalCostMapping = {
  period: "Month",
  amount: "Total",
  currency: "Cur",
  source: "Bill",
  customerId: "Client",
  category: "Kind",
  vendor: "Supplier",
  tags: "Labels",
};

function ok<T extends object>(result: T | { readonly error: string }): T {
  assert.ok(!("error" in result), `unexpected whole-file rejection: ${(result as { error?: string }).error}`);
  return result as T;
}

/* -------------------------------------------------------------------------- */
/* Mapping is explicit, never guessed                                          */
/* -------------------------------------------------------------------------- */

test("the operator's column mapping is applied verbatim, not guessed from header names", () => {
  // Note the decoys: a column literally called "amount" that is NOT the amount,
  // and a "period" column that is not the period. Only the mapping is honoured.
  const csv = [
    "Month,Total,Cur,Bill,amount,period",
    "2026-07,1200.50,usd,Microsoft 365,999999,1999-01",
  ].join("\n");
  const result = ok(parseExternalCostCsv(csv, { period: "Month", amount: "Total", currency: "Cur", source: "Bill" }));
  assert.equal(result.rejected.length, 0);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].amountMicros, "1200500000");
  assert.equal(result.records[0].period, "2026-07");
  assert.equal(result.records[0].currency, "USD");
  assert.equal(result.records[0].source, "Microsoft 365");
});

test("a mapped column missing from the header rejects the WHOLE file and names the column", () => {
  const csv = "Month,Amount\n2026-07,10.00";
  const result = parseExternalCostCsv(csv, { period: "Month", amount: "Total" }, { defaultCurrency: "USD", defaultSource: "Support" });
  assert.ok("error" in result);
  assert.match(result.error, /Total/u);
  assert.match(result.error, /not guessed/u);
});

test("the mapping must name period and amount, and rejects unknown mapping fields", () => {
  assert.ok("error" in validateExternalCostMapping({ amount: "Total" }, { defaultCurrency: "USD", defaultSource: "x" }));
  const unknown = validateExternalCostMapping({ period: "M", amount: "T", nope: "x" }, { defaultCurrency: "USD", defaultSource: "x" });
  assert.ok("error" in unknown);
  assert.match(unknown.error, /"nope"/u);
});

test("a currency and a source are required — neither is ever assumed", () => {
  const noCurrency = validateExternalCostMapping({ period: "M", amount: "T" }, { defaultSource: "Support" });
  assert.ok("error" in noCurrency);
  assert.match(noCurrency.error, /currency is never assumed/u);
  const noSource = validateExternalCostMapping({ period: "M", amount: "T" }, { defaultCurrency: "USD" });
  assert.ok("error" in noSource);
  assert.match(noSource.error, /source/u);
});

test("a whole-file currency/source assertion covers rows with no such column", () => {
  const csv = "Month,Total\n2026-06,49.99\n2026-06,10";
  const result = ok(parseExternalCostCsv(csv, { period: "Month", amount: "Total" }, { defaultCurrency: "eur", defaultSource: "Datadog" }));
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.currencies, ["EUR"]);
  assert.deepEqual(result.sources, ["Datadog"]);
});

/* -------------------------------------------------------------------------- */
/* Malformed rows are disclosed with row numbers                               */
/* -------------------------------------------------------------------------- */

test("malformed rows are rejected AND disclosed with their row number and reason", () => {
  const csv = [
    "Month,Total,Cur,Bill",          // header (row 0)
    "2026-07,100.00,USD,Licences",   // row 1 ok
    "2026-13,100.00,USD,Licences",   // row 2 bad period
    "2026-07,1.2e3,USD,Licences",    // row 3 bad amount (no float coercion)
    "2026-07,100.00,DOLLARS,Licences", // row 4 bad currency
    "2026-07,100.00,USD,",           // row 5 missing source
    "2026-07,-25.5,USD,Credit note", // row 6 ok, negative is legitimate
  ].join("\n");
  const result = ok(parseExternalCostCsv(csv, MAPPING_SUBSET));
  assert.equal(result.totalRows, 6);
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.rejected.map((row) => row.rowNumber), [2, 3, 4, 5]);
  assert.match(result.rejected[0].reason, /period '2026-13'/u);
  assert.match(result.rejected[1].reason, /amount '1\.2e3' is not a decimal number/u);
  assert.match(result.rejected[2].reason, /currency/u);
  assert.match(result.rejected[3].reason, /source/u);
  // Nothing was repaired: the rejected amounts contribute to no total.
  assert.equal(result.totals.length, 2);
  assert.equal(result.records[1].amountMicros, "-25500000");
});


test("unparseable tags reject the row rather than dropping the tags silently", () => {
  const csv = "Month,Total,Cur,Bill,Labels\n2026-07,1,USD,SaaS,\"not tags at all\"";
  const result = ok(parseExternalCostCsv(csv, { ...MAPPING_SUBSET, tags: "Labels" }));
  assert.equal(result.records.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /tags/u);
});

test("tags parse from a JSON object or from key=value pairs", () => {
  const csv = [
    "Month,Total,Cur,Bill,Labels",
    '2026-07,1,USD,SaaS,"{""team"":""ops""}"',
    '2026-07,2,USD,SaaS,"team=ops;env=prod"',
  ].join("\n");
  const result = ok(parseExternalCostCsv(csv, { ...MAPPING_SUBSET, tags: "Labels" }));
  assert.equal(result.rejected.length, 0);
  assert.deepEqual(result.records[0].tags, { team: "ops" });
  assert.deepEqual(result.records[1].tags, { team: "ops", env: "prod" });
});

/* -------------------------------------------------------------------------- */
/* Row cap rejects the whole file                                              */
/* -------------------------------------------------------------------------- */

test("a file over the row cap is rejected WHOLE, never truncated", () => {
  const rows = ["Month,Total"];
  for (let index = 0; index < EXTERNAL_COST_MAX_ROWS + 1; index += 1) rows.push("2026-07,1.00");
  const result = parseExternalCostCsv(rows.join("\n"), { period: "Month", amount: "Total" }, { defaultCurrency: "USD", defaultSource: "SaaS" });
  assert.ok("error" in result, "the oversized file must be rejected whole");
  assert.match(result.error, new RegExp(String(EXTERNAL_COST_MAX_ROWS), "u"));
  assert.match(result.error, /nothing was ingested/u);
});

test("a JSON payload over the row cap is rejected whole too", () => {
  const records = Array.from({ length: EXTERNAL_COST_MAX_ROWS + 1 }, () => ({ Month: "2026-07", Total: "1.00" }));
  const result = parseExternalCostJson(records, { period: "Month", amount: "Total" }, { defaultCurrency: "USD", defaultSource: "SaaS" });
  assert.ok("error" in result);
});

/* -------------------------------------------------------------------------- */
/* Money and currencies                                                        */
/* -------------------------------------------------------------------------- */

test("money is bigint micro-units, exact past float precision", () => {
  const csv = "Month,Total,Cur,Bill\n2026-07,0.07,USD,SaaS\n2026-07,0.01,USD,SaaS\n2026-07,9007199254.740993,USD,SaaS";
  const result = ok(parseExternalCostCsv(csv, MAPPING_SUBSET));
  assert.equal(result.records[0].amountMicros, "70000");
  assert.equal(result.records[1].amountMicros, "10000");
  // Beyond 2^53 micro-units: the string never became a JS number.
  assert.equal(result.records[2].amountMicros, "9007199254740993");
  const total = result.totals[0];
  assert.equal(total.amountMicros, (BigInt(70000) + BigInt(10000) + BigInt("9007199254740993")).toString());
  // 0.07 + 0.01 in floats is 0.08000000000000002; in micros it is exact.
  assert.equal((BigInt(result.records[0].amountMicros) + BigInt(result.records[1].amountMicros)).toString(), "80000");
});

test("currencies are separated and never summed together", () => {
  const csv = [
    "Month,Total,Cur,Bill",
    "2026-07,100,USD,Support",
    "2026-07,100,EUR,Support",
    "2026-07,50,EUR,Support",
  ].join("\n");
  const result = ok(parseExternalCostCsv(csv, MAPPING_SUBSET));
  assert.deepEqual(result.currencies, ["EUR", "USD"]);
  const totals = result.totals;
  assert.equal(totals.length, 2);
  const eur = totals.find((total) => total.currency === "EUR");
  const usd = totals.find((total) => total.currency === "USD");
  assert.equal(eur?.amountMicros, "150000000");
  assert.equal(usd?.amountMicros, "100000000");
  // No combined bucket exists at all.
  assert.equal(totals.filter((total) => total.currency === "").length, 0);
});

test("summaries split by (source, period, currency) and are deterministic", () => {
  const csv = [
    "Month,Total,Cur,Bill",
    "2026-07,10,USD,Zoom",
    "2026-06,10,USD,Zoom",
    "2026-07,10,USD,Slack",
  ].join("\n");
  const first = ok(parseExternalCostCsv(csv, MAPPING_SUBSET));
  const second = ok(parseExternalCostCsv(csv, MAPPING_SUBSET));
  assert.deepEqual(first.totals, second.totals);
  assert.deepEqual(first.records, second.records);
  assert.deepEqual(
    first.totals.map((total) => `${total.period}/${total.source}`),
    ["2026-07/Slack", "2026-07/Zoom", "2026-06/Zoom"],
  );
  assert.deepEqual(summarizeExternalCosts(first.records), first.totals);
});

test("every result carries the operator-asserted disclaimer", () => {
  const result = ok(parseExternalCostCsv("Month,Total,Cur,Bill\n2026-07,1,USD,SaaS", MAPPING_SUBSET));
  assert.match(result.disclaimer, /OPERATOR-ASSERTED/u);
  assert.match(result.disclaimer, /not reconciled invoices/u);
});

/* -------------------------------------------------------------------------- */
/* JSON records                                                                */
/* -------------------------------------------------------------------------- */

test("JSON records use the same mapping, and numeric cells stay exact", () => {
  const result = ok(parseExternalCostJson(
    {
      records: [
        { Month: "2026-07", Total: 1200.5, Cur: "usd", Bill: "Licences", Client: "cust-a", Kind: "licence", Supplier: "Acme", Labels: { team: "ops" } },
        { Month: "2026-07-15", Total: "10", Cur: "USD", Bill: "Licences" },
        { Month: "2026-07", Total: { nested: true }, Cur: "USD", Bill: "Licences" },
      ],
    },
    MAPPING,
  ));
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].amountMicros, "1200500000");
  assert.equal(result.records[0].attributedCustomer, "cust-a");
  assert.equal(result.records[0].category, "licence");
  assert.equal(result.records[0].vendor, "Acme");
  assert.deepEqual(result.records[0].tags, { team: "ops" });
  // A YYYY-MM-DD period is taken to its month; nothing else is inferred.
  assert.equal(result.records[1].period, "2026-07");
  assert.deepEqual(result.rejected.map((row) => row.rowNumber), [3]);
  assert.match(result.rejected[0].reason, /Total/u);
});

/* -------------------------------------------------------------------------- */
/* Ingest body: no tenant may be proposed                                      */
/* -------------------------------------------------------------------------- */

function body(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    connectionId: CONNECTION,
    format: "csv",
    csv: "Month,Total\n2026-07,1",
    mapping: { period: "Month", amount: "Total" },
    defaultCurrency: "USD",
    defaultSource: "SaaS",
    ...extra,
  };
}

test("a body-supplied orgId is REJECTED, not ignored", () => {
  assert.throws(() => parseExternalCostIngestBody(body({ orgId: "org_other" })), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /"orgId" is not accepted/u);
    assert.match(error.message, /resolved from your session/u);
    assert.equal((error as { code?: string }).code, "INVALID_INPUT");
    return true;
  });
});

test("a body-supplied customerId (or any tenant alias) is REJECTED", () => {
  for (const key of ["customerId", "customer_id", "org_id", "tenant", "tenantId", "subject"]) {
    assert.throws(() => parseExternalCostIngestBody(body({ [key]: "someone-else" })), new RegExp(`"${key}" is not accepted`, "u"), key);
  }
});

test("any unrecognized body field is rejected rather than silently dropped", () => {
  assert.throws(() => parseExternalCostIngestBody(body({ extra: 1 })), /"extra" is not accepted/u);
});

test("a valid body parses, and the request round-trips through the parser", () => {
  const parsedBody = parseExternalCostIngestBody(body({}));
  assert.equal(parsedBody.connectionId, CONNECTION);
  const parsed = ok(parseExternalCostRequest(parsedBody));
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].source, "SaaS");
  assert.equal(parsed.records[0].currency, "USD");
});

test("the body must name a real connection and a supported format", () => {
  assert.throws(() => parseExternalCostIngestBody(body({ connectionId: "conn_nope" })), /connection identifier/u);
  assert.throws(() => parseExternalCostIngestBody(body({ format: "xlsx" })), /must be "csv" or "json"/u);
});

/* -------------------------------------------------------------------------- */
/* Re-upload replaces rather than duplicates                                   */
/* -------------------------------------------------------------------------- */

test("a re-upload of the same (source, period) yields the same total, not double", () => {
  // The engine is deterministic per file, and the store replaces the pair the
  // file names — so ingesting the same file twice cannot double a total. This
  // asserts the invariant the repository's replaceSourcePeriod relies on: the
  // records of one upload all belong to exactly the (source, period) pairs the
  // upload declares, and re-parsing produces an identical set.
  const csv = "Month,Total,Cur,Bill\n2026-07,100,USD,Zoom\n2026-07,50,USD,Zoom";
  const first = ok(parseExternalCostCsv(csv, MAPPING_SUBSET));
  const second = ok(parseExternalCostCsv(csv, MAPPING_SUBSET));
  assert.deepEqual(first.totals, second.totals);
  assert.equal(first.totals[0].amountMicros, "150000000");
  // Replace semantics: the surviving state after two uploads is ONE upload's
  // worth of records for that pair, never the concatenation of both.
  const replaced = second.records;
  const concatenated = [...first.records, ...second.records];
  assert.equal(summarizeExternalCosts(replaced)[0].amountMicros, "150000000");
  assert.equal(summarizeExternalCosts(concatenated)[0].amountMicros, "300000000");
  // Each record is tagged with the exact pair the store deletes before insert.
  for (const record of replaced) {
    assert.equal(record.source, "Zoom");
    assert.equal(record.period, "2026-07");
  }
});

test("one upload covering several sources/periods is grouped into separate replace pairs", () => {
  const csv = [
    "Month,Total,Cur,Bill",
    "2026-07,10,USD,Zoom",
    "2026-07,10,USD,Slack",
    "2026-06,10,USD,Zoom",
  ].join("\n");
  const result = ok(parseExternalCostCsv(csv, MAPPING_SUBSET));
  const pairs = new Set(result.records.map((record) => `${record.source}|${record.period}`));
  assert.deepEqual([...pairs].sort(), ["Slack|2026-07", "Zoom|2026-06", "Zoom|2026-07"]);
});

/* -------------------------------------------------------------------------- */
/* Margin integration is additive and broken out                               */
/* -------------------------------------------------------------------------- */

test("external cost enters margin as a broken-out component and is opt-in", async () => {
  const { applyMargin } = await import("../lib/finops-margin.ts");
  const cloudOnly = applyMargin([{ customerId: "acme", currency: "USD", costMicros: "100000000" }], []);
  assert.equal(cloudOnly.includesExternalCosts, false);
  assert.equal(cloudOnly.rows[0].externalCostMicros, "0");
  assert.equal(cloudOnly.rows[0].cloudCostMicros, "100000000");
  assert.equal(cloudOnly.rows[0].costMicros, "100000000");

  const withExternal = applyMargin(
    [{ customerId: "acme", currency: "USD", costMicros: "100000000" }],
    [{ customerId: "acme", markupPercent: 10, monthlyFeeMicros: "0", currency: "USD" }],
    [{ customerId: "acme", currency: "USD", costMicros: "40000000" }],
  );
  assert.equal(withExternal.includesExternalCosts, true);
  const row = withExternal.rows[0];
  assert.equal(row.cloudCostMicros, "100000000");
  assert.equal(row.externalCostMicros, "40000000");
  assert.equal(row.costMicros, "140000000");
  assert.equal(row.billedMicros, "154000000");
  assert.equal(withExternal.totalsByCurrency[0].totalExternalCostMicros, "40000000");
  assert.equal(withExternal.totalsByCurrency[0].totalCloudCostMicros, "100000000");
});

test("external cost never crosses currencies, and external-only spend is still listed", async () => {
  const { applyMargin } = await import("../lib/finops-margin.ts");
  const result = applyMargin(
    [{ customerId: "acme", currency: "USD", costMicros: "100000000" }],
    [],
    [
      { customerId: "acme", currency: "EUR", costMicros: "20000000" },
      { customerId: "beta", currency: "USD", costMicros: "5000000" },
    ],
  );
  const usdAcme = result.rows.find((row) => row.customerId === "acme" && row.currency === "USD");
  const eurAcme = result.rows.find((row) => row.customerId === "acme" && row.currency === "EUR");
  const usdBeta = result.rows.find((row) => row.customerId === "beta");
  assert.equal(usdAcme?.externalCostMicros, "0", "a EUR external cost must not land on the USD row");
  assert.equal(eurAcme?.externalCostMicros, "20000000");
  assert.equal(eurAcme?.cloudCostMicros, "0");
  // A customer with external spend but no cloud spend is never hidden.
  assert.equal(usdBeta?.costMicros, "5000000");
  assert.equal(usdBeta?.cloudCostMicros, "0");
});

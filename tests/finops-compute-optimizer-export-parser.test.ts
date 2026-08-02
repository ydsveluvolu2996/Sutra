import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ComputeOptimizerExportParserError,
  parseComputeOptimizerExport,
  type ComputeOptimizerExportParserLimits,
} from "../lib/finops-compute-optimizer-export-parser.ts";

const CSV_NAME = "us-east-1-2020-05-18T001229Z-f264881a-bfb3-4676-9b14-8d1243599ebb.csv";
const encoder = new TextEncoder();

type Column = {
  name: string;
  titles: string;
  datatype: string;
  null?: string;
  required: boolean;
  format?: string;
};

const columns: readonly Column[] = [
  { name: "accountId", titles: "Account ID", datatype: "string", null: "", required: false },
  { name: "instanceArn", titles: "Instance Arn", datatype: "string", null: "", required: false },
  { name: "utilizationMetrics_CPU_MAXIMUM", titles: "CPU Maximum", datatype: "double", null: "", required: false },
  { name: "recommendations_count", titles: "Number of recommendations", datatype: "integer", required: true },
  { name: "exactCounter", titles: "Exact counter", datatype: "integer", null: "", required: false },
  { name: "lastRefreshTimestamp_UTC", titles: "Last refreshed", datatype: "datetime", format: "yyyy-MM-dd HH:mm:ss", null: "", required: false },
  { name: "errorCode", titles: "Error Code", datatype: "string", required: true },
  { name: "errorMessage", titles: "Error Message", datatype: "string", required: true },
];

function metadata(
  overrides: Record<string, unknown> = {},
  metadataColumns: readonly Column[] = columns,
): Record<string, unknown> {
  return {
    "@context": ["http://www.w3.org/ns/csvw"],
    url: CSV_NAME,
    "dc:title": "EC2 Instance Recommendations",
    dialect: {
      encoding: "utf-8",
      lineTerminators: ["\n"],
      doubleQuote: true,
      skipRows: 0,
      header: true,
      headerRowCount: 1,
      delimiter: ",",
      skipColumns: 0,
      skipBlankRows: false,
      trim: false,
    },
    "dc:modified": { "@value": "2020-05-20", "@type": "xsd:date" },
    tableSchema: { columns: metadataColumns },
    ...overrides,
  };
}

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function csv(
  rows: readonly (readonly string[])[],
  header: readonly string[] = columns.map((column) => column.name),
): string {
  const cell = (value: string): string =>
    /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\n");
}

function request(
  metadataValue: Record<string, unknown> = metadata(),
  csvValue = csv([[
    "111122223333",
    "arn:aws:ec2:us-east-1:111122223333:instance/i-1",
    "12.500",
    "1",
    "9007199254740993",
    "2020-05-18 00:12:29",
    "",
    "provider, said \"review\"\nnext line",
  ]]),
  limits?: Partial<ComputeOptimizerExportParserLimits>,
) {
  return {
    metadataBytes: bytes(JSON.stringify(metadataValue)),
    csvBytes: bytes(csvValue),
    trustedCsvBasename: CSV_NAME,
    ...(limits === undefined ? {} : { limits }),
  };
}

async function rejects(
  input: Parameters<typeof parseComputeOptimizerExport>[0],
  code: ComputeOptimizerExportParserError["code"],
): Promise<void> {
  await assert.rejects(
    parseComputeOptimizerExport(input),
    (error: unknown) => error instanceof ComputeOptimizerExportParserError && error.code === code,
  );
}

test("parses the AWS CSVW shape, RFC4180 quoting and exact numeric lexemes", async () => {
  const input = request();
  const parsed = await parseComputeOptimizerExport(input);
  assert.equal(parsed.schemaVersion, "sutra.compute-optimizer-csvw-export.v1");
  assert.equal(parsed.csvBasename, CSV_NAME);
  assert.equal(parsed.modifiedDate, "2020-05-20");
  assert.equal(parsed.rowCount, 1);
  assert.equal(parsed.rows[0]?.cells[2]?.decimalLexeme, "12.500");
  assert.equal(parsed.rows[0]?.cells[3]?.integerLexeme, "1");
  assert.equal(
    parsed.rows[0]?.cells[4]?.integerLexeme,
    "9007199254740993",
    "integers beyond Number.MAX_SAFE_INTEGER remain exact strings",
  );
  assert.equal(parsed.rows[0]?.cells[7]?.raw, "provider, said \"review\"\nnext line");
  assert.equal(
    parsed.metadataSha256,
    createHash("sha256").update(input.metadataBytes).digest("hex"),
  );
  assert.equal(
    parsed.objectSha256,
    createHash("sha256").update(input.csvBytes).digest("hex"),
  );
});

test("supports a declared CRLF dialect without treating embedded CRLF as a row", async () => {
  const value = metadata({
    dialect: {
      ...(metadata().dialect as Record<string, unknown>),
      lineTerminators: ["\r\n"],
    },
  });
  const header = columns.map((column) => column.name).join(",");
  const row = [
    "111122223333", "arn:aws:ec2:us-east-1:111122223333:instance/i-1", "1.25", "1", "2",
    "2020-05-18 00:12:29", "", '"first\r\nsecond"',
  ].join(",");
  const parsed = await parseComputeOptimizerExport(request(value, `${header}\r\n${row}`));
  assert.equal(parsed.rows[0]?.cells[7]?.raw, "first\r\nsecond");
});

test("rejects malformed UTF-8 in either metadata or CSV", async () => {
  const invalid = new Uint8Array([0xc3, 0x28]);
  await rejects({ ...request(), metadataBytes: invalid }, "INVALID_UTF8");
  await rejects({ ...request(), csvBytes: invalid }, "INVALID_UTF8");
});

test("rejects a metadata URL that is not the trusted CSV basename", async () => {
  await rejects(request(metadata({ url: "other.csv" })), "URL_MISMATCH");
  await rejects(
    { ...request(), trustedCsvBasename: "../export.csv" },
    "INVALID_INPUT",
  );
});

test("rejects unsupported metadata types, order mismatches and duplicate columns", async () => {
  const unsupported = columns.map((column, index) =>
    index === 2 ? { ...column, datatype: "number" } : column);
  await rejects(request(metadata({}, unsupported)), "INVALID_METADATA");

  const reversedHeader = [...columns.map((column) => column.name)].reverse();
  await rejects(request(metadata(), csv([], reversedHeader)), "SCHEMA_MISMATCH");

  const duplicate = [...columns, { ...columns[0]! }];
  await rejects(request(metadata({}, duplicate)), "INVALID_METADATA");
});

test("rejects missing or malformed AWS default columns", async () => {
  await rejects(
    request(metadata({}, columns.filter((column) => column.name !== "errorMessage"))),
    "SCHEMA_MISMATCH",
  );
  const wrongCount = columns.map((column) =>
    column.name === "recommendations_count" ? { ...column, datatype: "double" } : column);
  await rejects(request(metadata({}, wrongCount)), "SCHEMA_MISMATCH");
});

test("rejects malformed quotes and row width mismatches", async () => {
  const header = columns.map((column) => column.name).join(",");
  await rejects(request(metadata(), `${header}\n"unterminated`), "INVALID_CSV");
  await rejects(request(metadata(), `${header}\na"quote,1,2,3,4,5,6,7`), "INVALID_CSV");
  await rejects(request(metadata(), `${header}\n1,2,3`), "SCHEMA_MISMATCH");
});

test("enforces required/null semantics", async () => {
  const nullableRequired = columns.map((column) =>
    column.name === "recommendations_count" ? { ...column, null: "" } : column);
  await rejects(
    request(metadata({}, nullableRequired), csv([[
      "111122223333", "arn", "1.0", "", "2", "2020-05-18 00:12:29", "", "",
    ]])),
    "INVALID_CELL",
  );
});

test("preserves canonical finite decimals and rejects exponent, NaN and Infinity", async () => {
  for (const invalid of ["1e3", "NaN", "Infinity", "+1", "01.0"]) {
    await rejects(
      request(metadata(), csv([[
        "111122223333", "arn", invalid, "1", "2", "2020-05-18 00:12:29", "", "",
      ]])),
      "INVALID_CELL",
    );
  }
  const tooManyDigits = "9".repeat(129);
  await rejects(
    request(metadata(), csv([[
      "111122223333", "arn", "1.0", "1", tooManyDigits, "2020-05-18 00:12:29", "", "",
    ]])),
    "INVALID_CELL",
  );
});

test("enforces metadata, CSV, row, column and cell caps", async () => {
  const base = request();
  await rejects({ ...base, limits: { maximumMetadataBytes: base.metadataBytes.byteLength - 1 } }, "LIMIT_EXCEEDED");
  await rejects({ ...base, limits: { maximumCsvBytes: base.csvBytes.byteLength - 1 } }, "LIMIT_EXCEEDED");
  await rejects(request(metadata(), csv([
    ["1", "arn", "1", "1", "1", "2020-05-18 00:12:29", "", ""],
    ["2", "arn", "1", "1", "1", "2020-05-18 00:12:29", "", ""],
  ]), { maximumRows: 1 }), "LIMIT_EXCEEDED");
  await rejects(request(metadata(), csv([]), { maximumColumns: columns.length - 1 }), "LIMIT_EXCEEDED");
  await rejects(request(metadata(), csv([[
    "111122223333", "arn-too-long", "1", "1", "1", "2020-05-18 00:12:29", "", "",
  ]]), { maximumCellBytes: 8 }), "LIMIT_EXCEEDED");
});

test("rejects metadata extensions and dialects outside the supported AWS subset", async () => {
  await rejects(request(metadata({ unexpected: true })), "INVALID_METADATA");
  await rejects(request(metadata({
    dialect: { ...(metadata().dialect as Record<string, unknown>), delimiter: ";" },
  })), "UNSUPPORTED_DIALECT");
  await rejects(request(metadata({
    dialect: { ...(metadata().dialect as Record<string, unknown>), trim: true },
  })), "UNSUPPORTED_DIALECT");
});

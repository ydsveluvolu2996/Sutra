import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REPORT_MAX_LIMIT,
  buildReport,
  toCsv,
  validateReportDefinition,
  type ReportColumn,
  type ReportDefinition,
} from "../lib/report-builder.ts";
import type { CmdbQueryResource } from "../lib/cmdb-query.ts";

function resource(overrides: Partial<CmdbQueryResource>): CmdbQueryResource {
  return {
    resourceKey: "aws.ec2.instance/i-1",
    service: "ec2",
    resourceType: "aws.ec2.instance",
    regionKey: "us-east-1",
    name: "api-gateway",
    state: "running",
    arn: "arn:aws:ec2:us-east-1:1:instance/i-1",
    nativeId: "i-1",
    tags: { env: "prod" },
    configuration: { encrypted: false },
    ...overrides,
  };
}

const FLEET: readonly CmdbQueryResource[] = [
  resource({}),
  resource({ resourceKey: "aws.s3.bucket/b-1", service: "s3", resourceType: "aws.s3.bucket", nativeId: "b-1", name: null, state: null }),
  resource({ resourceKey: "aws.ec2.instance/i-2", nativeId: "i-2", name: "batch-runner", regionKey: "eu-west-1" }),
];

interface FindingRecord {
  readonly fingerprint: string;
  readonly resourceKey: string | null;
  readonly controlKey: string;
  readonly controlVersion: string;
  readonly severity: string;
  readonly status: string;
  readonly title: string;
  readonly summary: string;
  readonly remediation: string;
  readonly evaluatedAt: string;
}

function finding(overrides: Partial<FindingRecord>): Record<string, unknown> {
  return {
    fingerprint: "fp-1",
    resourceKey: "aws.s3.bucket/b-1",
    controlKey: "S3.1",
    controlVersion: "1",
    severity: "critical",
    status: "open",
    title: "Public S3 bucket",
    summary: "The bucket allows public access.",
    remediation: "Block public access.",
    evaluatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("toCsv (RFC-4180)", () => {
  const columns: readonly ReportColumn[] = [{ key: "name", label: "Name" }, { key: "note", label: "Note" }];

  it("quotes fields with commas, doubles interior quotes, quotes CR/LF, and uses a label header with CRLF rows", () => {
    const rows = [
      { name: "simple", note: "plain" },
      { name: "has,comma", note: 'has"quote' },
      { name: "line1\nline2", note: "cr\rreturn" },
      { name: "crlf\r\nhere", note: "" },
    ];
    const csv = toCsv(columns, rows);
    const expected = [
      "Name,Note",
      "simple,plain",
      '"has,comma","has""quote"',
      '"line1\nline2","cr\rreturn"',
      '"crlf\r\nhere",',
    ].join("\r\n");
    assert.equal(csv, expected);
  });

  it("renders a missing cell key as an empty field, never a fabricated value", () => {
    const csv = toCsv(columns, [{ name: "only-name" }]);
    assert.equal(csv, "Name,Note\r\nonly-name,");
  });

  it("escapes a value that is a lone double quote", () => {
    const csv = toCsv([{ key: "a", label: "A" }], [{ a: '"' }]);
    assert.equal(csv, 'A\r\n""""');
  });
});

describe("buildReport — cmdb-resources dataset (reuses runCmdbQuery)", () => {
  it("filters via the CMDB engine and projects the selected columns in catalog order", () => {
    const definition: ReportDefinition = {
      dataset: "cmdb-resources",
      filters: { combine: "and", predicates: [{ kind: "field", field: "service", op: "eq", value: "ec2" }] },
      columns: ["regionKey", "resourceKey", "service"],
    };
    const report = buildReport(definition, FLEET);
    assert.equal(report.dataset, "cmdb-resources");
    // Columns keep the caller's requested order.
    assert.deepEqual(report.columns.map((column) => column.key), ["regionKey", "resourceKey", "service"]);
    assert.equal(report.rowCount, 2);
    assert.equal(report.truncated, false);
    assert.deepEqual(report.rows.map((row) => row.resourceKey), ["aws.ec2.instance/i-1", "aws.ec2.instance/i-2"]);
    assert.match(report.disclaimer, /2 rows matched/u);
  });

  it("renders a null source field (name) as an empty cell", () => {
    const definition: ReportDefinition = {
      dataset: "cmdb-resources",
      filters: { combine: "and", predicates: [{ kind: "field", field: "service", op: "eq", value: "s3" }] },
      columns: ["resourceKey", "name", "state"],
    };
    const report = buildReport(definition, FLEET);
    assert.equal(report.rowCount, 1);
    assert.equal(report.rows[0].name, "");
    assert.equal(report.rows[0].state, "");
    assert.equal(report.rows[0].resourceKey, "aws.s3.bucket/b-1");
  });

  it("defaults to every catalog column when none are selected", () => {
    const definition: ReportDefinition = {
      dataset: "cmdb-resources",
      filters: { combine: "or", predicates: [{ kind: "field", field: "resourceKey", op: "prefix", value: "" }] },
      columns: [],
    };
    const report = buildReport(definition, FLEET);
    assert.equal(report.columns.length, 8);
    assert.equal(report.rowCount, 3);
  });
});

describe("buildReport — findings dataset (field filters, sort, limit)", () => {
  const findings = [
    finding({ fingerprint: "fp-1", severity: "critical", title: "Public S3 bucket" }),
    finding({ fingerprint: "fp-2", severity: "low", status: "acknowledged", resourceKey: null, title: "Weak TLS policy" }),
    finding({ fingerprint: "fp-3", severity: "high", title: "Open security group" }),
  ];

  it("applies case-insensitive field filters combined with AND", () => {
    const definition: ReportDefinition = {
      dataset: "findings",
      filters: [{ field: "title", op: "contains", value: "public" }],
      columns: ["fingerprint", "severity", "title"],
    };
    const report = buildReport(definition, findings);
    assert.equal(report.rowCount, 1);
    assert.equal(report.rows[0].fingerprint, "fp-1");
    assert.equal(report.rows[0].title, "Public S3 bucket");
  });

  it("renders a null finding field as an empty cell", () => {
    const definition: ReportDefinition = {
      dataset: "findings",
      filters: [{ field: "severity", op: "eq", value: "low" }],
      columns: ["fingerprint", "resourceKey"],
    };
    const report = buildReport(definition, findings);
    assert.equal(report.rowCount, 1);
    assert.equal(report.rows[0].resourceKey, "");
  });

  it("sorts by a field, ascending and descending, deterministically", () => {
    const base: Omit<ReportDefinition & { dataset: "findings" }, "sort"> = {
      dataset: "findings",
      filters: [],
      columns: ["fingerprint", "severity"],
    };
    const ascending = buildReport({ ...base, sort: { field: "severity", direction: "asc" } }, findings);
    assert.deepEqual(ascending.rows.map((row) => row.severity), ["critical", "high", "low"]);
    const descending = buildReport({ ...base, sort: { field: "severity", direction: "desc" } }, findings);
    assert.deepEqual(descending.rows.map((row) => row.severity), ["low", "high", "critical"]);
  });
});

describe("buildReport — honesty (truncation and empty)", () => {
  it("discloses truncation when the limit hides matching rows", () => {
    const many = Array.from({ length: 5 }, (_, index) => finding({ fingerprint: `fp-${index}`, severity: "low" }));
    const definition: ReportDefinition = { dataset: "findings", filters: [], columns: ["fingerprint"], limit: 2 };
    const report = buildReport(definition, many);
    assert.equal(report.rowCount, 2);
    assert.equal(report.truncated, true);
    assert.match(report.disclaimer, /Showing the first 2 of 5 matching rows \(limit 2\)/u);
  });

  it("discloses an empty dataset distinctly from a no-match filter", () => {
    const emptyDataset = buildReport({ dataset: "findings", filters: [], columns: ["fingerprint"] }, []);
    assert.equal(emptyDataset.rowCount, 0);
    assert.equal(emptyDataset.truncated, false);
    assert.match(emptyDataset.disclaimer, /dataset is empty/u);

    const noMatch = buildReport(
      { dataset: "findings", filters: [{ field: "severity", op: "eq", value: "critical" }], columns: ["fingerprint"] },
      [finding({ severity: "low" })],
    );
    assert.equal(noMatch.rowCount, 0);
    assert.match(noMatch.disclaimer, /No rows matched/u);
  });
});

describe("validateReportDefinition", () => {
  it("accepts a well-formed cmdb definition", () => {
    const { definition, errors } = validateReportDefinition({
      dataset: "cmdb-resources",
      filters: { combine: "and", predicates: [{ kind: "field", field: "service", op: "eq", value: "ec2" }] },
      columns: ["service"],
      sort: { field: "service", direction: "asc" },
      limit: 50,
    });
    assert.deepEqual(errors, []);
    assert.equal(definition?.dataset, "cmdb-resources");
    assert.equal(definition?.limit, 50);
  });

  it("accepts a well-formed findings definition with empty filters", () => {
    const { definition, errors } = validateReportDefinition({ dataset: "findings", filters: [], columns: ["severity", "title"] });
    assert.deepEqual(errors, []);
    assert.equal(definition?.dataset, "findings");
  });

  it("rejects an unknown dataset, unknown columns, bad ops, and out-of-range limits", () => {
    assert.match(String(validateReportDefinition({ dataset: "widgets" }).errors[0]), /dataset must be/u);
    assert.ok(validateReportDefinition({ dataset: "findings", filters: [], columns: ["password"] }).errors.some((error) => /not a column/u.test(error)));
    assert.ok(validateReportDefinition({ dataset: "findings", filters: [{ field: "severity", op: "regex", value: "x" }], columns: ["severity"] }).errors.some((error) => /not a valid filter operator/u.test(error)));
    assert.ok(validateReportDefinition({ dataset: "findings", filters: [], columns: ["severity"], limit: REPORT_MAX_LIMIT + 1 }).errors.some((error) => /limit must be/u.test(error)));
    // A cmdb definition with no predicates is rejected by the reused CMDB validator.
    assert.ok(validateReportDefinition({ dataset: "cmdb-resources", filters: { combine: "and", predicates: [] }, columns: ["service"] }).errors.some((error) => /predicates/u.test(error)));
  });
});

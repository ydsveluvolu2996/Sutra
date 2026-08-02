/**
 * Pure parser for AWS Compute Optimizer recommendation export objects.
 *
 * This is deliberately not a materializer. It validates the AWS CSVW metadata
 * and its paired CSV object, preserves provider numeric lexemes exactly, and
 * returns hash-addressed rows for a later resource-specific mapper. It performs
 * no network, persistence, tenant binding, or live-snapshot work.
 */

const UTF8 = "utf-8";
const CSVW_CONTEXT = "http://www.w3.org/ns/csvw";
const DEFAULT_COLUMNS = Object.freeze([
  "recommendations_count",
  "errorCode",
  "errorMessage",
] as const);
const SUPPORTED_DATATYPES = new Set(["string", "integer", "double", "datetime"]);
const SUPPORTED_LINE_TERMINATORS = new Set(["\n", "\r\n"]);
const INTEGER = /^-?(?:0|[1-9]\d*)$/u;
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>]+$/u;
const MAX_NUMERIC_DIGITS = 128;

export const COMPUTE_OPTIMIZER_EXPORT_PARSER_BOUNDS = Object.freeze({
  maximumMetadataBytes: 1 * 1_024 * 1_024,
  maximumCsvBytes: 256 * 1_024 * 1_024,
  maximumRows: 100_000,
  maximumColumns: 2_048,
  maximumCellBytes: 1 * 1_024 * 1_024,
} as const);

export interface ComputeOptimizerExportParserLimits {
  readonly maximumMetadataBytes: number;
  readonly maximumCsvBytes: number;
  readonly maximumRows: number;
  readonly maximumColumns: number;
  readonly maximumCellBytes: number;
}

export type ComputeOptimizerCsvwDatatype =
  | "string"
  | "integer"
  | "double"
  | "datetime";

export interface ComputeOptimizerCsvwColumn {
  readonly name: string;
  readonly titles: string;
  readonly datatype: ComputeOptimizerCsvwDatatype;
  readonly nullValue: string | null;
  readonly required: boolean;
  readonly format: string | null;
}

export interface ComputeOptimizerCsvwDialect {
  readonly encoding: "utf-8";
  readonly lineTerminators: readonly ("\n" | "\r\n")[];
  readonly doubleQuote: true;
  readonly skipRows: 0;
  readonly header: true;
  readonly headerRowCount: 1;
  readonly delimiter: ",";
  readonly skipColumns: 0;
  readonly skipBlankRows: false;
  readonly trim: false;
}

export interface ParsedComputeOptimizerExportCell {
  readonly column: string;
  readonly raw: string;
  readonly isNull: boolean;
  /** The original canonical base-10 integer; never converted to Number. */
  readonly integerLexeme: string | null;
  /** The original canonical finite decimal; never converted to Number. */
  readonly decimalLexeme: string | null;
}

export interface ParsedComputeOptimizerExportRow {
  /** One-based provider data-row position, excluding the CSV header. */
  readonly rowNumber: number;
  readonly cells: readonly ParsedComputeOptimizerExportCell[];
}

export interface ParsedComputeOptimizerExport {
  readonly schemaVersion: "sutra.compute-optimizer-csvw-export.v1";
  readonly csvBasename: string;
  readonly title: string;
  readonly modifiedDate: string | null;
  readonly dialect: ComputeOptimizerCsvwDialect;
  readonly columns: readonly ComputeOptimizerCsvwColumn[];
  readonly rows: readonly ParsedComputeOptimizerExportRow[];
  readonly rowCount: number;
  readonly metadataBytes: number;
  readonly csvBytes: number;
  readonly metadataSha256: string;
  readonly objectSha256: string;
}

export class ComputeOptimizerExportParserError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "LIMIT_EXCEEDED"
      | "INVALID_UTF8"
      | "INVALID_METADATA"
      | "UNSUPPORTED_DIALECT"
      | "URL_MISMATCH"
      | "INVALID_CSV"
      | "SCHEMA_MISMATCH"
      | "INVALID_CELL",
  ) {
    super("Compute Optimizer export parsing rejected");
    this.name = "ComputeOptimizerExportParserError";
  }
}

function reject(code: ComputeOptimizerExportParserError["code"]): never {
  throw new ComputeOptimizerExportParserError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && actual.every((key) => allowed.has(key));
}

function boundedText(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && new TextEncoder().encode(value).byteLength <= maximumBytes
    && SAFE_TEXT.test(value);
}

function configuredLimits(
  overrides: Partial<ComputeOptimizerExportParserLimits> | undefined,
): ComputeOptimizerExportParserLimits {
  if (overrides !== undefined && !isRecord(overrides)) reject("INVALID_INPUT");
  const keys = Object.keys(COMPUTE_OPTIMIZER_EXPORT_PARSER_BOUNDS) as
    (keyof ComputeOptimizerExportParserLimits)[];
  if (overrides !== undefined && Object.keys(overrides).some((key) => !keys.includes(
    key as keyof ComputeOptimizerExportParserLimits,
  ))) reject("INVALID_INPUT");
  const result = { ...COMPUTE_OPTIMIZER_EXPORT_PARSER_BOUNDS, ...overrides };
  for (const key of keys) {
    const value = result[key];
    if (
      !Number.isSafeInteger(value)
      || value < 1
      || value > COMPUTE_OPTIMIZER_EXPORT_PARSER_BOUNDS[key]
    ) reject("INVALID_INPUT");
  }
  return result;
}

function decode(bytes: Uint8Array, maximumBytes: number): string {
  if (!(bytes instanceof Uint8Array)) reject("INVALID_INPUT");
  if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
    reject("LIMIT_EXCEEDED");
  }
  try {
    const decoded = new TextDecoder(UTF8, { fatal: true }).decode(bytes);
    return decoded.startsWith("\uFEFF") ? decoded.slice(1) : decoded;
  } catch {
    return reject("INVALID_UTF8");
  }
}

function validBasename(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 4
    && value.length <= 1_024
    && value.endsWith(".csv")
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("?")
    && !value.includes("#")
    && !value.includes("%")
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function parseDialect(value: unknown): ComputeOptimizerCsvwDialect {
  const keys = [
    "encoding",
    "lineTerminators",
    "doubleQuote",
    "skipRows",
    "header",
    "headerRowCount",
    "delimiter",
    "skipColumns",
    "skipBlankRows",
    "trim",
  ] as const;
  if (!isRecord(value) || !exactKeys(value, keys)) reject("INVALID_METADATA");
  if (
    value.encoding !== UTF8
    || !Array.isArray(value.lineTerminators)
    || value.lineTerminators.length < 1
    || value.lineTerminators.length > SUPPORTED_LINE_TERMINATORS.size
    || value.lineTerminators.some((item) => !SUPPORTED_LINE_TERMINATORS.has(String(item)))
    || new Set(value.lineTerminators).size !== value.lineTerminators.length
    || value.doubleQuote !== true
    || value.skipRows !== 0
    || value.header !== true
    || value.headerRowCount !== 1
    || value.delimiter !== ","
    || value.skipColumns !== 0
    || value.skipBlankRows !== false
    || value.trim !== false
  ) reject("UNSUPPORTED_DIALECT");
  return {
    encoding: UTF8,
    lineTerminators: [...value.lineTerminators] as ("\n" | "\r\n")[],
    doubleQuote: true,
    skipRows: 0,
    header: true,
    headerRowCount: 1,
    delimiter: ",",
    skipColumns: 0,
    skipBlankRows: false,
    trim: false,
  };
}

function parseColumn(value: unknown): ComputeOptimizerCsvwColumn {
  if (
    !isRecord(value)
    || !exactKeys(value, ["name", "titles", "datatype", "required"], ["null", "format"])
    || !boundedText(value.name, 256)
    || !boundedText(value.titles, 1_024)
    || typeof value.datatype !== "string"
    || !SUPPORTED_DATATYPES.has(value.datatype)
    || typeof value.required !== "boolean"
    || (Object.hasOwn(value, "null") && typeof value.null !== "string")
    || (Object.hasOwn(value, "format") && !boundedText(value.format, 128))
    || (value.datatype !== "datetime" && Object.hasOwn(value, "format"))
    || (value.datatype === "datetime" && value.format !== "yyyy-MM-dd HH:mm:ss")
  ) reject("INVALID_METADATA");
  return {
    name: value.name,
    titles: value.titles,
    datatype: value.datatype as ComputeOptimizerCsvwDatatype,
    nullValue: Object.hasOwn(value, "null") ? value.null as string : null,
    required: value.required,
    format: Object.hasOwn(value, "format") ? value.format as string : null,
  };
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function parseMetadata(
  source: string,
  trustedCsvBasename: string,
  maximumColumns: number,
): {
  readonly csvBasename: string;
  readonly title: string;
  readonly modifiedDate: string | null;
  readonly dialect: ComputeOptimizerCsvwDialect;
  readonly columns: readonly ComputeOptimizerCsvwColumn[];
} {
  let candidate: unknown;
  try {
    candidate = JSON.parse(source) as unknown;
  } catch {
    return reject("INVALID_METADATA");
  }
  if (
    !isRecord(candidate)
    || !exactKeys(
      candidate,
      ["@context", "url", "dc:title", "dialect", "tableSchema"],
      ["dc:modified"],
    )
    || !Array.isArray(candidate["@context"])
    || candidate["@context"].length !== 1
    || candidate["@context"][0] !== CSVW_CONTEXT
    || !boundedText(candidate["dc:title"], 1_024)
    || !validBasename(candidate.url)
  ) reject("INVALID_METADATA");
  if (candidate.url !== trustedCsvBasename) reject("URL_MISMATCH");

  let modifiedDate: string | null = null;
  if (Object.hasOwn(candidate, "dc:modified")) {
    const modified = candidate["dc:modified"];
    if (
      !isRecord(modified)
      || !exactKeys(modified, ["@value", "@type"])
      || modified["@type"] !== "xsd:date"
      || typeof modified["@value"] !== "string"
      || !validDate(modified["@value"])
    ) reject("INVALID_METADATA");
    modifiedDate = modified["@value"];
  }
  const tableSchema = candidate.tableSchema;
  if (
    !isRecord(tableSchema)
    || !exactKeys(tableSchema, ["columns"])
    || !Array.isArray(tableSchema.columns)
    || tableSchema.columns.length < 1
    || tableSchema.columns.length > maximumColumns
  ) reject(tableSchema && isRecord(tableSchema) && Array.isArray(tableSchema.columns)
    && tableSchema.columns.length > maximumColumns ? "LIMIT_EXCEEDED" : "INVALID_METADATA");
  const columns = tableSchema.columns.map(parseColumn);
  if (new Set(columns.map((column) => column.name)).size !== columns.length) {
    reject("INVALID_METADATA");
  }
  for (const required of DEFAULT_COLUMNS) {
    const column = columns.find((entry) => entry.name === required);
    if (
      column === undefined
      || !column.required
      || (required === "recommendations_count" && column.datatype !== "integer")
      || (required !== "recommendations_count" && column.datatype !== "string")
    ) reject("SCHEMA_MISMATCH");
  }
  return {
    csvBasename: candidate.url,
    title: candidate["dc:title"],
    modifiedDate,
    dialect: parseDialect(candidate.dialect),
    columns,
  };
}

function terminatorAt(
  source: string,
  offset: number,
  terminators: readonly string[],
): string | null {
  for (const terminator of terminators) {
    if (source.startsWith(terminator, offset)) return terminator;
  }
  return null;
}

function parseCsvRows(
  source: string,
  dialect: ComputeOptimizerCsvwDialect,
  limits: ComputeOptimizerExportParserLimits,
): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  let fieldStarted = false;
  let rowStarted = false;
  const encoder = new TextEncoder();
  const terminators = [...dialect.lineTerminators].sort((left, right) => right.length - left.length);

  const finishField = (): void => {
    if (encoder.encode(field).byteLength > limits.maximumCellBytes) {
      reject("LIMIT_EXCEEDED");
    }
    row.push(field);
    if (row.length > limits.maximumColumns) reject("LIMIT_EXCEEDED");
    field = "";
    quoted = false;
    afterQuote = false;
    fieldStarted = false;
  };
  const finishRow = (): void => {
    finishField();
    rows.push(row);
    if (rows.length > limits.maximumRows + 1) reject("LIMIT_EXCEEDED");
    row = [];
    rowStarted = false;
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === "\"") {
        if (source[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      rowStarted = true;
      continue;
    }
    if (afterQuote) {
      if (character === dialect.delimiter) {
        finishField();
        rowStarted = true;
        continue;
      }
      const terminator = terminatorAt(source, index, terminators);
      if (terminator !== null) {
        finishRow();
        index += terminator.length - 1;
        continue;
      }
      reject("INVALID_CSV");
    }
    if (character === "\"") {
      if (fieldStarted || field.length > 0) reject("INVALID_CSV");
      quoted = true;
      fieldStarted = true;
      rowStarted = true;
      continue;
    }
    if (character === dialect.delimiter) {
      finishField();
      rowStarted = true;
      continue;
    }
    const terminator = terminatorAt(source, index, terminators);
    if (terminator !== null) {
      finishRow();
      index += terminator.length - 1;
      continue;
    }
    if (character === "\r" || character === "\n") reject("INVALID_CSV");
    field += character;
    fieldStarted = true;
    rowStarted = true;
  }
  if (quoted) reject("INVALID_CSV");
  if (rowStarted || row.length > 0 || field.length > 0 || afterQuote) finishRow();
  if (rows.length < 1) reject("INVALID_CSV");
  return rows;
}

function numericDigits(value: string): number {
  return [...value].reduce((count, character) => /\d/u.test(character) ? count + 1 : count, 0);
}

function parseCell(
  column: ComputeOptimizerCsvwColumn,
  raw: string,
): ParsedComputeOptimizerExportCell {
  const isNull = column.nullValue !== null && raw === column.nullValue;
  if (isNull && column.required) reject("INVALID_CELL");
  let integerLexeme: string | null = null;
  let decimalLexeme: string | null = null;
  if (!isNull && column.datatype === "integer") {
    if (!INTEGER.test(raw) || numericDigits(raw) > MAX_NUMERIC_DIGITS) {
      reject("INVALID_CELL");
    }
    integerLexeme = raw;
  } else if (!isNull && column.datatype === "double") {
    if (!DECIMAL.test(raw) || numericDigits(raw) > MAX_NUMERIC_DIGITS) {
      reject("INVALID_CELL");
    }
    decimalLexeme = raw;
  } else if (!isNull && column.datatype === "datetime") {
    if (!DATETIME.test(raw)) reject("INVALID_CELL");
    const iso = `${raw.replace(" ", "T")}.000Z`;
    const parsed = Date.parse(iso);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== iso) {
      reject("INVALID_CELL");
    }
  }
  return { column: column.name, raw, isNull, integerLexeme, decimalLexeme };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

export async function parseComputeOptimizerExport(input: {
  readonly metadataBytes: Uint8Array;
  readonly csvBytes: Uint8Array;
  readonly trustedCsvBasename: string;
  readonly limits?: Partial<ComputeOptimizerExportParserLimits>;
}): Promise<ParsedComputeOptimizerExport> {
  if (!isRecord(input) || !validBasename(input.trustedCsvBasename)) {
    reject("INVALID_INPUT");
  }
  const limits = configuredLimits(input.limits);
  const metadataSource = decode(input.metadataBytes, limits.maximumMetadataBytes);
  const csvSource = decode(input.csvBytes, limits.maximumCsvBytes);
  const metadata = parseMetadata(
    metadataSource,
    input.trustedCsvBasename,
    limits.maximumColumns,
  );
  const parsedRows = parseCsvRows(csvSource, metadata.dialect, limits);
  const header = parsedRows[0]!;
  if (
    header.length !== metadata.columns.length
    || header.some((value, index) => value !== metadata.columns[index]!.name)
  ) reject("SCHEMA_MISMATCH");
  const dataRows = parsedRows.slice(1);
  const rows = dataRows.map((values, index): ParsedComputeOptimizerExportRow => {
    if (values.length !== metadata.columns.length) reject("SCHEMA_MISMATCH");
    return {
      rowNumber: index + 1,
      cells: values.map((value, columnIndex) =>
        parseCell(metadata.columns[columnIndex]!, value)),
    };
  });
  const [metadataSha256, objectSha256] = await Promise.all([
    sha256(input.metadataBytes),
    sha256(input.csvBytes),
  ]);
  return {
    schemaVersion: "sutra.compute-optimizer-csvw-export.v1",
    csvBasename: metadata.csvBasename,
    title: metadata.title,
    modifiedDate: metadata.modifiedDate,
    dialect: metadata.dialect,
    columns: metadata.columns,
    rows,
    rowCount: rows.length,
    metadataBytes: input.metadataBytes.byteLength,
    csvBytes: input.csvBytes.byteLength,
    metadataSha256,
    objectSha256,
  };
}

/**
 * Render one RFC-4180 field while preventing spreadsheet formula execution.
 *
 * Cloud names, tags, scanner titles, and imported issue text are untrusted.
 * Spreadsheet applications can treat a cell beginning with `=`, `+`, `-`, or
 * `@` as a formula, including when the marker follows leading whitespace or a
 * byte-order mark. Prefixing the original value with a single quote preserves
 * the evidence as text. Quoting alone is not a formula-injection defense.
 */
export function safeCsvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const formulaProbe = text.replace(/^[\u0000-\u0020\uFEFF]+/u, "");
  const neutralized =
    /^[=+\-@]/u.test(formulaProbe) || /^[\t\r\n]/u.test(text)
      ? `'${text}`
      : text;
  return /[",\r\n]/u.test(neutralized)
    ? `"${neutralized.replaceAll('"', '""')}"`
    : neutralized;
}

export function safeCsvRow(values: readonly unknown[]): string {
  return values.map(safeCsvCell).join(",");
}

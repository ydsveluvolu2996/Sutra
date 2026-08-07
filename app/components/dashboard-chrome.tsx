import type { ReactNode } from "react";

import styles from "./dashboard-chrome.module.css";

/**
 * Shared dashboard chrome: the toolbar, tiles, and table furniture that sit
 * around a dashboard's charts.
 *
 * Every dashboard previously drew its own headings, counts, and tables, so the
 * same idea looked different on each one. These are presentational only -- no
 * hooks, no fetching, no state -- so a server component can render them and each
 * dashboard keeps owning its own data and query logic.
 *
 * Status colours are reserved: `severity` and `state` map to a fixed set that
 * never overlaps the categorical series palette, and each ships with a text
 * label so colour is never the only cue.
 */

export type ChromeSeverity = "critical" | "high" | "medium" | "low" | "info";
export type ChromeState = "open" | "resolved" | "suppressed" | "pending" | "failed";

export interface FilterChip {
  readonly id: string;
  readonly label: string;
  /** Rendered after the label as the chip's current selection. */
  readonly value?: string;
  readonly active?: boolean;
}

export interface DashboardToolbarProps {
  /** Free-text search box; omitted entirely when absent rather than shown disabled. */
  readonly search?: { readonly placeholder: string; readonly value?: string };
  readonly chips?: readonly FilterChip[];
  /** e.g. "22 threats" -- the count the current filters resolve to. */
  readonly resultLabel?: string;
  /** Right-aligned actions: view switches, sort, refresh. */
  readonly actions?: ReactNode;
}

/**
 * One filter row above the charts, in the order a reader scans: what am I
 * searching, what is filtered, how many rows survive, what can I do.
 */
export function DashboardToolbar({
  search,
  chips = [],
  resultLabel,
  actions,
}: DashboardToolbarProps) {
  return (
    <div className={styles.toolbar} role="group" aria-label="Dashboard filters">
      {search === undefined ? null : (
        <label className={styles.search}>
          <span className="sr-only">{search.placeholder}</span>
          <svg viewBox="0 0 16 16" aria-hidden="true" className={styles.searchGlyph}>
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input type="search" placeholder={search.placeholder} defaultValue={search.value} />
        </label>
      )}
      {chips.length === 0 ? null : (
        <div className={styles.chips}>
          {chips.map((chip) => (
            <span key={chip.id} className={styles.chip} data-active={chip.active ? "true" : undefined}>
              {chip.label}
              {chip.value === undefined ? null : <b>{chip.value}</b>}
              <svg viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </span>
          ))}
        </div>
      )}
      {resultLabel === undefined ? null : <span className={styles.resultCount}>{resultLabel}</span>}
      {actions === undefined ? null : <div className={styles.toolbarActions}>{actions}</div>}
    </div>
  );
}

export interface StatTileProps {
  readonly label: string;
  /** Pre-formatted by the caller, which owns units, currency, and precision. */
  readonly value: string;
  readonly caption?: string;
  /**
   * `direction` is what the number did; `sentiment` is whether that is good.
   * They are separate because a fall is good for cost and bad for coverage, and
   * conflating them is how a dashboard ends up colouring a win red.
   */
  readonly delta?: {
    readonly label: string;
    readonly direction: "up" | "down" | "flat";
    readonly sentiment: "good" | "bad" | "neutral";
  };
  readonly children?: ReactNode;
}

/** A headline number. Not a chart: no axes, no plot unless a caller adds one. */
export function StatTile({ label, value, caption, delta, children }: StatTileProps) {
  return (
    <article className={styles.statTile}>
      <p className={styles.statLabel}>{label}</p>
      <div className={styles.statValueRow}>
        <strong className={styles.statValue}>{value}</strong>
        {delta === undefined ? null : (
          <span className={styles.delta} data-sentiment={delta.sentiment}>
            <svg viewBox="0 0 10 10" aria-hidden="true">
              {delta.direction === "flat"
                ? <path d="M2 5h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                : <path
                    d={delta.direction === "up" ? "M5 8V2m0 0L2.5 4.5M5 2l2.5 2.5" : "M5 2v6m0 0L2.5 5.5M5 8l2.5-2.5"}
                    fill="none" stroke="currentColor" strokeWidth="1.6"
                    strokeLinecap="round" strokeLinejoin="round"
                  />}
            </svg>
            {delta.label}
          </span>
        )}
      </div>
      {caption === undefined ? null : <p className={styles.statCaption}>{caption}</p>}
      {children}
    </article>
  );
}

export interface SeverityCount {
  readonly severity: ChromeSeverity;
  readonly label: string;
  readonly count: number;
}

/**
 * Severity breakdown as a legend beside its total.
 *
 * The legend is always present and every row is labelled, so the reading never
 * depends on telling two swatches apart.
 */
export function SeverityLegend({
  total,
  totalLabel,
  counts,
}: {
  readonly total: number;
  readonly totalLabel: string;
  readonly counts: readonly SeverityCount[];
}) {
  return (
    <div className={styles.severityLegend}>
      <div className={styles.severityTotal}>
        <strong>{total.toLocaleString("en-US")}</strong>
        <span>{totalLabel}</span>
      </div>
      <ul>
        {counts.map((entry) => (
          <li key={entry.severity}>
            <i aria-hidden="true" data-severity={entry.severity} />
            <span>{entry.label}</span>
            <b>{entry.count.toLocaleString("en-US")}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Reserved status colour plus its text label; never colour alone. */
export function SeverityPill({ severity, label }: { readonly severity: ChromeSeverity; readonly label: string }) {
  return <span className={styles.severityPill} data-severity={severity}>{label}</span>;
}

export function StatePill({ state, label }: { readonly state: ChromeState; readonly label: string }) {
  return <span className={styles.statePill} data-state={state}>{label}</span>;
}

export interface DataTableColumn<Row> {
  readonly id: string;
  readonly header: string;
  /** Right-align numeric columns so digits line up down the column. */
  readonly numeric?: boolean;
  readonly cell: (row: Row) => ReactNode;
}

export interface DataTableProps<Row> {
  readonly caption: string;
  readonly columns: readonly DataTableColumn<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  /** Shown instead of an empty table body, so "no rows" is never ambiguous. */
  readonly empty?: ReactNode;
}

/**
 * Dense table with a sticky header.
 *
 * It also serves as the table view that every chart needs for accessibility, so
 * the same data is reachable without reading a colour.
 */
export function DataTable<Row>({ caption, columns, rows, rowKey, empty }: DataTableProps<Row>) {
  if (rows.length === 0 && empty !== undefined) {
    return <div className={styles.tableEmpty} role="status">{empty}</div>;
  }
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.id} scope="col" data-numeric={column.numeric ? "true" : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.id} data-numeric={column.numeric ? "true" : undefined}>
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A titled surface for a chart or a table, with optional header actions. */
export function DashboardCard({
  title,
  subtitle,
  actions,
  children,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <div>
          <h3>{title}</h3>
          {subtitle === undefined ? null : <p>{subtitle}</p>}
        </div>
        {actions === undefined ? null : <div className={styles.cardActions}>{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** Equal-width tile row that reflows to two columns, then one, on narrow viewports. */
export function DashboardTileRow({ children }: { readonly children: ReactNode }) {
  return <div className={styles.tileRow}>{children}</div>;
}

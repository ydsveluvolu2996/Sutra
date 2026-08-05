import type { ReactNode } from "react";
import styles from "./charts.module.css";

/**
 * Shared chrome for the chart kit.
 *
 * Every component here is a pure presentational function with no hooks, no
 * effects and no event handlers, so charts render identically from a server
 * component and from a client component and can be asserted with
 * `renderToStaticMarkup`. Interactivity is limited to what the platform gives
 * for free: native SVG `<title>` tooltips and CSS `:hover`.
 */

/** Tone names match the sidebar/icon tones so one visual language covers both. */
export type ChartTone =
  | "blue" | "indigo" | "cyan" | "teal" | "green"
  | "amber" | "orange" | "red" | "violet" | "slate";

/**
 * Default series order. Chosen so the first four tones stay distinguishable for
 * the most common forms of colour vision deficiency; components additionally
 * vary dash patterns and markers so hue is never the only cue.
 */
export const CHART_TONE_SEQUENCE: readonly ChartTone[] = Object.freeze([
  "blue", "amber", "teal", "violet", "red",
  "green", "indigo", "orange", "cyan", "slate",
]);

export function chartToneColor(tone: ChartTone): string {
  return `var(--chart-${tone})`;
}

/** Deterministic tone for series `index`, cycling through the sequence. */
export function chartToneAt(index: number): ChartTone {
  const sequence = CHART_TONE_SEQUENCE;
  return sequence[((index % sequence.length) + sequence.length) % sequence.length]!;
}

/** Dash pattern per series index; `null` means a solid stroke. */
export function chartDashAt(index: number): string | undefined {
  const patterns: readonly (string | undefined)[] = [
    undefined, "5 3", "2 2.5", "7 3 2 3", "1 2.5",
  ];
  return patterns[index % patterns.length];
}

export interface ChartStateProps {
  readonly title: string;
  readonly detail?: string;
}

/**
 * The chart kit's non-data state. Used for no evidence, too few points to plot,
 * and a total that cannot express a proportion. It is always visible and
 * labelled — an empty plot area must never be mistaken for a measured zero.
 */
export function ChartState({ title, detail }: ChartStateProps) {
  return (
    <div className={styles.chartState} role="status">
      <strong className={styles.chartStateTitle}>{title}</strong>
      {detail === undefined ? null : <span className={styles.chartStateDetail}>{detail}</span>}
    </div>
  );
}

export interface ChartLegendItem {
  readonly id: string;
  readonly label: string;
  readonly tone: ChartTone;
  readonly value?: string;
}

export function ChartLegend({ items }: { readonly items: readonly ChartLegendItem[] }) {
  if (items.length === 0) return null;
  return (
    <ul className={styles.legend}>
      {items.map((item) => (
        <li key={item.id}>
          <span
            aria-hidden="true"
            className={styles.legendSwatch}
            style={{ background: chartToneColor(item.tone) }}
          />
          {item.label}
          {item.value === undefined ? null : <span className={styles.legendValue}>{item.value}</span>}
        </li>
      ))}
    </ul>
  );
}

export interface ChartDataTableRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly series?: string;
}

/**
 * The chart's numbers as a real table, collapsed by default.
 *
 * A picture of a number is not an accessible substitute for the number. Every
 * chart in this kit ships its exact values here, which serves screen-reader
 * users, keyboard users and anyone who needs to read a figure precisely rather
 * than estimate it from a bar's length.
 */
export function ChartDataTable({
  caption,
  rows,
  seriesHeader = "Series",
  categoryHeader = "Category",
  valueHeader = "Value",
}: {
  readonly caption: string;
  readonly rows: readonly ChartDataTableRow[];
  readonly seriesHeader?: string;
  readonly categoryHeader?: string;
  readonly valueHeader?: string;
}) {
  if (rows.length === 0) return null;
  const showSeries = rows.some((row) => row.series !== undefined);
  return (
    <details className={styles.details}>
      <summary>Show the exact values</summary>
      <div>
        <table className={styles.dataTable}>
          <caption>{caption}</caption>
          <thead>
            <tr>
              {showSeries ? <th scope="col">{seriesHeader}</th> : null}
              <th scope="col">{categoryHeader}</th>
              <th scope="col">{valueHeader}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                {showSeries ? <td>{row.series ?? ""}</td> : null}
                <th scope="row">{row.label}</th>
                <td>{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export interface ChartFigureProps {
  /** Sentence describing what the chart shows; becomes the accessible name. */
  readonly ariaLabel: string;
  readonly caption?: ReactNode;
  readonly legend?: readonly ChartLegendItem[];
  readonly dataTable?: {
    readonly caption: string;
    readonly rows: readonly ChartDataTableRow[];
    readonly seriesHeader?: string;
    readonly categoryHeader?: string;
    readonly valueHeader?: string;
  };
  readonly viewBox: string;
  readonly children: ReactNode;
}

/**
 * Wraps one chart: the accessible SVG, an optional legend, a caption and the
 * collapsed exact-values table. The SVG carries `role="img"` and a `<title>` so
 * assistive technology announces one meaningful name instead of walking
 * hundreds of unlabelled shapes.
 */
export function ChartFigure({
  ariaLabel,
  caption,
  legend,
  dataTable,
  viewBox,
  children,
}: ChartFigureProps) {
  return (
    <figure className={`${styles.figure} ${styles.chartTone}`}>
      <svg role="img" aria-label={ariaLabel} viewBox={viewBox} preserveAspectRatio="xMidYMid meet">
        <title>{ariaLabel}</title>
        {children}
      </svg>
      {legend === undefined ? null : <ChartLegend items={legend} />}
      {caption === undefined ? null : <figcaption className={styles.caption}>{caption}</figcaption>}
      {dataTable === undefined ? null : (
        <ChartDataTable
          caption={dataTable.caption}
          rows={dataTable.rows}
          seriesHeader={dataTable.seriesHeader}
          categoryHeader={dataTable.categoryHeader}
          valueHeader={dataTable.valueHeader}
        />
      )}
    </figure>
  );
}

export interface ChartAxesProps {
  readonly plot: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
  readonly valueTicks: readonly { readonly value: number; readonly y: number; readonly label: string }[];
  readonly categoryTicks?: readonly { readonly key: string; readonly x: number; readonly label: string }[];
  readonly zeroY?: number | null;
}

/** Gridlines, tick labels and an explicit zero line when the domain crosses it. */
export function ChartAxes({ plot, valueTicks, categoryTicks, zeroY }: ChartAxesProps) {
  const right = plot.left + plot.width;
  const bottom = plot.top + plot.height;
  return (
    <g aria-hidden="true">
      {valueTicks.map((tick) => (
        <g key={`value-${tick.value}`}>
          <line className={styles.gridLine} x1={plot.left} x2={right} y1={tick.y} y2={tick.y} />
          <text className={`${styles.axisLabel} ${styles.axisLabelValue}`} x={plot.left - 7} y={tick.y}>
            {tick.label}
          </text>
        </g>
      ))}
      {typeof zeroY === "number" ? (
        <line className={styles.zeroLine} x1={plot.left} x2={right} y1={zeroY} y2={zeroY} />
      ) : null}
      <line className={styles.axisLine} x1={plot.left} x2={right} y1={bottom} y2={bottom} />
      {(categoryTicks ?? []).map((tick) => (
        <text
          className={`${styles.axisLabel} ${styles.axisLabelCategory}`}
          key={`category-${tick.key}`}
          x={tick.x}
          y={bottom + 7}
        >
          {tick.label}
        </text>
      ))}
    </g>
  );
}

export { styles as chartStyles };

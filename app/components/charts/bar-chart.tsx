import {
  bandScale,
  domainOf,
  niceTicks,
  padDegenerateDomain,
  plotArea,
  projectValue,
} from "./chart-scale";
import {
  ChartAxes,
  ChartFigure,
  ChartState,
  chartToneAt,
  chartToneColor,
  chartStyles as styles,
  type ChartLegendItem,
  type ChartTone,
} from "./chart-frame";

export interface BarChartSeries {
  readonly id: string;
  readonly label: string;
  readonly tone?: ChartTone;
  /** One value per category, aligned to `categories` by index. `null` is a gap. */
  readonly values: readonly (number | null)[];
}

export interface BarChartProps {
  readonly ariaLabel: string;
  readonly categories: readonly string[];
  readonly series: readonly BarChartSeries[];
  readonly formatValue: (value: number) => string;
  readonly caption?: string;
  /**
   * `grouped` places one bar per series side by side; `stacked` sums them into a
   * single column. Stacking is refused for data containing negatives, where a
   * stack would be arithmetically meaningless.
   */
  readonly layout?: "grouped" | "stacked";
  readonly maxCategoryLabels?: number;
  readonly height?: number;
}

const WIDTH = 720;
const PADDING = { top: 12, right: 16, bottom: 30, left: 60 } as const;

export function BarChart({
  ariaLabel,
  categories,
  series,
  formatValue,
  caption,
  layout = "grouped",
  maxCategoryLabels = 12,
  height = 260,
}: BarChartProps) {
  if (categories.length === 0 || series.length === 0) {
    return (
      <ChartState
        title="No plottable evidence"
        detail="This chart stays empty until a collected generation supplies values. An empty axis is not a measured zero."
      />
    );
  }

  const finiteValue = (value: number | null | undefined): number | null =>
    value === null || value === undefined || !Number.isFinite(value) ? null : value;

  const allValues = series.flatMap((entry) =>
    entry.values.map(finiteValue).filter((value): value is number => value !== null));
  if (allValues.length === 0) {
    return (
      <ChartState
        title="No plottable evidence"
        detail="Every category is missing a collected value, so no bar can be drawn."
      />
    );
  }

  const hasNegative = allValues.some((value) => value < 0);
  // Stacking negatives against positives produces a column whose height means
  // nothing. Fall back to grouped rather than draw a false total.
  const effectiveLayout = layout === "stacked" && hasNegative ? "grouped" : layout;

  const stackTotals = categories.map((_unused, index) =>
    series.reduce((sum, entry) => sum + (finiteValue(entry.values[index]) ?? 0), 0));

  // A bar's length is only meaningful measured from zero, so the domain always
  // includes it.
  const domain = padDegenerateDomain(
    domainOf(effectiveLayout === "stacked" ? stackTotals : allValues, { includeZero: true })!,
  );
  const plot = plotArea(WIDTH, height, PADDING);
  const ticks = niceTicks(domain, 5);
  const axisDomain = {
    min: Math.min(domain.min, ticks[0] ?? domain.min),
    max: Math.max(domain.max, ticks[ticks.length - 1] ?? domain.max),
  };
  const valueToY = (value: number) =>
    projectValue(value, axisDomain, { start: plot.top + plot.height, end: plot.top });
  const zeroY = valueToY(0);

  const categoryBands = bandScale(
    categories.length,
    { start: plot.left, end: plot.left + plot.width },
    { padding: categories.length > 30 ? 0.08 : 0.24 },
  );

  const labelStride = Math.max(1, Math.ceil(categories.length / Math.max(2, maxCategoryLabels)));
  const legend: ChartLegendItem[] = series.map((entry, index) => ({
    id: entry.id,
    label: entry.label,
    tone: entry.tone ?? chartToneAt(index),
  }));

  const tableRows = series.flatMap((entry) =>
    categories.map((category, index) => {
      const value = finiteValue(entry.values[index]);
      return {
        key: `${entry.id}-${index}`,
        series: series.length > 1 ? entry.label : undefined,
        label: category,
        value: value === null ? "Not collected" : formatValue(value),
      };
    }));

  return (
    <ChartFigure
      ariaLabel={ariaLabel}
      caption={caption}
      legend={series.length > 1 ? legend : undefined}
      viewBox={`0 0 ${WIDTH} ${height}`}
      dataTable={{ caption: ariaLabel, rows: tableRows }}
    >
      <ChartAxes
        plot={plot}
        zeroY={axisDomain.min < 0 ? zeroY : null}
        valueTicks={ticks.map((value) => ({ value, y: valueToY(value), label: formatValue(value) }))}
        categoryTicks={categoryBands
          .map((band, index) => ({ key: `${index}`, x: band.center, label: categories[index] ?? "", index }))
          .filter(({ index }) => index % labelStride === 0 || index === categories.length - 1)
          .map(({ key, x, label }) => ({ key, x, label }))}
      />
      {categories.map((category, categoryIndex) => {
        const band = categoryBands[categoryIndex];
        if (band === undefined) return null;

        if (effectiveLayout === "stacked") {
          let cursor = 0;
          return (
            <g key={`stack-${categoryIndex}`}>
              {series.map((entry, seriesIndex) => {
                const value = finiteValue(entry.values[categoryIndex]);
                if (value === null || value === 0) return null;
                const start = cursor;
                cursor += value;
                const top = valueToY(cursor);
                const bottom = valueToY(start);
                return (
                  <rect
                    className={styles.bar}
                    fill={chartToneColor(entry.tone ?? chartToneAt(seriesIndex))}
                    height={Math.max(0, bottom - top)}
                    key={entry.id}
                    width={band.width}
                    x={band.start}
                    y={top}
                  >
                    <title>{`${category} · ${entry.label}: ${formatValue(value)}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        }

        const inner = bandScale(
          series.length,
          { start: band.start, end: band.start + band.width },
          { padding: series.length > 1 ? 0.12 : 0 },
        );
        return (
          <g key={`group-${categoryIndex}`}>
            {series.map((entry, seriesIndex) => {
              const value = finiteValue(entry.values[categoryIndex]);
              if (value === null) return null;
              const slot = inner[seriesIndex];
              if (slot === undefined) return null;
              const valueY = valueToY(value);
              // A bar grows up from zero for positive values and down for
              // negative ones; both are drawn from the shared zero line.
              const top = Math.min(valueY, zeroY);
              const barHeight = Math.abs(valueY - zeroY);
              return (
                <rect
                  className={styles.bar}
                  fill={chartToneColor(entry.tone ?? chartToneAt(seriesIndex))}
                  height={Math.max(value === 0 ? 0 : 1, barHeight)}
                  key={entry.id}
                  width={slot.width}
                  x={slot.start}
                  y={top}
                >
                  <title>{`${category} · ${entry.label}: ${formatValue(value)}`}</title>
                </rect>
              );
            })}
          </g>
        );
      })}
    </ChartFigure>
  );
}

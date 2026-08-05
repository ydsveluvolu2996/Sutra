import {
  areaPath,
  bandScale,
  domainOf,
  linePath,
  niceTicks,
  padDegenerateDomain,
  plotArea,
  projectValue,
  type ChartPoint,
} from "./chart-scale";
import {
  ChartAxes,
  ChartFigure,
  ChartState,
  chartDashAt,
  chartToneAt,
  chartToneColor,
  chartStyles as styles,
  type ChartLegendItem,
  type ChartTone,
} from "./chart-frame";

/**
 * A single observation. `value: null` means no evidence for that period and is
 * drawn as a gap in the line — never as zero, which would understate spend and
 * invent a measurement that was not collected.
 */
export interface TimeSeriesPoint {
  readonly label: string;
  readonly value: number | null;
}

export interface TimeSeriesSeries {
  readonly id: string;
  readonly label: string;
  readonly tone?: ChartTone;
  readonly points: readonly TimeSeriesPoint[];
}

export interface TimeSeriesChartProps {
  readonly ariaLabel: string;
  readonly series: readonly TimeSeriesSeries[];
  readonly formatValue: (value: number) => string;
  readonly caption?: string;
  readonly mode?: "line" | "area";
  /**
   * Extend the value axis to zero. Off by default: for large, narrowly varying
   * costs a forced zero baseline flattens the very movement the chart exists to
   * show. Turn it on when absolute magnitude matters more than change.
   */
  readonly includeZero?: boolean;
  readonly maxCategoryLabels?: number;
  readonly emptyTitle?: string;
  readonly emptyDetail?: string;
  readonly height?: number;
}

const WIDTH = 720;
const PADDING = { top: 12, right: 16, bottom: 28, left: 60 } as const;

/**
 * Split a series into runs of consecutive present values, so a gap in the
 * evidence breaks the line instead of interpolating across it.
 */
function presentRuns(
  points: readonly TimeSeriesPoint[],
  positionAt: (index: number) => number,
  valueToY: (value: number) => number,
): readonly (readonly ChartPoint[])[] {
  const runs: ChartPoint[][] = [];
  let run: ChartPoint[] = [];
  points.forEach((point, index) => {
    if (point.value === null || !Number.isFinite(point.value)) {
      if (run.length > 0) runs.push(run);
      run = [];
      return;
    }
    run.push({ x: positionAt(index), y: valueToY(point.value) });
  });
  if (run.length > 0) runs.push(run);
  return runs;
}

/**
 * Multi-series trend chart for daily, weekly or monthly evidence.
 *
 * Pure and server-renderable: no hooks, no effects, no event handlers.
 */
export function TimeSeriesChart({
  ariaLabel,
  series,
  formatValue,
  caption,
  mode = "line",
  includeZero = false,
  maxCategoryLabels = 8,
  emptyTitle = "No plottable evidence",
  emptyDetail = "This chart stays empty until a collected generation supplies values. An empty axis is not a measured zero.",
  height = 260,
}: TimeSeriesChartProps) {
  const withPoints = series.filter((entry) => entry.points.length > 0);
  const values = withPoints.flatMap((entry) =>
    entry.points.map((point) => point.value).filter((value): value is number =>
      value !== null && Number.isFinite(value)));

  const rawDomain = domainOf(values, { includeZero: includeZero || mode === "area" });
  if (rawDomain === null || values.length === 0) {
    return <ChartState title={emptyTitle} detail={emptyDetail} />;
  }

  const longest = Math.max(...withPoints.map((entry) => entry.points.length));
  if (longest < 2) {
    return (
      <ChartState
        title="Only one observation is available"
        detail="A trend needs at least two collected periods. The single value is listed below the chart area instead of being drawn as a line."
      />
    );
  }

  const plot = plotArea(WIDTH, height, PADDING);
  const domain = padDegenerateDomain(rawDomain);
  const ticks = niceTicks(domain, 5);
  // The tick run can extend past the data; scale to whichever is wider so no
  // mark is clipped.
  const axisDomain = {
    min: Math.min(domain.min, ticks[0] ?? domain.min),
    max: Math.max(domain.max, ticks[ticks.length - 1] ?? domain.max),
  };
  const valueToY = (value: number) =>
    projectValue(value, axisDomain, { start: plot.top + plot.height, end: plot.top });

  // Points sit at band centres so a line chart and a bar chart of the same
  // periods align exactly.
  const bands = bandScale(longest, { start: plot.left, end: plot.left + plot.width }, { padding: 0 });
  const positionAt = (index: number) => bands[index]?.center ?? plot.left;

  const categories = withPoints[0]?.points ?? [];
  const labelStride = Math.max(1, Math.ceil(categories.length / Math.max(2, maxCategoryLabels)));
  const categoryTicks = categories
    .map((point, index) => ({ key: `${index}-${point.label}`, x: positionAt(index), label: point.label, index }))
    .filter(({ index }) => index % labelStride === 0 || index === categories.length - 1);

  const zeroY = axisDomain.min < 0 && axisDomain.max > 0 ? valueToY(0) : null;
  const baselineY = valueToY(Math.max(axisDomain.min, Math.min(0, axisDomain.max)));

  const legend: ChartLegendItem[] = withPoints.map((entry, index) => ({
    id: entry.id,
    label: entry.label,
    tone: entry.tone ?? chartToneAt(index),
  }));

  const tableRows = withPoints.flatMap((entry) =>
    entry.points.map((point, index) => ({
      key: `${entry.id}-${index}`,
      series: withPoints.length > 1 ? entry.label : undefined,
      label: point.label,
      value: point.value === null ? "Not collected" : formatValue(point.value),
    })));

  return (
    <ChartFigure
      ariaLabel={ariaLabel}
      caption={caption}
      legend={withPoints.length > 1 ? legend : undefined}
      viewBox={`0 0 ${WIDTH} ${height}`}
      dataTable={{ caption: ariaLabel, rows: tableRows, categoryHeader: "Period" }}
    >
      <ChartAxes
        plot={plot}
        zeroY={zeroY}
        valueTicks={ticks.map((value) => ({ value, y: valueToY(value), label: formatValue(value) }))}
        categoryTicks={categoryTicks.map(({ key, x, label }) => ({ key, x, label }))}
      />
      {withPoints.map((entry, index) => {
        const tone = entry.tone ?? chartToneAt(index);
        const color = chartToneColor(tone);
        const runs = presentRuns(entry.points, positionAt, valueToY);
        return (
          <g key={entry.id}>
            {mode === "area"
              ? runs.map((run, runIndex) => (
                <path
                  className={styles.area}
                  d={areaPath(run, baselineY)}
                  fill={color}
                  key={`area-${runIndex}`}
                />
              ))
              : null}
            {runs.map((run, runIndex) => (
              <path
                className={styles.line}
                d={linePath(run)}
                key={`line-${runIndex}`}
                stroke={color}
                strokeDasharray={chartDashAt(index)}
              />
            ))}
            {/* A single surviving observation in a run has no segment to draw,
                so mark it explicitly or it would vanish. */}
            {runs.filter((run) => run.length === 1).map((run, runIndex) => (
              <circle
                className={styles.marker}
                cx={run[0]!.x}
                cy={run[0]!.y}
                fill={color}
                key={`dot-${runIndex}`}
                r={2.75}
              />
            ))}
          </g>
        );
      })}
    </ChartFigure>
  );
}

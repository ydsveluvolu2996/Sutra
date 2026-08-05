import {
  areaPath,
  bandScale,
  domainOf,
  fractionsOf,
  linePath,
  padDegenerateDomain,
  projectValue,
  type ChartPoint,
} from "./chart-scale";
import {
  ChartState,
  chartToneAt,
  chartToneColor,
  chartStyles as styles,
  type ChartTone,
} from "./chart-frame";

export interface SparklineProps {
  /**
   * Sentence describing the trend. Required: an unlabelled inline graphic is
   * invisible to a screen-reader user.
   */
  readonly ariaLabel: string;
  readonly values: readonly (number | null)[];
  readonly tone?: ChartTone;
  readonly width?: number;
  readonly height?: number;
  readonly area?: boolean;
}

/**
 * Inline trend graphic for a KPI tile. Deliberately axis-free: it conveys shape
 * only, so the exact figure must always be shown as text beside it.
 */
export function Sparkline({
  ariaLabel,
  values,
  tone = "blue",
  width = 108,
  height = 28,
  area = true,
}: SparklineProps) {
  const present = values.filter((value): value is number =>
    value !== null && Number.isFinite(value));
  if (present.length < 2) return null;

  const domain = padDegenerateDomain(domainOf(present)!);
  const bands = bandScale(values.length, { start: 1.5, end: width - 1.5 }, { padding: 0 });
  const valueToY = (value: number) =>
    projectValue(value, domain, { start: height - 2.5, end: 2.5 });

  const runs: ChartPoint[][] = [];
  let run: ChartPoint[] = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      if (run.length > 0) runs.push(run);
      run = [];
      return;
    }
    run.push({ x: bands[index]?.center ?? 0, y: valueToY(value) });
  });
  if (run.length > 0) runs.push(run);

  const color = chartToneColor(tone);
  return (
    <svg
      aria-label={ariaLabel}
      className={styles.chartTone}
      height={height}
      role="img"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      <title>{ariaLabel}</title>
      {area
        ? runs.map((points, index) => (
          <path className={styles.sparkArea} d={areaPath(points, height)} fill={color} key={`a-${index}`} />
        ))
        : null}
      {runs.map((points, index) => (
        <path className={styles.sparkline} d={linePath(points)} key={`l-${index}`} stroke={color} />
      ))}
    </svg>
  );
}

export interface ShareBarSegment {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly tone?: ChartTone;
}

export interface ShareBarProps {
  readonly ariaLabel: string;
  readonly segments: readonly ShareBarSegment[];
  readonly formatValue: (value: number) => string;
  readonly height?: number;
}

/**
 * Single full-width composition bar — a compact alternative to a donut when the
 * question is "what proportion", and the parts are few. Same honesty contract as
 * the donut: it refuses to draw a share of a non-positive or negative total.
 */
export function ShareBar({
  ariaLabel,
  segments,
  formatValue,
  height = 12,
}: ShareBarProps) {
  const usable = segments.filter((segment) => Number.isFinite(segment.value));
  const fractions = fractionsOf(usable.map((segment) => segment.value));
  if (fractions === null) {
    return (
      <ChartState
        title="No proportional evidence"
        detail="A share needs a positive total made of non-negative parts."
      />
    );
  }

  const WIDTH = 100;
  return (
    <svg
      aria-label={ariaLabel}
      className={`${styles.chartTone} ${styles.shareBar}`}
      role="img"
      viewBox={`0 0 ${WIDTH} ${height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height }}
    >
      <title>{ariaLabel}</title>
      {usable.map((segment, index) => {
        const fraction = fractions[index]!;
        const x = fraction.startFraction * WIDTH;
        const segmentWidth = fraction.fraction * WIDTH;
        if (segmentWidth <= 0) return null;
        return (
          <rect
            className={styles.shareSegment}
            fill={chartToneColor(segment.tone ?? chartToneAt(index))}
            height={height}
            key={segment.id}
            width={segmentWidth}
            x={x}
          >
            <title>
              {`${segment.label}: ${formatValue(segment.value)} (${(fraction.fraction * 100).toFixed(1)}%)`}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

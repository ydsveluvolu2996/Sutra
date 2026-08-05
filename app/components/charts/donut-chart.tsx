import { donutSegmentPath, fractionsOf } from "./chart-scale";
import {
  ChartFigure,
  ChartState,
  chartToneAt,
  chartToneColor,
  chartStyles as styles,
  type ChartLegendItem,
  type ChartTone,
} from "./chart-frame";

export interface DonutChartSlice {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly tone?: ChartTone;
}

export interface DonutChartProps {
  readonly ariaLabel: string;
  readonly slices: readonly DonutChartSlice[];
  readonly formatValue: (value: number) => string;
  readonly caption?: string;
  /** Large figure in the ring's centre; defaults to the formatted total. */
  readonly centerValue?: string;
  readonly centerLabel?: string;
  readonly size?: number;
}

/**
 * Composition ring for a small number of parts of a whole.
 *
 * Refuses to draw when the parts cannot express a proportion — no slices, a
 * non-positive total, or any negative part — because a share of a meaningless
 * total is not a fact. Percentages appear in the legend so a reader gets the
 * exact split rather than estimating from arc length.
 */
export function DonutChart({
  ariaLabel,
  slices,
  formatValue,
  caption,
  centerValue,
  centerLabel,
  size = 210,
}: DonutChartProps) {
  const usable = slices.filter((slice) => Number.isFinite(slice.value));
  const fractions = fractionsOf(usable.map((slice) => slice.value));

  if (fractions === null) {
    const negative = usable.some((slice) => slice.value < 0);
    return (
      <ChartState
        title={negative ? "Composition cannot include negative parts" : "No proportional evidence"}
        detail={negative
          ? "Credits, refunds and negative amortization are real, but they cannot be drawn as a share of a whole. Use a bar chart, which represents sign correctly."
          : "A composition needs a positive total. Nothing is inferred from an absent or zero total."}
      />
    );
  }

  const cx = size / 2;
  const cy = size / 2;
  const outerRadius = size / 2 - 3;
  const innerRadius = outerRadius * 0.62;
  const total = usable.reduce((sum, slice) => sum + slice.value, 0);

  const percent = (fraction: number) =>
    `${(fraction * 100).toFixed(fraction < 0.01 && fraction > 0 ? 2 : 1)}%`;

  const legend: ChartLegendItem[] = usable.map((slice, index) => ({
    id: slice.id,
    label: slice.label,
    tone: slice.tone ?? chartToneAt(index),
    value: percent(fractions[index]!.fraction),
  }));

  return (
    <ChartFigure
      ariaLabel={ariaLabel}
      caption={caption}
      legend={legend}
      viewBox={`0 0 ${size} ${size}`}
      dataTable={{
        caption: ariaLabel,
        rows: usable.map((slice, index) => ({
          key: slice.id,
          label: `${slice.label} (${percent(fractions[index]!.fraction)})`,
          value: formatValue(slice.value),
        })),
        categoryHeader: "Part",
      }}
    >
      {usable.map((slice, index) => {
        const fraction = fractions[index]!;
        const path = donutSegmentPath(fraction.startFraction, fraction.endFraction, {
          cx, cy, outerRadius, innerRadius,
        });
        if (path === "") return null;
        return (
          <path
            className={styles.segment}
            d={path}
            fill={chartToneColor(slice.tone ?? chartToneAt(index))}
            key={slice.id}
          >
            <title>{`${slice.label}: ${formatValue(slice.value)} (${percent(fraction.fraction)})`}</title>
          </path>
        );
      })}
      <text className={styles.donutCenterValue} x={cx} y={centerLabel === undefined ? cy : cy - 7}>
        {centerValue ?? formatValue(total)}
      </text>
      {centerLabel === undefined ? null : (
        <text className={styles.donutCenterLabel} x={cx} y={cy + 11}>{centerLabel}</text>
      )}
    </ChartFigure>
  );
}

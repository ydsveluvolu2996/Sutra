import { ChartFigure, ChartState, chartToneColor, chartStyles as styles, type ChartTone } from "./chart-frame";

export interface RankingBarsItem {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly tone?: ChartTone;
  /** Optional secondary text, e.g. an account id or a share percentage. */
  readonly detail?: string;
}

export interface RankingBarsProps {
  readonly ariaLabel: string;
  readonly items: readonly RankingBarsItem[];
  readonly formatValue: (value: number) => string;
  readonly caption?: string;
  readonly tone?: ChartTone;
  /** Bars are drawn in the order given; set to sort descending by value first. */
  readonly sort?: boolean;
  readonly maxItems?: number;
}

const WIDTH = 720;
const ROW_HEIGHT = 26;
const LABEL_WIDTH = 210;
const VALUE_WIDTH = 104;
const BAR_HEIGHT = 11;

/**
 * Horizontal ranked bars — the right form for "top N by cost" style questions,
 * where labels are long and the comparison is ordinal.
 *
 * Bars are scaled against the largest magnitude in the set, and the scale is
 * stated in the caption so a reader never mistakes a full-width bar for 100% of
 * anything. Negative values (credits, refunds) draw from the axis in the
 * opposite direction rather than being hidden.
 */
export function RankingBars({
  ariaLabel,
  items,
  formatValue,
  caption,
  tone = "blue",
  sort = false,
  maxItems = 15,
}: RankingBarsProps) {
  const usable = items.filter((item) => Number.isFinite(item.value));
  if (usable.length === 0) {
    return (
      <ChartState
        title="No ranked evidence"
        detail="A ranking needs at least one collected value. Nothing is inferred from an absent row."
      />
    );
  }

  const ordered = sort ? [...usable].sort((left, right) => right.value - left.value) : usable;
  const shown = ordered.slice(0, maxItems);
  const omitted = ordered.length - shown.length;

  const peak = Math.max(...shown.map((item) => Math.abs(item.value)));
  const hasNegative = shown.some((item) => item.value < 0);
  const trackStart = LABEL_WIDTH;
  const trackWidth = WIDTH - LABEL_WIDTH - VALUE_WIDTH;
  // With negatives present the axis sits mid-track so both directions are
  // visible; otherwise bars start at the left edge and the full width is usable.
  const axisX = hasNegative ? trackStart + trackWidth / 2 : trackStart;
  const usableWidth = hasNegative ? trackWidth / 2 : trackWidth;
  const height = shown.length * ROW_HEIGHT + 6;

  const scaleNote = peak === 0
    ? "Every value is zero, so no bar length is drawn."
    : `Bar length is relative to the largest value shown, ${formatValue(peak)}.`;

  return (
    <ChartFigure
      ariaLabel={ariaLabel}
      caption={caption === undefined ? scaleNote : `${caption} ${scaleNote}`}
      viewBox={`0 0 ${WIDTH} ${height}`}
      dataTable={{
        caption: ariaLabel,
        rows: ordered.map((item) => ({
          key: item.id,
          label: item.detail === undefined ? item.label : `${item.label} — ${item.detail}`,
          value: formatValue(item.value),
        })),
        categoryHeader: "Item",
      }}
    >
      {shown.map((item, index) => {
        const rowY = index * ROW_HEIGHT + 3;
        const centerY = rowY + ROW_HEIGHT / 2;
        const magnitude = peak === 0 ? 0 : (Math.abs(item.value) / peak) * usableWidth;
        const barX = item.value < 0 ? axisX - magnitude : axisX;
        return (
          <g key={item.id}>
            <text className={styles.rankLabel} x={0} y={centerY} dominantBaseline="middle">
              {item.label.length > 34 ? `${item.label.slice(0, 33)}…` : item.label}
            </text>
            <rect
              className={styles.rankTrack}
              height={BAR_HEIGHT}
              rx={BAR_HEIGHT / 2}
              width={trackWidth}
              x={trackStart}
              y={centerY - BAR_HEIGHT / 2}
            />
            <rect
              className={styles.rankBar}
              fill={chartToneColor(item.tone ?? tone)}
              height={BAR_HEIGHT}
              rx={BAR_HEIGHT / 2}
              width={Math.max(magnitude, magnitude > 0 ? 2 : 0)}
              x={barX}
              y={centerY - BAR_HEIGHT / 2}
            >
              <title>{`${item.label}: ${formatValue(item.value)}`}</title>
            </rect>
            <text className={styles.rankValue} x={WIDTH} y={centerY} dominantBaseline="middle">
              {formatValue(item.value)}
            </text>
          </g>
        );
      })}
      {omitted > 0 ? (
        <text className={styles.rankLabel} x={0} y={height - 2} opacity={0.7}>
          {`${omitted} further ${omitted === 1 ? "row" : "rows"} not drawn — see the exact values`}
        </text>
      ) : null}
    </ChartFigure>
  );
}

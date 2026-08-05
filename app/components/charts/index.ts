/**
 * Sutra chart kit — native SVG, no charting dependency.
 *
 * Built in-repo for the same reason the icon system is: the product ships no
 * icon font, CDN asset or third-party UI bundle. Every component is a pure
 * presentational function with no hooks, effects or event handlers, so charts
 * render from server components, stay identical between server and browser, and
 * can be asserted exactly with `renderToStaticMarkup`.
 *
 * Shared honesty contract across the kit:
 * - Missing evidence is a gap or an explicit labelled state, never a zero.
 * - A value axis is not silently extended to zero for trend lines, and always
 *   includes zero for bars, where length is only meaningful against it.
 * - Negative amounts (credits, refunds, negative amortization) render with their
 *   real sign; composition charts refuse to draw them as a share.
 * - Every chart carries an accessible name and its exact values as a table, so
 *   the numbers never exist only as a picture.
 */

export {
  ChartAxes,
  ChartDataTable,
  ChartFigure,
  ChartLegend,
  ChartState,
  CHART_TONE_SEQUENCE,
  chartDashAt,
  chartToneAt,
  chartToneColor,
  chartStyles,
  type ChartDataTableRow,
  type ChartFigureProps,
  type ChartLegendItem,
  type ChartStateProps,
  type ChartTone,
} from "./chart-frame";

export {
  ChartGeometryError,
  areaPath,
  bandScale,
  domainOf,
  donutSegmentPath,
  fractionsOf,
  linePath,
  niceTicks,
  padDegenerateDomain,
  plotArea,
  projectValue,
  roundCoordinate,
  type ChartBand,
  type ChartDomain,
  type ChartFraction,
  type ChartPadding,
  type ChartPlotArea,
  type ChartPoint,
  type ChartRange,
} from "./chart-scale";

export {
  TimeSeriesChart,
  type TimeSeriesChartProps,
  type TimeSeriesPoint,
  type TimeSeriesSeries,
} from "./time-series-chart";

export { BarChart, type BarChartProps, type BarChartSeries } from "./bar-chart";

export { RankingBars, type RankingBarsItem, type RankingBarsProps } from "./ranking-bars";

export { DonutChart, type DonutChartProps, type DonutChartSlice } from "./donut-chart";

export {
  ShareBar,
  Sparkline,
  type ShareBarProps,
  type ShareBarSegment,
  type SparklineProps,
} from "./sparkline";

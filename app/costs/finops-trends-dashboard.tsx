"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { BarChart, RankingBars, TimeSeriesChart } from "../components/charts";
import {
  EndpointBoundary,
  StateBadge,
  formatMicrosExact,
  stateForEnvelope,
  type EndpointState,
} from "./finops-foundational-panels";
import { FinopsSheetBlock, foundationalStyles as styles } from "./finops-foundational-sheet-shell";
import { formatCount, formatUnits, microsToUnits } from "./finops-foundational-money";
import { TrendsOfficialCoverage } from "./finops-cur-intelligence-panels";
import type { FinopsCostBasis } from "../../lib/finops-billing-projections";
import type {
  FinopsTrendsComparison,
  FinopsTrendsContributorGroup,
  FinopsTrendsDimension,
  FinopsTrendsExactRational,
  FinopsTrendsIntelligenceResult,
  FinopsTrendsIntelligenceSnapshot,
  FinopsTrendsRollingComparison,
  FinopsTrendsSeries,
  FinopsTrendsSeriesPoint,
  FinopsTrendsTrailingAverage,
} from "../../lib/finops-trends-intelligence";
import type { FinopsTrendsCapabilityClosure } from "../../lib/finops-trends-capability-closure";
import type { FinopsTrendsOfficialDefinition } from "../../lib/finops-trends-official-definition";

/**
 * ADD-09 Trends, presented as the nine feature areas AWS documents.
 *
 * AWS does not publish the service-hosted QuickSight definition for the Trends
 * dashboard at the pinned framework commit, so there is no provable sheet,
 * visual or control count to mirror. This view is therefore organized by the
 * nine documented feature areas in
 * `FINOPS_TRENDS_OFFICIAL_DEFINITION.documentedFeatureAreas`, and each area
 * carries the audited native coverage and the named gap from that pinned
 * record. No sheet count is invented, and pixel or layout parity is not claimed.
 *
 * Every rendered field comes from the `/api/v1/finops/trends` envelope: the
 * trends intelligence snapshot and its capability closure. Money is an integer
 * count of currency micro-units carried as a decimal string; exact figures print
 * through `formatMicrosExact`, and `microsToUnits` converts only for chart
 * geometry. A period with no collected cost evidence is passed to the chart kit
 * as `value: null` so it draws a gap, never a zero. Percentages the engine
 * refused to compute are shown as a named reason rather than as a number, and
 * QuickSight machine-learning, geospatial and automation features Sutra does not
 * implement are stated as unavailable rather than simulated.
 */

const INTEGER = /^-?(?:0|[1-9]\d*)$/u;
const POSITIVE_INTEGER = /^[1-9]\d*$/u;
const HUNDRED = BigInt(100);
const MICROS_PER_UNIT = BigInt(1_000_000);
const CONTRIBUTOR_DIMENSIONS: readonly FinopsTrendsDimension[] = [
  "account",
  "service",
  "region",
  "charge_category",
];

/** The successful arm of the Trends report, with the capability closure the route attaches. */
export type FinopsTrendsSuccessfulReport = FinopsTrendsIntelligenceSnapshot & {
  readonly capabilities: FinopsTrendsCapabilityClosure;
};

export interface FinopsTrendsAvailablePeriod {
  readonly period: string;
  readonly generationId: string;
  readonly committedAtIso: string;
}

/** The `/api/v1/finops/trends` response envelope, exactly as the route returns it. */
export interface FinopsTrendsEnvelope {
  readonly connectionId: string;
  readonly officialDefinition: FinopsTrendsOfficialDefinition;
  readonly selectedWindow: {
    readonly fromPeriod: string;
    readonly toPeriod: string;
  } | null;
  readonly availablePeriods: readonly FinopsTrendsAvailablePeriod[];
  readonly report:
    | FinopsTrendsSuccessfulReport
    | Exclude<FinopsTrendsIntelligenceResult, { readonly ok: true }>
    | null;
  readonly sourceState: string;
}

/** Which series and which month every area reads. Held by the workspace, not fetched. */
export interface FinopsTrendsSelection {
  readonly currency: string;
  readonly costBasis: FinopsCostBasis;
  readonly period: string;
  readonly dimension: FinopsTrendsDimension;
}

type FeatureArea = FinopsTrendsOfficialDefinition["documentedFeatureAreas"][number];

/* -------------------------------------------------------------------------- */
/* Exact formatting                                                            */
/* -------------------------------------------------------------------------- */

function readable(value: string): string {
  return value.replaceAll("_", " ").toLowerCase();
}

function validRational(value: FinopsTrendsExactRational | null): value is FinopsTrendsExactRational {
  return value !== null
    && INTEGER.test(value.numerator)
    && POSITIVE_INTEGER.test(value.denominator);
}

/**
 * A rational already expressed in percent (the engine emits `delta*100/baseline`).
 * An exactly representable value prints exactly; otherwise the two-decimal
 * figure is truncated toward zero and the exact rational is printed beside it,
 * so no rounded number is ever presented as the measurement.
 */
function formatPercentRationalExact(value: FinopsTrendsExactRational | null): string {
  if (!validRational(value)) return "Not available";
  const numerator = BigInt(value.numerator);
  const denominator = BigInt(value.denominator);
  if (numerator % denominator === BigInt(0)) {
    return `${(numerator / denominator).toString()}%`;
  }
  const negative = numerator < BigInt(0);
  const absolute = negative ? -numerator : numerator;
  const scaled = (absolute * HUNDRED) / denominator;
  const whole = (scaled / HUNDRED).toString();
  const fraction = (scaled % HUNDRED).toString().padStart(2, "0");
  return `${negative ? "−" : ""}${whole}.${fraction}% (exact ${value.numerator}/${value.denominator}%, truncated for display)`;
}

/**
 * A rational expressed as a share of one (`abs(delta)/totalAbsoluteMovement`),
 * shown as a percentage of the total movement.
 */
function formatShareRationalExact(value: FinopsTrendsExactRational | null): string {
  if (!validRational(value)) return "Not available";
  return formatPercentRationalExact({
    numerator: (BigInt(value.numerator) * HUNDRED).toString(),
    denominator: value.denominator,
  });
}

/** An exact rational count of micro-units, shown as money plus its exact rational. */
function formatRationalMicrosExact(
  value: FinopsTrendsExactRational | null,
  currency: string,
): string {
  if (!validRational(value)) return "Not available";
  const numerator = BigInt(value.numerator);
  const denominator = BigInt(value.denominator);
  const whole = numerator / denominator;
  const money = formatMicrosExact(whole.toString(), currency);
  return numerator % denominator === BigInt(0)
    ? money
    : `${money} (exact ${value.numerator}/${value.denominator} micros)`;
}

/** Chart geometry for an exact rational of micros; null when it cannot convert exactly. */
function rationalMicrosToUnits(value: FinopsTrendsExactRational | null): number | null {
  if (!validRational(value)) return null;
  return microsToUnits((BigInt(value.numerator) / BigInt(value.denominator)).toString());
}

/**
 * A metered quantity in integer micro-units of the provider unit. Quantities are
 * never converted between units and unlike units are never summed.
 */
function formatUsageMicrosExact(micros: string, unit: string): string {
  if (!INTEGER.test(micros)) return "Not available";
  const amount = BigInt(micros);
  const negative = amount < BigInt(0);
  const absolute = negative ? -amount : amount;
  const whole = (absolute / MICROS_PER_UNIT).toString()
    .replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const fraction = (absolute % MICROS_PER_UNIT).toString().padStart(6, "0")
    .replace(/0+$/u, "");
  return `${negative ? "−" : ""}${whole}${fraction.length === 0 ? "" : `.${fraction}`} ${unit}`;
}

/** UTC timestamps only, so the server and browser renders never disagree. */
function formatIsoUtc(value: string | null): string {
  if (value === null) return "Not available";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(parsed));
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/(?:^-|-$)/gu, "");
}

/* -------------------------------------------------------------------------- */
/* Small presentational pieces                                                 */
/* -------------------------------------------------------------------------- */

function Tile({
  label, value, detail,
}: { readonly label: string; readonly value: string; readonly detail?: string }) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      {detail === undefined ? null : <span className={styles.tileDetail}>{detail}</span>}
    </div>
  );
}

/** Named absence. Never a zero, never an empty panel. */
function Unavailable({
  title, reasons,
}: { readonly title: string; readonly reasons: readonly string[] }) {
  return (
    <div className={styles.coverage} data-support="PARTIAL" role="status">
      <div className={styles.coverageHead}><strong>{title}</strong></div>
      <ul className={styles.coverageGaps}>
        {reasons.map((reason, index) => <li key={`${index}:${reason}`}>{reason}</li>)}
      </ul>
    </div>
  );
}

function Note({ children }: { readonly children: ReactNode }) {
  return <p className={styles.goalMeta}>{children}</p>;
}

/**
 * A month-over-month or window comparison. An unavailable comparison names the
 * engine reason; an available comparison whose percentage is undefined because
 * the baseline is zero says exactly that instead of printing a number.
 */
function ComparisonValue({
  comparison, currency,
}: {
  readonly comparison: FinopsTrendsComparison | FinopsTrendsRollingComparison;
  readonly currency: string;
}) {
  if (!comparison.available) {
    return <span>Not available: {readable(comparison.reason)}</span>;
  }
  const delta = formatMicrosExact(comparison.deltaMicros, currency);
  if (comparison.percent === null) {
    return (
      <span>
        {delta} · percentage withheld: {readable(comparison.percentUnavailableReason ?? "BASELINE_ZERO")}
        {" "}— a percentage of a zero baseline is undefined and is not estimated
      </span>
    );
  }
  return <span>{formatPercentRationalExact(comparison.percent)} · {delta}</span>;
}

function TrailingAverageValue({
  trailing, currency,
}: {
  readonly trailing: FinopsTrendsTrailingAverage;
  readonly currency: string;
}) {
  return trailing.available
    ? <span>{formatRationalMicrosExact(trailing.exactAverageMicros, currency)}</span>
    : <span>Not available: {readable(trailing.reason)}</span>;
}

/* -------------------------------------------------------------------------- */
/* Selection helpers                                                           */
/* -------------------------------------------------------------------------- */

export function defaultTrendsSelection(
  report: FinopsTrendsSuccessfulReport,
): FinopsTrendsSelection {
  const series = report.series[0] ?? null;
  return {
    currency: series?.currency ?? report.expectedCurrencies[0] ?? "USD",
    costBasis: series?.costBasis ?? report.selectedCostBases[0] ?? "unblended",
    period: report.window.toPeriod,
    dimension: "service",
  };
}

function selectedSeries(
  report: FinopsTrendsSuccessfulReport,
  selection: FinopsTrendsSelection,
): FinopsTrendsSeries | null {
  return report.series.find((series) =>
    series.currency === selection.currency && series.costBasis === selection.costBasis)
    ?? report.series[0]
    ?? null;
}

function selectedPoint(
  series: FinopsTrendsSeries | null,
  selection: FinopsTrendsSelection,
): FinopsTrendsSeriesPoint | null {
  if (series === null) return null;
  return series.points.find((point) => point.period === selection.period)
    ?? series.points.at(-1)
    ?? null;
}

function contributorGroup(
  point: FinopsTrendsSeriesPoint | null,
  dimension: FinopsTrendsDimension,
): FinopsTrendsContributorGroup | null {
  return point?.contributors.find((group) => group.dimension === dimension) ?? null;
}

function windowLabel(months: number): string {
  return months === 1
    ? "Month over prior month"
    : months === 3
      ? "Rolling quarter over prior quarter"
      : months === 12
        ? "Rolling year over prior year"
        : `Rolling ${months}-month window over the prior ${months} months`;
}

interface AreaProps {
  readonly report: FinopsTrendsSuccessfulReport;
  readonly definition: FinopsTrendsOfficialDefinition;
  readonly selection: FinopsTrendsSelection;
}

/* -------------------------------------------------------------------------- */
/* Area 1 — Periodic trends and actuals                                        */
/* -------------------------------------------------------------------------- */

function PeriodicTrendsArea({ report, selection }: AreaProps) {
  const series = selectedSeries(report, selection);
  const point = selectedPoint(series, selection);
  if (series === null) {
    return (
      <Unavailable
        title="No currency and cost-basis series is present in this snapshot"
        reasons={[
          "The engine produced no series for the selected window, so no actual, comparison or contributor can be shown. An absent series is not a zero bill.",
        ]}
      />
    );
  }
  return (
    <div className={styles.blocks}>
      <FinopsSheetBlock
        description={`Exact monthly actuals for ${series.currency} on the ${series.costBasis} basis. Currencies and cost bases are never merged or converted, and a month with no collected cost evidence is drawn as a gap rather than as a zero.`}
        title="Monthly actuals"
      >
        <div className={styles.tiles}>
          <Tile
            detail={point === null ? undefined : `Period state: ${readable(point.periodState)}`}
            label={`${point?.period ?? "Selected period"} actual`}
            value={formatMicrosExact(point?.totalMicros ?? null, series.currency)}
          />
          <Tile
            detail={point === null ? undefined : `${formatCount(point.contributingRowCount)} rows carried this basis · ${formatCount(point.missingCostRowCount)} did not`}
            label="Cost coverage"
            value={point === null ? "Not available" : point.costCoverage}
          />
          <Tile
            detail={`${formatCount(report.window.periodCount)} periods requested`}
            label="Complete periods"
            value={`${formatCount(report.summary.completePeriodCount)} of ${formatCount(report.window.periodCount)}`}
          />
          <Tile
            detail={`${formatCount(report.summary.activeGenerationCount)} active generations · ${formatCount(report.summary.sourceRowCount)} accepted rows`}
            label="Missing periods"
            value={formatCount(report.summary.missingPeriodCount)}
          />
        </div>

        <TimeSeriesChart
          ariaLabel={`Exact ${series.currency} ${series.costBasis} monthly cost from ${report.window.fromPeriod} to ${report.window.toPeriod}`}
          caption="A break in the line is a period with no collected cost evidence on this basis. It is not a measured zero and is not interpolated."
          formatValue={(value) => formatUnits(value, series.currency)}
          includeZero
          mode="area"
          series={[{
            id: `${series.currency}-${series.costBasis}`,
            label: `${series.currency} ${series.costBasis} actual`,
            points: series.points.map((entry) => ({
              label: entry.period,
              value: microsToUnits(entry.totalMicros),
            })),
          }]}
        />
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description={`Monthly, quarterly and yearly cadences come from the same immutable evidence: month over month, the exact ${formatCount(report.rollingWindowMonths)}-month trailing average, and the ${readable(windowLabel(report.rollingWindowMonths))} comparison.`}
        title="Periodic comparisons"
      >
        <TimeSeriesChart
          ariaLabel={`Monthly actual against the exact ${report.rollingWindowMonths}-month trailing average in ${series.currency}`}
          caption="The trailing average is withheld for any month whose window contains a missing or incomplete period, so its line breaks where the evidence does."
          formatValue={(value) => formatUnits(value, series.currency)}
          includeZero
          mode="line"
          series={[
            {
              id: "actual",
              label: `${series.currency} ${series.costBasis} actual`,
              points: series.points.map((entry) => ({
                label: entry.period,
                value: microsToUnits(entry.totalMicros),
              })),
            },
            {
              id: "trailing",
              label: `Exact ${report.rollingWindowMonths}-month trailing average`,
              tone: "amber",
              points: series.points.map((entry) => ({
                label: entry.period,
                value: entry.trailingAverage.available
                  ? rationalMicrosToUnits(entry.trailingAverage.exactAverageMicros)
                  : null,
              })),
            },
          ]}
        />

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>
              Every period in the requested window is listed, including periods with no active
              generation, so an absent month is visible evidence rather than an omission.
            </caption>
            <thead>
              <tr>
                <th scope="col">Period</th>
                <th scope="col">State</th>
                <th className={styles.numeric} scope="col">Actual</th>
                <th scope="col">Month over month</th>
                <th scope="col">{formatCount(report.rollingWindowMonths)}-month trailing average</th>
                <th scope="col">{windowLabel(report.rollingWindowMonths)}</th>
              </tr>
            </thead>
            <tbody>
              {series.points.map((entry) => (
                <tr key={entry.period}>
                  <th scope="row">{entry.period}</th>
                  <td><StateBadge state={entry.periodState.toLowerCase()} /></td>
                  <td className={styles.numeric}>
                    {entry.totalMicros === null
                      ? "Not collected"
                      : formatMicrosExact(entry.totalMicros, series.currency)}
                  </td>
                  <td><ComparisonValue comparison={entry.monthOverMonth} currency={series.currency} /></td>
                  <td><TrailingAverageValue currency={series.currency} trailing={entry.trailingAverage} /></td>
                  <td><ComparisonValue comparison={entry.rollingComparison} currency={series.currency} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description={`Pinned, explainable review thresholds. ${formatCount(report.summary.signalCount)} signals were raised across every series in this window. Signals are informational and are not AWS Cost Anomaly Detection findings.`}
        title="Signals requiring review"
      >
        {point === null || point.signals.length === 0 ? (
          <Note>
            No pinned threshold was crossed for {point?.period ?? "the selected period"} on this
            series. The thresholds are {report.signalPolicy.momAbsolutePercentThreshold}% month over
            month and {report.signalPolicy.trailingAbsolutePercentThreshold}% against the previous
            {" "}{report.signalPolicy.trailingBaselineMonths}-month average.
          </Note>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>Every signal carries its formula, its pinned threshold and its exact observed percentage.</caption>
              <thead>
                <tr>
                  <th scope="col">Signal</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Baseline</th>
                  <th className={styles.numeric} scope="col">Threshold</th>
                  <th scope="col">Observed</th>
                  <th scope="col">Formula</th>
                </tr>
              </thead>
              <tbody>
                {point.signals.map((signal) => (
                  <tr key={signal.code}>
                    <th scope="row">{readable(signal.code)}</th>
                    <td>{readable(signal.severity)}</td>
                    <td>{readable(signal.baseline)}</td>
                    <td className={styles.numeric}>{signal.thresholdPercent}%</td>
                    <td>{formatPercentRationalExact(signal.observedPercent)}</td>
                    <td><code>{signal.formula}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ul className={styles.formulaList} aria-label="Pinned signal formulas">
          <li>{report.signalPolicy.formulas.momAbsolutePercentChange}</li>
          <li>{report.signalPolicy.formulas.trailingBaselineDeviation}</li>
        </ul>
      </FinopsSheetBlock>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Area 2 — ML-powered forecast                                                */
/* -------------------------------------------------------------------------- */

function ForecastArea({ report, selection }: AreaProps) {
  const series = selectedSeries(report, selection);
  const currency = series?.currency ?? selection.currency;
  const basis = series?.costBasis ?? selection.costBasis;
  const forecast = report.capabilities.forecast.sutra.find((entry) =>
    entry.currency === currency && entry.costBasis === basis) ?? null;

  return (
    <div className={styles.blocks}>
      <FinopsSheetBlock
        description="The official area is the QuickSight machine-learning forecast. Sutra does not ingest provider forecast evidence, so that forecast is unavailable and is not simulated."
        title="AWS QuickSight ML forecast"
      >
        <Unavailable
          title="QuickSight machine-learning forecast is unavailable"
          reasons={[
            readable(report.capabilities.forecast.provider.reason),
            `The trends engine itself produces no forecast: ${readable(report.forecast.reason)}.`,
            "No AWS forecast value is reconstructed, approximated or copied from a screenshot.",
          ]}
        />
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description={`A separately labelled Sutra estimate for ${currency} on the ${basis} basis. It is a deterministic integer trend over contiguous complete periods, not QuickSight ML, not a statistical confidence interval and not a quote.`}
        title="Sutra deterministic estimate"
      >
        {forecast === null ? (
          <Unavailable
            title="No estimate was produced for this currency and cost basis"
            reasons={["The capability closure carries no estimate entry for the selected series."]}
          />
        ) : !forecast.available ? (
          <Unavailable
            title="A Sutra estimate is withheld"
            reasons={[
              readable(forecast.reason),
              `${formatCount(forecast.observedCompletePeriods)} contiguous complete periods are eligible; ${formatCount(forecast.minimumRequired)} are required.`,
              "An estimate is never produced from partial, missing, stale or corrected periods.",
            ]}
          />
        ) : (
          <>
            <div className={styles.tiles}>
              <Tile
                detail={forecast.model}
                label="Model"
                value="Deterministic integer linear trend"
              />
              <Tile
                detail={`${forecast.trainingWindow.fromPeriod} — ${forecast.trainingWindow.toPeriod}`}
                label="Training periods"
                value={formatCount(forecast.trainingWindow.periodCount)}
              />
              <Tile
                detail={`Method: ${readable(forecast.errorBand.method)} · statistical confidence: ${forecast.errorBand.statisticalConfidence ? "claimed" : "not claimed"}`}
                label="Mean absolute residual"
                value={formatMicrosExact(forecast.errorBand.meanAbsoluteResidualMicros, forecast.currency)}
              />
            </div>

            <TimeSeriesChart
              ariaLabel={`Collected ${forecast.currency} ${forecast.costBasis} actuals and the separately labelled Sutra estimate`}
              caption="The two lines are different kinds of value: collected evidence and a labelled deterministic estimate. They never join into a single line."
              formatValue={(value) => formatUnits(value, forecast.currency)}
              includeZero
              mode="line"
              series={[
                {
                  id: "actual",
                  label: `${forecast.currency} ${forecast.costBasis} collected actual`,
                  points: [
                    ...(series?.points ?? []).map((entry) => ({
                      label: entry.period,
                      value: microsToUnits(entry.totalMicros),
                    })),
                    ...forecast.points.map((entry) => ({ label: entry.period, value: null })),
                  ],
                },
                {
                  id: "estimate",
                  label: "Sutra deterministic estimate",
                  tone: "amber",
                  points: [
                    ...(series?.points ?? []).map((entry) => ({ label: entry.period, value: null })),
                    ...forecast.points.map((entry) => ({
                      label: entry.period,
                      value: microsToUnits(entry.forecastMicros),
                    })),
                  ],
                },
              ]}
            />

            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>
                  Estimated periods with their residual band. The band is the mean absolute
                  residual of the training fit, not a statistical confidence interval.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Period</th>
                    <th className={styles.numeric} scope="col">Estimate</th>
                    <th className={styles.numeric} scope="col">Lower</th>
                    <th className={styles.numeric} scope="col">Upper</th>
                  </tr>
                </thead>
                <tbody>
                  {forecast.points.map((entry) => (
                    <tr key={entry.period}>
                      <th scope="row">{entry.period}</th>
                      <td className={styles.numeric}>{formatMicrosExact(entry.forecastMicros, forecast.currency)}</td>
                      <td className={styles.numeric}>{formatMicrosExact(entry.lowerMicros, forecast.currency)}</td>
                      <td className={styles.numeric}>{formatMicrosExact(entry.upperMicros, forecast.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Note>Disclosure: {readable(forecast.disclosure)}.</Note>
            <Note>
              Training generations: {forecast.trainingWindow.generationIds.length === 0
                ? "not available"
                : forecast.trainingWindow.generationIds.join(", ")}
            </Note>
          </>
        )}
      </FinopsSheetBlock>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Area 3 — Service category and service usage trends                          */
/* -------------------------------------------------------------------------- */

function ServiceTrendsArea({ report, definition, selection }: AreaProps) {
  const series = selectedSeries(report, selection);
  const point = selectedPoint(series, selection);
  const currency = series?.currency ?? selection.currency;
  const basis = series?.costBasis ?? selection.costBasis;
  const period = point?.period ?? report.window.toPeriod;
  const taxonomy = report.capabilities.serviceTaxonomy;
  const usage = report.capabilities.serviceUsage;
  const area = definition.documentedFeatureAreas.find((entry) =>
    entry.name === "Service category and service usage trends") ?? null;

  const costs = taxonomy.costTrends.filter((entry) =>
    entry.period === period && entry.currency === currency && entry.costBasis === basis);
  const usageGroups = usage.groups.filter((entry) => entry.period === period);

  return (
    <div className={styles.blocks}>
      <FinopsSheetBlock
        description={`Active CUR 2.0 service taxonomy for ${period} in ${currency} on the ${basis} basis. Coverage: ${taxonomy.state}; evidence basis ${readable(taxonomy.evidenceBasis)}.`}
        title="Service category cost trends"
      >
        {costs.length === 0 ? (
          <Unavailable
            title="No service-category cost evidence for this selection"
            reasons={[
              `No active CUR2 row for ${period} carried both a provider service category and a cost on the ${basis} basis in ${currency}.`,
              `${formatCount(taxonomy.missingTaxonomyRowCount)} rows in the window carry no provider taxonomy and are excluded from grouping rather than bucketed as unknown cost.`,
            ]}
          />
        ) : (
          <>
            <RankingBars
              ariaLabel={`Service cost for ${period} in ${currency} on the ${basis} basis`}
              caption="Ranked by the exact cost the provider reported for each category and service pair."
              formatValue={(value) => formatUnits(value, currency)}
              items={costs.flatMap((entry) => {
                const units = microsToUnits(entry.totalMicros);
                return units === null ? [] : [{
                  id: `${entry.category}|${entry.subcategory ?? ""}|${entry.service}`,
                  label: `${entry.category} · ${entry.service}`,
                  value: units,
                  detail: `${formatCount(entry.rowCount)} rows`,
                }];
              })}
              sort
            />
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>Exact CUR2 category, subcategory and service cost for the selected period.</caption>
                <thead>
                  <tr>
                    <th scope="col">Category</th>
                    <th scope="col">Subcategory</th>
                    <th scope="col">Service</th>
                    <th className={styles.numeric} scope="col">Cost</th>
                    <th className={styles.numeric} scope="col">Rows</th>
                  </tr>
                </thead>
                <tbody>
                  {costs.map((entry) => (
                    <tr key={`${entry.category}|${entry.subcategory ?? ""}|${entry.service}`}>
                      <th scope="row">{entry.category}</th>
                      <td>{entry.subcategory ?? "Not reported"}</td>
                      <td>{entry.service}</td>
                      <td className={styles.numeric}>{formatMicrosExact(entry.totalMicros, entry.currency)}</td>
                      <td className={styles.numeric}>{formatCount(entry.rowCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {taxonomy.groups.length === 0 ? null : (
          <details>
            <summary>Observed category to service grouping ({formatCount(taxonomy.groups.length)})</summary>
            <ul className={styles.formulaList} aria-label="Observed CUR2 category to service grouping">
              {taxonomy.groups.map((group) => (
                <li key={`${group.category}|${group.subcategory ?? ""}`}>
                  {group.category}
                  {group.subcategory === null ? "" : ` · ${group.subcategory}`}
                  {": "}
                  {group.services.join(", ")}
                </li>
              ))}
            </ul>
          </details>
        )}
        <Note>
          {formatCount(taxonomy.missingTaxonomyRowCount)} rows in this window carry no provider
          service category. They are excluded from taxonomy grouping rather than bucketed as
          unknown cost, so no category total absorbs an unclassified row.
        </Note>
        <Note>{area?.gap ?? "Layout parity is not claimed."}</Note>
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description={`Metered usage for ${period} from ${readable(usage.evidenceBasis)}. Coverage: ${usage.state}. Unlike units are never combined and no unit conversion is performed.`}
        title="Service usage trends"
      >
        {usageGroups.length === 0 ? (
          <Unavailable
            title="No metered usage evidence for this period"
            reasons={[
              `${formatCount(usage.missingQuantityRowCount)} rows carry no metered quantity and ${formatCount(usage.missingUnitRowCount)} carry no usable provider unit.`,
              "A missing quantity is not treated as zero usage.",
            ]}
          />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>Exact metered quantity in provider units. Each unit is reported separately.</caption>
              <thead>
                <tr>
                  <th scope="col">Service</th>
                  <th scope="col">Category</th>
                  <th scope="col">Usage type</th>
                  <th className={styles.numeric} scope="col">Quantity</th>
                  <th className={styles.numeric} scope="col">Rows</th>
                </tr>
              </thead>
              <tbody>
                {usageGroups.map((entry) => (
                  <tr key={`${entry.service}|${entry.usageType ?? ""}|${entry.unit}`}>
                    <th scope="row">{entry.service}</th>
                    <td>{entry.category ?? "Not reported"}</td>
                    <td>{entry.usageType ?? "Not reported"}</td>
                    <td className={styles.numeric}>{formatUsageMicrosExact(entry.usageAmountMicros, entry.unit)}</td>
                    <td className={styles.numeric}>{formatCount(entry.rowCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Note>
          {formatCount(usage.missingQuantityRowCount)} rows lack a metered quantity and
          {" "}{formatCount(usage.missingUnitRowCount)} lack a usable unit; both stay excluded rather
          than being counted as zero usage.
        </Note>
      </FinopsSheetBlock>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Area 4 — Three-month service percentage change                              */
/* -------------------------------------------------------------------------- */

function ServiceChangeArea({ report, definition, selection }: AreaProps) {
  const series = selectedSeries(report, selection);
  const point = selectedPoint(series, selection);
  const currency = series?.currency ?? selection.currency;
  const group = contributorGroup(point, "service");
  const area = definition.documentedFeatureAreas.find((entry) =>
    entry.name === "Three-month service percentage change") ?? null;
  const rolling = point?.rollingComparison ?? null;

  return (
    <div className={styles.blocks}>
      <FinopsSheetBlock
        description={`${windowLabel(report.rollingWindowMonths)} for ${currency} on the ${series?.costBasis ?? selection.costBasis} basis, ending ${point?.period ?? report.window.toPeriod}. The comparison window is a request option, so the documented three-month snapshot is one selectable case rather than a fixed layout.`}
        title="Rolling window change"
      >
        {rolling === null ? (
          <Unavailable
            title="No period is selected for a rolling comparison"
            reasons={["The selected series carries no point for this window."]}
          />
        ) : rolling.available ? (
          <div className={styles.tiles}>
            <Tile
              detail={`${rolling.currentWindowStartPeriod} — ${rolling.currentWindowEndPeriod}`}
              label="Current window total"
              value={formatMicrosExact(rolling.currentWindowTotalMicros, currency)}
            />
            <Tile
              detail={`${rolling.priorWindowStartPeriod} — ${rolling.priorWindowEndPeriod}`}
              label="Prior window total"
              value={formatMicrosExact(rolling.priorWindowTotalMicros, currency)}
            />
            <Tile
              detail={`Window: ${formatCount(rolling.windowMonths)} months`}
              label="Change"
              value={formatMicrosExact(rolling.deltaMicros, currency)}
            />
            <Tile
              detail={rolling.percent === null
                ? `Withheld: ${readable(rolling.percentUnavailableReason ?? "BASELINE_ZERO")}`
                : "Exact rational percentage"}
              label="Percentage change"
              value={rolling.percent === null
                ? "Withheld"
                : formatPercentRationalExact(rolling.percent)}
            />
          </div>
        ) : (
          <Unavailable
            title="The rolling comparison is withheld"
            reasons={[
              readable(rolling.reason),
              "Neither window is completed with interpolated or carried-forward values.",
            ]}
          />
        )}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description={`Exact service cost movement into ${point?.period ?? report.window.toPeriod} against the prior month. Contributors are ranked by absolute movement; credits and refunds keep their negative sign.`}
        title="Service movement"
      >
        {group === null || !group.available || group.contributors.length === 0 ? (
          <Unavailable
            title="Service movement cannot be ranked"
            reasons={[
              group === null
                ? "The selected period carries no service contributor group."
                : group.available
                  ? "No service changed between the two periods, so there is no movement to rank. This is a measured absence of change, not an absence of cost."
                  : readable(group.unavailableReason ?? "MISSING_PERIOD"),
              "A movement ranking requires two complete periods on the same cost basis.",
            ]}
          />
        ) : (
          <>
            <RankingBars
              ariaLabel={`Service cost movement into ${point?.period ?? report.window.toPeriod} in ${currency}`}
              caption="Bars extend either side of the axis: a decrease keeps its negative sign and is never shown as a magnitude."
              formatValue={(value) => formatUnits(value, currency)}
              items={group.contributors.flatMap((entry) => {
                const units = microsToUnits(entry.deltaMicros);
                return units === null ? [] : [{
                  id: entry.value ?? "__not_reported__",
                  label: entry.value ?? "Service not reported",
                  value: units,
                  detail: formatShareRationalExact(entry.absoluteMovementShare),
                  tone: units < 0 ? ("teal" as const) : ("amber" as const),
                }];
              })}
            />
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>
                  Exact prior and current service cost with the share of total absolute movement.
                  Percentages of a zero prior month are withheld by the engine.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Service</th>
                    <th className={styles.numeric} scope="col">Prior</th>
                    <th className={styles.numeric} scope="col">Current</th>
                    <th className={styles.numeric} scope="col">Change</th>
                    <th scope="col">Share of absolute movement</th>
                  </tr>
                </thead>
                <tbody>
                  {group.contributors.map((entry) => (
                    <tr key={entry.value ?? "__not_reported__"}>
                      <th scope="row">{entry.value ?? "Service not reported"}</th>
                      <td className={styles.numeric}>{formatMicrosExact(entry.priorMicros, currency)}</td>
                      <td className={styles.numeric}>{formatMicrosExact(entry.currentMicros, currency)}</td>
                      <td className={styles.numeric}>{formatMicrosExact(entry.deltaMicros, currency)}</td>
                      <td>{formatShareRationalExact(entry.absoluteMovementShare)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Note>
              {formatCount(group.totalDimensionValues)} services moved;
              {" "}{group.truncated
                ? `the list is truncated to the requested contributor limit of ${formatCount(report.contributorLimit)}`
                : "every moved service is listed"}.
            </Note>
          </>
        )}
        <Note>{area?.gap ?? "Layout parity is not claimed."}</Note>
        <Note>
          Usage percentage change is unavailable wherever comparable metered units are incomplete:
          {" "}{formatCount(report.capabilities.serviceUsage.missingQuantityRowCount)} rows carry no
          quantity and {formatCount(report.capabilities.serviceUsage.missingUnitRowCount)} carry no
          usable unit, so a usage percentage is withheld rather than computed over unlike units.
        </Note>
      </FinopsSheetBlock>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Area 5 — AWS account trends                                                 */
/* -------------------------------------------------------------------------- */

function AccountTrendsArea({ report, selection }: AreaProps) {
  const series = selectedSeries(report, selection);
  const point = selectedPoint(series, selection);
  const currency = series?.currency ?? selection.currency;
  const accounts = report.capabilities.accounts;
  const group = contributorGroup(point, "account");

  return (
    <div className={styles.blocks}>
      <FinopsSheetBlock
        description={`Payer and usage account identity from ${readable(accounts.evidenceBasis)}. Coverage: ${accounts.state}.`}
        title="Account identity evidence"
      >
        {accounts.entries.length === 0 ? (
          <Unavailable
            title="No account identity evidence is available"
            reasons={["No active CUR2 row carried a usable usage or payer account identifier."]}
          />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>
                Account names come from CUR2 fields only. A conflicting name is reported as a
                conflict and is never resolved by inference.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">Account</th>
                  <th scope="col">Friendly name</th>
                  <th scope="col">Name evidence</th>
                </tr>
              </thead>
              <tbody>
                {accounts.entries.map((entry) => (
                  <tr key={`${entry.role}:${entry.accountId}`}>
                    <th scope="row">{entry.role}</th>
                    <td>{entry.accountId}</td>
                    <td>{entry.friendlyName ?? "Not available"}</td>
                    <td><StateBadge state={entry.nameState.toLowerCase()} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Unavailable
          title="AWS Organizations account taxonomy is unavailable"
          reasons={[
            `Organizations API evidence available: ${accounts.organizationsApiEvidenceAvailable ? "yes" : "no"}.`,
            `${formatCount(accounts.missingPayerAccountIdRowCount)} rows carry no payer account id and ${formatCount(accounts.missingNameRowCount)} carry no account name.`,
            "Friendly names are not invented for accounts the export does not name.",
          ]}
        />
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description={`Exact usage-account cost movement into ${point?.period ?? report.window.toPeriod} in ${currency}.`}
        title="Account movement"
      >
        {group === null || !group.available || group.contributors.length === 0 ? (
          <Unavailable
            title="Account movement cannot be ranked"
            reasons={[
              group === null
                ? "The selected period carries no account contributor group."
                : group.available
                  ? "No account changed between the two periods."
                  : readable(group.unavailableReason ?? "MISSING_PERIOD"),
            ]}
          />
        ) : (
          <>
            <RankingBars
              ariaLabel={`Usage-account cost movement into ${point?.period ?? report.window.toPeriod} in ${currency}`}
              formatValue={(value) => formatUnits(value, currency)}
              items={group.contributors.flatMap((entry) => {
                const units = microsToUnits(entry.deltaMicros);
                return units === null ? [] : [{
                  id: entry.value ?? "__not_reported__",
                  label: entry.value ?? "Account not reported",
                  value: units,
                  detail: formatShareRationalExact(entry.absoluteMovementShare),
                }];
              })}
            />
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>Exact prior and current usage-account cost on the selected basis.</caption>
                <thead>
                  <tr>
                    <th scope="col">Usage account</th>
                    <th className={styles.numeric} scope="col">Prior</th>
                    <th className={styles.numeric} scope="col">Current</th>
                    <th className={styles.numeric} scope="col">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {group.contributors.map((entry) => (
                    <tr key={entry.value ?? "__not_reported__"}>
                      <th scope="row">{entry.value ?? "Account not reported"}</th>
                      <td className={styles.numeric}>{formatMicrosExact(entry.priorMicros, currency)}</td>
                      <td className={styles.numeric}>{formatMicrosExact(entry.currentMicros, currency)}</td>
                      <td className={styles.numeric}>{formatMicrosExact(entry.deltaMicros, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </FinopsSheetBlock>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Area 6 — Filter controls and one-click filtering                            */
/* -------------------------------------------------------------------------- */

function FilterControlsArea({ report, definition, selection }: AreaProps) {
  const totals = definition.quickSightDefinition;
  const series = selectedSeries(report, selection);
  const nativeSelectors: readonly { readonly label: string; readonly value: string }[] = [
    {
      label: "Window (from and to billing period)",
      value: `${report.window.fromPeriod} — ${report.window.toPeriod} · ${formatCount(report.window.periodCount)} periods`,
    },
    {
      label: "Comparison window (months)",
      value: `${formatCount(report.rollingWindowMonths)} · ${windowLabel(report.rollingWindowMonths)}`,
    },
    { label: "Currency", value: report.expectedCurrencies.join(", ") },
    { label: "Cost basis", value: report.selectedCostBases.join(", ") },
    { label: "Selected month", value: selection.period },
    { label: "Contributor dimension", value: CONTRIBUTOR_DIMENSIONS.map(readable).join(", ") },
    { label: "Contributor limit", value: formatCount(report.contributorLimit) },
  ];

  return (
    <div className={styles.blocks}>
      <FinopsSheetBlock
        description="These are Sutra selectors, verifiable from this page. They are not claimed to be the QuickSight field controls: the service-hosted definition is not published, so no control object count exists to match."
        title="Native selectors in this view"
      >
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>Every selector this dashboard exposes, with its current value.</caption>
            <thead>
              <tr>
                <th scope="col">Selector</th>
                <th scope="col">Current value</th>
              </tr>
            </thead>
            <tbody>
              {nativeSelectors.map((entry) => (
                <tr key={entry.label}>
                  <th scope="row">{entry.label}</th>
                  <td>{entry.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Note>
          Selecting a month re-derives the comparison, contributor, taxonomy, usage, account and
          Region panels from the same immutable evidence, which is the one-click behaviour AWS
          documents. Same-sheet QuickSight interaction trees are not reproduced.
        </Note>
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description={`AWS names these controls in its documentation and states the list is not exhaustive (${definition.controlsNotExhaustivelyEnumeratedByAws ? "confirmed by the pinned audit" : "not confirmed"}). They are documented capability names, not counted QuickSight objects.`}
        title="Documented AWS controls"
      >
        <ul className={styles.formulaList} aria-label="Documented AWS Trends controls">
          {definition.documentedControls.map((control) => <li key={control}>{control}</li>)}
        </ul>
        <Unavailable
          title="QuickSight control and parameter counts are unavailable"
          reasons={[
            readable(totals.reason),
            `Filter controls: ${totals.filterControlCount ?? "not published"} · parameter controls: ${totals.parameterControlCount ?? "not published"} · parameters: ${totals.parameterCount ?? "not published"} · calculated fields: ${totals.calculatedFieldCount ?? "not published"}.`,
            `Pixel parity claimed: ${totals.pixelParityClaimed ? "yes" : "no"}.`,
            "Unavailable means not published, not zero.",
          ]}
        />
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Which series the current selection resolves to, so a filtered figure can never be read against the wrong currency or cost basis."
        title="Resolved series"
      >
        <div className={styles.tiles}>
          <Tile label="Currency" value={series?.currency ?? "Not available"} />
          <Tile label="Cost basis" value={series?.costBasis ?? "Not available"} />
          <Tile
            detail={`${formatCount(report.series.length)} series in this snapshot`}
            label="Series points"
            value={formatCount(series?.points.length ?? 0)}
          />
        </div>
      </FinopsSheetBlock>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Area 7 — Global usage map                                                   */
/* -------------------------------------------------------------------------- */

function GeographyArea({ report, selection }: AreaProps) {
  const series = selectedSeries(report, selection);
  const currency = series?.currency ?? selection.currency;
  const basis = series?.costBasis ?? selection.costBasis;
  const geography = report.capabilities.geography;
  const regions = geography.regions.map((entry) => ({
    ...entry,
    cost: entry.costs.find((cost) => cost.currency === currency && cost.costBasis === basis) ?? null,
  }));

  return (
    <div className={styles.blocks}>
      <FinopsSheetBlock
        description="The official area is a geospatial usage map with Region drilldown. Sutra does not ingest authoritative Region coordinates, so no map is drawn and no coordinate is inferred from a Region code."
        title="Geospatial map"
      >
        <Unavailable
          title="The global usage map is unavailable"
          reasons={[
            readable(geography.map.reason),
            "Sutra does not place a Region on a map from an inferred coordinate, and does not exclude or include AWS China Regions on an assumption.",
          ]}
        />
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description={`Region cost and unit-separated metered usage from ${readable(geography.evidenceBasis)}. Coverage: ${geography.state}.`}
        title="Region cost and usage"
      >
        {regions.length === 0 ? (
          <Unavailable
            title="No Region evidence is available"
            reasons={[
              `${formatCount(geography.missingRegionRowCount)} rows carry no valid provider Region and are excluded rather than grouped as an unknown Region.`,
            ]}
          />
        ) : (
          <>
            <RankingBars
              ariaLabel={`Region cost in ${currency} on the ${basis} basis`}
              caption="Regions with no cost on this basis are absent from the ranking and listed in the table below as not available."
              formatValue={(value) => formatUnits(value, currency)}
              items={regions.flatMap((entry) => {
                const units = microsToUnits(entry.cost?.totalMicros ?? null);
                return units === null ? [] : [{
                  id: entry.region,
                  label: entry.region,
                  value: units,
                }];
              })}
              sort
            />
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>
                  Exact Region cost on the selected basis, with metered usage reported separately
                  for each provider unit.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Region</th>
                    <th className={styles.numeric} scope="col">Cost</th>
                    <th scope="col">Metered usage by unit</th>
                  </tr>
                </thead>
                <tbody>
                  {regions.map((entry) => (
                    <tr key={entry.region}>
                      <th scope="row">{entry.region}</th>
                      <td className={styles.numeric}>
                        {entry.cost === null
                          ? "Not available"
                          : formatMicrosExact(entry.cost.totalMicros, entry.cost.currency)}
                      </td>
                      <td>
                        {entry.usage.length === 0
                          ? "Not available"
                          : entry.usage
                            .map((item) => formatUsageMicrosExact(item.usageAmountMicros, item.unit))
                            .join(" · ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Note>
              {formatCount(geography.missingRegionRowCount)} rows carry no valid provider Region.
              Region cost is not a proxy for usage magnitude and usage is not inferred from cost.
            </Note>
          </>
        )}
      </FinopsSheetBlock>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Area 8 — Threshold alerts and scheduled delivery                            */
/* -------------------------------------------------------------------------- */

function AutomationArea({ report }: AreaProps) {
  const automation = report.capabilities.automation;
  const rows = [
    { label: "Sutra alert rules", status: automation.sutraAlertRules, scope: "tenant" },
    {
      label: "Sutra scheduled cost reports",
      status: automation.sutraScheduledCostReports,
      scope: "connection",
    },
  ] as const;

  return (
    <div className={styles.blocks}>
      <FinopsSheetBlock
        description="The official area is QuickSight threshold alerting and scheduled dashboard delivery. Sutra does not ingest that provider configuration, so its state is unavailable rather than reported as none."
        title="QuickSight alerting and delivery"
      >
        <Unavailable
          title="QuickSight automation state is unavailable"
          reasons={[
            `Threshold alerts: ${readable(automation.quickSightThresholdAlerts.reason)}.`,
            `Scheduled delivery: ${readable(automation.quickSightScheduledDelivery.reason)}.`,
            "No QuickSight alert or schedule is created, counted or simulated by this view.",
          ]}
        />
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Sutra automation is separate from QuickSight and is shown as such. It is not presented as parity with the official feature."
        title="Sutra tenant automation"
      >
        <div className={styles.tiles}>
          {rows.map((row) => (
            <Tile
              detail={row.status.available
                ? `${readable(row.status.reason)} · scoped to this ${row.scope}`
                : `Withheld: ${readable(row.status.reason)}`}
              key={row.label}
              label={row.label}
              value={row.status.available
                ? `${formatCount(row.status.enabledCount ?? 0)} enabled of ${formatCount(row.status.configuredCount ?? 0)}`
                : "Unavailable"}
            />
          ))}
        </div>
        {rows.some((row) => !row.status.available) ? (
          <Note>
            A runtime status Sutra could not read is reported as unavailable, never as zero
            configured rules or reports.
          </Note>
        ) : null}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="What this view raises instead: pinned, explainable review thresholds evaluated over immutable evidence."
        title="Pinned review policy"
      >
        <div className={styles.tiles}>
          <Tile
            detail="Absolute month-over-month change"
            label="Month-over-month threshold"
            value={`${report.signalPolicy.momAbsolutePercentThreshold}%`}
          />
          <Tile
            detail={`Against the previous ${formatCount(report.signalPolicy.trailingBaselineMonths)}-month average`}
            label="Trailing deviation threshold"
            value={`${report.signalPolicy.trailingAbsolutePercentThreshold}%`}
          />
          <Tile
            detail="Across every series in this window"
            label="Signals raised"
            value={formatCount(report.summary.signalCount)}
          />
        </div>
        <Note>
          These are informational review signals from pinned thresholds. They are not machine
          learning and are not AWS Cost Anomaly Detection findings.
        </Note>
      </FinopsSheetBlock>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Area 9 — AWS Usage v5.1 additions                                           */
/* -------------------------------------------------------------------------- */

function CalendarSpendArea({ report, definition, selection }: AreaProps) {
  const currency = selectedSeries(report, selection)?.currency ?? selection.currency;
  const currencySeries = report.series.filter((series) => series.currency === currency);
  const periods = currencySeries[0]?.points.map((point) => point.period) ?? [];
  const accounts = report.capabilities.accounts;
  const area = definition.documentedFeatureAreas.find((entry) =>
    entry.name === "AWS Usage v5.1 additions") ?? null;

  return (
    <div className={styles.blocks}>
      <FinopsSheetBlock
        description={`Spend by calendar billing period in ${currency}, one series per selected cost basis. Cost bases are shown side by side and are never added together.`}
        title="Spend by calendar period"
      >
        {periods.length === 0 ? (
          <Unavailable
            title="No calendar period spend is available"
            reasons={[`No series is present for ${currency} in this snapshot.`]}
          />
        ) : (
          <BarChart
            ariaLabel={`Spend by calendar billing period in ${currency}, by cost basis`}
            caption="A missing bar is a period with no collected cost on that basis; it is not a zero bill."
            categories={periods}
            formatValue={(value) => formatUnits(value, currency)}
            series={currencySeries.map((series) => ({
              id: series.costBasis,
              label: `${currency} ${series.costBasis}`,
              values: series.points.map((point) => microsToUnits(point.totalMicros)),
            }))}
          />
        )}
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>Exact calendar-period spend for every selected cost basis in {currency}.</caption>
            <thead>
              <tr>
                <th scope="col">Period</th>
                {currencySeries.map((series) => (
                  <th className={styles.numeric} key={series.costBasis} scope="col">{series.costBasis}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {periods.map((period, index) => (
                <tr key={period}>
                  <th scope="row">{period}</th>
                  {currencySeries.map((series) => {
                    const micros = series.points[index]?.totalMicros ?? null;
                    return (
                      <td className={styles.numeric} key={series.costBasis}>
                        {micros === null ? "Not collected" : formatMicrosExact(micros, currency)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Payer and usage account roles are stated explicitly rather than merged into one account column."
        title="Payer and usage account evidence"
      >
        <div className={styles.tiles}>
          <Tile
            label="Payer accounts"
            value={formatCount(accounts.entries.filter((entry) => entry.role === "PAYER").length)}
          />
          <Tile
            label="Usage accounts"
            value={formatCount(accounts.entries.filter((entry) => entry.role === "USAGE").length)}
          />
          <Tile
            detail={`${formatCount(accounts.missingPayerAccountIdRowCount)} rows carry no payer account id`}
            label="Named accounts"
            value={formatCount(accounts.entries.filter((entry) => entry.nameState === "CUR2_FIELD").length)}
          />
        </div>
        <Note>{area?.gap ?? "Layout parity is not claimed."}</Note>
      </FinopsSheetBlock>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Lineage, shown with every area                                              */
/* -------------------------------------------------------------------------- */

function LineageBlock({ report }: { readonly report: FinopsTrendsSuccessfulReport }) {
  return (
    <FinopsSheetBlock
      description={`Every period in the window with its immutable generation, manifest hash and freshness. Evaluated ${formatIsoUtc(report.evaluatedAtIso)} UTC.`}
      title="Evidence and lineage"
    >
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption>
            Active, reconciled, immutable CUR 2.0 generations only. A period with no generation is
            listed as missing rather than dropped from the window.
          </caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col">State</th>
              <th scope="col">Load kind</th>
              <th scope="col">Generation</th>
              <th scope="col">Manifest SHA-256</th>
              <th className={styles.numeric} scope="col">Rows</th>
              <th className={styles.numeric} scope="col">Rejected</th>
              <th scope="col">Source updated</th>
              <th scope="col">Age against stale limit</th>
            </tr>
          </thead>
          <tbody>
            {report.periods.map((period) => (
              <tr key={period.period}>
                <th scope="row">{period.period}</th>
                <td>
                  <StateBadge state={period.state.toLowerCase()} />
                  <small> {period.stateReasons.map(readable).join(", ")}</small>
                </td>
                <td>{period.loadKind === null ? "Not available" : readable(period.loadKind)}</td>
                <td>{period.generationId ?? "Not available"}</td>
                <td>{period.lineage?.manifestSha256 ?? "Not available"}</td>
                <td className={styles.numeric}>
                  {period.rowCount === null ? "Not available" : formatCount(period.rowCount)}
                </td>
                <td className={styles.numeric}>
                  {period.rejectedRowCount === null
                    ? "Not available"
                    : formatCount(period.rejectedRowCount)}
                </td>
                <td>{formatIsoUtc(period.lineage?.sourceUpdatedAtIso ?? null)}</td>
                <td>
                  {period.ageSeconds === null
                    ? "Not available"
                    : `${formatCount(period.ageSeconds)}s of ${formatCount(period.staleAfterSeconds)}s`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details>
        <summary>Source line-item evidence by period</summary>
        <ul className={styles.formulaList} aria-label="Source line-item evidence by period">
          {report.periods.map((period) => (
            <li key={period.period}>
              {period.period}: {period.lineage === null
                ? "no active generation, so no line-item evidence exists"
                : `${formatCount(period.lineage.sourceLineItemIdCount)} line items${period.lineage.sourceLineItemIdsTruncated ? " (evidence list truncated)" : ""} · evidence ${period.lineage.sourceEvidenceId} · committed ${formatIsoUtc(period.lineage.committedAtIso)}`}
            </li>
          ))}
        </ul>
      </details>

      <ul className={styles.coverageGaps} aria-label="Engine limitations">
        {report.limitations.map((limitation) => <li key={limitation}>{readable(limitation)}</li>)}
      </ul>
      <Note>
        Additional AWS read operations required by this view:
        {" "}{report.additionalReadOperations.length === 0
          ? "none — Trends reuses the already-authorized active CUR 2.0 source"
          : report.additionalReadOperations.join(", ")}.
      </Note>
      <Note>
        Tenant {report.tenant.organizationId} · customer {report.tenant.customerId} · connection
        {" "}{report.tenant.connectionId} · export {report.tenant.exportName}.
      </Note>
    </FinopsSheetBlock>
  );
}

/* -------------------------------------------------------------------------- */
/* One feature area                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One documented feature area. Exported so a test or a server render can assert
 * any area directly, without driving selection state or a fetch.
 */
export function FinopsTrendsFeatureAreaPanel({
  report, definition, area, selection,
}: {
  readonly report: FinopsTrendsSuccessfulReport;
  readonly definition: FinopsTrendsOfficialDefinition;
  readonly area: FeatureArea;
  readonly selection: FinopsTrendsSelection;
}) {
  const props: AreaProps = { report, definition, selection };
  // Widened to string so exhausting the nine pinned names does not narrow `area`
  // itself to never: the defensive branch must stay reachable if the pinned
  // definition ever documents a tenth area.
  const name: string = area.name;
  const body = name === "Periodic trends and actuals"
    ? <PeriodicTrendsArea {...props} />
    : name === "ML-powered forecast"
      ? <ForecastArea {...props} />
      : name === "Service category and service usage trends"
        ? <ServiceTrendsArea {...props} />
        : name === "Three-month service percentage change"
          ? <ServiceChangeArea {...props} />
          : name === "AWS account trends"
            ? <AccountTrendsArea {...props} />
            : name === "Filter controls and one-click filtering"
              ? <FilterControlsArea {...props} />
              : name === "Global usage map"
                ? <GeographyArea {...props} />
                : name === "Threshold alerts and scheduled delivery"
                  ? <AutomationArea {...props} />
                  : name === "AWS Usage v5.1 additions"
                    ? <CalendarSpendArea {...props} />
                    : (
                      <Unavailable
                        title={`Sutra has no native projection for "${name}"`}
                        reasons={[
                          "The area is listed because the pinned AWS audit documents it; it is not presented as delivered.",
                        ]}
                      />
                    );

  return (
    <div className={styles.blocks}>
      <section
        aria-label={`${area.name} coverage`}
        className={styles.coverage}
        data-support={area.nativeCoverage === "SUPPORTED" ? "SUPPORTED" : "PARTIAL"}
      >
        <div className={styles.coverageHead}>
          <strong>{area.name}</strong>
          <span
            className={styles.coverageBadge}
            data-support={area.nativeCoverage === "SUPPORTED" ? "SUPPORTED" : "PARTIAL"}
          >
            {area.nativeCoverage}
          </span>
          <span className={styles.coverageMeta}>documented AWS feature area</span>
        </div>
        <ul className={styles.coverageGaps}>
          <li>AWS purpose: {area.purpose}</li>
          <li>Native evidence: {area.evidence}</li>
          <li>
            {area.gap === null
              ? "No identified semantic gap. Layout, pixel and QuickSight runtime parity are still not claimed."
              : `Remaining gap: ${area.gap}`}
          </li>
        </ul>
      </section>
      {body}
      <LineageBlock report={report} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Workspace                                                                   */
/* -------------------------------------------------------------------------- */

function Field({
  label, children,
}: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className={styles.field}>
      <label>
        {label}
        {children}
      </label>
    </div>
  );
}

/**
 * Presentation for a loaded Trends envelope: the pinned official audit, one tab
 * per documented feature area and the selectors every area reads. Takes the
 * envelope directly so it renders from a test or a server snapshot with no fetch.
 */
export function FinopsTrendsWorkspace({
  envelope, initialAreaName, onWindowChange, onRollingWindowChange,
}: {
  readonly envelope: FinopsTrendsEnvelope;
  readonly initialAreaName?: string;
  readonly onWindowChange?: (fromPeriod: string, toPeriod: string) => void;
  readonly onRollingWindowChange?: (months: number) => void;
}) {
  const definition = envelope.officialDefinition;
  const areas = definition.documentedFeatureAreas;
  const report = envelope.report !== null && envelope.report.ok ? envelope.report : null;

  const [areaName, setAreaName] = useState<string>(initialAreaName ?? areas[0].name);
  const [selection, setSelection] = useState<FinopsTrendsSelection | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const active = useMemo(
    () => areas.find((entry) => entry.name === areaName) ?? areas[0],
    [areaName, areas],
  );

  /**
   * Roving tab movement, matching the Foundational sheet shell: nine tabs is too
   * many to reach the last one by tabbing through every panel before it.
   */
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = areas.findIndex((entry) => entry.name === areaName);
    const index = current < 0 ? 0 : current;
    const last = areas.length - 1;
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? last
        : event.key === "ArrowLeft"
          ? (index === 0 ? last : index - 1)
          : (index === last ? 0 : index + 1);
    const target = areas[next];
    if (target === undefined) return;
    setAreaName(target.name);
    tabsRef.current
      ?.querySelector<HTMLButtonElement>(`#trends-tab-${slug(target.name)}`)
      ?.focus();
  }, [areaName, areas]);

  const resolved: FinopsTrendsSelection | null = report === null
    ? null
    : selection ?? defaultTrendsSelection(report);

  if (report === null || resolved === null) return null;

  const currencies = [...new Set(report.series.map((series) => series.currency))];
  const bases = [...new Set(report.series.map((series) => series.costBasis))];
  const series = selectedSeries(report, resolved);
  const periods = series?.points.map((point) => point.period) ?? [];
  const windowPeriods = [...new Set([
    ...envelope.availablePeriods.map((entry) => entry.period),
    report.window.fromPeriod,
    report.window.toPeriod,
  ])].sort((left, right) => left.localeCompare(right));

  return (
    <>
      <TrendsOfficialCoverage definition={definition} />

      <div className={styles.shell}>
        <div className={styles.shellHead}>
          <p className={styles.inventory}>
            <span><b>{areas.length}</b> documented AWS feature areas</span>
            <span><b>{definition.documentedControls.length}</b> documented control names</span>
            <span><b>{definition.datasets.length}</b> published SPICE datasets</span>
            <span>
              QuickSight sheets and visuals:
              {" "}<b>{definition.quickSightDefinition.sheetCount ?? "not published"}</b>
            </span>
            <span className={styles.inventoryPin}>
              pinned {definition.source.commit.slice(0, 12)} · {definition.source.latestDocumentedVersion}
            </span>
          </p>
        </div>

        <div
          aria-label="Documented AWS Trends feature areas"
          className={styles.tabs}
          onKeyDown={onKeyDown}
          ref={tabsRef}
          role="tablist"
        >
          {areas.map((entry) => {
            const selected = entry.name === active.name;
            return (
              <button
                aria-controls={`trends-panel-${slug(entry.name)}`}
                aria-selected={selected}
                className={selected
                  ? `${styles.tab} ${styles.tabActive}`
                  : entry.nativeCoverage === "SUPPORTED"
                    ? styles.tab
                    : `${styles.tab} ${styles.tabPartial}`}
                id={`trends-tab-${slug(entry.name)}`}
                key={entry.name}
                onClick={() => setAreaName(entry.name)}
                role="tab"
                tabIndex={selected ? 0 : -1}
                type="button"
              >
                {entry.name}
                <span className={styles.tabCount}>{entry.nativeCoverage.slice(0, 1)}</span>
              </button>
            );
          })}
        </div>

        <div
          aria-labelledby={`trends-tab-${slug(active.name)}`}
          className={styles.panel}
          id={`trends-panel-${slug(active.name)}`}
          role="tabpanel"
          tabIndex={0}
        >
          <div className={styles.toolbar}>
            <Field label="Currency">
              <select
                onChange={(event) => setSelection({ ...resolved, currency: event.target.value })}
                value={resolved.currency}
              >
                {currencies.map((currency) => <option key={currency}>{currency}</option>)}
              </select>
            </Field>
            <Field label="Cost basis">
              <select
                onChange={(event) => setSelection({
                  ...resolved,
                  costBasis: event.target.value as FinopsCostBasis,
                })}
                value={resolved.costBasis}
              >
                {bases.map((basis) => <option key={basis}>{basis}</option>)}
              </select>
            </Field>
            <Field label="Month">
              <select
                onChange={(event) => setSelection({ ...resolved, period: event.target.value })}
                value={series?.points.some((point) => point.period === resolved.period) === true
                  ? resolved.period
                  : periods.at(-1) ?? resolved.period}
              >
                {periods.map((period) => <option key={period}>{period}</option>)}
              </select>
            </Field>
            <Field label="Contributor dimension">
              <select
                onChange={(event) => setSelection({
                  ...resolved,
                  dimension: event.target.value as FinopsTrendsDimension,
                })}
                value={resolved.dimension}
              >
                {CONTRIBUTOR_DIMENSIONS.map((dimension) => (
                  <option key={dimension} value={dimension}>{readable(dimension)}</option>
                ))}
              </select>
            </Field>
            {onWindowChange === undefined ? null : (
              <>
                <Field label="From period">
                  <select
                    onChange={(event) =>
                      onWindowChange(event.target.value, report.window.toPeriod)}
                    value={report.window.fromPeriod}
                  >
                    {windowPeriods.map((period) => <option key={period}>{period}</option>)}
                  </select>
                </Field>
                <Field label="To period">
                  <select
                    onChange={(event) =>
                      onWindowChange(report.window.fromPeriod, event.target.value)}
                    value={report.window.toPeriod}
                  >
                    {windowPeriods.map((period) => <option key={period}>{period}</option>)}
                  </select>
                </Field>
              </>
            )}
            {onRollingWindowChange === undefined ? null : (
              <Field label="Comparison window">
                <select
                  onChange={(event) => onRollingWindowChange(Number(event.target.value))}
                  value={String(report.rollingWindowMonths)}
                >
                  <option value="1">Monthly</option>
                  <option value="3">Quarterly</option>
                  <option value="12">Yearly</option>
                </select>
              </Field>
            )}
          </div>

          <FinopsTrendsFeatureAreaPanel
            area={active}
            definition={definition}
            report={report}
            selection={resolved}
          />
        </div>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Container                                                                   */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the tenant binding, the report schema and the pinned official audit. */
function readTrendsEnvelope(body: unknown, connectionId: string): FinopsTrendsEnvelope {
  if (
    !isRecord(body)
    || body.connectionId !== connectionId
    || typeof body.sourceState !== "string"
    || !Array.isArray(body.availablePeriods)
    || !("report" in body)
  ) throw new Error("The Trends response did not match its tenant-bound contract.");
  if (
    !isRecord(body.officialDefinition)
    || body.officialDefinition.schema !== "sutra.finops-trends-official-definition.v1"
  ) throw new Error("The pinned Trends official-definition audit was not recognized.");
  const report = body.report;
  if (report !== null) {
    if (!isRecord(report) || report.schema !== "sutra.finops-trends-intelligence.v1") {
      throw new Error("The Trends report schema was not recognized.");
    }
    if (
      report.ok === true
      && (
        !isRecord(report.capabilities)
        || report.capabilities.schema !== "sutra.finops-trends-capability-closure.v1"
      )
    ) throw new Error("The Trends capability closure was not recognized.");
  }
  return body as unknown as FinopsTrendsEnvelope;
}

function trendsUrl(
  connectionId: string,
  periodWindow: { readonly fromPeriod: string; readonly toPeriod: string } | null,
  rollingWindowMonths: number,
): string {
  const query = new URLSearchParams({
    connectionId,
    costBases: "unblended,amortized",
    rollingWindowMonths: String(rollingWindowMonths),
    contributorLimit: "8",
  });
  if (periodWindow !== null) {
    query.set("fromPeriod", periodWindow.fromPeriod);
    query.set("toPeriod", periodWindow.toPeriod);
  }
  return `/api/v1/finops/trends?${query.toString()}`;
}

/** Explains a source state that produced no report, without inventing a figure. */
function SourceNotice({
  sourceState, onRetry,
}: { readonly sourceState: string; readonly onRetry: () => void }) {
  const detail = sourceState === "source_incomplete"
    ? "The active generation does not carry a complete unblended cost basis for every selected period, so no trend is derived from it."
    : sourceState === "empty"
      ? "The active generation carries no accepted billing row for this window."
      : "No active reconciled CUR 2.0 generation is available for this window yet.";
  return (
    <div className={styles.coverage} data-support="PARTIAL" role="status">
      <div className={styles.coverageHead}>
        <strong>Trends is waiting for immutable CUR 2.0 evidence</strong>
        <span className={styles.coverageBadge} data-support="PARTIAL">{readable(sourceState)}</span>
      </div>
      <ul className={styles.coverageGaps}>
        <li>{detail}</li>
        <li>Sutra never substitutes Cost Explorer snapshots, fixtures or another tenant&apos;s data.</li>
      </ul>
      <button onClick={onRetry} type="button">Check again</button>
    </div>
  );
}

/**
 * ADD-09 Trends for one customer connection. Owns only the fetch lifecycle; all
 * presentation lives in `FinopsTrendsWorkspace`.
 */
export function FinopsTrendsDashboard({
  connectionId,
}: { readonly connectionId: string | null }) {
  const [nonce, setNonce] = useState(0);
  const [periodWindow, setPeriodWindow] = useState<{
    readonly fromPeriod: string;
    readonly toPeriod: string;
  } | null>(null);
  const [rollingWindowMonths, setRollingWindowMonths] = useState(3);
  /**
   * Settled results are keyed by the request that produced them, so `idle` and
   * `loading` are derived rather than written from the effect, and a late
   * response for a superseded request can never be displayed.
   */
  const [settled, setSettled] = useState<{
    readonly key: string;
    readonly state: EndpointState<FinopsTrendsEnvelope>;
  } | null>(null);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const url = connectionId === null
    ? null
    : trendsUrl(connectionId, periodWindow, rollingWindowMonths);
  const key = url === null ? null : `${nonce}:${url}`;

  useEffect(() => {
    if (url === null || key === null || connectionId === null) return;
    const controller = new AbortController();
    let live = true;
    void (async () => {
      try {
        const response = await fetch(url, {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const message = isRecord(body) && isRecord(body.error)
            && typeof body.error.message === "string"
            ? body.error.message
            : "The Trends request failed.";
          throw new Error(message);
        }
        const envelope = readTrendsEnvelope(body, connectionId);
        if (live) setSettled({ key, state: stateForEnvelope(envelope) });
      } catch (error) {
        if (!live || controller.signal.aborted) return;
        setSettled({
          key,
          state: {
            status: "error",
            message: error instanceof Error
              ? error.message
              : "Sutra could not load the immutable Trends evidence.",
          },
        });
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [connectionId, key, url]);

  const state: EndpointState<FinopsTrendsEnvelope> = url === null
    ? { status: "idle" }
    : settled !== null && settled.key === key
      ? settled.state
      : { status: "loading" };

  const envelope = "envelope" in state ? state.envelope ?? null : null;
  const onWindowChange = useCallback((fromPeriod: string, toPeriod: string) => {
    setPeriodWindow(fromPeriod <= toPeriod
      ? { fromPeriod, toPeriod }
      : { fromPeriod: toPeriod, toPeriod: fromPeriod });
  }, []);

  return (
    <section aria-label="Trends dashboard" className={styles.shell}>
      <EndpointBoundary onRetry={reload} state={state} title="the Trends dashboard" />
      {envelope === null ? null : envelope.report !== null && envelope.report.ok ? (
        <FinopsTrendsWorkspace
          envelope={envelope}
          onRollingWindowChange={setRollingWindowMonths}
          onWindowChange={onWindowChange}
        />
      ) : (
        <>
          <SourceNotice onRetry={reload} sourceState={envelope.sourceState} />
          <TrendsOfficialCoverage definition={envelope.officialDefinition} />
        </>
      )}
    </section>
  );
}

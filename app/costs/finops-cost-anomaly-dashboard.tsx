"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart,
  DonutChart,
  RankingBars,
  ShareBar,
  Sparkline,
  TimeSeriesChart,
} from "../components/charts";
import {
  EndpointBoundary,
  StateBadge,
  formatMicrosExact,
  type EndpointState,
} from "./finops-foundational-panels";
import {
  sheetKey,
  type FinopsSheetDescriptor,
  type FinopsSheetInventory,
} from "./finops-foundational-sheets";
import {
  FinopsSheetBlock,
  FinopsSheetShell,
  foundationalStyles as styles,
} from "./finops-foundational-sheet-shell";
import { formatCount, formatUnits, microsToUnits } from "./finops-foundational-money";
import {
  COST_ANOMALY_OFFICIAL_DEFINITION,
  type CostAnomalyOfficialDefinition,
  type CostAnomalyOfficialVisual,
} from "../../lib/finops-cost-anomaly-official-definition";
import type {
  CostAnomalyObservedAmount,
  CostAnomalyProviderAnalysis,
  CostAnomalyProviderMover,
} from "../../lib/finops-aws-cost-anomaly";

/**
 * ADV-03 AWS Cost Anomaly Detection, presented as the two sheets AWS publishes
 * in the pinned CID definition rather than as concern-based panels.
 *
 * The sheet set, visual inventory and control counts come from the hash-pinned
 * official definition, so this view cannot invent or omit an official sheet, and
 * each official visual is rendered from the fields `/api/v1/finops/cost-anomaly`
 * actually returns — nothing else.
 *
 * Two honesty rules govern the money here, and they are different rules because
 * the two engines carry money differently:
 *
 * - AWS Cost Anomaly Detection returns impact, spend and root-cause contribution
 *   as JSON numbers in the payer account's billing currency, and does not return
 *   a currency code. Those values are printed exactly as AWS reported them, with
 *   no currency symbol invented and no rounding applied. `formatMicrosExact` is
 *   deliberately not used on them: they are not integer micro-unit strings, and
 *   passing them through a micro formatter would print "Not available" for real
 *   provider evidence.
 * - Sutra's independent statistical billing signals are canonical integer
 *   micro-unit strings with a real currency, so they are printed with
 *   `formatMicrosExact` and converted with `microsToUnits` only for chart
 *   geometry.
 *
 * A value AWS did not report stays an explicit labelled gap. Aggregates carry the
 * count of provider values that were present, so a total is never read as if it
 * covered every finding. A percentage AWS withheld is stated as withheld and is
 * never recomputed from other fields.
 */

/* ---------------------------------------------------------------------------
 * The response contract, exactly as `app/api/v1/finops/cost-anomaly/route.ts`
 * serializes it. Fields absent from the route's `publicDashboard` projection —
 * monitor ARNs and names, subscription ARNs and names, anomaly dimension values,
 * linked-account names, collection limitations — are absent here too.
 * ------------------------------------------------------------------------- */

export type CostAnomalyState = "complete" | "partial" | "stale" | "failed" | "waiting";

export interface CostAnomalyOperationCoverageView {
  readonly operation: string;
  readonly status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  readonly pagesObserved: number;
  readonly recordsObserved: number;
  readonly recordsAccepted: number;
  readonly recordsRejected: number;
  readonly recordsOmitted: number;
  readonly errorCode: string | null;
}

export interface CostAnomalyRootCauseView {
  readonly service: string | null;
  readonly region: string | null;
  readonly linkedAccountId: string | null;
  readonly usageType: string | null;
  readonly contribution: number | null;
}

export interface CostAnomalyFindingView {
  readonly anomalyId: string;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly feedback: "YES" | "NO" | "PLANNED_ACTIVITY" | null;
  readonly score: { readonly current: number; readonly maximum: number };
  readonly impact: {
    readonly maximum: number;
    readonly total: number | null;
    readonly actualSpend: number | null;
    readonly expectedSpend: number | null;
    readonly percentage: number | null;
  };
  readonly rootCauses: readonly CostAnomalyRootCauseView[];
  readonly rootCausesOmitted: number;
  readonly monitorType: "CUSTOM" | "DIMENSIONAL" | null;
  readonly monitorDimension: "SERVICE" | "LINKED_ACCOUNT" | "TAG" | "COST_CATEGORY" | null;
}

export interface CostAnomalyMonitorView {
  readonly type: "CUSTOM" | "DIMENSIONAL";
  readonly dimension: "SERVICE" | "LINKED_ACCOUNT" | "TAG" | "COST_CATEGORY" | null;
  readonly specificationPresent: boolean;
  readonly dimensionalValueCount: number | null;
  readonly lastEvaluatedAt: string | null;
}

export interface CostAnomalySubscriptionView {
  readonly frequency: "IMMEDIATE" | "DAILY" | "WEEKLY";
  readonly monitorCount: number;
  readonly monitorArnsOmitted: number;
  readonly threshold: number | null;
  readonly thresholdExpressionPresent: boolean;
  readonly subscriberCounts: {
    readonly emailConfirmed: number;
    readonly emailDeclined: number;
    readonly snsConfirmed: number;
    readonly snsDeclined: number;
    readonly unknown: number;
  };
}

export interface CostAnomalyStatisticalFinding {
  readonly dateIso: string;
  readonly service: string;
  readonly currency: string;
  readonly amountMicros: string;
  readonly baselineMicros: string;
  readonly ratio: number;
}

export interface CostAnomalyReport {
  readonly aws: {
    readonly source: "AWS_COST_EXPLORER_COST_ANOMALY_DETECTION";
    readonly status: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
    readonly windowStartDate: string;
    readonly windowEndDate: string;
    readonly coverage: readonly CostAnomalyOperationCoverageView[];
    readonly anomalies: readonly CostAnomalyFindingView[];
    readonly monitors: readonly CostAnomalyMonitorView[];
    readonly subscriptions: readonly CostAnomalySubscriptionView[];
    readonly disclaimer: string;
  };
  readonly sutra: {
    readonly source: "SUTRA_STATISTICAL_BILLING_SIGNALS";
    readonly anomalies: readonly CostAnomalyStatisticalFinding[];
    readonly evaluatedDays: number;
    readonly disclaimer: string;
  };
  readonly analysis: CostAnomalyProviderAnalysis;
  readonly disclaimer: string;
}

export interface CostAnomalyEnvelope {
  readonly source: "AWS_COST_EXPLORER_COST_ANOMALY_DETECTION";
  readonly officialDefinition: CostAnomalyOfficialDefinition;
  readonly state: CostAnomalyState;
  readonly latestAttemptStatus: string | null;
  readonly collectedAt: string | null;
  readonly dataThroughAt: string | null;
  readonly freshness: {
    readonly ageHours: number | null;
    readonly staleAfterHours: number;
  };
  readonly dashboard: CostAnomalyReport | null;
  readonly sutraInput: {
    readonly periods: readonly string[];
    readonly lineCount: number;
    readonly capped: boolean;
  };
}

/* ---------------------------------------------------------------------------
 * Official sheet inventory, derived from the pinned definition only.
 * ------------------------------------------------------------------------- */

const OFFICIAL = COST_ANOMALY_OFFICIAL_DEFINITION;

/** The audited visuals of the one sheet that carries visuals. */
const OFFICIAL_VISUALS: readonly CostAnomalyOfficialVisual[] = OFFICIAL.sheets[0].visuals;

function visualByName(name: string): CostAnomalyOfficialVisual | null {
  return OFFICIAL_VISUALS.find((visual) => visual.name === name) ?? null;
}

function sheetDescriptors(): readonly FinopsSheetDescriptor[] {
  return OFFICIAL.sheets.map((sheet) => {
    const visuals: readonly CostAnomalyOfficialVisual[] = sheet.visuals;
    // Only a sheet whose every audited visual is SUPPORTED may read as covered.
    const supported = visuals.length > 0
      && visuals.every((visual) => visual.coverage === "SUPPORTED");
    const gaps = visuals.length === 0
      // The About sheet publishes no visual; its audit lives in the disclosures.
      ? [...OFFICIAL.disclosures]
      : [...new Set(visuals
        .filter((visual) => visual.coverage !== "SUPPORTED")
        .map((visual) => `${visual.name}: ${visual.remainingGap}`))];
    return Object.freeze({
      key: sheetKey(sheet.name),
      name: sheet.name,
      visualCount: sheet.visualCount,
      controlCount: sheet.parameterControls.length + sheet.filterControls.length,
      support: supported ? ("SUPPORTED" as const) : ("PARTIAL" as const),
      supportLabel: supported
        ? "SUPPORTED"
        : visuals.length === 0
          ? "ABOUT"
          : "PARTIAL_SEMANTICS",
      gaps: Object.freeze(gaps),
      formulaIds: Object.freeze([]),
    });
  });
}

/** ADV-03 Cost Anomaly — 2 official sheets, 6 visuals, 12 control placements. */
export const FINOPS_COST_ANOMALY_SHEETS: FinopsSheetInventory = (() => {
  const sheets = sheetDescriptors();
  return Object.freeze({
    sheets: Object.freeze(sheets),
    totalSheets: sheets.length,
    totalVisuals: sheets.reduce((sum, sheet) => sum + sheet.visualCount, 0),
    totalControls: sheets.reduce((sum, sheet) => sum + sheet.controlCount, 0),
    supportedSheets: sheets.filter((sheet) => sheet.support === "SUPPORTED").length,
    partialSheets: sheets.filter((sheet) => sheet.support === "PARTIAL").length,
    source: Object.freeze({
      repository: OFFICIAL.source.repository,
      commit: OFFICIAL.source.commit,
      path: OFFICIAL.source.manifestPath,
      sha256: OFFICIAL.source.embeddedDefinitionSha256,
      version: null,
    }),
  });
})();

/* ---------------------------------------------------------------------------
 * Formatting. Provider money and Sutra money are formatted by different rules.
 * ------------------------------------------------------------------------- */

const GROUPS = /\B(?=(\d{3})+(?!\d))/gu;

/**
 * Prints an AWS-reported amount exactly as AWS reported it.
 *
 * AWS Cost Anomaly Detection returns these as JSON numbers in the payer's
 * billing currency and supplies no currency code, so no symbol is added and no
 * rounding is applied — the digits are the provider's own.
 */
export function formatProviderAmount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Not reported by AWS";
  const text = Math.abs(value).toString();
  if (text.includes("e")) return `${value < 0 ? "−" : ""}${text}`;
  const [whole, fraction] = text.split(".");
  const grouped = (whole ?? "0").replace(GROUPS, ",");
  return `${value < 0 ? "−" : ""}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

/** A provider percentage AWS withheld is stated as withheld, never derived. */
function formatProviderPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "Withheld by AWS";
  }
  return `${formatProviderAmount(value)}%`;
}

/** A provider score is a 0-100 confidence figure, not money and not a percentage. */
function formatScore(value: number): string {
  return Number.isFinite(value) ? value.toString() : "Not reported by AWS";
}

function formatRatio(value: number): string {
  return Number.isFinite(value) ? `${value.toString()}×` : "Not available";
}

function formatUtc(value: string | null): string {
  if (value === null) return "Not available";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(parsed));
}

function readable(value: string): string {
  return value.replaceAll("_", " ");
}

/** How many of a finding population actually carried the provider value. */
function observedDetail(amount: CostAnomalyObservedAmount): string {
  const population = amount.observedValueCount + amount.unavailableValueCount;
  if (population === 0) return "No finding was returned for this window";
  if (amount.unavailableValueCount === 0) {
    return `All ${formatCount(population)} findings reported this value`;
  }
  return `${formatCount(amount.observedValueCount)} of ${formatCount(population)} findings`
    + ` reported this value · ${formatCount(amount.unavailableValueCount)} withheld by AWS`;
}

function observedValue(amount: CostAnomalyObservedAmount): string {
  return formatProviderAmount(amount.total);
}

function assessmentLabel(feedback: CostAnomalyFindingView["feedback"]): string {
  if (feedback === "YES") return "Accurate anomaly";
  if (feedback === "NO") return "Not an issue";
  if (feedback === "PLANNED_ACTIVITY") return "Planned activity";
  return "Not submitted";
}

/**
 * Provider-window lifecycle, exactly the basis the engine records:
 * `PROVIDER_END_DATE_RELATIVE_TO_COLLECTION_DAY`. When the collection day is
 * unknown the lifecycle is withheld rather than guessed from today's date.
 */
function lifecycleLabel(endDate: string | null, collectionDay: string | null): string {
  if (collectionDay === null) return "Lifecycle unavailable";
  return endDate === null || endDate >= collectionDay ? "Open window" : "Window ended";
}

/* ---------------------------------------------------------------------------
 * Small shared presentation pieces.
 * ------------------------------------------------------------------------- */

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

function NoEvidence({ reason }: { readonly reason: string }) {
  return (
    <div className={styles.coverage} data-support="PARTIAL" role="status">
      <div className={styles.coverageHead}>
        <strong>No provider evidence for this visual in the collected window</strong>
      </div>
      <ul className={styles.coverageGaps}><li>{reason}</li></ul>
    </div>
  );
}

/** The audited coverage note of one official visual, shown with the visual. */
function VisualAudit({ name }: { readonly name: string }) {
  const visual = visualByName(name);
  if (visual === null) return null;
  return (
    <p className={styles.goalMeta}>
      Official {visual.type.toLowerCase()} · {readable(visual.coverage)} ·{" "}
      {visual.nativeEvidence} <strong>Remaining gap:</strong> {visual.remainingGap}
    </p>
  );
}

/** Which movers had no provider contribution, so a ranking never looks total. */
function WithheldMovers({
  movers, dimension,
}: { readonly movers: readonly CostAnomalyProviderMover[]; readonly dimension: string }) {
  const withheld = movers.filter((mover) => mover.contribution.total === null);
  if (withheld.length === 0) return null;
  return (
    <p className={styles.goalMeta}>
      {formatCount(withheld.length)} {dimension}{" "}
      {withheld.length === 1 ? "value appears" : "values appear"} in provider root causes with no
      contribution amount, so {withheld.length === 1 ? "it is" : "they are"} excluded from the
      ranking rather than plotted as zero: {withheld.map((mover) => mover.value).join(", ")}.
    </p>
  );
}

function MoverRanking({
  movers, dimension, label, officialVisual,
}: {
  readonly movers: readonly CostAnomalyProviderMover[];
  readonly dimension: string;
  readonly label: string;
  /** The official visual this ranking answers, where one exists. */
  readonly officialVisual?: string;
}) {
  return (
    <FinopsSheetBlock
      description={`Provider-reported root-cause contribution grouped by ${dimension}. Contribution is the amount AWS attributed to the cause, not the finding's total impact.${officialVisual === undefined ? " This dimension is outside the six official visuals; AWS returns it, so Sutra shows it." : ""}`}
      title={label}
    >
      <RankingBars
        ariaLabel={`Provider root-cause contribution by ${dimension} in the payer billing currency`}
        formatValue={formatProviderAmount}
        items={movers.flatMap((mover) => mover.contribution.total === null ? [] : [{
          id: mover.value,
          label: mover.value,
          value: mover.contribution.total,
          detail: `${formatCount(mover.findingCount)} ${mover.findingCount === 1 ? "finding" : "findings"} · ${observedDetail(mover.contribution)}`,
        }])}
        sort
      />
      <WithheldMovers dimension={dimension} movers={movers} />
      {officialVisual === undefined ? null : <VisualAudit name={officialVisual} />}
    </FinopsSheetBlock>
  );
}

/* ---------------------------------------------------------------------------
 * Sheet 1 — "AWS Cost Anomalies": the six official visuals plus the provider
 * detection configuration the API returns.
 * ------------------------------------------------------------------------- */

function DailyImpactVisual({ analysis }: { readonly analysis: CostAnomalyProviderAnalysis }) {
  if (analysis.monthly.length === 0) {
    return (
      <FinopsSheetBlock title="Daily Cost Anomalies Total Impact">
        <NoEvidence reason="No accepted finding carried a provider start date, so no impact period can be formed. This is an absence of provider evidence, not an impact of zero." />
        <VisualAudit name="Daily Cost Anomalies Total Impact" />
      </FinopsSheetBlock>
    );
  }
  const values = analysis.monthly.map((bucket) => bucket.totalImpact.total);
  return (
    <FinopsSheetBlock
      description="Provider total impact over the collected window. A period whose findings reported no total impact is a gap, not a zero."
      title="Daily Cost Anomalies Total Impact"
    >
      <BarChart
        ariaLabel="Provider total impact by anomaly start month in the payer billing currency"
        categories={analysis.monthly.map((bucket) => bucket.month)}
        formatValue={formatProviderAmount}
        series={[{ id: "total-impact", label: "Observed total impact", values }]}
      />
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption>
            Each period states how many of its findings reported a total impact, so a
            period total is never read as covering every finding.
          </caption>
          <thead>
            <tr>
              <th scope="col">Anomaly start month</th>
              <th className={styles.numeric} scope="col">Findings</th>
              <th className={styles.numeric} scope="col">Observed total impact</th>
              <th scope="col">Provider values</th>
            </tr>
          </thead>
          <tbody>
            {analysis.monthly.map((bucket) => (
              <tr key={bucket.month}>
                <th scope="row">{bucket.month}</th>
                <td className={styles.numeric}>{formatCount(bucket.findingCount)}</td>
                <td className={styles.numeric}>{observedValue(bucket.totalImpact)}</td>
                <td>{observedDetail(bucket.totalImpact)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <VisualAudit name="Daily Cost Anomalies Total Impact" />
    </FinopsSheetBlock>
  );
}

function TotalImpactVisual({ analysis }: { readonly analysis: CostAnomalyProviderAnalysis }) {
  const { summary, monthly } = analysis;
  const spark = monthly.map((bucket) => bucket.totalImpact.total);
  const aggregates = [
    { label: "Observed total impact", amount: summary.totalImpact },
    { label: "Sum of per-finding maximum daily impact", amount: summary.maximumImpact },
    { label: "Observed actual spend", amount: summary.actualSpend },
    { label: "Observed expected spend", amount: summary.expectedSpend },
  ] as const;

  return (
    <FinopsSheetBlock
      description="Aggregated only from provider values that are present. Maximum daily impact is never substituted for total impact, and an absent value is never counted as zero."
      title="Total Impact Cost"
    >
      <div className={styles.tiles}>
        <Tile
          detail={`${formatCount(summary.openWindowCount)} open · ${formatCount(summary.endedWindowCount)} ended, by ${readable(analysis.lifecycleBasis.toLowerCase())}`}
          label="Provider findings"
          value={formatCount(summary.findingCount)}
        />
        {aggregates.map((entry) => (
          <Tile
            detail={observedDetail(entry.amount)}
            key={entry.label}
            label={entry.label}
            value={observedValue(entry.amount)}
          />
        ))}
        {spark.filter((value) => value !== null).length < 2 ? null : (
          <div className={styles.tile}>
            <span className={styles.tileLabel}>Total impact shape by month</span>
            <span className={styles.tileSpark}>
              <Sparkline
                ariaLabel="Shape of observed provider total impact across anomaly start months; exact figures are listed in the table above"
                values={spark}
              />
            </span>
            <span className={styles.tileDetail}>
              Shape only — the exact figures are in the period table.
            </span>
          </div>
        )}
      </div>

      <BarChart
        ariaLabel="Provider impact and spend aggregates in the payer billing currency"
        categories={aggregates.map((entry) => entry.label)}
        formatValue={formatProviderAmount}
        series={[{
          id: "aggregate",
          label: "Observed provider amount",
          values: aggregates.map((entry) => entry.amount.total),
        }]}
      />

      {monthly.length === 0 ? null : (
        <TimeSeriesChart
          ariaLabel="Observed actual spend against observed expected spend by anomaly start month, in the payer billing currency"
          formatValue={formatProviderAmount}
          mode="line"
          series={[
            {
              id: "actual",
              label: "Observed actual spend",
              points: monthly.map((bucket) => ({
                label: bucket.month,
                value: bucket.actualSpend.total,
              })),
            },
            {
              id: "expected",
              label: "Observed expected spend",
              points: monthly.map((bucket) => ({
                label: bucket.month,
                value: bucket.expectedSpend.total,
              })),
            },
          ]}
        />
      )}
      <VisualAudit name="Total Impact Cost" />
    </FinopsSheetBlock>
  );
}

function DetailsVisual({
  report, collectionDay,
}: { readonly report: CostAnomalyReport; readonly collectionDay: string | null }) {
  const anomalies = report.aws.anomalies;
  if (anomalies.length === 0) {
    return (
      <FinopsSheetBlock title="AWS Cost Anomalies Details">
        <NoEvidence reason={`AWS accepted no anomaly finding for ${report.aws.windowStartDate} to ${report.aws.windowEndDate}. An empty finding list is a provider statement about this window, not proof that spend was correct.`} />
        <VisualAudit name="AWS Cost Anomalies Details" />
      </FinopsSheetBlock>
    );
  }
  const causeRows = anomalies.flatMap((anomaly) =>
    anomaly.rootCauses.map((cause, index) => ({ anomaly, cause, index })));

  return (
    <FinopsSheetBlock
      description="Every accepted finding with its provider impact, score, assessment and monitor metadata. Values AWS did not return are labelled, never filled in."
      title="AWS Cost Anomalies Details"
    >
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption>
            Bounded provider findings. Impact, spend and score are AWS observations for the
            displayed window; the impact percentage is shown only when AWS reported it.
          </caption>
          <thead>
            <tr>
              <th scope="col">Anomaly</th>
              <th scope="col">Provider window</th>
              <th scope="col">Lifecycle</th>
              <th scope="col">Assessment</th>
              <th className={styles.numeric} scope="col">Score (current / max)</th>
              <th className={styles.numeric} scope="col">Total impact</th>
              <th className={styles.numeric} scope="col">Max daily impact</th>
              <th className={styles.numeric} scope="col">Actual spend</th>
              <th className={styles.numeric} scope="col">Expected spend</th>
              <th className={styles.numeric} scope="col">Impact percentage</th>
              <th scope="col">Monitor</th>
              <th scope="col">Root causes</th>
            </tr>
          </thead>
          <tbody>
            {anomalies.map((anomaly) => (
              <tr key={anomaly.anomalyId}>
                <th scope="row">{anomaly.anomalyId}</th>
                <td>
                  {anomaly.startDate ?? "Start date not reported by AWS"}
                  {" → "}
                  {anomaly.endDate ?? "still open"}
                </td>
                <td>{lifecycleLabel(anomaly.endDate, collectionDay)}</td>
                <td>{assessmentLabel(anomaly.feedback)}</td>
                <td className={styles.numeric}>
                  {formatScore(anomaly.score.current)} / {formatScore(anomaly.score.maximum)}
                </td>
                <td className={styles.numeric}>{formatProviderAmount(anomaly.impact.total)}</td>
                <td className={styles.numeric}>{formatProviderAmount(anomaly.impact.maximum)}</td>
                <td className={styles.numeric}>{formatProviderAmount(anomaly.impact.actualSpend)}</td>
                <td className={styles.numeric}>{formatProviderAmount(anomaly.impact.expectedSpend)}</td>
                <td className={styles.numeric}>{formatProviderPercent(anomaly.impact.percentage)}</td>
                <td>
                  {anomaly.monitorType === null
                    ? "Monitor not returned"
                    : `${readable(anomaly.monitorType)}${anomaly.monitorDimension === null ? "" : ` · ${readable(anomaly.monitorDimension)}`}`}
                </td>
                <td>
                  {anomaly.rootCauses.length === 0
                    ? "AWS returned no root cause"
                    : `${formatCount(anomaly.rootCauses.length)} returned`}
                  {anomaly.rootCausesOmitted === 0
                    ? ""
                    : ` · ${formatCount(anomaly.rootCausesOmitted)} omitted by the bounded read`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {causeRows.length === 0 ? (
        <p className={styles.goalMeta}>
          No finding in this window carried a provider root cause, so no dimensional drilldown
          exists. Sutra does not attribute a finding to a service, account, region or usage type
          that AWS did not name.
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>
              Provider root-cause drilldown. Each dimension appears only where AWS supplied it;
              a blank dimension is reported as not supplied rather than inferred.
            </caption>
            <thead>
              <tr>
                <th scope="col">Anomaly</th>
                <th scope="col">Service</th>
                <th scope="col">Linked account</th>
                <th scope="col">Region</th>
                <th scope="col">Usage type</th>
                <th className={styles.numeric} scope="col">Contribution</th>
              </tr>
            </thead>
            <tbody>
              {causeRows.map(({ anomaly, cause, index }) => (
                <tr key={`${anomaly.anomalyId}-${index}`}>
                  <th scope="row">{anomaly.anomalyId}</th>
                  <td>{cause.service ?? "Not supplied"}</td>
                  <td>{cause.linkedAccountId ?? "Not supplied"}</td>
                  <td>{cause.region ?? "Not supplied"}</td>
                  <td>{cause.usageType ?? "Not supplied"}</td>
                  <td className={styles.numeric}>{formatProviderAmount(cause.contribution)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <VisualAudit name="AWS Cost Anomalies Details" />
    </FinopsSheetBlock>
  );
}

function StartDateVisual({ analysis }: { readonly analysis: CostAnomalyProviderAnalysis }) {
  const { monthly, summary } = analysis;
  return (
    <FinopsSheetBlock
      description="Provider total impact grouped by the accepted anomaly start month, with the finding count that produced each group."
      title="Total Impact Cost by Anomaly Start Date"
    >
      {monthly.length === 0 ? (
        <NoEvidence reason="No accepted finding carried a provider start date, so no start-date grouping exists." />
      ) : (
        <>
          <BarChart
            ariaLabel="Findings and observed total impact by anomaly start month"
            categories={monthly.map((bucket) => bucket.month)}
            formatValue={formatCount}
            series={[{
              id: "findings",
              label: "Findings with a provider start date",
              values: monthly.map((bucket) => bucket.findingCount),
            }]}
          />
          <BarChart
            ariaLabel="Observed total impact by anomaly start month in the payer billing currency"
            categories={monthly.map((bucket) => bucket.month)}
            formatValue={formatProviderAmount}
            series={[{
              id: "impact",
              label: "Observed total impact",
              values: monthly.map((bucket) => bucket.totalImpact.total),
            }]}
          />
        </>
      )}
      {summary.missingStartDateCount === 0 ? null : (
        <p className={styles.goalMeta}>
          {formatCount(summary.missingStartDateCount)}{" "}
          {summary.missingStartDateCount === 1 ? "finding has" : "findings have"} no provider start
          date and {summary.missingStartDateCount === 1 ? "is" : "are"} therefore excluded from
          every start-date grouping. They remain listed in the details table.
        </p>
      )}
      <VisualAudit name="Total Impact Cost by Anomaly Start Date" />
    </FinopsSheetBlock>
  );
}

function StatusVisual({ analysis }: { readonly analysis: CostAnomalyProviderAnalysis }) {
  const { summary } = analysis;
  const assessments = [
    { id: "accurate", label: "Accurate anomaly", value: summary.assessmentCounts.accurateAnomaly },
    { id: "not-an-issue", label: "Not an issue", value: summary.assessmentCounts.notAnIssue },
    { id: "planned", label: "Planned activity", value: summary.assessmentCounts.plannedActivity },
    { id: "not-submitted", label: "Not submitted", value: summary.assessmentCounts.notSubmitted },
  ] as const;

  return (
    <FinopsSheetBlock
      description={`Lifecycle basis: ${readable(analysis.lifecycleBasis.toLowerCase())}. Status is derived from provider end dates only.`}
      title="Anomalies Status"
    >
      <DonutChart
        ariaLabel="Open provider anomaly windows against ended windows, by provider end date relative to the collection day"
        formatValue={formatCount}
        slices={[
          { id: "open", label: "Open window", value: summary.openWindowCount, tone: "amber" },
          { id: "ended", label: "Window ended", value: summary.endedWindowCount, tone: "slate" },
        ]}
      />
      <BarChart
        ariaLabel="Provider assessment submissions across accepted findings"
        categories={assessments.map((entry) => entry.label)}
        formatValue={formatCount}
        series={[{
          id: "assessment",
          label: "Findings",
          values: assessments.map((entry) => entry.value),
        }]}
      />
      <ShareBar
        ariaLabel={`Findings with a provider root cause against findings with none, out of ${formatCount(summary.findingCount)} findings`}
        formatValue={formatCount}
        segments={[
          {
            id: "with-cause",
            label: "Root cause returned",
            value: Math.max(0, summary.findingCount - summary.missingRootCauseCount),
            tone: "teal",
          },
          {
            id: "without-cause",
            label: "No root cause returned",
            value: summary.missingRootCauseCount,
            tone: "amber",
          },
        ]}
      />
      <p className={styles.goalMeta}>
        {formatCount(summary.missingRootCauseCount)}{" "}
        {summary.missingRootCauseCount === 1 ? "finding has" : "findings have"} no provider root
        cause, so {summary.missingRootCauseCount === 1 ? "it contributes" : "they contribute"} to no
        dimensional ranking on this sheet.
      </p>
      <VisualAudit name="Anomalies Status" />
    </FinopsSheetBlock>
  );
}

function DetectionCoverage({ report }: { readonly report: CostAnomalyReport }) {
  const { analysis, aws } = report;
  return (
    <FinopsSheetBlock
      description="Outside the six official visuals: the monitor, subscription and per-operation evidence the collection returns. Caller-defined monitor and subscription labels stay redacted at the trust boundary."
      title="Detection coverage and collection completeness"
    >
      <div className={styles.tiles}>
        <Tile
          detail={`${formatCount(aws.monitors.filter((monitor) => monitor.lastEvaluatedAt !== null).length)} report a last evaluation time`}
          label="Monitors returned"
          value={formatCount(aws.monitors.length)}
        />
        <Tile
          detail={`${formatCount(aws.subscriptions.filter((subscription) => subscription.frequency === "IMMEDIATE").length)} immediate`}
          label="Subscriptions returned"
          value={formatCount(aws.subscriptions.length)}
        />
        <Tile
          detail={`Window ${aws.windowStartDate} → ${aws.windowEndDate}`}
          label="Collection status"
          value={readable(aws.status)}
        />
      </div>

      {aws.monitors.length === 0 ? (
        <NoEvidence reason="AWS returned no anomaly monitor. Without a monitor no finding can exist, so an empty finding list here says nothing about spend correctness." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>
              Grouped monitor coverage from the analysis, with the per-monitor evaluation evidence
              that produced it.
            </caption>
            <thead>
              <tr>
                <th scope="col">Monitor type</th>
                <th scope="col">Dimension</th>
                <th className={styles.numeric} scope="col">Monitors</th>
                <th className={styles.numeric} scope="col">Evaluated by AWS</th>
              </tr>
            </thead>
            <tbody>
              {analysis.monitorCoverage.map((group) => (
                <tr key={`${group.type}-${group.dimension ?? "none"}`}>
                  <th scope="row">{readable(group.type)}</th>
                  <td>{group.dimension === null ? "Not reported" : readable(group.dimension)}</td>
                  <td className={styles.numeric}>{formatCount(group.monitorCount)}</td>
                  <td className={styles.numeric}>{formatCount(group.evaluatedMonitorCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {aws.monitors.length === 0 ? null : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>Per-monitor provider evidence.</caption>
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Dimension</th>
                <th scope="col">Specification</th>
                <th className={styles.numeric} scope="col">Dimensional values</th>
                <th scope="col">Last evaluated (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {aws.monitors.map((monitor, index) => (
                <tr key={`${monitor.type}-${monitor.dimension ?? "none"}-${index}`}>
                  <th scope="row">{readable(monitor.type)}</th>
                  <td>{monitor.dimension === null ? "Not reported" : readable(monitor.dimension)}</td>
                  <td>{monitor.specificationPresent ? "Present" : "Not returned"}</td>
                  <td className={styles.numeric}>
                    {monitor.dimensionalValueCount === null
                      ? "Not reported"
                      : formatCount(monitor.dimensionalValueCount)}
                  </td>
                  <td>{formatUtc(monitor.lastEvaluatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {aws.subscriptions.length === 0 ? (
        <NoEvidence reason="AWS returned no anomaly subscription, so no alert delivery is evidenced for this account." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>
              Alert subscriptions and their subscriber confirmation state. A declined or unknown
              subscriber is not a delivery guarantee.
            </caption>
            <thead>
              <tr>
                <th scope="col">Frequency</th>
                <th className={styles.numeric} scope="col">Monitors</th>
                <th scope="col">Threshold</th>
                <th className={styles.numeric} scope="col">Email confirmed</th>
                <th className={styles.numeric} scope="col">SNS confirmed</th>
                <th className={styles.numeric} scope="col">Declined</th>
                <th className={styles.numeric} scope="col">Unknown</th>
              </tr>
            </thead>
            <tbody>
              {aws.subscriptions.map((subscription, index) => (
                <tr key={`${subscription.frequency}-${index}`}>
                  <th scope="row">{readable(subscription.frequency)}</th>
                  <td className={styles.numeric}>
                    {formatCount(subscription.monitorCount)}
                    {subscription.monitorArnsOmitted === 0
                      ? ""
                      : ` (+${formatCount(subscription.monitorArnsOmitted)} omitted)`}
                  </td>
                  <td>
                    {subscription.threshold === null
                      ? subscription.thresholdExpressionPresent
                        ? "Expression threshold only — no numeric value returned"
                        : "Not reported by AWS"
                      : formatProviderAmount(subscription.threshold)}
                  </td>
                  <td className={styles.numeric}>
                    {formatCount(subscription.subscriberCounts.emailConfirmed)}
                  </td>
                  <td className={styles.numeric}>
                    {formatCount(subscription.subscriberCounts.snsConfirmed)}
                  </td>
                  <td className={styles.numeric}>
                    {formatCount(subscription.subscriberCounts.emailDeclined
                      + subscription.subscriberCounts.snsDeclined)}
                  </td>
                  <td className={styles.numeric}>
                    {formatCount(subscription.subscriberCounts.unknown)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption>
            Per-operation collection coverage. A failed operation is disclosed with its provider
            error code; its records are never counted as accepted.
          </caption>
          <thead>
            <tr>
              <th scope="col">Operation</th>
              <th scope="col">Status</th>
              <th className={styles.numeric} scope="col">Pages</th>
              <th className={styles.numeric} scope="col">Observed</th>
              <th className={styles.numeric} scope="col">Accepted</th>
              <th className={styles.numeric} scope="col">Rejected</th>
              <th className={styles.numeric} scope="col">Omitted</th>
              <th scope="col">Error code</th>
            </tr>
          </thead>
          <tbody>
            {aws.coverage.map((operation) => (
              <tr key={operation.operation}>
                <th scope="row">{readable(operation.operation)}</th>
                <td><StateBadge state={operation.status.toLowerCase()} /></td>
                <td className={styles.numeric}>{formatCount(operation.pagesObserved)}</td>
                <td className={styles.numeric}>{formatCount(operation.recordsObserved)}</td>
                <td className={styles.numeric}>{formatCount(operation.recordsAccepted)}</td>
                <td className={styles.numeric}>{formatCount(operation.recordsRejected)}</td>
                <td className={styles.numeric}>{formatCount(operation.recordsOmitted)}</td>
                <td>{operation.errorCode === null ? "None" : readable(operation.errorCode)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.goalMeta}>
        AWS does not publish an expected total-record count for these paginated APIs, so accepted
        record counts cannot be expressed as a completeness percentage.
      </p>
    </FinopsSheetBlock>
  );
}

function AnomaliesSheet({ envelope }: { readonly envelope: CostAnomalyEnvelope }) {
  const report = envelope.dashboard;
  if (report === null) {
    return (
      <div className={styles.blocks}>
        <FinopsSheetBlock title="AWS Cost Anomalies">
          <NoEvidence reason={collectionReason(envelope)} />
        </FinopsSheetBlock>
      </div>
    );
  }
  const collectionDay = envelope.collectedAt === null ? null : envelope.collectedAt.slice(0, 10);
  return (
    <div className={styles.blocks}>
      <DailyImpactVisual analysis={report.analysis} />
      <TotalImpactVisual analysis={report.analysis} />
      <MoverRanking
        dimension="service"
        label="AWS Cost Anomalies - Service (Total Cost Impact)"
        movers={report.analysis.movers.service}
        officialVisual="AWS Cost Anomalies - Service (Total Cost Impact)"
      />
      <MoverRanking
        dimension="linked account"
        label="Root-cause contribution by linked account"
        movers={report.analysis.movers.linkedAccount}
      />
      <MoverRanking
        dimension="region"
        label="Root-cause contribution by region"
        movers={report.analysis.movers.region}
      />
      <MoverRanking
        dimension="usage type"
        label="Root-cause contribution by usage type"
        movers={report.analysis.movers.usageType}
      />
      <DetailsVisual collectionDay={collectionDay} report={report} />
      <StartDateVisual analysis={report.analysis} />
      <StatusVisual analysis={report.analysis} />
      <DetectionCoverage report={report} />
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Sheet 2 — "About": provenance, the audited visual coverage, collection
 * lineage, and the independent Sutra statistical source.
 * ------------------------------------------------------------------------- */

function collectionReason(envelope: CostAnomalyEnvelope): string {
  const attempt = envelope.latestAttemptStatus === null
    ? "no collection attempt is recorded"
    : `the latest collection attempt is ${readable(envelope.latestAttemptStatus)}`;
  if (envelope.state === "failed") {
    return `No verified AWS Cost Anomaly Detection materialization could be read and ${attempt}.`
      + " Provider evidence is failed, not zero: Sutra reports no finding count and no impact"
      + " until AWS evidence is accepted again.";
  }
  return `No AWS Cost Anomaly Detection materialization is available yet and ${attempt}.`
    + " Provider evidence is collecting or unavailable, never zero, so no finding count, impact or"
    + " monitor coverage is shown.";
}

function StatisticalSource({ envelope }: { readonly envelope: CostAnomalyEnvelope }) {
  const report = envelope.dashboard;
  if (report === null) {
    return (
      <FinopsSheetBlock title="Sutra statistical billing signals">
        <NoEvidence reason="Sutra statistical signals are computed alongside an accepted provider materialization; none is available for this connection yet." />
      </FinopsSheetBlock>
    );
  }
  const findings = report.sutra.anomalies;
  const currencies = [...new Set(findings.map((finding) => finding.currency))].sort();
  return (
    <FinopsSheetBlock
      description={report.sutra.disclaimer}
      title={`Sutra statistical billing signals (${formatCount(findings.length)})`}
    >
      <div className={styles.tiles}>
        <Tile label="Days evaluated" value={formatCount(report.sutra.evaluatedDays)} />
        <Tile
          detail={envelope.sutraInput.capped
            ? "The statistical input was capped, so absence of a signal is not proof of absence"
            : "The full available statistical input was evaluated"}
          label="Billing lines evaluated"
          value={formatCount(envelope.sutraInput.lineCount)}
        />
        <Tile
          label="Billing periods evaluated"
          value={envelope.sutraInput.periods.length === 0
            ? "None available"
            : envelope.sutraInput.periods.join(", ")}
        />
      </div>

      {findings.length === 0 ? (
        <NoEvidence reason="No canonical billing day met the statistical threshold in the evaluated periods. This is independent of the AWS provider findings above and does not confirm them." />
      ) : (
        <>
          {currencies.map((currency) => (
            <BarChart
              ariaLabel={`Statistical signal amount against its baseline in ${currency}`}
              categories={findings
                .filter((finding) => finding.currency === currency)
                .map((finding) => `${finding.dateIso} ${finding.service}`)}
              formatValue={(value) => formatUnits(value, currency)}
              key={currency}
              series={[
                {
                  id: `${currency}-amount`,
                  label: `Observed ${currency} cost`,
                  values: findings
                    .filter((finding) => finding.currency === currency)
                    .map((finding) => microsToUnits(finding.amountMicros)),
                },
                {
                  id: `${currency}-baseline`,
                  label: `${currency} baseline`,
                  values: findings
                    .filter((finding) => finding.currency === currency)
                    .map((finding) => microsToUnits(finding.baselineMicros)),
                },
              ]}
            />
          ))}
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>
                Statistical signals are canonical integer micro-units and are printed exactly.
                Currencies are never combined.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Service</th>
                  <th className={styles.numeric} scope="col">Observed cost</th>
                  <th className={styles.numeric} scope="col">Baseline</th>
                  <th className={styles.numeric} scope="col">Ratio</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((finding) => (
                  <tr key={`${finding.dateIso}-${finding.service}-${finding.currency}`}>
                    <th scope="row">{finding.dateIso}</th>
                    <td>{finding.service}</td>
                    <td className={styles.numeric}>
                      {formatMicrosExact(finding.amountMicros, finding.currency)}
                    </td>
                    <td className={styles.numeric}>
                      {formatMicrosExact(finding.baselineMicros, finding.currency)}
                    </td>
                    <td className={styles.numeric}>{formatRatio(finding.ratio)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className={styles.goalMeta}>{report.disclaimer}</p>
    </FinopsSheetBlock>
  );
}

function AboutSheet({ envelope }: { readonly envelope: CostAnomalyEnvelope }) {
  const definition = envelope.officialDefinition;
  const pinned = definition.source.commit === OFFICIAL.source.commit
    && definition.source.manifestSha256 === OFFICIAL.source.manifestSha256
    && definition.source.embeddedDefinitionSha256 === OFFICIAL.source.embeddedDefinitionSha256;
  const report = envelope.dashboard;

  return (
    <div className={styles.blocks}>
      <FinopsSheetBlock
        description="The dashboard mirrors a hash-pinned public AWS definition. Structural totals are provable at the pinned commit; QuickSight layout, geometry and query parity are not claimed."
        title="Pinned official definition"
      >
        <div className={styles.tiles}>
          <Tile label="Official sheets" value={formatCount(definition.totals.sheets)} />
          <Tile label="Official visuals" value={formatCount(definition.totals.visuals)} />
          <Tile
            detail={`${formatCount(definition.totals.parameterControls)} parameter · ${formatCount(definition.totals.filterControls)} filter placements`}
            label="Official controls"
            value={formatCount(definition.totals.parameterControls + definition.totals.filterControls)}
          />
          <Tile label="Calculated fields" value={formatCount(definition.totals.calculatedFields)} />
          <Tile label="Filter groups" value={formatCount(definition.totals.filterGroups)} />
          <Tile
            detail={pinned
              ? "Manifest and embedded definition digests match the pinned audit"
              : "The response digests do not match the pinned audit; treat the inventory above as unverified"}
            label="Definition verification"
            value={pinned ? "Matches pin" : "Does not match pin"}
          />
        </div>
        <p className={styles.goalMeta}>
          {definition.source.repository} · commit {definition.source.commit} ·{" "}
          {definition.source.manifestPath} · manifest SHA-256 {definition.source.manifestSha256} ·
          embedded definition SHA-256 {definition.source.embeddedDefinitionSha256} · dataset{" "}
          {definition.source.datasetIdentifier} ·{" "}
          {definition.source.queryArtifact === null
            ? "no standalone query artifact is published, so query parity is not claimed"
            : definition.source.queryArtifact}
        </p>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>
              Every visual in the pinned definition, with the native evidence behind it and the gap
              that remains. A partial visual is never presented as delivered.
            </caption>
            <thead>
              <tr>
                <th scope="col">Official visual</th>
                <th scope="col">Type</th>
                <th scope="col">Coverage</th>
                <th scope="col">Native evidence</th>
                <th scope="col">Remaining gap</th>
              </tr>
            </thead>
            <tbody>
              {definition.sheets.flatMap((sheet) =>
                sheet.visuals.map((visual) => (
                  <tr key={visual.id}>
                    <th scope="row">{visual.name}</th>
                    <td>{visual.type}</td>
                    <td>{readable(visual.coverage)}</td>
                    <td>{visual.nativeEvidence}</td>
                    <td>{visual.remainingGap}</td>
                  </tr>
                )))}
            </tbody>
          </table>
        </div>
        <ul className={styles.formulaList} aria-label="Official parameter declarations">
          {definition.parameterDeclarations.map((name) => <li key={name}>{name}</li>)}
        </ul>
        <ul className={styles.formulaList} aria-label="Official filter groups">
          {definition.filterGroups.map((name) => <li key={name}>{name}</li>)}
        </ul>
        <ul className={styles.coverageGaps}>
          {definition.disclosures.map((note) => <li key={note}>{note}</li>)}
        </ul>
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Provider collection lineage. Freshness comes from the provider's own data-through timestamp, never from the time the page was rendered."
        title="Collection lineage and freshness"
      >
        <div className={styles.tiles}>
          <Tile
            detail={envelope.latestAttemptStatus === null
              ? "No collection attempt is recorded"
              : `Latest attempt: ${readable(envelope.latestAttemptStatus)}`}
            label="Dashboard state"
            value={readable(envelope.state)}
          />
          <Tile label="Collected at (UTC)" value={formatUtc(envelope.collectedAt)} />
          <Tile
            detail={`Considered stale after ${formatCount(envelope.freshness.staleAfterHours)} hours`}
            label="Data through (UTC)"
            value={formatUtc(envelope.dataThroughAt)}
          />
          <Tile
            label="Evidence age"
            value={envelope.freshness.ageHours === null
              ? "Not available"
              : `${envelope.freshness.ageHours} hours`}
          />
          {report === null ? null : (
            <>
              <Tile
                detail={`Window ${report.aws.windowStartDate} → ${report.aws.windowEndDate}`}
                label="Provider collection status"
                value={readable(report.aws.status)}
              />
              <Tile
                label="Analysis schema"
                value={report.analysis.schema}
              />
            </>
          )}
        </div>
        {report === null ? (
          <NoEvidence reason={collectionReason(envelope)} />
        ) : (
          <p className={styles.goalMeta}>{report.aws.disclaimer}</p>
        )}
      </FinopsSheetBlock>

      <StatisticalSource envelope={envelope} />
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Exported presentation.
 * ------------------------------------------------------------------------- */

/**
 * One sheet's content. Exported so every official sheet can be rendered and
 * asserted directly, without driving the fetch lifecycle.
 */
export function FinopsCostAnomalySheetContent({
  envelope, sheet,
}: {
  readonly envelope: CostAnomalyEnvelope;
  readonly sheet: FinopsSheetDescriptor;
}) {
  if (sheet.key === "about") return <AboutSheet envelope={envelope} />;
  if (sheet.key === "aws-cost-anomalies") return <AnomaliesSheet envelope={envelope} />;
  return (
    <NoEvidence
      reason={`Sutra has no projection for the official sheet "${sheet.name}". The sheet is listed because AWS publishes it; it is not presented as delivered.`}
    />
  );
}

/**
 * Presentation for a loaded Cost Anomaly envelope: the provider status strip,
 * the two official sheet tabs and the active sheet. Takes the envelope directly
 * so it can be rendered from a test or a server-side snapshot without fetching.
 */
export function FinopsCostAnomalySheets({
  envelope, initialSheetKey,
}: {
  readonly envelope: CostAnomalyEnvelope;
  readonly initialSheetKey?: string;
}) {
  const first = FINOPS_COST_ANOMALY_SHEETS.sheets[0];
  const [sheetKeyState, setSheetKey] = useState<string>(initialSheetKey ?? first?.key ?? "about");
  const sheet = useMemo(
    () => FINOPS_COST_ANOMALY_SHEETS.sheets.find((entry) => entry.key === sheetKeyState) ?? first,
    [first, sheetKeyState],
  );
  if (sheet === undefined) return null;

  const report = envelope.dashboard;
  return (
    <>
      <section
        aria-label="AWS Cost Anomaly Detection evidence and freshness"
        className={styles.coverage}
        data-support={envelope.state === "complete" ? "SUPPORTED" : "PARTIAL"}
      >
        <div className={styles.coverageHead}>
          <strong>AWS Cost Anomaly Detection</strong>
          <StateBadge state={envelope.state} />
          <span className={styles.coverageMeta}>
            {report === null
              ? "No accepted provider materialization"
              : `${formatCount(report.aws.anomalies.length)} accepted findings · window ${report.aws.windowStartDate} → ${report.aws.windowEndDate}`}
            {" · data through "}
            {formatUtc(envelope.dataThroughAt)}
          </span>
        </div>
        <ul className={styles.coverageGaps}>
          <li>
            {envelope.state === "stale"
              ? `Provider evidence is older than the ${formatCount(envelope.freshness.staleAfterHours)}-hour objective and is shown with its own timestamp, not as current.`
              : envelope.state === "partial"
                ? "At least one bounded AWS operation did not complete. Only accepted records are shown."
                : envelope.state === "failed"
                  ? "The latest AWS collection failed. Any evidence below is the last accepted generation and is not presented as current."
                  : envelope.state === "waiting"
                    ? "A collection is pending or in progress. Missing provider evidence is unavailable, never zero."
                    : "Every bounded AWS operation succeeded for the displayed window."}
          </li>
          {report === null ? null : <li>{report.disclaimer}</li>}
        </ul>
      </section>
      <FinopsSheetShell
        activeKey={sheet.key}
        idPrefix="cost-anomaly"
        inventory={FINOPS_COST_ANOMALY_SHEETS}
        onSelectSheet={setSheetKey}
      >
        <FinopsCostAnomalySheetContent envelope={envelope} sheet={sheet} />
      </FinopsSheetShell>
    </>
  );
}

function isEnvelope(value: unknown): value is CostAnomalyEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CostAnomalyEnvelope>;
  return candidate.source === "AWS_COST_EXPLORER_COST_ANOMALY_DETECTION"
    && typeof candidate.state === "string"
    && typeof candidate.officialDefinition === "object"
    && candidate.officialDefinition !== null
    && typeof candidate.freshness === "object"
    && candidate.freshness !== null
    && typeof candidate.sutraInput === "object"
    && candidate.sutraInput !== null
    && "dashboard" in candidate;
}

/**
 * ADV-03 Cost Anomaly dashboard: reads the tenant-scoped endpoint and presents
 * the pinned official sheets. The endpoint is authoritative for every value; this
 * component computes no money and infers no finding.
 */
export function FinopsCostAnomalyDashboard({
  connectionId,
}: {
  readonly connectionId: string | null;
}) {
  /**
   * The settled result is stored with the request it belongs to, so a result is
   * never shown for a different connection or a superseded reload. The loading
   * state is derived from that mismatch rather than written from the effect.
   */
  const [settled, setSettled] = useState<{
    readonly connectionId: string;
    readonly token: number;
    readonly result: EndpointState<CostAnomalyEnvelope>;
  } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    if (connectionId === null) return;
    const controller = new AbortController();
    const settle = (result: EndpointState<CostAnomalyEnvelope>) =>
      setSettled({ connectionId, token: reloadToken, result });
    fetch(
      `/api/v1/finops/cost-anomaly?connectionId=${encodeURIComponent(connectionId)}`,
      {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok || !isEnvelope(body)) {
          throw new Error(
            "The AWS Cost Anomaly Detection response did not match the expected contract.",
          );
        }
        settle({ status: "ready", envelope: body });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        settle({
          status: "error",
          message: error instanceof Error
            ? error.message
            : "The AWS Cost Anomaly Detection request failed.",
        });
      });
    return () => controller.abort();
  }, [connectionId, reloadToken]);

  const state: EndpointState<CostAnomalyEnvelope> = connectionId === null
    ? { status: "idle" }
    : settled !== null
      && settled.connectionId === connectionId
      && settled.token === reloadToken
      ? settled.result
      : { status: "loading" };
  const envelope = state.status === "ready" ? state.envelope : null;
  return (
    <section aria-label="AWS Cost Anomaly dashboard" className={styles.shell}>
      {connectionId === null ? (
        <div className={styles.coverage} data-support="PARTIAL" role="status">
          <div className={styles.coverageHead}>
            <strong>No active AWS connection is selected</strong>
          </div>
          <ul className={styles.coverageGaps}>
            <li>
              Connect an active AWS trust role with the current read-only permission pack before
              provider anomaly evidence can be collected.
            </li>
          </ul>
        </div>
      ) : (
        <EndpointBoundary
          onRetry={reload}
          state={state}
          title="the AWS Cost Anomaly dashboard"
        />
      )}
      {envelope === null ? null : <FinopsCostAnomalySheets envelope={envelope} />}
    </section>
  );
}

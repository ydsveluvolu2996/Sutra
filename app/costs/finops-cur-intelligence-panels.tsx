"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DataTransferCategory,
  DataTransferCostBasis,
  DataTransferDirection,
  DataTransferSnapshot,
} from "../../lib/finops-data-transfer";
import { buildDataTransferEvidenceCsv } from "../../lib/finops-data-transfer-export";
import type { DataTransferOfficialAudit } from "../../lib/finops-data-transfer-official-audit";
import type {
  FinopsTrendsExactRational,
  FinopsTrendsIntelligenceResult,
  FinopsTrendsSeries,
} from "../../lib/finops-trends-intelligence";
import type { FinopsTrendsCapabilityClosure } from "../../lib/finops-trends-capability-closure";
import { buildTrendsEvidenceCsv } from "../../lib/finops-trends-export";
import type { FinopsTrendsOfficialDefinition } from "../../lib/finops-trends-official-definition";
import styles from "./costs.module.css";

type CurIntelligenceSection = "overview" | "services";

interface CurIntelligenceProps {
  readonly connectionId: string;
  readonly section: CurIntelligenceSection;
}

interface AvailablePeriod {
  readonly period: string;
  readonly generationId: string;
  readonly committedAtIso: string;
}

type TrendsSuccessfulReport = Extract<FinopsTrendsIntelligenceResult, { ok: true }> & {
  readonly capabilities: FinopsTrendsCapabilityClosure;
};

interface TrendsEnvelope {
  readonly connectionId: string;
  readonly officialDefinition: FinopsTrendsOfficialDefinition;
  readonly selectedWindow: {
    readonly fromPeriod: string;
    readonly toPeriod: string;
  } | null;
  readonly availablePeriods: readonly AvailablePeriod[];
  readonly report: TrendsSuccessfulReport | Exclude<FinopsTrendsIntelligenceResult, { ok: true }> | null;
  readonly sourceState: string;
}

interface TrendsReportProps {
  readonly report: TrendsSuccessfulReport;
  readonly officialDefinition: FinopsTrendsOfficialDefinition;
  readonly availablePeriods: readonly AvailablePeriod[];
  readonly onFromPeriodChange: (period: string) => void;
  readonly onToPeriodChange: (period: string) => void;
  readonly onRollingWindowChange: (months: number) => void;
}

interface DataTransferEnvelope {
  readonly connectionId: string;
  readonly selectedPeriod: string | null;
  readonly availablePeriods: readonly AvailablePeriod[];
  readonly officialAudit: DataTransferOfficialAudit;
  readonly report: DataTransferSnapshot | null;
  readonly sourceState: string;
}

type LoadState<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly envelope: T }
  | { readonly status: "error"; readonly message: string };

const INTEGER = /^-?(?:0|[1-9]\d*)$/u;
const CURRENCY = /^[A-Z]{3}$/u;

function grouped(value: string): string {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const separated = digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return `${negative ? "−" : ""}${separated}`;
}

function formatQuantityMicrosExact(micros: string, unit: string): string {
  if (!INTEGER.test(micros)) return "Not available";
  const amount = BigInt(micros);
  const negative = amount < BigInt(0);
  const absolute = negative ? -amount : amount;
  const whole = (absolute / BigInt(1_000_000)).toString();
  const fraction = (absolute % BigInt(1_000_000)).toString()
    .padStart(6, "0").replace(/0+$/u, "");
  return `${negative ? "−" : ""}${grouped(whole)}${
    fraction.length === 0 ? "" : `.${fraction}`
  } ${unit}`;
}

/** Exact string/BigInt rendering; no billing integer is converted to Number. */
export function formatCurMicrosExact(
  micros: string | null,
  currency: string,
): string {
  if (micros === null || !INTEGER.test(micros) || !CURRENCY.test(currency)) {
    return "Not available";
  }
  const amount = BigInt(micros);
  const negative = amount < BigInt(0);
  const absolute = negative ? -amount : amount;
  const whole = (absolute / BigInt(1_000_000)).toString();
  const fraction = (absolute % BigInt(1_000_000)).toString()
    .padStart(6, "0").replace(/0+$/u, "");
  return `${currency} ${negative ? "−" : ""}${grouped(whole)}${
    fraction.length === 0 ? ".00" : `.${fraction}`
  }`;
}

export function formatCurRationalPercentExact(
  value: FinopsTrendsExactRational | null,
): string {
  if (
    value === null
    || !INTEGER.test(value.numerator)
    || !/^(?:[1-9]\d*)$/u.test(value.denominator)
  ) return "Not available";
  const numerator = BigInt(value.numerator);
  const denominator = BigInt(value.denominator);
  if (numerator % denominator === BigInt(0)) {
    return `${(numerator / denominator).toString()}%`;
  }
  const negative = numerator < BigInt(0);
  const absolute = negative ? -numerator : numerator;
  /*
   * The rational already expresses a percent, as the exactly-divisible branch
   * above and the trailing "%" on the exact form both show. Scaling by 100 keeps
   * two decimal places; scaling by 10,000 overstated every non-terminating
   * percentage by 100x, so 100/3 rendered as 3333.33% instead of 33.33%.
   */
  const scaled = (absolute * BigInt(100)) / denominator;
  const whole = scaled / BigInt(100);
  const fraction = (scaled % BigInt(100)).toString().padStart(2, "0");
  return `${negative ? "−" : ""}${whole.toString()}.${fraction}% · exact ${value.numerator}/${value.denominator}%`;
}

function relativeBasisPoints(value: string | null, maximum: bigint): number {
  if (value === null || !INTEGER.test(value) || maximum <= BigInt(0)) return 0;
  const amount = BigInt(value);
  const absolute = amount < BigInt(0) ? -amount : amount;
  return Number((absolute * BigInt(10_000)) / maximum);
}

function downloadTrendsEvidenceCsv(
  report: TrendsSuccessfulReport,
  series: FinopsTrendsSeries,
): void {
  const blob = new Blob([buildTrendsEvidenceCsv(report, series)], {
    type: "text/csv;charset=utf-8",
  });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `sutra-trends-${report.window.fromPeriod}-${report.window.toPeriod}-${series.currency}-${series.costBasis}.csv`;
  anchor.click();
  URL.revokeObjectURL(href);
}

function downloadDataTransferEvidenceCsv(
  report: DataTransferSnapshot,
  rows: DataTransferSnapshot["drilldowns"],
  costBasis: DataTransferCostBasis,
): void {
  const blob = new Blob([buildDataTransferEvidenceCsv(report, rows, costBasis)], {
    type: "text/csv;charset=utf-8",
  });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `sutra-data-transfer-${report.scope.billingPeriod}-${costBasis}.csv`;
  anchor.click();
  URL.revokeObjectURL(href);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readEnvelope<T>(
  response: Response,
  connectionId: string,
  schema: string,
  officialAuditSchema: string | null = null,
): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(body)) {
    const error = isRecord(body) && isRecord(body.error)
      && typeof body.error.message === "string"
      ? body.error.message
      : "The immutable CUR2 request failed.";
    throw new Error(error);
  }
  if (
    body.connectionId !== connectionId
    || typeof body.sourceState !== "string"
    || !Array.isArray(body.availablePeriods)
    || !("report" in body)
  ) throw new Error("The CUR2 response did not match its tenant-bound contract.");
  if (
    body.report !== null
    && (
      !isRecord(body.report)
      || (body.report.schema !== schema
        && body.report.schemaVersion !== schema)
    )
  ) throw new Error("The CUR2 report schema was not recognized.");
  if (
    officialAuditSchema !== null
    && (
      !isRecord(body.officialAudit)
      || body.officialAudit.schema !== officialAuditSchema
    )
  ) throw new Error("The official-source audit contract was not recognized.");
  if (
    schema === "sutra.finops-trends-intelligence.v1"
    && (
      !isRecord(body.officialDefinition)
      || body.officialDefinition.schema
        !== "sutra.finops-trends-official-definition.v1"
    )
  ) throw new Error("The Trends official-definition audit was not recognized.");
  return body as unknown as T;
}

function SourceState({
  state,
  title,
  onRetry,
}: {
  readonly state: string;
  readonly title: string;
  readonly onRetry: () => void;
}) {
  const copy = state === "configuration_required"
    ? "A live reconciled AWS CUR 2.0 Data Export is required."
    : state === "source_incomplete"
      ? "The active generation is missing required CUR2 dimensions or cost evidence."
      : state === "empty"
        ? "The active generation contains no accepted billing rows for this view."
        : "No active reconciled CUR2 generation is available yet.";
  return (
    <section className={styles.curState} role="status">
      <span aria-hidden="true">CUR2</span>
      <div><strong>{title}</strong><p>{copy} Sutra never substitutes Cost Explorer snapshots, fixtures, or another tenant&apos;s data.</p></div>
      <button type="button" onClick={onRetry}>Retry</button>
    </section>
  );
}

function StatusBanner({ state, message }: { readonly state: string; readonly message: string }) {
  if (state === "READY" || state === "COMPLETE") return null;
  return (
    <div className={styles.curBanner} data-state={state.toLowerCase()} role="status">
      <strong>{state.replaceAll("_", " ")}</strong>
      <span>{message}</span>
    </div>
  );
}

export function TrendsOfficialCoverage({
  definition,
}: {
  readonly definition: FinopsTrendsOfficialDefinition;
}) {
  const totals = definition.quickSightDefinition;
  return (
    <section className={styles.curSignals} aria-label="Official AWS Trends Dashboard coverage">
      <div className={styles.curPanelHeading}>
        <div><small>Immutable AWS source audit · {definition.source.latestDocumentedVersion}</small><h3>Official Trends coverage and evidence boundary</h3></div>
        <span>{definition.source.category} · {definition.artifacts.length} pinned artifacts</span>
      </div>
      <p className={styles.curBoundaryNote}>AWS does not publish the service-hosted QuickSight definition at the pinned framework commit. Exact sheets, visuals, filter controls, parameter controls, parameters and calculated fields are therefore unavailable—not zero. Pixel parity is not claimed.</p>
      <div className={styles.curKpis}>
        <article><small>QuickSight sheets</small><strong>{totals.sheetCount ?? "Not published"}</strong><span>{totals.reason.replaceAll("_", " ")}</span></article>
        <article><small>QuickSight visuals</small><strong>{totals.visualCount ?? "Not published"}</strong><span>No screenshot-derived count</span></article>
        <article><small>Published datasets</small><strong>{definition.datasets.length}</strong><span>3 Athena views · SPICE definitions</span></article>
        <article><small>Documented controls</small><strong>{definition.documentedControls.length} named</strong><span>AWS also says other fields exist</span></article>
      </div>
      <div className={styles.curGrid}>
        <article className={styles.curPanel}>
          <div className={styles.curPanelHeading}><div><small>Provable labels only</small><h3>Documented controls</h3></div><span>Not an object count</span></div>
          <ul>{definition.documentedControls.map((control) => <li key={control}>{control}</li>)}</ul>
          <p className={styles.curBoundaryNote}>The public article does not exhaustively enumerate every control, and the object definition is absent. These names are documented capabilities, not inferred QuickSight control objects.</p>
        </article>
        <article className={styles.curPanel}>
          <div className={styles.curPanelHeading}><div><small>Deployment contract</small><h3>Published prerequisites and template boundary</h3></div><span>{definition.source.templateId}</span></div>
          <ul>{definition.prerequisites.map((prerequisite) => <li key={prerequisite}>{prerequisite}</li>)}</ul>
          <p className={styles.curBoundaryNote}>The changelog documents v5.1.0 while the pinned resource manifest declares minimum template version 1 / description v5.0.0. The absent service-hosted template payload is not reconstructed.</p>
        </article>
      </div>
      <div className={styles.curTableWrap} tabIndex={0}>
        <table className={styles.curTable}>
          <caption>Documented AWS Trends feature areas and native evidence coverage</caption>
          <thead><tr><th>Documented area</th><th>AWS purpose</th><th>Native status</th><th>Evidence and remaining gap</th></tr></thead>
          <tbody>{definition.documentedFeatureAreas.map((area) => <tr key={area.name}><td><strong>{area.name}</strong></td><td>{area.purpose}</td><td>{area.nativeCoverage}</td><td>{area.evidence}<small>{area.gap ?? "No identified semantic gap; layout parity is still not claimed."}</small></td></tr>)}</tbody>
        </table>
      </div>
      <details className={styles.curEvidenceDrawer}>
        <summary>Pinned AWS artifact hashes and dataset contracts</summary>
        <div className={styles.curTableWrap} tabIndex={0}>
          <table className={styles.curTable}>
            <caption>Immutable AWS framework artifact inventory</caption>
            <thead><tr><th>Kind</th><th>Path</th><th>SHA-256</th></tr></thead>
            <tbody>{definition.artifacts.map((artifact) => <tr key={artifact.path}><td>{artifact.kind.replaceAll("_", " ")}</td><td>{artifact.path}</td><td>{artifact.sha256}</td></tr>)}</tbody>
          </table>
        </div>
        <div className={styles.curTableWrap} tabIndex={0}>
          <table className={styles.curTable}>
            <caption>Published Trends SPICE dataset definitions</caption>
            <thead><tr><th>Dataset</th><th>Athena view</th><th>Columns</th><th>Published window</th></tr></thead>
            <tbody>{definition.datasets.map((dataset) => <tr key={dataset.id}><td>{dataset.id}</td><td>{dataset.view}</td><td>{dataset.inputColumnCount}</td><td>{dataset.documentedWindow}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

export function TrendsReport({
  report,
  officialDefinition,
  availablePeriods,
  onFromPeriodChange,
  onToPeriodChange,
  onRollingWindowChange,
}: TrendsReportProps) {
  const [currency, setCurrency] = useState(report.series[0]?.currency ?? "USD");
  const [costBasis, setCostBasis] = useState(report.series[0]?.costBasis ?? "unblended");
  const [selectedPeriod, setSelectedPeriod] = useState(report.window.toPeriod);
  const [contributorDimension, setContributorDimension] = useState<
    "account" | "service" | "region" | "charge_category"
  >("service");
  const selected = report.series.find((series) =>
    series.currency === currency && series.costBasis === costBasis)
    ?? report.series[0] ?? null;
  const currencies = [...new Set(report.series.map((series) => series.currency))];
  const bases = [...new Set(report.series.map((series) => series.costBasis))];
  const maximum = selected === null
    ? BigInt(1)
    : selected.points.reduce((largest, point) => {
      if (point.totalMicros === null) return largest;
      const value = BigInt(point.totalMicros);
      const absolute = value < BigInt(0) ? -value : value;
      return absolute > largest ? absolute : largest;
    }, BigInt(1));
  const current = selected?.points.find((point) => point.period === selectedPeriod)
    ?? selected?.points.at(-1) ?? null;
  const monthOverMonthDetail = current === null
    ? "No period"
    : current.monthOverMonth.available
      ? formatCurMicrosExact(
        current.monthOverMonth.deltaMicros,
        selected?.currency ?? currency,
      )
      : current.monthOverMonth.reason.replaceAll("_", " ");
  const contributorGroups = current?.contributors ?? [];
  const selectedContributorGroup = contributorGroups.find((group) =>
    group.dimension === contributorDimension) ?? contributorGroups[0] ?? null;
  const contributors = selectedContributorGroup?.contributors ?? [];
  const rollingLabel = report.rollingWindowMonths === 12
    ? "Rolling year over year"
    : report.rollingWindowMonths === 3
      ? "Rolling quarter over quarter"
      : `${report.rollingWindowMonths}-month period over period`;
  const rollingComparison = current?.rollingComparison ?? null;
  const rollingDetail = rollingComparison === null
    ? "No period"
    : rollingComparison.available
      ? formatCurMicrosExact(
        rollingComparison.deltaMicros,
        selected?.currency ?? currency,
      )
      : rollingComparison.reason.replaceAll("_", " ");
  const periodOptions = [...new Set([
    ...availablePeriods.map(({ period }) => period),
    report.window.fromPeriod,
    report.window.toPeriod,
  ])]
    .sort((left, right) => left.localeCompare(right));
  const capabilities = report.capabilities;
  const selectedForecast = capabilities.forecast.sutra.find((item) =>
    item.currency === (selected?.currency ?? currency)
      && item.costBasis === (selected?.costBasis ?? costBasis)) ?? null;
  const selectedTaxonomyCosts = capabilities.serviceTaxonomy.costTrends.filter((item) =>
    item.period === (current?.period ?? report.window.toPeriod)
      && item.currency === (selected?.currency ?? currency)
      && item.costBasis === (selected?.costBasis ?? costBasis));
  const selectedUsage = capabilities.serviceUsage.groups.filter((item) =>
    item.period === (current?.period ?? report.window.toPeriod));
  const selectedRegions = capabilities.geography.regions.map((item) => ({
    ...item,
    cost: item.costs.find((cost) => cost.currency === (selected?.currency ?? currency)
      && cost.costBasis === (selected?.costBasis ?? costBasis)) ?? null,
  })).filter((item) => item.cost !== null || item.usage.length > 0);
  const sutraAlertRules = capabilities.automation.sutraAlertRules;
  const sutraReports = capabilities.automation.sutraScheduledCostReports;
  return (
    <section className={styles.curWorkspace} aria-label="Enterprise CUR2 trends intelligence">
      <StatusBanner
        state={report.state}
        message="Missing, current, stale, or partially reconciled periods remain visible and are never interpolated."
      />
      <TrendsOfficialCoverage definition={officialDefinition} />
      <header className={styles.curHeader}>
        <div><p className="eyebrow">Immutable CUR2 intelligence</p><h2>Enterprise cost trends</h2><p>Exact monthly comparisons, explainable signals, and ranked contributors from active reconciled generations only.</p></div>
        <div className={styles.curFilters}>
          <label>From period<select aria-label="Trends start period" value={report.window.fromPeriod} onChange={(event) => onFromPeriodChange(event.target.value)}>{periodOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>To period<select aria-label="Trends end period" value={report.window.toPeriod} onChange={(event) => onToPeriodChange(event.target.value)}>{periodOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Comparison<select aria-label="Trends comparison window" value={String(report.rollingWindowMonths)} onChange={(event) => onRollingWindowChange(Number(event.target.value))}><option value="1">Monthly</option><option value="3">Quarterly</option><option value="12">Yearly</option></select></label>
          <label>Currency<select value={currency} onChange={(event) => setCurrency(event.target.value)}>{currencies.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Cost basis<select value={costBasis} onChange={(event) => setCostBasis(event.target.value as FinopsTrendsSeries["costBasis"])}>{bases.map((item) => <option key={item}>{item}</option>)}</select></label>
          <button type="button" disabled={selected === null} onClick={() => { if (selected !== null) downloadTrendsEvidenceCsv(report, selected); }}>Export evidence CSV</button>
        </div>
      </header>
      <div className={styles.curKpis}>
        <article><small>Selected period</small><strong>{formatCurMicrosExact(current?.totalMicros ?? null, selected?.currency ?? currency)}</strong><span>{current?.period ?? "Not available"}</span></article>
        <article><small>Month over month</small><strong>{current?.monthOverMonth.available ? formatCurRationalPercentExact(current.monthOverMonth.percent) : "Not available"}</strong><span>{monthOverMonthDetail}</span></article>
        <article><small>{rollingLabel}</small><strong>{current?.rollingComparison.available ? formatCurRationalPercentExact(current.rollingComparison.percent) : "Not available"}</strong><span>{rollingDetail}</span></article>
        <article><small>Evidence coverage</small><strong>{report.summary.completePeriodCount}/{report.window.periodCount}</strong><span>{report.summary.sourceRowCount.toLocaleString("en-US")} accepted rows</span></article>
        <article><small>Explainable signals</small><strong>{report.summary.signalCount}</strong><span>pinned review thresholds</span></article>
        <article><small>Next-month Sutra estimate</small><strong>{selectedForecast?.available ? formatCurMicrosExact(selectedForecast.points[0]?.forecastMicros ?? null, selectedForecast.currency) : "Not available"}</strong><span>deterministic estimate · not QuickSight ML</span></article>
      </div>
      {selected === null ? <p className={styles.emptyNote}>No currency and cost-basis series is available.</p> : (
        <div className={styles.curGrid}>
          <article className={styles.curPanel}>
            <div className={styles.curPanelHeading}><div><small>Monthly evidence</small><h3>{selected.currency} · {selected.costBasis}</h3></div><span>{report.window.fromPeriod} — {report.window.toPeriod}</span></div>
            <div className={styles.curChart} role="group" aria-label={`Exact ${selected.currency} ${selected.costBasis} monthly cost trend; choose a month to update every companion panel`}>
              {selected.points.map((point) => (
                <button className={styles.curColumn} type="button" key={point.period} aria-pressed={current?.period === point.period} onClick={() => setSelectedPeriod(point.period)} title={`${point.period}: ${formatCurMicrosExact(point.totalMicros, selected.currency)}; ${point.periodState.replaceAll("_", " ")}`}>
                  <span>{formatCurMicrosExact(point.totalMicros, selected.currency)}</span>
                  <i style={{ height: `${Math.max(3, relativeBasisPoints(point.totalMicros, maximum) / 100)}%` }} data-state={point.periodState.toLowerCase()} />
                  <b>{point.period.slice(5)}</b><small>{point.periodState.replaceAll("_", " ")}</small>
                </button>
              ))}
            </div>
          </article>
          <article className={styles.curPanel}>
            <div className={styles.curPanelHeading}><div><small>One-click drilldown</small><h3>{current?.period ?? "Current"} movement contributors</h3></div><span>{contributors.length} shown</span></div>
            <div className={styles.curDimensionTabs} role="group" aria-label="Movement contributor dimension">{contributorGroups.map((group) => (
              <button type="button" key={group.dimension} aria-pressed={group.dimension === contributorDimension} onClick={() => setContributorDimension(group.dimension)}>{group.dimension.replaceAll("_", " ")} <span>{group.totalDimensionValues}</span></button>
            ))}</div>
            {contributors.length === 0 ? <p className={styles.emptyNote}>A complete prior period is required before {contributorDimension.replaceAll("_", " ")} movement can be ranked.</p> : (
              <ul className={styles.curContributors}>{contributors.slice(0, 12).map((entry) => (
                <li key={`${contributorDimension}:${entry.value ?? "unknown"}`}><span><b>{entry.value ?? "Unallocated"}</b><small>{contributorDimension.replaceAll("_", " ")}</small></span><span><strong>{formatCurMicrosExact(entry.deltaMicros, selected.currency)}</strong><small>{formatCurRationalPercentExact(entry.absoluteMovementShare)}</small></span></li>
              ))}</ul>
            )}
            {contributorDimension === "account" ? <p className={styles.curBoundaryNote}>CUR2 usage account IDs are shown. Organization-friendly and payer account names remain unavailable until authoritative Organizations taxonomy is joined.</p> : null}
            {contributorDimension === "region" ? <p className={styles.curBoundaryNote}>This is exact regional cost movement, not the official geographic usage map; usage magnitude and coordinates are not inferred from cost.</p> : null}
          </article>
        </div>
      )}
      <section className={styles.curSignals} aria-label="Explainable cost signals">
        <div className={styles.curPanelHeading}><div><small>Pinned policy</small><h3>Signals requiring review</h3></div><span>Informational, not a forecast</span></div>
        {(current?.signals.length ?? 0) === 0 ? <p className={styles.emptyNote}>No pinned threshold was crossed for the selected current period.</p> : current?.signals.map((signal) => <article key={signal.code}><span>{signal.severity}</span><div><strong>{signal.code.replaceAll("_", " ")}</strong><p>{signal.explanation}</p><small>{formatCurRationalPercentExact(signal.observedPercent)} · {signal.baseline.replaceAll("_", " ")}</small></div></article>)}
      </section>
      <div className={styles.curGrid}>
        <article className={styles.curPanel}>
          <div className={styles.curPanelHeading}><div><small>Evidence-derived outlook</small><h3>Three-month Sutra estimate</h3></div><span>Not a quote or statistical confidence interval</span></div>
          {selectedForecast?.available ? <>
            <p className={styles.curBoundaryNote}>Integer linear trend over {selectedForecast.trainingWindow.periodCount} contiguous complete periods ({selectedForecast.trainingWindow.fromPeriod} — {selectedForecast.trainingWindow.toPeriod}); the band is mean absolute residual, not statistical confidence.</p>
            <div className={styles.curTableWrap} tabIndex={0}><table className={styles.curTable}><caption>Sutra deterministic forecast evidence</caption><thead><tr><th>Period</th><th>Estimate</th><th>Residual band</th></tr></thead><tbody>{selectedForecast.points.map((point) => <tr key={point.period}><td>{point.period}</td><td><strong>{formatCurMicrosExact(point.forecastMicros, selectedForecast.currency)}</strong></td><td>{formatCurMicrosExact(point.lowerMicros, selectedForecast.currency)} — {formatCurMicrosExact(point.upperMicros, selectedForecast.currency)}</td></tr>)}</tbody></table></div>
          </> : <p className={styles.emptyNote}>A Sutra estimate requires at least three contiguous complete periods for the selected currency and cost basis. {selectedForecast?.observedCompletePeriods ?? 0} are currently eligible.</p>}
          <p className={styles.curBoundaryNote}>AWS QuickSight ML forecast is unavailable because provider forecast evidence is not ingested.</p>
        </article>
        <article className={styles.curPanel}>
          <div className={styles.curPanelHeading}><div><small>Active CUR2 taxonomy</small><h3>Service category cost trends</h3></div><span>{capabilities.serviceTaxonomy.state}</span></div>
          {selectedTaxonomyCosts.length === 0 ? <p className={styles.emptyNote}>No service-category cost evidence is available for the selected period and cost basis.</p> : <div className={styles.curTableWrap} tabIndex={0}><table className={styles.curTable}><caption>CUR2 service taxonomy and cost</caption><thead><tr><th>Category</th><th>Service</th><th>Cost</th><th>Rows</th></tr></thead><tbody>{selectedTaxonomyCosts.slice(0, 20).map((item) => <tr key={JSON.stringify([item.period,item.category,item.subcategory,item.service,item.currency,item.costBasis])}><td><strong>{item.category}</strong><small>{item.subcategory ?? "No subcategory"}</small></td><td>{item.service}</td><td>{formatCurMicrosExact(item.totalMicros, item.currency)}</td><td>{item.rowCount}</td></tr>)}</tbody></table></div>}
          <p className={styles.curBoundaryNote}>{capabilities.serviceTaxonomy.missingTaxonomyRowCount} rows lack provider taxonomy and remain excluded from taxonomy grouping.</p>
        </article>
        <article className={styles.curPanel}>
          <div className={styles.curPanelHeading}><div><small>Metered evidence by unit</small><h3>Service usage trends</h3></div><span>{capabilities.serviceUsage.state}</span></div>
          {selectedUsage.length === 0 ? <p className={styles.emptyNote}>No metered quantity with a provider unit is available for the selected period.</p> : <div className={styles.curTableWrap} tabIndex={0}><table className={styles.curTable}><caption>Exact CUR2 metered usage; unlike units are never combined</caption><thead><tr><th>Service</th><th>Usage type</th><th>Quantity</th><th>Rows</th></tr></thead><tbody>{selectedUsage.slice(0, 20).map((item) => <tr key={JSON.stringify([item.period,item.category,item.service,item.usageType,item.unit])}><td><strong>{item.service}</strong><small>{item.category ?? "Category unavailable"}</small></td><td>{item.usageType ?? "Not reported"}</td><td>{formatQuantityMicrosExact(item.usageAmountMicros, item.unit)}</td><td>{item.rowCount}</td></tr>)}</tbody></table></div>}
          <p className={styles.curBoundaryNote}>{capabilities.serviceUsage.missingQuantityRowCount} rows lack quantity and {capabilities.serviceUsage.missingUnitRowCount} lack a usable unit.</p>
        </article>
        <article className={styles.curPanel}>
          <div className={styles.curPanelHeading}><div><small>Payer and usage directory</small><h3>Account identity evidence</h3></div><span>{capabilities.accounts.state}</span></div>
          {capabilities.accounts.entries.length === 0 ? <p className={styles.emptyNote}>No account identity evidence is available.</p> : <div className={styles.curTableWrap} tabIndex={0}><table className={styles.curTable}><caption>CUR2 account identity fields</caption><thead><tr><th>Role</th><th>Account</th><th>Friendly name</th><th>Evidence</th></tr></thead><tbody>{capabilities.accounts.entries.slice(0, 20).map((item) => <tr key={`${item.role}:${item.accountId}`}><td>{item.role}</td><td>{item.accountId}</td><td>{item.friendlyName ?? "Unavailable"}</td><td>{item.nameState.replaceAll("_", " ")}</td></tr>)}</tbody></table></div>}
          <p className={styles.curBoundaryNote}>Friendly names are CUR2 fields only. AWS Organizations API evidence is not available and conflicting names are never resolved by inference.</p>
        </article>
        <article className={styles.curPanel}>
          <div className={styles.curPanelHeading}><div><small>Region evidence</small><h3>Geographic cost and usage</h3></div><span>{capabilities.geography.state}</span></div>
          {selectedRegions.length === 0 ? <p className={styles.emptyNote}>No provider Region evidence is available for this selection.</p> : <div className={styles.curTableWrap} tabIndex={0}><table className={styles.curTable}><caption>CUR2 Region cost and unit-separated usage</caption><thead><tr><th>Region</th><th>Cost</th><th>Usage</th></tr></thead><tbody>{selectedRegions.slice(0, 20).map((item) => <tr key={item.region}><td><strong>{item.region}</strong></td><td>{item.cost === null ? "Not available" : formatCurMicrosExact(item.cost.totalMicros, item.cost.currency)}</td><td>{item.usage.length === 0 ? "Not available" : item.usage.map((usage) => formatQuantityMicrosExact(usage.usageAmountMicros, usage.unit)).join(" · ")}</td></tr>)}</tbody></table></div>}
          <p className={styles.curBoundaryNote}>The official geographic map is unavailable because authoritative Region coordinates are not ingested; Sutra does not infer coordinates.</p>
        </article>
        <article className={styles.curPanel}>
          <div className={styles.curPanelHeading}><div><small>Delivery and review controls</small><h3>Automation status</h3></div><span>Tenant scoped</span></div>
          <div className={styles.curKpis}>
            <article><small>Sutra alert rules</small><strong>{sutraAlertRules.available ? `${sutraAlertRules.enabledCount}/${sutraAlertRules.configuredCount}` : "Unavailable"}</strong><span>enabled / configured</span></article>
            <article><small>Sutra scheduled reports</small><strong>{sutraReports.available ? `${sutraReports.enabledCount}/${sutraReports.configuredCount}` : "Unavailable"}</strong><span>enabled / configured for this connection</span></article>
          </div>
          <p className={styles.curBoundaryNote}>AWS QuickSight threshold alerts and scheduled delivery are unavailable because provider configuration evidence is not ingested. Sutra automation is shown separately and is not claimed as QuickSight parity.</p>
        </article>
      </div>
      <details className={styles.curEvidenceDrawer}>
        <summary>Evidence, lineage, formulas, and parity limits</summary>
        <div className={styles.curEvidenceGrid}>
          <dl><div><dt>Connection</dt><dd>{report.tenant.connectionId}</dd></div><div><dt>Export</dt><dd>{report.tenant.exportName}</dd></div><div><dt>Evaluated</dt><dd>{new Date(report.evaluatedAtIso).toLocaleString()}</dd></div><div><dt>Active generations</dt><dd>{report.summary.activeGenerationCount}</dd></div></dl>
          <div><strong>Explainable signal policy</strong><ul><li>{report.signalPolicy.formulas.momAbsolutePercentChange}</li><li>{report.signalPolicy.formulas.trailingBaselineDeviation}</li></ul></div>
          <div><strong>Official parity boundary</strong><ul><li>Core AWS ML forecast remains withheld: {report.forecast.reason.replaceAll("_", " ").toLowerCase()}; the separately labelled Sutra estimate is deterministic.</li><li>QuickSight threshold alerts and scheduled report delivery are not connected to this view.</li><li>CUR2 taxonomy, usage, account names, and Region evidence are shown with completeness states; AWS Organizations identity and an authoritative geographic map remain unavailable.</li></ul></div>
        </div>
        <div className={styles.curTableWrap} tabIndex={0}><table className={styles.curTable}><caption>Immutable billing generation evidence by trends period</caption><thead><tr><th>Period</th><th>State</th><th>Generation</th><th>Manifest</th><th>Rows</th><th>Committed</th></tr></thead><tbody>{report.periods.map((period) => <tr key={period.period}><td>{period.period}</td><td><strong>{period.state}</strong><small>{period.stateReasons.join(", ")}</small></td><td>{period.generationId ?? "Not available"}</td><td>{period.lineage?.manifestSha256 ?? "Not available"}</td><td>{period.rowCount ?? "Not available"}</td><td>{period.lineage === null ? "Not available" : new Date(period.lineage.committedAtIso).toLocaleString()}</td></tr>)}</tbody></table></div>
      </details>
      <footer className={styles.curEvidence}>Active generations {report.summary.activeGenerationCount} · evaluated {new Date(report.evaluatedAtIso).toLocaleString()} · informational review signals are not AWS Cost Anomaly Detection findings</footer>
    </section>
  );
}

function transferCost(
  costs: DataTransferSnapshot["categorySummaries"][number]["costs"],
  basis: DataTransferCostBasis,
): string | null {
  return costs.find((cost) => cost.basis === basis)?.totalMicros ?? null;
}

function DataTransferOfficialCoverage({ audit }: {
  readonly audit: DataTransferOfficialAudit;
}) {
  return <details className={styles.curEvidenceDrawer}>
    <summary>Official AWS Data Transfer coverage · public definition unavailable</summary>
    <div className={styles.curEvidenceGrid}>
      <dl>
        <div><dt>Frozen commit</dt><dd>{audit.source.commit}</dd></div>
        <div><dt>Manifest SHA-256</dt><dd>{audit.source.manifestSha256}</dd></div>
        <div><dt>Embedded query SHA-256</dt><dd>{audit.source.embeddedQuerySha256}</dd></div>
        <div><dt>External template reference</dt><dd>{audit.source.externalTemplateId}</dd></div>
      </dl>
      <div><strong>Published artifact boundary</strong><ul><li>Manifest and inline <code>data_transfer_view</code> Athena SQL are published and hash-pinned.</li><li>QuickSight definition: not published.</li><li>QuickSight template body: not published.</li><li>Dashboard changelog: not published.</li></ul></div>
      <div><strong>Exact object totals</strong><ul><li>Sheets: not available</li><li>Visuals: not available</li><li>Controls: not available</li><li>Parameters, calculated fields, filter groups, and dataset objects: not available</li></ul></div>
      <div><strong>Control evidence</strong><ul><li>AWS guidance and the pinned public artifact do not enumerate dashboard controls.</li><li>Sutra&apos;s currency, cost-basis, category, direction, account, service, Region, source, destination, and transfer-type filters are native controls—not claimed QuickSight parity.</li></ul></div>
    </div>
    <div className={styles.curTableWrap} tabIndex={0}>
      <table className={styles.curTable}>
        <caption>Native mapping of the five visual purposes documented by AWS guidance</caption>
        <thead><tr><th>Documented purpose</th><th>Coverage</th><th>Native evidence</th><th>Remaining gap</th></tr></thead>
        <tbody>{audit.documentedVisualPurposes.map((item) => <tr key={item.purpose}><th scope="row">{item.purpose}</th><td>{item.coverage.replaceAll("_", " ")}</td><td>{item.nativeEvidence}</td><td>{item.remainingGap}</td></tr>)}</tbody>
      </table>
    </div>
    <p className={styles.curBoundaryNote}>The five AWS guidance bullets are documented purposes, not proof of five QuickSight visual objects. CUR2 provider-field rematerialization, controlled provider reconciliation, two-tenant proof, release-SHA review, immutable image deployment, and production acceptance remain open. No pixel, layout, interaction-tree, or QuickSight runtime parity is claimed.</p>
  </details>;
}

export function DataTransferReport({ report, officialAudit }: {
  readonly report: DataTransferSnapshot;
  readonly officialAudit: DataTransferOfficialAudit;
}) {
  const currencies = [...new Set(report.categorySummaries.map((item) => item.currency))];
  const [currency, setCurrency] = useState(currencies[0] ?? "USD");
  const [costBasis, setCostBasis] = useState<DataTransferCostBasis>("amortized");
  const [category, setCategory] = useState<DataTransferCategory | "ALL">("ALL");
  const [direction, setDirection] = useState<DataTransferDirection | "ALL">("ALL");
  const [account, setAccount] = useState("ALL");
  const [service, setService] = useState("ALL");
  const [region, setRegion] = useState("ALL");
  const [sourceLocation, setSourceLocation] = useState("ALL");
  const [destinationLocation, setDestinationLocation] = useState("ALL");
  const [transferType, setTransferType] = useState("ALL");
  const currencyRows = report.drilldowns.filter((item) => item.currency === currency);
  const categories = report.categorySummaries.filter((item) =>
    item.currency === currency && (category === "ALL" || item.category === category));
  const categoryOptions = [...new Set(currencyRows.map((item) => item.category))].sort();
  const directionOptions = [...new Set(currencyRows.map((item) => item.direction))].sort();
  const accountOptions = [...new Set(currencyRows.map((item) => item.usageAccountId))].sort();
  const serviceOptions = [...new Set(currencyRows.map((item) => item.service))].sort();
  const regionOptions = [...new Set(currencyRows.map((item) => item.region ?? "NOT_REPORTED"))].sort();
  const sourceLocationOptions = [...new Set(currencyRows.map((item) => item.path.sourceLocation ?? "NOT_REPORTED"))].sort();
  const destinationLocationOptions = [...new Set(currencyRows.map((item) => item.path.destinationLocation ?? "NOT_REPORTED"))].sort();
  const transferTypeOptions = [...new Set(currencyRows.map((item) => item.provider.transferType ?? "NOT_REPORTED"))].sort();
  const drilldowns = currencyRows.filter((item) =>
    (category === "ALL" || item.category === category)
    && (direction === "ALL" || item.direction === direction)
    && (account === "ALL" || item.usageAccountId === account)
    && (service === "ALL" || item.service === service)
    && (region === "ALL" || (item.region ?? "NOT_REPORTED") === region)
    && (sourceLocation === "ALL" || (item.path.sourceLocation ?? "NOT_REPORTED") === sourceLocation)
    && (destinationLocation === "ALL" || (item.path.destinationLocation ?? "NOT_REPORTED") === destinationLocation)
    && (transferType === "ALL" || (item.provider.transferType ?? "NOT_REPORTED") === transferType));
  return (
    <section className={styles.curWorkspace} aria-label="Enterprise AWS data-transfer intelligence">
      <StatusBanner
        state={report.state}
        message={report.source.objectCoverage.status === "unavailable" ? "Row evidence is active and reconciled, but manifest object counts were not retained; completeness remains partial." : "The selected source generation is not fully fresh and ready."}
      />
      <DataTransferOfficialCoverage audit={officialAudit} />
      <header className={styles.curHeader}>
        <div><p className="eyebrow">AWS Data Transfer</p><h2>Transfer cost intelligence</h2><p>Charged internet, Global Accelerator, inter-Region, inter-AZ, and CloudFront evidence with exact cost, byte, account, service, Region, Availability Zone, and resource drilldowns.</p></div>
        <div className={styles.curFilters}>
          <label>Currency<select value={currency} onChange={(event) => setCurrency(event.target.value)}>{currencies.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Cost basis<select value={costBasis} onChange={(event) => setCostBasis(event.target.value as DataTransferCostBasis)}>{["unblended", "net", "amortized", "list", "contracted", "public"].map((item) => <option key={item}>{item}</option>)}</select></label>
          <button type="button" disabled={drilldowns.length === 0} onClick={() => downloadDataTransferEvidenceCsv(report, drilldowns, costBasis)}>Export filtered evidence</button>
        </div>
      </header>
      <div className={styles.curTransferFilters} role="group" aria-label="Data-transfer drilldown filters">
        <label>Category<select value={category} onChange={(event) => setCategory(event.target.value as DataTransferCategory | "ALL")}><option value="ALL">All categories</option>{categoryOptions.map((item) => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}</select></label>
        <label>Direction<select value={direction} onChange={(event) => setDirection(event.target.value as DataTransferDirection | "ALL")}><option value="ALL">All directions</option>{directionOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>Account<select value={account} onChange={(event) => setAccount(event.target.value)}><option value="ALL">All accounts</option>{accountOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>Service<select value={service} onChange={(event) => setService(event.target.value)}><option value="ALL">All services</option>{serviceOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>Region<select value={region} onChange={(event) => setRegion(event.target.value)}><option value="ALL">All Regions</option>{regionOptions.map((item) => <option key={item} value={item}>{item === "NOT_REPORTED" ? "Not reported" : item}</option>)}</select></label>
        <label>Source<select value={sourceLocation} onChange={(event) => setSourceLocation(event.target.value)}><option value="ALL">All source locations</option>{sourceLocationOptions.map((item) => <option key={item} value={item}>{item === "NOT_REPORTED" ? "Not reported" : item}</option>)}</select></label>
        <label>Destination<select value={destinationLocation} onChange={(event) => setDestinationLocation(event.target.value)}><option value="ALL">All destination locations</option>{destinationLocationOptions.map((item) => <option key={item} value={item}>{item === "NOT_REPORTED" ? "Not reported" : item}</option>)}</select></label>
        <label>Transfer type<select value={transferType} onChange={(event) => setTransferType(event.target.value)}><option value="ALL">All transfer types</option>{transferTypeOptions.map((item) => <option key={item} value={item}>{item === "NOT_REPORTED" ? "Not reported" : item}</option>)}</select></label>
      </div>
      <div className={styles.curKpis}>
        <article><small>Transfer candidates</small><strong>{report.coverage.transferCandidateRowCount.toLocaleString("en-US")}</strong><span>{report.coverage.classification} classification</span></article>
        <article><small>Classified rows</small><strong>{report.coverage.classifiedRowCount.toLocaleString("en-US")}</strong><span>{report.coverage.unclassifiedRowCount + report.coverage.unknownRowCount} need review</span></article>
        <article><small>Byte normalization</small><strong>{report.coverage.byteNormalization}</strong><span>{report.coverage.byteNormalizedRowCount.toLocaleString("en-US")} rows normalized</span></article>
        <article><small>Manifest coverage</small><strong>{report.source.objectCoverage.status}</strong><span>{report.source.errorCode?.replaceAll("_", " ") ?? "Complete evidence"}</span></article>
      </div>
      {categories.length === 0 ? <p className={styles.emptyNote}>No data-transfer candidates were classified for this currency and period.</p> : (
        <div className={styles.curCategoryGrid} aria-label="Charged transfer category summary">{categories.map((item) => <article key={`${item.category}:${item.currency}`}><small>{item.category.replaceAll("_", " ")}</small><strong>{formatCurMicrosExact(transferCost(item.costs, costBasis), item.currency)}</strong><span>{item.rowCount} rows · {item.directionCounts.OUTBOUND} outbound · {item.directionCounts.INBOUND} inbound</span><i>{item.normalizedBytesMicros === null ? "Bytes unavailable" : `${grouped(item.normalizedBytesMicros)} microbytes`}</i></article>)}</div>
      )}
      <article className={styles.curPanel}>
        <div className={styles.curPanelHeading}><div><small>Resource evidence</small><h3>Transfer drilldown</h3></div><span>{drilldowns.length} groups</span></div>
        {drilldowns.length === 0 ? <p className={styles.emptyNote}>No evidence-backed transfer group is available.</p> : (
          <div className={styles.curTableWrap} tabIndex={0}><table className={styles.curTable}><caption>Data-transfer cost by exact provider-reported source, destination, transfer type, account, service, Region, Availability Zone, and resource</caption><thead><tr><th>Category / direction</th><th>Source → destination</th><th>Account / provider</th><th>Region / AZ / resource</th><th>{costBasis} cost</th><th>Evidence</th></tr></thead><tbody>{drilldowns.slice(0, 40).map((item) => <tr key={JSON.stringify([item.category,item.direction,item.currency,item.usageAccountId,item.service,item.region,item.availabilityZone,item.resourceId,item.path.sourceLocation,item.path.sourceLocationType,item.path.destinationLocation,item.provider.serviceCode,item.provider.serviceName,item.provider.productCode,item.provider.productName,item.provider.operation,item.provider.transferType])}><td><strong>{item.category.replaceAll("_", " ")}</strong><small>{item.direction}</small></td><td><strong>{item.path.sourceLocation ?? "Source not reported"} → {item.path.destinationLocation ?? "Destination not reported"}</strong><small>{item.path.sourceLocationType ?? "Location type not reported"} · {item.path.evidence.replaceAll("_", " ")}</small></td><td><strong>{item.usageAccountId}</strong><small>{item.provider.serviceName ?? item.provider.serviceCode ?? item.service} · {item.provider.productName ?? item.provider.productCode ?? "Product not reported"} · {item.provider.operation ?? "Operation not reported"} · {item.provider.transferType ?? "Transfer type not reported"}</small></td><td><strong>{item.region ?? "Region not reported"}</strong><small>{item.availabilityZone ?? "AZ not reported"} · {item.resourceId ?? "Resource not reported"}</small></td><td>{formatCurMicrosExact(transferCost(item.costs, costBasis), item.currency)}</td><td><strong>{item.rowCount} rows</strong><small>{item.classificationRuleIds.join(", ")}</small></td></tr>)}</tbody></table></div>
        )}
      </article>
      <details className={styles.curEvidenceDrawer}>
        <summary>Evidence, lineage, classification, and official parity limits</summary>
        <div className={styles.curEvidenceGrid}>
          <dl><div><dt>Generation</dt><dd>{report.scope.generationId}</dd></div><div><dt>Manifest SHA-256</dt><dd>{report.source.manifestSha256 ?? "Not available"}</dd></div><div><dt>Manifest objects</dt><dd>{report.source.objectCoverage.manifestObjectCount ?? "Not retained"}</dd></div><div><dt>Processed objects</dt><dd>{report.source.objectCoverage.processedObjectCount ?? "Not retained"}</dd></div></dl>
          <div><strong>Pinned classification</strong><ul><li>{report.taxonomy.id} · {report.taxonomy.version}</li><li>{report.taxonomy.sha256}</li><li>{report.coverage.unclassifiedRowCount} unclassified and {report.coverage.unknownRowCount} unknown rows remain visible.</li></ul></div>
          <div><strong>Provider path coverage</strong><ul><li>Source location: {report.coverage.dimensions.sourceLocation}</li><li>Destination location: {report.coverage.dimensions.destinationLocation}</li><li>Provider service: {report.coverage.dimensions.providerService}</li><li>Transfer type: {report.coverage.dimensions.transferType}</li></ul></div>
          <div><strong>Official parity boundary</strong><ul>{report.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}<li>Global Accelerator cards show billed CUR evidence; they do not simulate a future pricing quote.</li><li>CUR Region and Availability Zone fields are not inferred traffic endpoints.</li></ul></div>
        </div>
      </details>
      <footer className={styles.curEvidence}>Generation {report.scope.generationId.slice(0, 16)}… · taxonomy {report.taxonomy.version} · {report.source.dataThroughAtIso === null ? "source freshness unavailable" : `source updated ${new Date(report.source.dataThroughAtIso).toLocaleString()}`}</footer>
    </section>
  );
}

export function FinopsCurIntelligencePanels({
  connectionId,
  section,
}: CurIntelligenceProps) {
  const [reloadToken, setReloadToken] = useState(0);
  const [period, setPeriod] = useState<string | null>(null);
  const [trendsFromPeriod, setTrendsFromPeriod] = useState<string | null>(null);
  const [trendsToPeriod, setTrendsToPeriod] = useState<string | null>(null);
  const [trendsRollingWindow, setTrendsRollingWindow] = useState(3);
  const [state, setState] = useState<LoadState<TrendsEnvelope | DataTransferEnvelope>>({ status: "loading" });
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setReloadToken((current) => current + 1);
  }, []);
  const selectPeriod = useCallback((nextPeriod: string) => {
    setState({ status: "loading" });
    setPeriod(nextPeriod);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ connectionId });
    if (section === "overview") {
      query.set("costBases", "unblended,amortized");
      query.set("rollingWindowMonths", String(trendsRollingWindow));
      query.set("contributorLimit", "8");
      if (trendsFromPeriod !== null && trendsToPeriod !== null) {
        query.set("fromPeriod", trendsFromPeriod);
        query.set("toPeriod", trendsToPeriod);
      }
    } else {
      query.set("groupLimit", "250");
      if (period !== null) query.set("period", period);
    }
    const endpoint = section === "overview" ? "trends" : "data-transfer";
    const schema = section === "overview"
      ? "sutra.finops-trends-intelligence.v1"
      : "sutra.finops-data-transfer-snapshot.v1";
    void fetch(`/api/v1/finops/${endpoint}?${query.toString()}`, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    }).then((response) => readEnvelope<TrendsEnvelope | DataTransferEnvelope>(
      response,
      connectionId,
      schema,
      section === "services" ? "sutra.data-transfer-official-audit.v1" : null,
    )).then((envelope) => {
      if (!controller.signal.aborted) setState({ status: "ready", envelope });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({
        status: "error",
        message: error instanceof Error ? error.message : "The CUR2 request failed.",
      });
    });
    return () => controller.abort();
  }, [connectionId, period, reloadToken, section, trendsFromPeriod, trendsRollingWindow, trendsToPeriod]);

  const periodOptions = useMemo(() => state.status === "ready"
    ? state.envelope.availablePeriods
    : [], [state]);
  if (state.status === "loading") {
    return <section className={styles.curState} role="status"><span aria-hidden="true">CUR2</span><div><strong>Loading immutable billing evidence</strong><p>Reading bounded active generations for this customer connection.</p></div></section>;
  }
  if (state.status === "error") {
    return <section className={styles.curState} role="alert"><span aria-hidden="true">!</span><div><strong>CUR2 intelligence could not load</strong><p>{state.message}</p></div><button type="button" onClick={retry}>Retry</button></section>;
  }
  const envelope = state.envelope;
  const periodControl = section === "services" && periodOptions.length > 0 ? (
    <label className={styles.curPeriod}>Billing period<select value={period ?? (envelope as DataTransferEnvelope).selectedPeriod ?? ""} onChange={(event) => selectPeriod(event.target.value)}>{periodOptions.map((item) => <option key={item.generationId} value={item.period}>{item.period}</option>)}</select></label>
  ) : null;
  if (envelope.report === null) {
    return <><SourceState state={envelope.sourceState} title={section === "overview" ? "Enterprise trends are waiting" : "Data-transfer intelligence is waiting"} onRetry={retry} />{section === "overview" ? <TrendsOfficialCoverage definition={(envelope as TrendsEnvelope).officialDefinition} /> : <DataTransferOfficialCoverage audit={(envelope as DataTransferEnvelope).officialAudit} />}{periodControl}</>;
  }
  if (section === "overview") {
    const report = (envelope as TrendsEnvelope).report;
    if (report === null || !report.ok) {
      return <><section className={styles.curState} role="alert"><span aria-hidden="true">!</span><div><strong>Trends evidence was rejected</strong><p>{report?.failures.map((failure) => failure.code).join(" · ") ?? "Unknown engine rejection"}</p></div><button type="button" onClick={retry}>Retry</button></section><TrendsOfficialCoverage definition={(envelope as TrendsEnvelope).officialDefinition} /></>;
    }
    const trendsEnvelope = envelope as TrendsEnvelope;
    return <TrendsReport
      report={report}
      officialDefinition={trendsEnvelope.officialDefinition}
      availablePeriods={trendsEnvelope.availablePeriods}
      onFromPeriodChange={(nextPeriod) => {
        setTrendsFromPeriod(nextPeriod);
        setTrendsToPeriod((current) => {
          const effective = current ?? trendsEnvelope.selectedWindow?.toPeriod ?? nextPeriod;
          return effective < nextPeriod ? nextPeriod : effective;
        });
      }}
      onToPeriodChange={(nextPeriod) => {
        setTrendsToPeriod(nextPeriod);
        setTrendsFromPeriod((current) => {
          const effective = current ?? trendsEnvelope.selectedWindow?.fromPeriod ?? nextPeriod;
          return effective > nextPeriod ? nextPeriod : effective;
        });
      }}
      onRollingWindowChange={setTrendsRollingWindow}
    />;
  }
  const transferReport = (envelope as DataTransferEnvelope).report!;
  return <>{periodControl}<DataTransferReport key={transferReport.scope.generationId} report={transferReport} officialAudit={(envelope as DataTransferEnvelope).officialAudit} /></>;
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DataTransferCostBasis,
  DataTransferSnapshot,
} from "../../lib/finops-data-transfer";
import type {
  FinopsTrendsExactRational,
  FinopsTrendsIntelligenceResult,
  FinopsTrendsSeries,
} from "../../lib/finops-trends-intelligence";
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

interface TrendsEnvelope {
  readonly connectionId: string;
  readonly selectedWindow: {
    readonly fromPeriod: string;
    readonly toPeriod: string;
  } | null;
  readonly availablePeriods: readonly AvailablePeriod[];
  readonly report: FinopsTrendsIntelligenceResult | null;
  readonly sourceState: string;
}

interface DataTransferEnvelope {
  readonly connectionId: string;
  readonly selectedPeriod: string | null;
  readonly availablePeriods: readonly AvailablePeriod[];
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
  const scaled = (absolute * BigInt(10_000)) / denominator;
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readEnvelope<T>(
  response: Response,
  connectionId: string,
  schema: string,
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
  if (state === "READY") return null;
  return (
    <div className={styles.curBanner} data-state={state.toLowerCase()} role="status">
      <strong>{state.replaceAll("_", " ")}</strong>
      <span>{message}</span>
    </div>
  );
}

function TrendsReport({ report }: { readonly report: Extract<FinopsTrendsIntelligenceResult, { ok: true }> }) {
  const [currency, setCurrency] = useState(report.series[0]?.currency ?? "USD");
  const [costBasis, setCostBasis] = useState(report.series[0]?.costBasis ?? "unblended");
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
  const current = selected?.points.at(-1) ?? null;
  const monthOverMonthDetail = current === null
    ? "No period"
    : current.monthOverMonth.available
      ? formatCurMicrosExact(
        current.monthOverMonth.deltaMicros,
        selected?.currency ?? currency,
      )
      : current.monthOverMonth.reason.replaceAll("_", " ");
  const contributors = current?.contributors.flatMap((group) =>
    group.contributors.map((entry) => ({ ...entry, dimension: group.dimension }))) ?? [];
  return (
    <section className={styles.curWorkspace} aria-label="Enterprise CUR2 trends intelligence">
      <StatusBanner
        state={report.state}
        message="Missing, current, stale, or partially reconciled periods remain visible and are never interpolated."
      />
      <header className={styles.curHeader}>
        <div><p className="eyebrow">Immutable CUR2 intelligence</p><h2>Enterprise cost trends</h2><p>Exact monthly comparisons, explainable signals, and ranked contributors from active reconciled generations only.</p></div>
        <div className={styles.curFilters}>
          <label>Currency<select value={currency} onChange={(event) => setCurrency(event.target.value)}>{currencies.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Cost basis<select value={costBasis} onChange={(event) => setCostBasis(event.target.value as FinopsTrendsSeries["costBasis"])}>{bases.map((item) => <option key={item}>{item}</option>)}</select></label>
        </div>
      </header>
      <div className={styles.curKpis}>
        <article><small>Current period</small><strong>{formatCurMicrosExact(current?.totalMicros ?? null, selected?.currency ?? currency)}</strong><span>{current?.period ?? "Not available"}</span></article>
        <article><small>Month over month</small><strong>{current?.monthOverMonth.available ? formatCurRationalPercentExact(current.monthOverMonth.percent) : "Not available"}</strong><span>{monthOverMonthDetail}</span></article>
        <article><small>Evidence coverage</small><strong>{report.summary.completePeriodCount}/{report.window.periodCount}</strong><span>{report.summary.sourceRowCount.toLocaleString("en-US")} accepted rows</span></article>
        <article><small>Explainable signals</small><strong>{report.summary.signalCount}</strong><span>pinned thresholds · no forecast</span></article>
      </div>
      {selected === null ? <p className={styles.emptyNote}>No currency and cost-basis series is available.</p> : (
        <div className={styles.curGrid}>
          <article className={styles.curPanel}>
            <div className={styles.curPanelHeading}><div><small>Monthly evidence</small><h3>{selected.currency} · {selected.costBasis}</h3></div><span>{report.window.fromPeriod} — {report.window.toPeriod}</span></div>
            <div className={styles.curChart} role="img" aria-label={`Exact ${selected.currency} ${selected.costBasis} monthly cost trend`}>
              {selected.points.map((point) => (
                <div className={styles.curColumn} key={point.period}>
                  <span>{formatCurMicrosExact(point.totalMicros, selected.currency)}</span>
                  <i style={{ height: `${Math.max(3, relativeBasisPoints(point.totalMicros, maximum) / 100)}%` }} data-state={point.periodState.toLowerCase()} />
                  <b>{point.period.slice(5)}</b><small>{point.periodState.replaceAll("_", " ")}</small>
                </div>
              ))}
            </div>
          </article>
          <article className={styles.curPanel}>
            <div className={styles.curPanelHeading}><div><small>Cost movers</small><h3>Current-period contributors</h3></div><span>{contributors.length} shown</span></div>
            {contributors.length === 0 ? <p className={styles.emptyNote}>A complete prior period is required before contributor movement can be ranked.</p> : (
              <ul className={styles.curContributors}>{contributors.slice(0, 12).map((entry) => (
                <li key={`${entry.dimension}:${entry.value ?? "unknown"}`}><span><b>{entry.value ?? "Unallocated"}</b><small>{entry.dimension.replaceAll("_", " ")}</small></span><span><strong>{formatCurMicrosExact(entry.deltaMicros, selected.currency)}</strong><small>{formatCurRationalPercentExact(entry.absoluteMovementShare)}</small></span></li>
              ))}</ul>
            )}
          </article>
        </div>
      )}
      <section className={styles.curSignals} aria-label="Explainable cost signals">
        <div className={styles.curPanelHeading}><div><small>Pinned policy</small><h3>Signals requiring review</h3></div><span>Informational, not a forecast</span></div>
        {(current?.signals.length ?? 0) === 0 ? <p className={styles.emptyNote}>No pinned threshold was crossed for the selected current period.</p> : current?.signals.map((signal) => <article key={signal.code}><span>{signal.severity}</span><div><strong>{signal.code.replaceAll("_", " ")}</strong><p>{signal.explanation}</p><small>{formatCurRationalPercentExact(signal.observedPercent)} · {signal.baseline.replaceAll("_", " ")}</small></div></article>)}
      </section>
      <footer className={styles.curEvidence}>Active generations {report.summary.activeGenerationCount} · evaluated {new Date(report.evaluatedAtIso).toLocaleString()} · forecast withheld ({report.forecast.reason.replaceAll("_", " ").toLowerCase()})</footer>
    </section>
  );
}

function transferCost(
  costs: DataTransferSnapshot["categorySummaries"][number]["costs"],
  basis: DataTransferCostBasis,
): string | null {
  return costs.find((cost) => cost.basis === basis)?.totalMicros ?? null;
}

function DataTransferReport({ report }: { readonly report: DataTransferSnapshot }) {
  const currencies = [...new Set(report.categorySummaries.map((item) => item.currency))];
  const [currency, setCurrency] = useState(currencies[0] ?? "USD");
  const [costBasis, setCostBasis] = useState<DataTransferCostBasis>("amortized");
  const categories = report.categorySummaries.filter((item) => item.currency === currency);
  const drilldowns = report.drilldowns.filter((item) => item.currency === currency);
  return (
    <section className={styles.curWorkspace} aria-label="Enterprise AWS data-transfer intelligence">
      <StatusBanner
        state={report.state}
        message={report.source.objectCoverage.status === "unavailable" ? "Row evidence is active and reconciled, but manifest object counts were not retained; completeness remains partial." : "The selected source generation is not fully fresh and ready."}
      />
      <header className={styles.curHeader}>
        <div><p className="eyebrow">AWS Data Transfer</p><h2>Transfer cost intelligence</h2><p>Internet, inter-Region, inter-AZ, and CloudFront classification with exact cost, byte, account, service, and resource drilldowns.</p></div>
        <div className={styles.curFilters}>
          <label>Currency<select value={currency} onChange={(event) => setCurrency(event.target.value)}>{currencies.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Cost basis<select value={costBasis} onChange={(event) => setCostBasis(event.target.value as DataTransferCostBasis)}>{["unblended", "net", "amortized", "list", "contracted", "public"].map((item) => <option key={item}>{item}</option>)}</select></label>
        </div>
      </header>
      <div className={styles.curKpis}>
        <article><small>Transfer candidates</small><strong>{report.coverage.transferCandidateRowCount.toLocaleString("en-US")}</strong><span>{report.coverage.classification} classification</span></article>
        <article><small>Classified rows</small><strong>{report.coverage.classifiedRowCount.toLocaleString("en-US")}</strong><span>{report.coverage.unclassifiedRowCount + report.coverage.unknownRowCount} need review</span></article>
        <article><small>Byte normalization</small><strong>{report.coverage.byteNormalization}</strong><span>{report.coverage.byteNormalizedRowCount.toLocaleString("en-US")} rows normalized</span></article>
        <article><small>Manifest coverage</small><strong>{report.source.objectCoverage.status}</strong><span>{report.source.errorCode?.replaceAll("_", " ") ?? "Complete evidence"}</span></article>
      </div>
      {categories.length === 0 ? <p className={styles.emptyNote}>No data-transfer candidates were classified for this currency and period.</p> : (
        <div className={styles.curCategoryGrid}>{categories.map((item) => <article key={`${item.category}:${item.currency}`}><small>{item.category.replaceAll("_", " ")}</small><strong>{formatCurMicrosExact(transferCost(item.costs, costBasis), item.currency)}</strong><span>{item.rowCount} rows · {item.directionCounts.OUTBOUND} outbound</span><i>{item.normalizedBytesMicros === null ? "Bytes unavailable" : `${grouped(item.normalizedBytesMicros)} microbytes`}</i></article>)}</div>
      )}
      <article className={styles.curPanel}>
        <div className={styles.curPanelHeading}><div><small>Resource evidence</small><h3>Transfer drilldown</h3></div><span>{drilldowns.length} groups</span></div>
        {drilldowns.length === 0 ? <p className={styles.emptyNote}>No evidence-backed transfer group is available.</p> : (
          <div className={styles.curTableWrap}><table className={styles.curTable}><caption>Data-transfer cost by category, direction, account, service, region, and resource</caption><thead><tr><th>Category</th><th>Direction</th><th>Account / service</th><th>Region / resource</th><th>{costBasis} cost</th><th>Evidence</th></tr></thead><tbody>{drilldowns.slice(0, 40).map((item) => <tr key={`${item.category}:${item.direction}:${item.usageAccountId}:${item.service}:${item.region}:${item.resourceId}`}><td>{item.category.replaceAll("_", " ")}</td><td>{item.direction}</td><td><strong>{item.usageAccountId}</strong><small>{item.service}</small></td><td><strong>{item.region ?? "Not reported"}</strong><small>{item.resourceId ?? "Resource not reported"}</small></td><td>{formatCurMicrosExact(transferCost(item.costs, costBasis), item.currency)}</td><td><strong>{item.rowCount} rows</strong><small>{item.classificationRuleIds.join(", ")}</small></td></tr>)}</tbody></table></div>
        )}
      </article>
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
      query.set("rollingWindowMonths", "3");
      query.set("contributorLimit", "8");
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
    )).then((envelope) => {
      if (!controller.signal.aborted) setState({ status: "ready", envelope });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({
        status: "error",
        message: error instanceof Error ? error.message : "The CUR2 request failed.",
      });
    });
    return () => controller.abort();
  }, [connectionId, period, reloadToken, section]);

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
    return <><SourceState state={envelope.sourceState} title={section === "overview" ? "Enterprise trends are waiting" : "Data-transfer intelligence is waiting"} onRetry={retry} />{periodControl}</>;
  }
  if (section === "overview") {
    const report = (envelope as TrendsEnvelope).report;
    if (report === null || !report.ok) {
      return <section className={styles.curState} role="alert"><span aria-hidden="true">!</span><div><strong>Trends evidence was rejected</strong><p>{report?.failures.map((failure) => failure.code).join(" · ") ?? "Unknown engine rejection"}</p></div><button type="button" onClick={retry}>Retry</button></section>;
    }
    return <TrendsReport report={report} />;
  }
  const transferReport = (envelope as DataTransferEnvelope).report!;
  return <>{periodControl}<DataTransferReport key={transferReport.scope.generationId} report={transferReport} /></>;
}

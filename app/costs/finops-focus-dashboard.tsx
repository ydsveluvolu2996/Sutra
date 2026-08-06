"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FinopsDashboardCatalogEntry } from "../../lib/finops-dashboard-catalog";
import type {
  FinopsFocusCurrencyReport,
  FinopsFocusCostSummary,
  FinopsFocusDashboardResult,
  FinopsFocusDimension,
} from "../../lib/finops-focus-dashboard";
import type { FocusOfficialDefinition } from "../../lib/finops-focus-official-definition";
import {
  FinopsCapabilityShell,
  type FinopsCapabilityEvidence,
  type FinopsCapabilityViewState,
} from "./finops-capability-shell";
import { RankingBars, TimeSeriesChart } from "../components/charts";
import styles from "./costs.module.css";

type FocusReport = Extract<FinopsFocusDashboardResult, { ok: true }>;

interface AvailablePeriod {
  readonly period: string;
  readonly generationId: string;
  readonly committedAtIso: string;
}
interface FocusProviderSource { readonly provider: "AWS" | "AZURE" | "GCP"; readonly sourceId: string; readonly focusVersion: string | null; readonly state: string; readonly selectable: boolean }
interface FocusFilters { readonly billingAccount: string; readonly subAccount: string; readonly provider: string; readonly publisher: string; readonly chargeCategory: string }
const EMPTY_FOCUS_FILTERS: FocusFilters = { billingAccount: "", subAccount: "", provider: "", publisher: "", chargeCategory: "" };

interface FocusEnvelope {
  readonly connectionId: string;
  readonly selectedWindow: {
    readonly fromPeriod: string;
    readonly toPeriod: string;
  } | null;
  readonly availablePeriods: readonly AvailablePeriod[];
  readonly report: FocusReport | null;
  readonly providerSources: readonly FocusProviderSource[];
  readonly officialDefinition: FocusOfficialDefinition;
  readonly activation?: { readonly ready: boolean; readonly reason: string; readonly substitutionAllowed: false };
  readonly sourceState:
    | "complete"
    | "stale"
    | "partial"
    | "configuration_required"
    | "waiting"
    | "empty"
    | "source_incomplete";
}

type RequestState =
  | { readonly status: "loading"; readonly connectionId: string | null }
  | { readonly status: "loaded"; readonly envelope: FocusEnvelope }
  | {
      readonly status: "failed";
      readonly connectionId: string;
      readonly message: string;
    };

interface FinopsFocusDashboardProps {
  readonly connectionId: string | null;
  readonly dashboard: FinopsDashboardCatalogEntry;
  readonly onOpenSharedAnalysis: () => void;
}

const INTEGER_MICROS = /^-?(?:0|[1-9]\d{0,127})$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const STALE_AFTER_HOURS = 48;
const FOCUS_DIMENSION_LABELS: Readonly<Record<FinopsFocusDimension, string>> = {
  billing_account: "Billing account",
  sub_account: "Subaccount",
  provider: "Provider",
  publisher: "Publisher",
  service: "Service",
  service_category: "Service category",
  region: "Region",
  charge_category: "Charge category",
  invoice: "Invoice",
  resource: "Resource",
  resource_type: "Resource type",
};
type FocusCostBasis = "billed" | "effective" | "contracted" | "list";
const FOCUS_COST_LABELS: Readonly<Record<FocusCostBasis, string>> = {
  billed: "Billed Cost", effective: "Effective Cost", contracted: "Contracted Cost", list: "List Cost",
};
function focusCostMicros(summary: FinopsFocusCostSummary, basis: FocusCostBasis): string | null {
  if (basis === "billed") return summary.billedCostMicros;
  if (basis === "effective") return summary.effectiveCost?.totalMicros ?? null;
  if (basis === "contracted") return summary.contractedCost?.totalMicros ?? null;
  return summary.listCost?.totalMicros ?? null;
}
function focusCostCoverage(summary: FinopsFocusCostSummary, basis: FocusCostBasis): string {
  if (basis === "billed") return "complete";
  if (basis === "effective") return summary.effectiveCost?.coverage ?? "unavailable";
  if (basis === "contracted") return summary.contractedCost?.coverage ?? "unavailable";
  return summary.listCost?.coverage ?? "unavailable";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function grouped(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

/** Exact FOCUS monetary rendering. Billing micros are never converted to Number. */
export function formatFocusMicrosExact(
  micros: string | null,
  currency: string,
): string {
  if (
    micros === null
    || !INTEGER_MICROS.test(micros)
    || !CURRENCY.test(currency)
  ) return "Not available";
  const amount = BigInt(micros);
  const negative = amount < BigInt(0);
  const absolute = negative ? -amount : amount;
  const whole = (absolute / BigInt(1_000_000)).toString();
  const fraction = (absolute % BigInt(1_000_000)).toString()
    .padStart(6, "0")
    .replace(/0+$/u, "");
  return `${currency} ${negative ? "−" : ""}${grouped(whole)}${
    fraction.length === 0 ? ".00" : `.${fraction}`
  }`;
}

function parseFocusEnvelope(body: unknown, connectionId: string): FocusEnvelope {
  if (
    !isRecord(body)
    || body.connectionId !== connectionId
    || !Array.isArray(body.availablePeriods)
    || !Array.isArray(body.providerSources)
    || !isRecord(body.officialDefinition)
    || body.officialDefinition.schema !== "sutra.finops-focus-official-definition.v1"
    || !isRecord(body.officialDefinition.source)
    || body.officialDefinition.source.commit !== "f9e36d88c47709f10e8fa784ad11d5cc0e728021"
    || body.officialDefinition.source.definitionSha256 !== "bc7bafbcb47e745dd256a151ee3fbe260aad10515fc5e626e02aec0c6e6ea1cc"
    || !isRecord(body.officialDefinition.totals)
    || body.officialDefinition.totals.sheets !== 3
    || body.officialDefinition.totals.visuals !== 27
    || !("selectedWindow" in body)
    || !("report" in body)
    || ![
      "complete",
      "stale",
      "partial",
      "configuration_required",
      "waiting",
      "empty",
      "source_incomplete",
    ].includes(String(body.sourceState))
  ) throw new Error("The FOCUS response did not match its tenant-bound contract.");
  if (
    body.report !== null
    && (
      !isRecord(body.report)
      || body.report.ok !== true
      || body.report.schema !== "sutra.finops-focus-dashboard.v1"
      || body.report.standard !== "FOCUS_1_2"
      || body.report.conformanceClaim !== false
      || !Array.isArray(body.report.currencies)
      || !Array.isArray(body.report.trends)
    )
  ) throw new Error("The FOCUS report schema was not recognized.");
  return body as unknown as FocusEnvelope;
}

export function FocusOfficialDefinitionPanel({
  definition,
}: {
  readonly definition: FocusOfficialDefinition;
}) {
  return (
    <div className={styles.focusWorkspace}>
      <section className={styles.focusPanel} aria-label="Official AWS FOCUS definition coverage">
        <header>
          <div>
            <small>Pinned public QuickSight source</small>
            <h4>Official FOCUS definition coverage</h4>
          </div>
          <span>{definition.source.version} · {definition.source.commit.slice(0, 12)} · {definition.source.definitionSha256.slice(0, 16)}…</span>
        </header>
        <div className={styles.focusQualityGrid}>
          {definition.sheets.map((officialSheet) => (
            <article key={officialSheet.id}>
              <div>
                <strong>{officialSheet.name}</strong>
                <span>{officialSheet.visualCount} visuals · {officialSheet.parameterControls.length + officialSheet.filterControls.length} controls</span>
              </div>
              <b>{officialSheet.nativeCoverage}</b>
              <small>{officialSheet.documentedPurpose ?? "Source attribution, version and notices in layout text boxes."}</small>
            </article>
          ))}
        </div>
        <details className={styles.focusEvidenceDrawer}>
          <summary>Official provider repositories and native binding state</summary>
          <div className={styles.focusTableWrap} tabIndex={0} role="region" aria-label="Scrollable FOCUS provider source audit">
            <table className={styles.focusTable}>
              <caption>Official provider repository audit and native binding state</caption>
              <thead><tr><th>Provider</th><th>Published source</th><th>Immutable commit</th><th>Native state</th><th>Disclosure</th></tr></thead>
              <tbody>{definition.providerSources.map((source) => (
                <tr key={source.provider}>
                  <th scope="row">{source.provider}</th>
                  <td>{source.sourceKind.replaceAll("_", " ")}</td>
                  <td title={source.commit}>{source.commit.slice(0, 12)}</td>
                  <td>{source.nativeBindingState.replaceAll("_", " ")}</td>
                  <td>{source.disclosure}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p>{definition.totals.sheets} sheets · {definition.totals.visuals} visuals · {definition.totals.parameterControls + definition.totals.filterControls} controls. Exact counts describe the pinned public definition; Sutra does not claim QuickSight pixel, geometry, query-result, or interaction parity.</p>
          <p>Azure, GCP, and OCI normalized provider bindings remain fail-closed. Discovery never implies supported FOCUS ingestion, and native billing exports are never relabelled as FOCUS.</p>
        </details>
      </section>
    </div>
  );
}

async function readFocusEnvelope(
  response: Response,
  connectionId: string,
): Promise<FocusEnvelope> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isRecord(body)
      && isRecord(body.error)
      && typeof body.error.message === "string"
      ? body.error.message
      : "Sutra could not load the active FOCUS 1.2 report.";
    throw new Error(message);
  }
  return parseFocusEnvelope(body, connectionId);
}

/**
 * A FOCUS cost as a plottable amount, or null when there is nothing to plot.
 *
 * The bars this replaces read `focusCostMicros(entry, basis) ?? "0"`, so a
 * period or dimension value for which the selected basis supplies **no** cost
 * was plotted as zero and then floored to a visible stub by `Math.max(4, ...)`
 * or `Math.max(1, ...)`. Absence and a measured zero drew identically, and both
 * drew as a bar. Null here means "not supplied"; the caller excludes and counts
 * it rather than drawing it.
 *
 * Sign is preserved. The old `absoluteMicros` divisor drew a credit with the
 * same length as an equal charge, so a -500 refund and a +500 charge were
 * indistinguishable bars.
 *
 * Micros beyond exact double range are dropped rather than silently rounded
 * into a coordinate, matching how the data-transfer and extended-support
 * dashboards already handle unplottable monetary totals. The exact figure is
 * still printed beside each bar from the original micros string.
 */
/**
 * Axis and legend formatting for a plotted amount. The exact figure always
 * comes from `formatFocusMicrosExact` against the original micros; this is only
 * for the coordinate scale, where a rounded tick is expected and correct.
 */
function formatFocusPlotValue(value: number, currency: string): string {
  return `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function focusPlotAmount(micros: string | null): number | null {
  if (micros === null || !INTEGER_MICROS.test(micros)) return null;
  const parsed = Number(micros);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed / 1_000_000;
}

/**
 * Excluded-row disclosure shared by all four FOCUS charts. A row the selected
 * basis does not supply is absence, and saying so is the whole point of
 * excluding it -- silently dropping rows would understate the set as much as
 * plotting them as zero would misstate it.
 */
function FocusExcluded({ excluded, total, noun }: {
  readonly excluded: number;
  readonly total: number;
  readonly noun: string;
}) {
  if (excluded === 0) return null;
  return (
    <p className={styles.focusFootnote}>
      {excluded} of {total} {total === 1 ? noun : `${noun}s`} {excluded === 1 ? "supplies" : "supply"} no
      cost for this basis, or an amount too large to plot exactly, and {excluded === 1 ? "is" : "are"} excluded
      from the chart rather than drawn as zero.
    </p>
  );
}

/**
 * A FOCUS cost trend over ordered periods.
 *
 * Currency is fixed by the currency selector above, so every point already
 * shares one axis; the label states it so a screenshot cannot lose that context.
 */
function FocusCostTrend({ ariaLabel, currency, points }: {
  readonly ariaLabel: string;
  readonly currency: string;
  readonly points: readonly { readonly label: string; readonly micros: string | null; readonly detail?: string }[];
}) {
  const plottable = points
    .map((point) => ({ label: point.label, value: focusPlotAmount(point.micros) }))
    .filter((point): point is { label: string; value: number } => point.value !== null);
  return (
    <>
      {plottable.length === 0 ? null : (
        <TimeSeriesChart
          ariaLabel={ariaLabel}
          caption={`${currency} only. Periods with no supplied cost for the selected basis are excluded, not plotted as zero.`}
          formatValue={(value) => formatFocusPlotValue(value, currency)}
          series={[{ id: "cost", label: `${currency} cost`, points: plottable }]}
        />
      )}
      {points.every((point) => point.detail === undefined) ? null : (
        // The kit's data table carries the exact amounts, but not line counts or
        // basis coverage. Coverage of "unavailable" is a truth signal about the
        // selected basis, so it stays visible rather than being lost with the
        // markup the chart replaced.
        <dl className={styles.focusCoverageList}>
          {points.map((point) => (
            <div key={point.label}><dt>{point.label}</dt><dd>{point.detail}</dd></div>
          ))}
        </dl>
      )}
      <FocusExcluded excluded={points.length - plottable.length} total={points.length} noun="period" />
    </>
  );
}

/** A FOCUS cost ranking across one dimension's values, within one currency. */
function FocusDimensionRanking({ ariaLabel, currency, entries }: {
  readonly ariaLabel: string;
  readonly currency: string;
  readonly entries: readonly { readonly value: string | null; readonly micros: string | null; readonly lineCount: number }[];
}) {
  const plottable = entries
    .map((entry) => ({ entry, value: focusPlotAmount(entry.micros) }))
    .filter((row): row is { entry: typeof entries[number]; value: number } => row.value !== null)
    .map(({ entry, value }) => ({
      id: entry.value ?? "__missing__",
      label: entry.value ?? "Not provided",
      value,
      detail: `${entry.lineCount.toLocaleString("en-US")} lines · ${formatFocusMicrosExact(entry.micros, currency)}`,
    }));
  return (
    <>
      {plottable.length === 0 ? null : (
        <RankingBars
          ariaLabel={ariaLabel}
          caption={`${currency} only. Values with no supplied cost for the selected basis are excluded, not ranked as zero.`}
          formatValue={(value) => formatFocusPlotValue(value, currency)}
          items={plottable}
          sort
        />
      )}
      <FocusExcluded excluded={entries.length - plottable.length} total={entries.length} noun="value" />
    </>
  );
}

function statePresentation(
  connectionId: string | null,
  state: RequestState,
): {
  readonly view: FinopsCapabilityViewState;
  readonly title: string;
  readonly detail: string;
} {
  if (connectionId === null) {
    return {
      view: "configuration_required",
      title: "An active AWS trust-role connection is required",
      detail: "Connect AWS and deliver a canonical FOCUS 1.2 export. CUR, FOCUS 1.0, Cost Explorer, and sample spend are never substituted.",
    };
  }
  if (
    state.status === "loading"
    || (state.status === "loaded" && state.envelope.connectionId !== connectionId)
    || (state.status === "failed" && state.connectionId !== connectionId)
  ) {
    return {
      view: "loading",
      title: "Loading active canonical FOCUS 1.2 evidence",
      detail: "Reading the bounded tenant-scoped history without combining currencies or filling missing fields.",
    };
  }
  if (state.status === "failed") {
    return {
      view: "failed",
      title: "The FOCUS report could not be verified",
      detail: state.message,
    };
  }
  const { envelope } = state;
  if (envelope.sourceState === "configuration_required") {
    return {
      view: "configuration_required",
      title: "The selected provider FOCUS source is not ready",
      detail: `Activation state: ${envelope.activation?.reason ?? "FOCUS_SOURCE_NOT_CONFIGURED"}. Sutra will not relabel another billing schema or substitute another provider.`,
    };
  }
  if (envelope.sourceState === "waiting") {
    return {
      view: "waiting",
      title: "Waiting for an active FOCUS 1.2 generation",
      detail: "No accepted active generation matches the selected period window. No zero-spend result is inferred.",
    };
  }
  if (envelope.sourceState === "empty") {
    return {
      view: "empty",
      title: "The active delivery has no accepted billing rows",
      detail: "The selected active FOCUS 1.2 history is empty; no spend, savings, or reconciliation value is inferred.",
    };
  }
  if (envelope.sourceState === "source_incomplete" || envelope.sourceState === "partial") {
    return {
      view: "partial",
      title: "FOCUS source evidence is partial",
      detail: envelope.report === null
        ? "The active canonical rows failed a bounded quality check, so no visual totals are shown."
        : "Accepted rows remain visible below while rejected source rows and missing optional fields remain disclosed.",
    };
  }
  if (envelope.report === null) {
    return {
      view: "failed",
      title: "The FOCUS report response was incomplete",
      detail: "The API reported ready without a verified report payload.",
    };
  }
  if (envelope.sourceState === "stale") return { view: "stale", title: "The selected FOCUS evidence is stale", detail: "The provider-reported data-through timestamp is outside the 48-hour freshness boundary." };
  const committedAt = envelope.report.evidence.periods
    .map(({ committedAtIso }) => Date.parse(committedAtIso))
    .filter(Number.isFinite)
    .reduce((latest, value) => Math.max(latest, value), 0);
  const ageHours = committedAt === 0
    ? null
    : Math.max(0, (Date.now() - committedAt) / 3_600_000);
  if (ageHours === null || ageHours > STALE_AFTER_HOURS) {
    return {
      view: "stale",
      title: "The selected FOCUS evidence is stale",
      detail: ageHours === null
        ? "No valid active-generation commit timestamp was supplied; retained values are not presented as current."
        : `The newest selected generation was committed ${Math.floor(ageHours)} hours ago, beyond this view’s ${STALE_AFTER_HOURS}-hour freshness threshold.`,
    };
  }
  return {
    view: "complete",
    title: "Active FOCUS 1.2 projection loaded",
    detail: "All accepted rows in the selected active window are rendered below. This is a bounded cost projection, not FOCUS conformance certification or invoice reconciliation.",
  };
}

function evidenceFor(report: FocusReport | null): FinopsCapabilityEvidence | null {
  if (report === null) return null;
  const newest = [...report.evidence.periods].sort((left, right) =>
    right.committedAtIso.localeCompare(left.committedAtIso))[0] ?? null;
  const acceptedRecords = report.evidence.periods.reduce(
    (total, period) => total + period.acceptedRows,
    0,
  );
  const rejectedRecords = report.evidence.periods.reduce(
    (total, period) => total + period.rejectedRows,
    0,
  );
  const committedAt = newest === null ? Number.NaN : Date.parse(newest.committedAtIso);
  return {
    sourceLabel: "Active canonical FOCUS 1.2 partitions",
    collectedAt: newest?.committedAtIso ?? null,
    dataThroughAt: null,
    freshnessAgeHours: Number.isFinite(committedAt)
      ? Math.max(0, Math.floor((Date.now() - committedAt) / 3_600_000))
      : null,
    freshnessSlaHours: STALE_AFTER_HOURS,
    acceptedRecords,
    rejectedRecords,
    generationId: newest?.generationId ?? null,
    contentSha256: newest?.manifestSha256 ?? null,
    limitations: [
      "This view is not a FOCUS conformance certification.",
      "This view is not invoice reconciliation and makes no savings claim.",
      "Currencies are shown independently; no exchange-rate conversion is performed.",
      ...(rejectedRecords === 0
        ? []
        : [`${rejectedRecords} rejected source rows are excluded from displayed totals.`]),
    ],
  };
}

function percentFromBasisPoints(value: string | null): string { if (value === null || !INTEGER_MICROS.test(value)) return "Not available"; const amount=BigInt(value),negative=amount<BigInt(0),absolute=negative?-amount:amount;return `${negative?"−":""}${absolute/BigInt(100)}.${(absolute%BigInt(100)).toString().padStart(2,"0")}%`; }
function focusDelta(current: string | null, previous: string | null): { readonly amount: string | null; readonly basisPoints: string | null } {
  if (current === null || previous === null || !INTEGER_MICROS.test(current) || !INTEGER_MICROS.test(previous)) return { amount: null, basisPoints: null };
  const currentValue = BigInt(current); const previousValue = BigInt(previous); const amount = currentValue - previousValue;
  return { amount: amount.toString(), basisPoints: previousValue === BigInt(0) ? null : ((amount * BigInt(10_000)) / (previousValue < BigInt(0) ? -previousValue : previousValue)).toString() };
}

function CurrencyKpis({ currency, neutralCurrency }: { readonly currency: FinopsFocusCurrencyReport; readonly neutralCurrency: FocusReport["neutral"]["currencies"][number] | null }) {
  const distinct = (dimension: FinopsFocusDimension) => currency.dimensions.find((item) => item.dimension === dimension)?.distinctValueCount ?? 0;
  return (
    <div className={styles.focusKpis} aria-label={`${currency.currency} FOCUS key metrics`}>
      <article>
        <small>Billed cost</small>
        <strong>{formatFocusMicrosExact(currency.billedCostMicros, currency.currency)}</strong>
        <span>Exact signed accepted-row total</span>
      </article>
      <article>
        <small>Effective cost</small>
        <strong>{formatFocusMicrosExact(currency.effectiveCost.totalMicros, currency.currency)}</strong>
        <span>{currency.effectiveCost.coverage} · {currency.effectiveCost.missingLineCount} missing rows</span>
      </article>
      <article>
        <small>Contracted cost</small>
        <strong>{formatFocusMicrosExact(currency.contractedCost?.totalMicros ?? null, currency.currency)}</strong>
        <span>{currency.contractedCost?.coverage ?? "unavailable"} source coverage</span>
      </article>
      <article>
        <small>List cost</small>
        <strong>{formatFocusMicrosExact(currency.listCost?.totalMicros ?? null, currency.currency)}</strong>
        <span>{currency.listCost?.coverage ?? "unavailable"} source coverage</span>
      </article>
      <article>
        <small>Accepted lines</small>
        <strong>{currency.lineCount.toLocaleString("en-US")}</strong>
        <span>Current currency only</span>
      </article>
      <article>
        <small>Effective discount rate</small>
        <strong>{percentFromBasisPoints(neutralCurrency?.effectiveDiscountRate.basisPoints ?? null)}</strong>
        <span>{neutralCurrency?.effectiveDiscountRate.reason.replaceAll("_", " ") ?? "No denominator evidence"}</span>
      </article>
      <article><small>Total providers</small><strong>{distinct("provider")}</strong><span>Supplied provider values</span></article>
      <article><small>Total services</small><strong>{distinct("service")}</strong><span>Supplied service values</span></article>
      <article><small>Total accounts</small><strong>{distinct("sub_account")}</strong><span>Supplied subaccount values</span></article>
    </div>
  );
}

export function FinopsFocusReportView({ report }: { readonly report: FocusReport }) {
  const [currencyCode, setCurrencyCode] = useState(report.currencies[0]?.currency ?? "");
  const [dimension, setDimension] = useState<FinopsFocusDimension>("service");
  const [secondaryDimension, setSecondaryDimension] = useState<FinopsFocusDimension>("provider");
  const [costBasis, setCostBasis] = useState<FocusCostBasis>("effective");
  const selectedCurrency = report.currencies.find(({ currency }) =>
    currency === currencyCode) ?? report.currencies[0] ?? null;
  const selectedDimension = selectedCurrency?.dimensions.find((entry) =>
    entry.dimension === dimension) ?? null;
  const selectedSecondaryDimension = selectedCurrency?.dimensions.find((entry) => entry.dimension === secondaryDimension) ?? null;
  const trend = report.trends.filter(({ currency }) => currency === selectedCurrency?.currency);
  const drilldowns = report.drilldowns.rows.filter(({ currency }) =>
    currency === selectedCurrency?.currency);
  const neutralCurrency = report.neutral.currencies.find(({ currency }) => currency === selectedCurrency?.currency) ?? null;
  const periods = [...new Set(trend.map(({ period }) => period))].sort();
  const dailyTrend = (report.dailyTrends ?? []).filter(({ currency }) => currency === selectedCurrency?.currency).slice(-31);
  const latestPeriod = periods.at(-1) ?? null; const previousPeriod = periods.at(-2) ?? null;
  const monthlyBucket = (period: string | null) => period === null ? null : report.monthlyDimensions?.find((item) =>
    item.currency === selectedCurrency?.currency && item.dimension === dimension && item.period === period) ?? null;
  const latestDimension = monthlyBucket(latestPeriod); const previousDimension = monthlyBucket(previousPeriod);
  const previousEntries = new Map(previousDimension?.entries.map((entry) => [entry.value, entry]) ?? []);

  return (
    <div className={styles.focusWorkspace} aria-label="FOCUS 1.2 cost projection">
      <header className={styles.focusReportHeader}>
        <div>
          <p className="eyebrow">Canonical FOCUS 1.2 projection</p>
          <h3>Portable billing analysis</h3>
          <p>Exact accepted-row totals, trends, bounded dimensions, and source quality. No conformance or invoice-reconciliation claim is made.</p>
        </div>
        <div className={styles.focusCurrencyTabs} role="group" aria-label="Report currency">
          {report.currencies.map(({ currency }) => (
            <button
              aria-pressed={currency === selectedCurrency?.currency}
              key={currency}
              onClick={() => setCurrencyCode(currency)}
              type="button"
            >
              {currency}
            </button>
          ))}
          <label>Cost<select value={costBasis} onChange={(event) => setCostBasis(event.target.value as FocusCostBasis)}>{(Object.keys(FOCUS_COST_LABELS) as FocusCostBasis[]).map((basis) => <option key={basis} value={basis}>{FOCUS_COST_LABELS[basis]}</option>)}</select></label>
        </div>
      </header>

      {selectedCurrency === null ? (
        <p className={styles.focusEmpty}>No accepted currency totals are available in this report.</p>
      ) : (
        <>
          <CurrencyKpis currency={selectedCurrency} neutralCurrency={neutralCurrency} />
          <div className={styles.focusSplitGrid}>
            <section className={styles.focusPanel} aria-labelledby="focus-trend-heading">
              <header><div><small>Monthly evidence</small><h4 id="focus-trend-heading">{selectedCurrency.currency} {FOCUS_COST_LABELS[costBasis]} trend</h4></div><span>{trend.length} periods</span></header>
              {trend.length === 0 ? <p className={styles.focusEmpty}>No trend buckets are available.</p> : (
                <FocusCostTrend
                  ariaLabel={`${selectedCurrency.currency} exact ${FOCUS_COST_LABELS[costBasis]} trend`}
                  currency={selectedCurrency.currency}
                  points={trend.map((entry) => ({ label: entry.period, micros: focusCostMicros(entry, costBasis), detail: `${entry.lineCount.toLocaleString("en-US")} lines · ${focusCostCoverage(entry, costBasis)}` }))}
                />
              )}
            </section>

            <section className={styles.focusPanel} aria-labelledby="focus-dimension-heading">
              <header>
                <div><small>Bounded ranking</small><h4 id="focus-dimension-heading">Dimension analysis</h4></div>
                <label>
                  <span className={styles.focusVisuallyHidden}>Dimension</span>
                  <select value={dimension} onChange={(event) => setDimension(event.target.value as FinopsFocusDimension)}>
                    {selectedCurrency.dimensions.map(({ dimension: item }) => (
                      <option key={item} value={item}>{FOCUS_DIMENSION_LABELS[item]}</option>
                    ))}
                  </select>
                </label>
              </header>
              {selectedDimension === null ? <p className={styles.focusEmpty}>No dimension evidence is available.</p> : (
                <>
                  <FocusDimensionRanking
                    ariaLabel={`${FOCUS_DIMENSION_LABELS[dimension]} ${FOCUS_COST_LABELS[costBasis]} ranking`}
                    currency={selectedCurrency.currency}
                    entries={selectedDimension.entries.map((entry) => ({ value: entry.value, micros: focusCostMicros(entry, costBasis), lineCount: entry.lineCount }))}
                  />
                  <p className={styles.focusFootnote}>{selectedDimension.distinctValueCount} supplied values · {selectedDimension.missingLineCount} missing lines{selectedDimension.truncated ? " · ranking truncated at the server bound" : ""}</p>
                </>
              )}
            </section>
          </div>

          <section className={styles.focusPanel} aria-labelledby="focus-daily-heading">
            <header><div><small>Daily billing summary</small><h4 id="focus-daily-heading">Daily {FOCUS_COST_LABELS[costBasis]} in {selectedCurrency.currency}</h4></div><span>Latest {dailyTrend.length} retained days</span></header>
            {dailyTrend.length === 0 ? <p className={styles.focusEmpty}>No daily charge-period evidence is available.</p> : <FocusCostTrend ariaLabel={`${selectedCurrency.currency} exact daily ${FOCUS_COST_LABELS[costBasis]} trend`} currency={selectedCurrency.currency} points={dailyTrend.map((entry) => ({ label: entry.day, micros: focusCostMicros(entry, costBasis), detail: `${entry.lineCount.toLocaleString("en-US")} lines` }))} />}
          </section>

          <section className={styles.focusPanel} aria-labelledby="focus-secondary-heading"><header><div><small>Second Group By</small><h4 id="focus-secondary-heading">Secondary dimension analysis</h4></div><label><span className={styles.focusVisuallyHidden}>Second dimension</span><select value={secondaryDimension} onChange={(event) => setSecondaryDimension(event.target.value as FinopsFocusDimension)}>{selectedCurrency.dimensions.map(({ dimension: item }) => <option key={item} value={item}>{FOCUS_DIMENSION_LABELS[item]}</option>)}</select></label></header>
            {selectedSecondaryDimension === null ? <p className={styles.focusEmpty}>No secondary dimension evidence is available.</p> : <FocusDimensionRanking ariaLabel={`${FOCUS_DIMENSION_LABELS[secondaryDimension]} secondary ${FOCUS_COST_LABELS[costBasis]} ranking`} currency={selectedCurrency.currency} entries={selectedSecondaryDimension.entries.map((entry) => ({ value: entry.value, micros: focusCostMicros(entry, costBasis), lineCount: entry.lineCount }))} />}
          </section>

          <section className={styles.focusPanel} aria-labelledby="focus-mom-heading">
            <header><div><small>Month over month trends</small><h4 id="focus-mom-heading">{FOCUS_COST_LABELS[costBasis]} by {FOCUS_DIMENSION_LABELS[dimension]}</h4></div><span>{previousPeriod ?? "No prior period"} → {latestPeriod ?? "No current period"}</span></header>
            {latestDimension === null ? <p className={styles.focusEmpty}>No monthly dimension evidence is available for this selection.</p> : <div className={styles.focusTableWrap} tabIndex={0} role="region" aria-label="Scrollable FOCUS month over month table"><table className={styles.focusTable}><caption>Month over month exact cost change</caption><thead><tr><th>{FOCUS_DIMENSION_LABELS[dimension]}</th><th>Previous</th><th>Current</th><th>MoM change</th><th>MoM %</th></tr></thead><tbody>{latestDimension.entries.map((entry) => {
              const previous = previousEntries.get(entry.value) ?? null; const currentMicros = focusCostMicros(entry, costBasis); const previousMicros = previous === null ? null : focusCostMicros(previous, costBasis); const delta = focusDelta(currentMicros, previousMicros);
              return <tr key={entry.value ?? "missing"}><th scope="row">{entry.value ?? "Not provided"}</th><td>{formatFocusMicrosExact(previousMicros, selectedCurrency.currency)}</td><td>{formatFocusMicrosExact(currentMicros, selectedCurrency.currency)}</td><td>{formatFocusMicrosExact(delta.amount, selectedCurrency.currency)}</td><td>{percentFromBasisPoints(delta.basisPoints)}</td></tr>;
            })}</tbody></table></div>}
            <p className={styles.focusFootnote}>Changes are calculated only when both retained periods have complete coverage for the selected cost column. Missing or zero denominators remain unavailable.</p>
          </section>

          <section className={styles.focusPanel} aria-labelledby="focus-drilldown-heading">
            <header><div><small>Canonical line evidence</small><h4 id="focus-drilldown-heading">Bounded billing-line drilldown</h4></div><span>{drilldowns.length} of {report.drilldowns.totalRows.toLocaleString("en-US")} report rows</span></header>
            {drilldowns.length === 0 ? <p className={styles.focusEmpty}>No drilldown rows are available for {selectedCurrency.currency}.</p> : (
              <div className={styles.focusTableWrap} tabIndex={0} role="region" aria-label="Scrollable FOCUS billing-line table">
                <table className={styles.focusTable}>
                  <caption>Bounded canonical FOCUS billing-line drilldown</caption>
                  <thead><tr><th>Period</th><th>Line item</th><th>Service / category</th><th>Account</th><th>Region</th><th>Resource</th><th>Billed cost</th><th>Effective cost</th></tr></thead>
                  <tbody>{drilldowns.map((row) => (
                    <tr key={`${row.period}-${row.lineItemId}`}>
                      <td>{row.period}</td>
                      <td title={row.lineItemId}>{row.lineItemId}</td>
                      <th scope="row">{row.service}<small>{row.chargeCategory}</small></th>
                      <td>{row.subAccountId}<small>{row.billingAccountId ?? "Billing account not provided"}</small></td>
                      <td>{row.region ?? "Not provided"}</td>
                      <td>{row.resourceId ?? "Not provided"}</td>
                      <td>{formatFocusMicrosExact(row.billedCostMicros, row.currency)}</td>
                      <td>{formatFocusMicrosExact(row.effectiveCostMicros, row.currency)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </section>

          <section className={styles.focusPanel} aria-labelledby="focus-quality-heading">
            <header><div><small>Source quality</small><h4 id="focus-quality-heading">Schema coverage</h4></div><span>{report.quality.ingestionCoverage} ingestion · {report.quality.rejectedSourceRowCount} rejected</span></header>
            <div className={styles.focusQualityGrid}>
              {report.quality.fields.map((field) => (
                <article key={field.field}>
                  <div><strong>{field.field}</strong><span>{field.requirement.replaceAll("_", " ")}</span></div>
                  <b>{field.coverageBasisPoints === null ? "No rows" : `${BigInt(field.coverageBasisPoints) / BigInt(100)}%`}</b>
                  <small>{field.presentLineCount.toLocaleString("en-US")} present · {field.missingLineCount.toLocaleString("en-US")} missing</small>
                </article>
              ))}
            </div>
          </section>

          <section className={styles.focusPanel} aria-labelledby="focus-taxonomy-heading">
            <header><div><small>Governed organizational allocation</small><h4 id="focus-taxonomy-heading">Tag taxonomy</h4></div><span>{report.neutral.taxonomy.state} · {report.neutral.taxonomy.policyId ?? "no policy"}</span></header>
            {neutralCurrency === null || neutralCurrency.tags.length === 0 ? <p className={styles.focusEmpty}>No governed or provider tag values are present for this currency.</p> : <div className={styles.focusTableWrap} tabIndex={0} role="region" aria-label="Scrollable governed FOCUS tag taxonomy"><table className={styles.focusTable}><caption>Governed FOCUS tag taxonomy allocation</caption><thead><tr><th>Classification</th><th>Taxonomy key</th><th>Value</th><th>Lines</th><th>Billed cost</th></tr></thead><tbody>{neutralCurrency.tags.map((tag) => <tr key={`${tag.classification}:${tag.key}:${tag.value}`}><td>{tag.classification.replaceAll("_", " ")}</td><th scope="row">{tag.label}<small>{tag.key}</small></th><td>{tag.value}</td><td>{tag.lineCount}</td><td>{formatFocusMicrosExact(tag.billedCostMicros, neutralCurrency.currency)}</td></tr>)}</tbody></table></div>}
            <p className={styles.focusFootnote}>Only exact policy keys are governed. Provider-prefixed and ungoverned tags remain visibly separate.</p>
          </section>

          <details className={styles.focusEvidenceDrawer}>
            <summary>Active generation evidence for all selected periods</summary>
            <div className={styles.focusTableWrap} tabIndex={0} role="region" aria-label="Scrollable FOCUS generation evidence table">
              <table className={styles.focusTable}>
                <caption>Active canonical FOCUS generation evidence</caption>
                <thead><tr><th>Period</th><th>Generation</th><th>Manifest SHA-256</th><th>Source table</th><th>Committed</th><th>Accepted / rejected</th></tr></thead>
                <tbody>{report.evidence.periods.map((period) => (
                  <tr key={period.generationId}>
                    <th scope="row">{period.period}</th>
                    <td title={period.generationId}>{period.generationId.slice(0, 16)}…</td>
                    <td title={period.manifestSha256}>{period.manifestSha256.slice(0, 16)}…</td>
                    <td>{period.sourceTable}</td>
                    <td>{new Date(period.committedAtIso).toLocaleString("en-US", { timeZone: "UTC" })} UTC</td>
                    <td>{period.acceptedRows.toLocaleString("en-US")} / {period.rejectedRows.toLocaleString("en-US")}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <p>{report.disclaimer}</p>
            <p>Normalized source contract: {report.neutral.providers.join(", ")} · FOCUS {report.neutral.versions.join(", ")} · {report.neutral.sources.length} immutable period sources. Version and provider provenance are retained; currencies are never combined.</p>
          </details>
        </>
      )}
    </div>
  );
}

export function FinopsFocusDashboard({
  connectionId,
  dashboard,
  onOpenSharedAnalysis,
}: FinopsFocusDashboardProps) {
  const [requestState, setRequestState] = useState<RequestState>({
    status: "loading",
    connectionId: null,
  });
  const [fromPeriod, setFromPeriod] = useState("");
  const [toPeriod, setToPeriod] = useState("");
  const [providerSourceId, setProviderSourceId] = useState(connectionId ?? "");
  const [draftFilters, setDraftFilters] = useState<FocusFilters>(EMPTY_FOCUS_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<FocusFilters>(EMPTY_FOCUS_FILTERS);
  const requestSequence = useRef(0);

  useEffect(() => { const frame = window.requestAnimationFrame(() => setProviderSourceId(connectionId ?? "")); return () => window.cancelAnimationFrame(frame); }, [connectionId]);

  const load = useCallback(async (
    selectedFrom?: string,
    selectedTo?: string,
  ): Promise<void> => {
    if (connectionId === null) return;
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    await Promise.resolve();
    if (requestSequence.current !== sequence) return;
    setRequestState({ status: "loading", connectionId });
    const parameters = new URLSearchParams({ connectionId });
    if (providerSourceId !== "" && providerSourceId !== connectionId) parameters.set("providerSourceId", providerSourceId);
    for (const [key, value] of Object.entries(appliedFilters)) if (value !== "") parameters.set(key, value);
    if (selectedFrom !== undefined && selectedTo !== undefined) {
      parameters.set("fromPeriod", selectedFrom);
      parameters.set("toPeriod", selectedTo);
    }
    try {
      const response = await fetch(`/api/v1/finops/focus?${parameters.toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const envelope = await readFocusEnvelope(response, connectionId);
      if (requestSequence.current !== sequence) return;
      setRequestState({ status: "loaded", envelope });
      setFromPeriod(envelope.selectedWindow?.fromPeriod ?? "");
      setToPeriod(envelope.selectedWindow?.toPeriod ?? "");
    } catch (caught) {
      if (requestSequence.current !== sequence) return;
      setRequestState({
        status: "failed",
        connectionId,
        message: caught instanceof Error
          ? caught.message
          : "Sutra could not load the active FOCUS 1.2 report.",
      });
    }
  }, [appliedFilters, connectionId, providerSourceId]);

  useEffect(() => {
    requestSequence.current += 1;
    if (connectionId === null) return;
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [connectionId, providerSourceId, load]);

  const presentation = statePresentation(connectionId, requestState);
  const envelope = requestState.status === "loaded"
    && requestState.envelope.connectionId === connectionId
    ? requestState.envelope
    : null;
  const report = envelope?.report ?? null;
  const evidence = useMemo(() => evidenceFor(report), [report]);
  const periodOptions = envelope?.availablePeriods ?? [];
  const invalidWindow = fromPeriod === "" || toPeriod === "" || fromPeriod > toPeriod;
  const providerSources = envelope?.providerSources ?? [];
  const providerSelector = providerSources.length === 0 ? null : <label>FOCUS source<select value={providerSourceId || connectionId || ""} onChange={(event) => { setProviderSourceId(event.target.value); setFromPeriod(""); setToPeriod(""); }}>{providerSources.map((source) => <option key={source.sourceId} value={source.sourceId}>{source.provider} · FOCUS {source.focusVersion ?? "adapter pending"} · {source.state.replaceAll("_", " ")}</option>)}</select></label>;
  const actions = presentation.view === "configuration_required" ? (
    <>
      {providerSelector}
      <a className="button button-secondary" href="/onboard">Configure AWS source</a>
      <a className="button button-secondary" href={dashboard.documentationUrl} rel="noreferrer" target="_blank">AWS guidance</a>
    </>
  ) : (
    <>
      {providerSelector}
      <button className="button button-secondary" disabled={connectionId === null || requestState.status === "loading"} onClick={() => void load(fromPeriod || undefined, toPeriod || undefined)} type="button">Retry report</button>
      <button className="button button-secondary" onClick={onOpenSharedAnalysis} type="button">Open shared cost explorer</button>
      <a className="button button-secondary" href={dashboard.documentationUrl} rel="noreferrer" target="_blank">AWS guidance</a>
    </>
  );

  return (
    <FinopsCapabilityShell
      actions={actions}
      dashboard={dashboard}
      evidence={evidence}
      state={presentation.view}
      stateDetail={presentation.detail}
      stateTitle={presentation.title}
    >
      {envelope === null ? null : (
        <FocusOfficialDefinitionPanel definition={envelope.officialDefinition} />
      )}
      {periodOptions.length === 0 ? null : (
        <form
          className={styles.focusPeriodFilters}
          onSubmit={(event) => {
            event.preventDefault();
            if (!invalidWindow) void load(fromPeriod, toPeriod);
          }}
        >
          <label>From period<select value={fromPeriod} onChange={(event) => setFromPeriod(event.target.value)}>{periodOptions.map(({ period }) => <option key={`from-${period}`} value={period}>{period}</option>)}</select></label>
          <label>To period<select value={toPeriod} onChange={(event) => setToPeriod(event.target.value)}>{periodOptions.map(({ period }) => <option key={`to-${period}`} value={period}>{period}</option>)}</select></label>
          <button className="button button-secondary" disabled={invalidWindow || requestState.status === "loading"} type="submit">Apply period window</button>
          <button className="button button-secondary" disabled={requestState.status === "loading"} onClick={() => void load()} type="button">All available periods</button>
          {fromPeriod !== "" && toPeriod !== "" && fromPeriod > toPeriod ? <span role="alert">From period must not be after to period.</span> : null}
        </form>
      )}
      {report === null || report.selection === undefined ? null : (
        <form className={styles.focusPeriodFilters} aria-label="FOCUS billing controls" onSubmit={(event) => { event.preventDefault(); setAppliedFilters(draftFilters); }}>
          {([
            ["billingAccount", "Billing Account", report.selection.filterOptions.billingAccounts.values],
            ["subAccount", "Sub Account", report.selection.filterOptions.subAccounts.values],
            ["publisher", "Publisher", report.selection.filterOptions.publishers.values],
            ["provider", "Provider", report.selection.filterOptions.providers.values],
            ["chargeCategory", "Charge Category", report.selection.filterOptions.chargeCategories.values],
          ] as const).map(([key, label, options]) => <label key={key}>{label}<select value={draftFilters[key]} onChange={(event) => setDraftFilters({ ...draftFilters, [key]: event.target.value })}><option value="">All</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>)}
          <button className="button button-secondary" disabled={requestState.status === "loading"} type="submit">Apply billing controls</button>
          <button className="button button-secondary" disabled={requestState.status === "loading"} onClick={() => { setDraftFilters(EMPTY_FOCUS_FILTERS); setAppliedFilters(EMPTY_FOCUS_FILTERS); }} type="button">Clear billing controls</button>
          <small>{report.selection.matchedLineCount.toLocaleString("en-US")} of {report.selection.sourceAcceptedLineCount.toLocaleString("en-US")} accepted lines match</small>
          {Object.values(report.selection.filterOptions).some((option) => option.truncated) ? <small>One or more filter lists reached the 500-value display bound; omitted values are not grouped or relabeled.</small> : null}
        </form>
      )}
      {report === null ? null : <FinopsFocusReportView report={report} />}
    </FinopsCapabilityShell>
  );
}

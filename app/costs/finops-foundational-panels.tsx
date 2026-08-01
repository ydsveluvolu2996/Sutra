"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  FinopsCudosCostBasis,
  FinopsCudosCostSummary,
  FinopsCudosCurrencyExecutiveSummary,
  FinopsCudosRankingEntry,
  FinopsCudosResult,
  FinopsCudosTrendBucket,
} from "../../lib/finops-cudos";
import type {
  FinopsCostIntelligenceResult,
  FinopsCurrencyAllocation,
  FinopsTaxonomyAllocationNode,
} from "../../lib/finops-cost-intelligence";
import {
  FINOPS_KPI_IDS,
  type FinopsKpiMeasurement,
  type FinopsKpiResult,
} from "../../lib/finops-kpi";
import { FinopsCurIntelligencePanels } from "./finops-cur-intelligence-panels";
import styles from "./costs.module.css";

export type FinopsFoundationalSection =
  | "overview"
  | "explorer"
  | "allocation"
  | "optimization"
  | "commitments"
  | "services";

export type FinopsFoundationalAvailability =
  | "checking"
  | "canonical"
  | "legacy";

interface FinopsFoundationalPanelsProps {
  readonly connectionId: string | null;
  readonly section: FinopsFoundationalSection;
  readonly onAvailabilityChange?: (
    availability: FinopsFoundationalAvailability,
  ) => void;
}

interface ActiveGenerationEvidence {
  readonly manifestSha256: string;
  readonly generationId: string;
  readonly sourceUpdatedAtIso: string | null;
  readonly observedAtIso: string;
  readonly committedAtIso: string;
  readonly acceptedRows: number;
  readonly rejectedRows: number;
}

interface SingleGenerationSourceEvidence {
  readonly activeGeneration: ActiveGenerationEvidence;
}

interface PeriodGenerationEvidence extends ActiveGenerationEvidence {
  readonly period: string;
}

interface PeriodHistorySourceEvidence {
  readonly periods: readonly PeriodGenerationEvidence[];
}

type FoundationalSourceEvidence =
  | SingleGenerationSourceEvidence
  | PeriodHistorySourceEvidence;

interface AvailablePeriod {
  readonly period: string;
  readonly generationId: string;
  readonly committedAtIso: string;
}

interface CudosEnvelope {
  readonly connectionId: string;
  readonly selectedPeriod: string | null;
  readonly availablePeriods: readonly AvailablePeriod[];
  readonly report: FinopsCudosResult | null;
  readonly sourceState: "complete" | "waiting";
  readonly sourceEvidence: FoundationalSourceEvidence | null;
}

interface CostIntelligenceEnvelope {
  readonly connectionId: string;
  readonly selectedPeriods: readonly string[];
  readonly availablePeriods: readonly AvailablePeriod[];
  readonly report: FinopsCostIntelligenceResult | null;
  readonly taxonomyConfigured: boolean;
  readonly sourceState: "complete" | "waiting" | "configuration_required";
  readonly sourceEvidence: FoundationalSourceEvidence | null;
}

interface KpiEnvelope {
  readonly connectionId: string;
  readonly selectedPeriod: string | null;
  readonly availablePeriods: readonly AvailablePeriod[];
  readonly report: FinopsKpiResult | null;
  readonly goalsConfigured: number;
  readonly sourceState: "complete" | "waiting";
  readonly sourceEvidence: FoundationalSourceEvidence | null;
}

type EndpointState<T> =
  | { readonly status: "idle" | "loading" }
  | {
      readonly status: "waiting" | "configuration_required";
      readonly envelope?: T;
    }
  | { readonly status: "ready"; readonly envelope: T }
  | {
      readonly status: "incomplete";
      readonly envelope?: T;
      readonly failureCodes: readonly string[];
      readonly message?: string;
    }
  | { readonly status: "error"; readonly message: string };

const INITIAL_STATE: EndpointState<never> = { status: "idle" };
const INTEGER_MICROS = /^-?(?:0|[1-9]\d*)$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const BILLING_PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const GENERATION_ID = /^fbg_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * Formats signed integer micro-units without converting the value to Number.
 * Significant fractional micros are retained; whole amounts retain two
 * decimal places for scanability.
 */
export function formatMicrosExact(
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
  const whole = (absolute / BigInt(1_000_000)).toString()
    .replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const rawFraction = (absolute % BigInt(1_000_000)).toString().padStart(6, "0");
  const significantFraction = rawFraction.replace(/0+$/u, "");
  const fraction = significantFraction.length < 2
    ? significantFraction.padEnd(2, "0")
    : significantFraction;
  return `${negative ? "−" : ""}${currency} ${whole}.${fraction}`;
}

function formatBasisPoints(value: string | number | null): string {
  if (value === null) return "Not available";
  const basisPoints = typeof value === "number"
    ? BigInt(value)
    : INTEGER_MICROS.test(value)
      ? BigInt(value)
      : null;
  if (basisPoints === null) return "Not available";
  const negative = basisPoints < BigInt(0);
  const absolute = negative ? -basisPoints : basisPoints;
  const whole = absolute / BigInt(100);
  const fraction = (absolute % BigInt(100)).toString().padStart(2, "0");
  return `${negative ? "−" : ""}${whole.toString()}.${fraction}%`;
}

function percentageWidth(basisPoints: bigint): string {
  const bounded = basisPoints < BigInt(0)
    ? BigInt(0)
    : basisPoints > BigInt(10_000)
      ? BigInt(10_000)
      : basisPoints;
  const whole = bounded / BigInt(100);
  const fraction = (bounded % BigInt(100)).toString().padStart(2, "0");
  return `${whole.toString()}.${fraction}%`;
}

function relativeBasisPoints(value: string | null, maximum: bigint): bigint {
  if (
    value === null
    || !INTEGER_MICROS.test(value)
    || maximum <= BigInt(0)
  ) return BigInt(0);
  const parsed = BigInt(value);
  if (parsed <= BigInt(0)) return BigInt(0);
  return (parsed * BigInt(10_000)) / maximum;
}

function costFor(
  costs: readonly FinopsCudosCostSummary[],
  basis: FinopsCudosCostBasis,
): FinopsCudosCostSummary | null {
  return costs.find((cost) => cost.basis === basis) ?? null;
}

function readableToken(value: string): string {
  return value.replaceAll("_", " ");
}

function compactEvidence(value: string, visible = 20): string {
  if (value.length <= visible) return value;
  const half = Math.max(4, Math.floor((visible - 1) / 2));
  return `${value.slice(0, half)}…${value.slice(-half)}`;
}

function formatObservedAt(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(parsed));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class FoundationalEndpointError extends Error {
  public readonly kind: "no_active_generation" | "source_incomplete" | "request";

  public constructor(
    message: string,
    kind: FoundationalEndpointError["kind"],
  ) {
    super(message);
    this.kind = kind;
  }
}

function endpointError(body: unknown): FoundationalEndpointError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code = error !== null && typeof error.code === "string"
    ? error.code
    : "";
  const message = error !== null && typeof error.message === "string"
    ? error.message
    : "The canonical billing endpoint could not be read.";
  if (
    code.includes("NO_ACTIVE")
    || code.includes("MISSING_ACTIVE")
    || code.includes("NO_RECONCILED")
  ) return new FoundationalEndpointError(message, "no_active_generation");
  if (
    code.includes("INCOMPLETE")
    || code.includes("MISSING_SOURCE")
    || code.includes("RECONCILIATION")
  ) return new FoundationalEndpointError(message, "source_incomplete");
  return new FoundationalEndpointError(message, "request");
}

function validActiveGeneration(value: unknown): boolean {
  return isRecord(value)
    && typeof value.manifestSha256 === "string"
    && SHA256.test(value.manifestSha256)
    && typeof value.generationId === "string"
    && GENERATION_ID.test(value.generationId)
    && (
      value.sourceUpdatedAtIso === null
      || (
        typeof value.sourceUpdatedAtIso === "string"
        && Number.isFinite(Date.parse(value.sourceUpdatedAtIso))
      )
    )
    && typeof value.observedAtIso === "string"
    && Number.isFinite(Date.parse(value.observedAtIso))
    && typeof value.committedAtIso === "string"
    && Number.isFinite(Date.parse(value.committedAtIso))
    && typeof value.acceptedRows === "number"
    && Number.isSafeInteger(value.acceptedRows)
    && value.acceptedRows >= 0
    && typeof value.rejectedRows === "number"
    && Number.isSafeInteger(value.rejectedRows)
    && value.rejectedRows >= 0;
}

function validSourceEvidence(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if ("activeGeneration" in value) {
    return validActiveGeneration(value.activeGeneration);
  }
  return Array.isArray(value.periods)
    && value.periods.length <= 36
    && value.periods.every((period) =>
      isRecord(period)
      && typeof period.period === "string"
      && BILLING_PERIOD.test(period.period)
      && validActiveGeneration(period));
}

function validAvailablePeriods(value: unknown): boolean {
  return Array.isArray(value)
    && value.length <= 36
    && value.every((period) =>
      isRecord(period)
      && typeof period.period === "string"
      && BILLING_PERIOD.test(period.period)
      && typeof period.generationId === "string"
      && GENERATION_ID.test(period.generationId)
      && typeof period.committedAtIso === "string"
      && Number.isFinite(Date.parse(period.committedAtIso)));
}

function validCudosEnvelope(value: Readonly<Record<string, unknown>>): boolean {
  return (
    value.selectedPeriod === null
    || (
      typeof value.selectedPeriod === "string"
      && BILLING_PERIOD.test(value.selectedPeriod)
    )
  )
    && validAvailablePeriods(value.availablePeriods)
    && (value.sourceState === "complete" || value.sourceState === "waiting")
    && validSourceEvidence(value.sourceEvidence);
}

function validCostIntelligenceEnvelope(
  value: Readonly<Record<string, unknown>>,
): boolean {
  return Array.isArray(value.selectedPeriods)
    && value.selectedPeriods.length <= 36
    && value.selectedPeriods.every((period) =>
      typeof period === "string" && BILLING_PERIOD.test(period))
    && validAvailablePeriods(value.availablePeriods)
    && typeof value.taxonomyConfigured === "boolean"
    && (
      value.sourceState === "complete"
      || value.sourceState === "waiting"
      || value.sourceState === "configuration_required"
    )
    && validSourceEvidence(value.sourceEvidence);
}

function validKpiEnvelope(value: Readonly<Record<string, unknown>>): boolean {
  return (
    value.selectedPeriod === null
    || (
      typeof value.selectedPeriod === "string"
      && BILLING_PERIOD.test(value.selectedPeriod)
    )
  )
    && validAvailablePeriods(value.availablePeriods)
    && typeof value.goalsConfigured === "number"
    && Number.isSafeInteger(value.goalsConfigured)
    && value.goalsConfigured >= 0
    && (value.sourceState === "complete" || value.sourceState === "waiting")
    && validSourceEvidence(value.sourceEvidence);
}

async function readEnvelope<T>(
  response: Response,
  connectionId: string,
  schema: string,
  validate: (value: Readonly<Record<string, unknown>>) => boolean,
): Promise<T> {
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw endpointError(body);
  if (
    !isRecord(body)
    || body.connectionId !== connectionId
    || !("report" in body)
    || !validate(body)
  ) {
    throw new FoundationalEndpointError(
      "The canonical billing response did not match the tenant-bound contract.",
      "request",
    );
  }
  if (
    body.report !== null
    && (
      !isRecord(body.report)
      || body.report.schema !== schema
      || typeof body.report.ok !== "boolean"
    )
  ) {
    throw new FoundationalEndpointError(
      "The canonical billing report schema was not recognized.",
      "request",
    );
  }
  return body as unknown as T;
}

function failureCodes(report: unknown): readonly string[] {
  if (
    !isRecord(report)
    || report.ok !== false
    || !Array.isArray(report.failures)
  ) return [];
  return report.failures.flatMap((failure) =>
    isRecord(failure) && typeof failure.code === "string"
      ? [failure.code]
      : []);
}

function stateForEnvelope<
  T extends {
    readonly report: { readonly ok: boolean } | null;
    readonly sourceState: string;
  },
>(envelope: T): EndpointState<T> {
  if (envelope.sourceState === "configuration_required") {
    return { status: "configuration_required", envelope };
  }
  if (envelope.sourceState === "waiting" || envelope.report === null) {
    return { status: "waiting", envelope };
  }
  if (!envelope.report.ok) {
    return {
      status: "incomplete",
      envelope,
      failureCodes: failureCodes(envelope.report),
    };
  }
  return { status: "ready", envelope };
}

function cudosUrl(connectionId: string): string {
  const query = new URLSearchParams({
    connectionId,
    costBasis: "amortized",
    rankingLimit: "8",
  });
  return `/api/v1/finops/cudos?${query.toString()}`;
}

function costIntelligenceUrl(connectionId: string): string {
  const query = new URLSearchParams({
    connectionId,
    costBasis: "amortized",
    allocationMode: "showback",
    moverDimension: "service",
    pivotRow: "business_unit",
    pivotColumn: "service",
  });
  return `/api/v1/finops/cost-intelligence?${query.toString()}`;
}

function kpiUrl(connectionId: string): string {
  const query = new URLSearchParams({ connectionId });
  return `/api/v1/finops/kpi?${query.toString()}`;
}

function sourceEvidenceFor(
  envelope: {
    readonly sourceEvidence: FoundationalSourceEvidence | null;
    readonly availablePeriods: readonly AvailablePeriod[];
  },
): FoundationalSourceEvidence | null {
  const evidence = envelope.sourceEvidence;
  if (evidence === null) return null;
  const available = new Map(envelope.availablePeriods.map((period) => [
    period.period,
    period,
  ]));
  if ("activeGeneration" in evidence) {
    const matches = envelope.availablePeriods.some((period) =>
      period.generationId === evidence.activeGeneration.generationId
      && period.committedAtIso === evidence.activeGeneration.committedAtIso);
    return matches ? evidence : null;
  }
  const matches = evidence.periods.every((period) => {
    const active = available.get(period.period);
    return active?.generationId === period.generationId
      && active.committedAtIso === period.committedAtIso;
  });
  return matches ? evidence : null;
}

function EvidenceStrip({
  title,
  basis,
  currencies,
  evidence,
}: {
  readonly title: string;
  readonly basis: string;
  readonly currencies: readonly string[];
  readonly evidence: FoundationalSourceEvidence | null;
}) {
  const periodEvidence = evidence !== null && "periods" in evidence
    ? evidence.periods
    : [];
  const active = evidence !== null && "activeGeneration" in evidence
    ? evidence.activeGeneration
    : periodEvidence[0] ?? null;
  const acceptedRows = periodEvidence.length === 0
    ? active?.acceptedRows ?? null
    : periodEvidence.reduce((sum, period) => sum + period.acceptedRows, 0);
  const rejectedRows = periodEvidence.length === 0
    ? active?.rejectedRows ?? null
    : periodEvidence.reduce((sum, period) => sum + period.rejectedRows, 0);
  return (
    <section className={styles.foundationalEvidence} aria-label={`${title} evidence and freshness`}>
      <div className={styles.foundationalEvidenceTitle}>
        <span aria-hidden="true">AWS</span>
        <div>
          <strong>{title}</strong>
          <small>Reconciled canonical billing evidence</small>
        </div>
      </div>
      <dl>
        <div>
          <dt>Cost basis</dt>
          <dd>{readableToken(basis)}</dd>
        </div>
        <div>
          <dt>Currencies</dt>
          <dd>{currencies.length === 0 ? "None reported" : currencies.join(" · ")}</dd>
        </div>
        <div>
          <dt>Generation</dt>
          <dd title={active?.generationId}>
            {active === null
              ? "Not available"
              : periodEvidence.length > 1
                ? `${periodEvidence.length} reconciled generations`
                : compactEvidence(active.generationId)}
          </dd>
        </div>
        <div>
          <dt>Committed</dt>
          <dd>{active === null ? "Not available" : formatObservedAt(active.committedAtIso)}</dd>
        </div>
        <div>
          <dt>Accepted / rejected</dt>
          <dd>
            {acceptedRows === null || rejectedRows === null
              ? "Not available"
              : `${acceptedRows} / ${rejectedRows}`}
          </dd>
        </div>
        <div>
          <dt>Source freshness</dt>
          <dd>
            {active === null
              ? "Not available"
              : active.sourceUpdatedAtIso === null
                ? `Observed ${formatObservedAt(active.observedAtIso)}`
                : `Updated ${formatObservedAt(active.sourceUpdatedAtIso)}`}
          </dd>
        </div>
      </dl>
      {evidence === null ? (
        <p role="status">
          Source provenance is incomplete. Freshness is withheld until active
          generation evidence is supplied.
        </p>
      ) : null}
    </section>
  );
}

function EndpointBoundary({
  title,
  state,
  onRetry,
}: {
  readonly title: string;
  readonly state: EndpointState<unknown>;
  readonly onRetry: () => void;
}) {
  if (state.status === "idle") return null;
  if (state.status === "loading") {
    return (
      <section className={styles.foundationalState} role="status" aria-live="polite">
        <span className="loading-spinner" />
        <div>
          <strong>Loading {title}</strong>
          <p>Reading the active tenant-scoped billing generation.</p>
        </div>
      </section>
    );
  }
  if (state.status === "waiting") {
    return (
      <section className={styles.foundationalState} role="status">
        <span aria-hidden="true">CUR</span>
        <div>
          <strong>No active reconciled generation</strong>
          <p>
            {title} will appear after the first canonical billing export is
            delivered, accepted, reconciled, and activated.
          </p>
        </div>
        <button type="button" onClick={onRetry}>Check again</button>
      </section>
    );
  }
  if (state.status === "configuration_required") {
    return (
      <section className={styles.foundationalState} role="status">
        <span aria-hidden="true">MAP</span>
        <div>
          <strong>Organization taxonomy is required</strong>
          <p>
            Configure the tenant-owned account mapping before Cost Intelligence
            can allocate spend. No ownership values are inferred.
          </p>
        </div>
        <a href="#finops-sources">Review sources</a>
      </section>
    );
  }
  if (state.status === "incomplete") {
    return (
      <section className={`${styles.foundationalState} ${styles.foundationalStateWarning}`} role="alert">
        <span aria-hidden="true">!</span>
        <div>
          <strong>Source evidence is incomplete</strong>
          <p>
            The canonical engine retained the active generation and withheld
            this view: {state.failureCodes.length > 0
              ? state.failureCodes.map(readableToken).join(" · ")
              : state.message ?? "no machine-readable reason was supplied"}.
          </p>
        </div>
        <button type="button" onClick={onRetry}>Retry</button>
      </section>
    );
  }
  if (state.status === "error") {
    return (
      <section className={`${styles.foundationalState} ${styles.foundationalStateError}`} role="alert">
        <span aria-hidden="true">!</span>
        <div>
          <strong>{title} could not be loaded</strong>
          <p>{state.message}</p>
        </div>
        <button type="button" onClick={onRetry}>Retry</button>
      </section>
    );
  }
  return null;
}

function PanelHeading({
  eyebrow,
  title,
  meta,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly meta?: string;
}) {
  return (
    <header className={styles.foundationalPanelHeading}>
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {meta === undefined ? null : <span>{meta}</span>}
    </header>
  );
}

function CurrencyKpis({
  summaries,
  basis,
}: {
  readonly summaries: readonly FinopsCudosCurrencyExecutiveSummary[];
  readonly basis: FinopsCudosCostBasis;
}) {
  return (
    <section className={styles.foundationalKpis} aria-label="CUDOS executive billing totals by currency">
      {summaries.map((summary) => {
        const selected = costFor(summary.costs, basis);
        return (
          <article key={summary.currency}>
            <small>{summary.currency} · {readableToken(basis)}</small>
            <strong>{formatMicrosExact(selected?.totalMicros ?? null, summary.currency)}</strong>
            <span>
              {summary.accountCount} accounts · {summary.serviceCount} services ·{" "}
              {selected?.coverage ?? "unavailable"} coverage
            </span>
          </article>
        );
      })}
    </section>
  );
}

function TrendChart({
  points,
  basis,
  title,
}: {
  readonly points: readonly FinopsCudosTrendBucket[];
  readonly basis: FinopsCudosCostBasis;
  readonly title: string;
}) {
  const values = points.flatMap((point) => {
    const value = costFor(point.costs, basis)?.totalMicros ?? null;
    return value !== null && INTEGER_MICROS.test(value) && BigInt(value) > BigInt(0)
      ? [BigInt(value)]
      : [];
  });
  const maximum = values.reduce(
    (current, value) => value > current ? value : current,
    BigInt(0),
  );
  return (
    <div
      className={styles.foundationalTrend}
      role="img"
      aria-label={`${title}; currencies are displayed as independent bars`}
    >
      {points.map((point) => {
        const selected = costFor(point.costs, basis);
        const height = percentageWidth(relativeBasisPoints(
          selected?.totalMicros ?? null,
          maximum,
        ));
        return (
          <div
            className={styles.foundationalTrendColumn}
            key={`${point.currency}:${point.period}`}
            aria-label={`${point.period}, ${formatMicrosExact(selected?.totalMicros ?? null, point.currency)}`}
          >
            <span>{formatMicrosExact(selected?.totalMicros ?? null, point.currency)}</span>
            <i style={{ height }} aria-hidden="true" />
            <small>{point.period}<b>{point.currency}</b></small>
          </div>
        );
      })}
    </div>
  );
}

function RankingBars({
  entries,
  title,
}: {
  readonly entries: readonly FinopsCudosRankingEntry[];
  readonly title: string;
}) {
  const positive = entries.flatMap(({ selectedTotalMicros }) =>
    selectedTotalMicros !== null
    && INTEGER_MICROS.test(selectedTotalMicros)
    && BigInt(selectedTotalMicros) > BigInt(0)
      ? [BigInt(selectedTotalMicros)]
      : []);
  const maximum = positive.reduce(
    (current, value) => value > current ? value : current,
    BigInt(0),
  );
  return (
    <div className={styles.foundationalRankings} aria-label={title}>
      {entries.length === 0 ? (
        <p className={styles.foundationalEmpty}>No ranked source rows were returned.</p>
      ) : entries.map((entry) => (
        <article key={`${entry.currency}:${entry.dimension}:${entry.value ?? "missing"}`}>
          <span className={styles.foundationalRankNumber}>{entry.rank}</span>
          <div>
            <strong>{entry.label ?? entry.value ?? "Dimension not supplied"}</strong>
            <span
              className={styles.foundationalBar}
              role="img"
              aria-label={`${entry.label ?? entry.value ?? "Missing dimension"} ${formatMicrosExact(entry.selectedTotalMicros, entry.currency)}`}
            >
              <i
                aria-hidden="true"
                style={{
                  width: percentageWidth(relativeBasisPoints(
                    entry.selectedTotalMicros,
                    maximum,
                  )),
                }}
              />
            </span>
          </div>
          <small>{formatMicrosExact(entry.selectedTotalMicros, entry.currency)}</small>
        </article>
      ))}
    </div>
  );
}

function ChargeDisclosure({
  summaries,
  basis,
}: {
  readonly summaries: readonly FinopsCudosCurrencyExecutiveSummary[];
  readonly basis: FinopsCudosCostBasis;
}) {
  return (
    <div className={styles.foundationalTableScroll}>
      <table className={styles.foundationalTable}>
        <caption>Signed charge-kind disclosure by currency</caption>
        <thead>
          <tr><th scope="col">Currency</th><th scope="col">Charge kind</th><th scope="col">Lines</th><th scope="col">Signed total</th><th scope="col">Coverage</th></tr>
        </thead>
        <tbody>
          {summaries.flatMap((summary) =>
            summary.chargeKinds.map((charge) => {
              const selected = costFor(charge.costs, basis);
              return (
                <tr key={`${summary.currency}:${charge.chargeKind}`}>
                  <td>{summary.currency}</td>
                  <th scope="row">{readableToken(charge.chargeKind)}</th>
                  <td>{charge.lineCount}</td>
                  <td>{formatMicrosExact(selected?.totalMicros ?? null, summary.currency)}</td>
                  <td>{selected?.coverage ?? "unavailable"}</td>
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
    </div>
  );
}

function CudosOverview({
  envelope,
}: {
  readonly envelope: CudosEnvelope;
}) {
  const report = envelope.report;
  if (report === null || !report.ok) return null;
  const partial = report.executive.some((summary) =>
    costFor(summary.costs, report.selectedCostBasis)?.coverage !== "complete")
    || report.evidence.currencies.length === 0;
  return (
    <div className={styles.foundationalWorkspace}>
      <EvidenceStrip
        title="CUDOS executive view"
        basis={report.selectedCostBasis}
        currencies={report.evidence.currencies}
        evidence={sourceEvidenceFor(envelope)}
      />
      {partial ? (
        <div className={styles.foundationalNotice} role="status">
          At least one selected cost basis is incomplete. Partial totals remain
          labelled and currencies remain separate.
        </div>
      ) : null}
      <CurrencyKpis summaries={report.executive} basis={report.selectedCostBasis} />
      <section className={styles.foundationalTwoColumn}>
        <article className={styles.foundationalPanel}>
          <PanelHeading eyebrow="Daily evidence" title="Billing trend" meta={`${report.trends.daily.length} buckets`} />
          <TrendChart
            points={report.trends.daily}
            basis={report.selectedCostBasis}
            title="Daily CUDOS billing trend"
          />
        </article>
        <article className={styles.foundationalPanel}>
          <PanelHeading eyebrow="Spend concentration" title="Top services" meta="Per currency" />
          <RankingBars entries={report.rankings.services} title="CUDOS service rankings" />
        </article>
      </section>
      <section className={styles.foundationalPanel}>
        <PanelHeading eyebrow="Invoice integrity" title="Signed charge disclosure" meta="No charge kind hidden" />
        <ChargeDisclosure summaries={report.executive} basis={report.selectedCostBasis} />
      </section>
    </div>
  );
}

function CudosExplorer({
  envelope,
}: {
  readonly envelope: CudosEnvelope;
}) {
  const report = envelope.report;
  if (report === null || !report.ok) return null;
  return (
    <div className={styles.foundationalWorkspace}>
      <EvidenceStrip
        title="CUDOS operational explorer"
        basis={report.selectedCostBasis}
        currencies={report.evidence.currencies}
        evidence={sourceEvidenceFor(envelope)}
      />
      <section className={styles.foundationalThreeColumn}>
        <article className={styles.foundationalPanel}>
          <PanelHeading eyebrow="Account" title="Cost ranking" />
          <RankingBars entries={report.rankings.accounts} title="Account cost ranking" />
        </article>
        <article className={styles.foundationalPanel}>
          <PanelHeading eyebrow="Service" title="Cost ranking" />
          <RankingBars entries={report.rankings.services} title="Service cost ranking" />
        </article>
        <article className={styles.foundationalPanel}>
          <PanelHeading eyebrow="Region" title="Cost ranking" />
          <RankingBars entries={report.rankings.regions} title="Region cost ranking" />
        </article>
      </section>
      <section className={styles.foundationalTwoColumn}>
        <article className={styles.foundationalPanel}>
          <PanelHeading eyebrow="Compatible units only" title="Unit-cost evidence" meta={`${report.unitCosts.totalMetrics} metrics`} />
          <div className={styles.foundationalTableScroll}>
            <table className={styles.foundationalTable}>
              <caption>Exact cost and usage ratios</caption>
              <thead>
                <tr><th scope="col">Service</th><th scope="col">Unit</th><th scope="col">Cost</th><th scope="col">Quantity micros</th></tr>
              </thead>
              <tbody>
                {report.unitCosts.metrics.slice(0, 12).map((metric) => (
                  <tr key={`${metric.currency}:${metric.service}:${metric.usageUnit}`}>
                    <th scope="row">{metric.service}<small>{metric.currency}</small></th>
                    <td>{metric.usageUnit}</td>
                    <td>{formatMicrosExact(metric.cost.totalMicros, metric.currency)}</td>
                    <td>{metric.usageQuantityMicros}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.foundationalDisclosure}>
            {readableToken(report.unitCosts.invariant)}.
          </p>
        </article>
        <article className={styles.foundationalPanel}>
          <PanelHeading eyebrow="Review candidates" title="CUR-derived opportunities" meta={`${report.opportunities.totalCandidates} candidates`} />
          {report.opportunities.estimates.length === 0 ? (
            <p className={styles.foundationalEmpty}>No billing pattern met a versioned review rule.</p>
          ) : (
            <div className={styles.foundationalFindings}>
              {report.opportunities.estimates.slice(0, 8).map((estimate) => (
                <article key={`${estimate.ruleId}:${estimate.subjectId}:${estimate.currency}`}>
                  <span>{estimate.confidence}</span>
                  <div>
                    <strong>{estimate.subjectId}</strong>
                    <p>{readableToken(estimate.ruleId)} · {formatMicrosExact(estimate.estimate.totalMicros, estimate.currency)}</p>
                    <small>
                      Rule {estimate.ruleVersion} · review required ·{" "}
                      {estimate.sourceLineIds.slice(0, 3).map((id) => compactEvidence(id, 14)).join(" · ")}
                      {estimate.sourceLineIdsTruncated ? " · more evidence retained" : ""}
                    </small>
                  </div>
                </article>
              ))}
            </div>
          )}
          <p className={styles.foundationalDisclosure}>{report.opportunities.disclaimer}</p>
        </article>
      </section>
      <div className={styles.foundationalAvailability} role="status">
        <strong>Drilldown availability</strong>
        <span>Resource: {report.drilldowns.resource.status} ({report.drilldowns.resource.availableLineCount}/{report.drilldowns.lineCount})</span>
        <span>Hourly: {report.drilldowns.hourly.status} ({report.drilldowns.hourly.availableLineCount}/{report.drilldowns.lineCount})</span>
        <span>Resource + hourly: {report.drilldowns.resourceHourly.status}</span>
      </div>
    </div>
  );
}

function CudosCommitments({
  envelope,
}: {
  readonly envelope: CudosEnvelope;
}) {
  const report = envelope.report;
  if (report === null || !report.ok) return null;
  return (
    <div className={styles.foundationalWorkspace}>
      <EvidenceStrip
        title="CUDOS commitment evidence"
        basis={report.selectedCostBasis}
        currencies={report.evidence.currencies}
        evidence={sourceEvidenceFor(envelope)}
      />
      <section className={styles.foundationalPanel}>
        <PanelHeading eyebrow="RI and Savings Plans" title="Coverage, utilization, unused cost, and true-up" meta="Evidence completeness enforced" />
        <div className={styles.foundationalTableScroll}>
          <table className={styles.foundationalTable}>
            <caption>Commitment evidence by currency</caption>
            <thead>
              <tr>
                <th scope="col">Currency</th><th scope="col">Coverage</th>
                <th scope="col">Covered / eligible</th><th scope="col">Utilization</th>
                <th scope="col">Unused</th><th scope="col">True-up</th>
              </tr>
            </thead>
            <tbody>
              {report.commitments.map((commitment) => (
                <tr key={commitment.currency}>
                  <th scope="row">{commitment.currency}</th>
                  <td><StateBadge state={commitment.coverage.status} />{formatBasisPoints(commitment.coverage.coverageBasisPoints)}</td>
                  <td>
                    {formatMicrosExact(commitment.coverage.coveredCostMicros, commitment.currency)}
                    <small>of {formatMicrosExact(commitment.coverage.classifiedEligibleCostMicros, commitment.currency)}</small>
                  </td>
                  <td><StateBadge state={commitment.utilization.status} />{formatBasisPoints(commitment.utilization.utilizationBasisPoints)}</td>
                  <td>{formatMicrosExact(commitment.utilization.explicitUnusedCostMicros, commitment.currency)}</td>
                  <td>
                    {formatMicrosExact(
                      commitment.trueUp.amortizedMinusUnblendedMicros,
                      commitment.currency,
                    )}
                    <small>{commitment.trueUp.status}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function CudosServices({
  envelope,
}: {
  readonly envelope: CudosEnvelope;
}) {
  const report = envelope.report;
  if (report === null || !report.ok) return null;
  return (
    <div className={styles.foundationalWorkspace}>
      <EvidenceStrip
        title="CUDOS service intelligence"
        basis={report.selectedCostBasis}
        currencies={report.evidence.currencies}
        evidence={sourceEvidenceFor(envelope)}
      />
      {report.modules.length === 0 ? (
        <section className={styles.foundationalState} role="status">
          <span aria-hidden="true">AWS</span>
          <div>
            <strong>No service-family evidence</strong>
            <p>No canonical source row matched a Foundational service module.</p>
          </div>
        </section>
      ) : (
        <section className={styles.foundationalModuleGrid} aria-label="Evidence-backed CUDOS service modules">
          {report.modules.map((module) => (
            <article key={module.moduleId}>
              <header>
                <span>{module.moduleId.replaceAll("_", " / ")}</span>
                <strong>{module.lineCount}</strong>
              </header>
              <p>{module.services.join(" · ")}</p>
              <dl>
                {module.currencies.map((currency) => (
                  <div key={currency.currency}>
                    <dt>{currency.currency}</dt>
                    <dd>{formatMicrosExact(
                      costFor(currency.costs, report.selectedCostBasis)?.totalMicros ?? null,
                      currency.currency,
                    )}</dd>
                  </div>
                ))}
              </dl>
              <small>
                {module.sourceLineIdCount} source lines ·{" "}
                {module.sourceLineIds.slice(0, 2).map((id) => compactEvidence(id, 14)).join(" · ")}
                {module.sourceLineIdsTruncated ? " · bounded" : ""}
              </small>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

function StateBadge({ state }: { readonly state: string }) {
  const className = state === "complete" || state === "met" || state === "measured"
    ? styles.foundationalBadgePositive
    : state === "partial" || state === "not_met" || state === "insufficient_evidence"
      ? styles.foundationalBadgeWarning
      : styles.foundationalBadgeNeutral;
  return <span className={`${styles.foundationalBadge} ${className}`}>{readableToken(state)}</span>;
}

function AllocationNodes({
  nodes,
  currency,
}: {
  readonly nodes: readonly FinopsTaxonomyAllocationNode[];
  readonly currency: string;
}) {
  if (nodes.length === 0) return null;
  return (
    <ul className={styles.foundationalTree}>
      {nodes.map((node) => (
        <li key={`${node.dimension}:${node.value}`}>
          <div>
            <span>{readableToken(node.dimension)}</span>
            <strong>{node.value === "__unallocated__" ? "Unallocated" : node.value}</strong>
            <small>{formatMicrosExact(node.amountMicros, currency)} · {node.lineCount} lines</small>
          </div>
          <AllocationNodes nodes={node.children} currency={currency} />
        </li>
      ))}
    </ul>
  );
}

function AllocationCard({ allocation }: { readonly allocation: FinopsCurrencyAllocation }) {
  return (
    <article className={styles.foundationalPanel}>
      <PanelHeading
        eyebrow={`${allocation.period} · ${allocation.currency}`}
        title="Tenant allocation tree"
        meta={`${allocation.rootUnallocatedLineCount} root-unallocated lines`}
      />
      <div className={styles.foundationalAllocationTotals}>
        <span><small>Source</small><strong>{formatMicrosExact(allocation.sourceTotalMicros, allocation.currency)}</strong></span>
        <span><small>Included</small><strong>{formatMicrosExact(allocation.includedMicros, allocation.currency)}</strong></span>
        <span><small>Excluded</small><strong>{formatMicrosExact(allocation.excludedMicros, allocation.currency)}</strong></span>
      </div>
      {allocation.children.length === 0 ? (
        <p className={styles.foundationalEmpty}>No taxonomy allocation nodes were returned.</p>
      ) : <AllocationNodes nodes={allocation.children} currency={allocation.currency} />}
    </article>
  );
}

function CostIntelligenceAllocation({
  envelope,
}: {
  readonly envelope: CostIntelligenceEnvelope;
}) {
  const report = envelope.report;
  if (report === null || !report.ok) return null;
  const currencies = [...new Set(report.allocations.map(({ currency }) => currency))].sort();
  return (
    <div className={styles.foundationalWorkspace}>
      <EvidenceStrip
        title="Cost Intelligence allocation"
        basis={report.costBasis}
        currencies={currencies}
        evidence={sourceEvidenceFor(envelope)}
      />
      <div className={styles.foundationalNotice} role="note">
        {report.allocationMode} · {readableToken(report.inclusionPolicy.id)} ·
        taxonomy from {readableToken(report.taxonomyEvidence.source)} observed{" "}
        {formatObservedAt(report.taxonomyEvidence.observedAtIso)}
      </div>
      <section className={styles.foundationalAllocationGrid}>
        {report.allocations.map((allocation) => (
          <AllocationCard
            key={`${allocation.period}:${allocation.currency}`}
            allocation={allocation}
          />
        ))}
      </section>
    </div>
  );
}

function CostIntelligenceExplorer({
  envelope,
}: {
  readonly envelope: CostIntelligenceEnvelope;
}) {
  const report = envelope.report;
  if (report === null || !report.ok) return null;
  const currencies = [...new Set(report.summaries.map(({ currency }) => currency))].sort();
  return (
    <div className={styles.foundationalWorkspace}>
      <EvidenceStrip
        title="Cost Intelligence explorer"
        basis={report.costBasis}
        currencies={currencies}
        evidence={sourceEvidenceFor(envelope)}
      />
      <section className={styles.foundationalTwoColumn}>
        <article className={styles.foundationalPanel}>
          <PanelHeading eyebrow={`${report.baselinePeriod} → ${report.comparisonPeriod}`} title="Cost movers" meta={`${report.movers.length} changes`} />
          <div className={styles.foundationalMovers}>
            {report.movers.slice(0, 12).map((mover) => (
              <article key={`${mover.currency}:${mover.dimension}:${mover.value}`}>
                <div><strong>{mover.value}</strong><small>{readableToken(mover.dimension)} · {mover.currency}</small></div>
                <span className={BigInt(mover.absoluteDeltaMicros) > BigInt(0) ? styles.foundationalCostUp : styles.foundationalCostDown}>
                  {formatMicrosExact(mover.absoluteDeltaMicros, mover.currency)}
                  <small>{formatBasisPoints(mover.deltaPercentBasisPoints)}</small>
                </span>
              </article>
            ))}
          </div>
        </article>
        <article className={styles.foundationalPanel}>
          <PanelHeading eyebrow="Disclosed model" title="Forecast ranges" meta="Currencies independent" />
          <div className={styles.foundationalForecasts}>
            {report.forecasts.map((forecast) => (
              <article key={forecast.currency}>
                <header><strong>{forecast.currency}</strong><StateBadge state={forecast.status} /></header>
                {forecast.status === "available" ? (
                  <>
                    <b>{formatMicrosExact(forecast.forecastMicros, forecast.currency)}</b>
                    <span>
                      {formatMicrosExact(forecast.confidenceRange.lowerMicros, forecast.currency)}
                      {" — "}
                      {formatMicrosExact(forecast.confidenceRange.upperMicros, forecast.currency)}
                    </span>
                    <small>
                      {readableToken(forecast.model)} · {forecast.trainingWindow.startPeriod}
                      {" to "}{forecast.trainingWindow.endPeriod} ·{" "}
                      {readableToken(forecast.confidenceRange.disclosure)}
                    </small>
                  </>
                ) : (
                  <p>
                    {forecast.observedPeriods}/{forecast.minimumPeriods} periods ·{" "}
                    {readableToken(forecast.reason)}
                  </p>
                )}
              </article>
            ))}
          </div>
        </article>
      </section>
      {report.explorer === null ? null : (
        <section className={styles.foundationalPanel}>
          <PanelHeading eyebrow={report.explorer.period} title="Bounded explorer groups" meta={`${report.explorer.groups.length} groups`} />
          <div className={styles.foundationalExplorerGrid}>
            {report.explorer.groups.map((group) => (
              <article key={`${group.currency}:${group.dimensions.map(({ dimension, value }) => `${dimension}:${value}`).join("|")}`}>
                <div>{group.dimensions.map(({ dimension, value }) => (
                  <span key={dimension}><small>{readableToken(dimension)}</small><strong>{value}</strong></span>
                ))}</div>
                <b>{formatMicrosExact(group.amountMicros, group.currency)}</b>
                <small>{group.lineCount} source lines</small>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function measurementById(
  measurements: readonly FinopsKpiMeasurement[],
): ReadonlyMap<string, FinopsKpiMeasurement> {
  return new Map(measurements.map((measurement) => [
    measurement.kpiId,
    measurement,
  ]));
}

function KpiScorecard({ envelope }: { readonly envelope: KpiEnvelope }) {
  const report = envelope.report;
  if (report === null || !report.ok) return null;
  const measurements = measurementById(report.measurements);
  const registryComplete = FINOPS_KPI_IDS.every((id) =>
    report.formulaRegistry.some((formula) => formula.id === id));
  const currencies = [...new Set(report.measurements.flatMap((measurement) =>
    measurement.segments.map(({ currency }) => currency)))].sort();
  return (
    <div className={styles.foundationalWorkspace}>
      <EvidenceStrip
        title="Foundational KPI scorecard"
        basis="usage quantity or unblended cost per formula"
        currencies={currencies}
        evidence={sourceEvidenceFor(envelope)}
      />
      {!registryComplete ? (
        <div className={styles.foundationalNotice} role="alert">
          The versioned KPI registry is incomplete; missing formulas are not
          replaced with locally invented metrics.
        </div>
      ) : null}
      <section className={styles.foundationalKpiHeader} aria-label="KPI scorecard evidence">
        <span><small>Registry</small><strong>{report.formulaRegistry.length} formulas</strong></span>
        <span><small>Governed goals</small><strong>{envelope.goalsConfigured}</strong></span>
        <span><small>Review candidates</small><strong>{report.opportunities.length}</strong></span>
        <span><small>Evidence window</small><strong>{report.evidenceWindow.startIso.slice(0, 10)} — {report.evidenceWindow.endIso.slice(0, 10)}</strong></span>
      </section>
      <section className={styles.foundationalKpiMatrix} aria-label="All 19 Foundational KPI measurements">
        {report.formulaRegistry.map((formula) => {
          const measurement = measurements.get(formula.id);
          return (
            <article key={formula.id}>
              <header>
                <span>{formula.formulaVersion}</span>
                <StateBadge state={measurement?.state ?? "missing"} />
              </header>
              <h3>{formula.label}</h3>
              <p>{formula.numeratorDefinition}</p>
              {measurement === undefined || measurement.segments.length === 0 ? (
                <div className={styles.foundationalKpiMissing}>
                  <strong>No measured segment</strong>
                  <small>{measurement?.reasonCodes.map(readableToken).join(" · ") ?? "Measurement not returned"}</small>
                </div>
              ) : (
                <div className={styles.foundationalKpiSegments}>
                  {measurement.segments.map((segment) => (
                    <div key={`${segment.currency}:${segment.usageUnit ?? "unknown"}:${segment.basis}`}>
                      <strong>{formatBasisPoints(segment.currentBasisPoints)}</strong>
                      <span>{segment.currency} · {segment.usageUnit ?? "unit not supplied"}</span>
                      <small>{readableToken(segment.goalStatus)} · goal{" "}
                        {measurement.selectedGoal === null
                          ? "not configured"
                          : formatBasisPoints(measurement.selectedGoal.targetBasisPoints)}
                      </small>
                    </div>
                  ))}
                </div>
              )}
              <footer>
                <span>{readableToken(formula.targetDirection)}</span>
                <span>{measurement?.evidenceCompleteness ?? "none"} evidence</span>
              </footer>
            </article>
          );
        })}
      </section>
      <section className={styles.foundationalPanel}>
        <PanelHeading eyebrow="Evidence, not execution" title="KPI opportunity candidates" meta={report.opportunitiesTruncated ? "Bounded result" : `${report.opportunities.length} candidates`} />
        {report.opportunities.length === 0 ? (
          <p className={styles.foundationalEmpty}>No KPI opportunity evidence was returned.</p>
        ) : (
          <div className={styles.foundationalFindings}>
            {report.opportunities.slice(0, 12).map((opportunity) => (
              <article key={`${opportunity.kpiId}:${opportunity.sourceLineId}`}>
                <span>{opportunity.confidence}</span>
                <div>
                  <strong>{report.formulaRegistry.find(({ id }) => id === opportunity.kpiId)?.label ?? opportunity.kpiId}</strong>
                  <p>
                    {opportunity.resourceId ?? "Resource ID not supplied"} ·{" "}
                    {opportunity.estimatedSavingsMicros === null
                      ? "Savings not established"
                      : formatMicrosExact(opportunity.estimatedSavingsMicros, opportunity.currency)}
                  </p>
                  <small>
                    Candidate estimate · validation required · source{" "}
                    {compactEvidence(opportunity.sourceLineId, 18)}
                  </small>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function statusReady<T>(state: EndpointState<T>): state is {
  readonly status: "ready";
  readonly envelope: T;
} {
  return state.status === "ready";
}

function stateBelongsToConnection(
  state: EndpointState<unknown>,
  connectionId: string,
): boolean {
  if (state.status !== "ready") return true;
  return isRecord(state.envelope)
    && state.envelope.connectionId === connectionId;
}

function BoundaryAndContent({
  title,
  state,
  onRetry,
  children,
}: {
  readonly title: string;
  readonly state: EndpointState<unknown>;
  readonly onRetry: () => void;
  readonly children: ReactNode;
}) {
  return (
    <>
      <EndpointBoundary title={title} state={state} onRetry={onRetry} />
      {children}
    </>
  );
}

export function FinopsFoundationalPanels({
  connectionId,
  section,
  onAvailabilityChange,
}: FinopsFoundationalPanelsProps) {
  const [reloadToken, setReloadToken] = useState(0);
  const [cudos, setCudos] = useState<EndpointState<CudosEnvelope>>(INITIAL_STATE);
  const [costIntelligence, setCostIntelligence] =
    useState<EndpointState<CostIntelligenceEnvelope>>(INITIAL_STATE);
  const [kpi, setKpi] = useState<EndpointState<KpiEnvelope>>(INITIAL_STATE);

  const needsCudos = ["overview", "explorer", "commitments", "services"]
    .includes(section);
  const needsCostIntelligence = ["allocation", "explorer"].includes(section);
  const needsKpi = section === "optimization";

  const retry = useCallback(() => {
    setReloadToken((current) => current + 1);
  }, []);

  useEffect(() => {
    if (connectionId === null) return;
    const controller = new AbortController();
    const request = async <T,>(
      url: string,
      schema: string,
      validate: (value: Readonly<Record<string, unknown>>) => boolean,
      setter: (state: EndpointState<T>) => void,
    ): Promise<void> => {
      setter({ status: "loading" });
      try {
        const response = await fetch(url, {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        const envelope = await readEnvelope<T>(
          response,
          connectionId,
          schema,
          validate,
        );
        setter(stateForEnvelope(envelope as T & {
          readonly report: { readonly ok: boolean } | null;
          readonly sourceState: string;
        }) as EndpointState<T>);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof FoundationalEndpointError) {
          setter(caught.kind === "no_active_generation"
            ? { status: "waiting" }
            : caught.kind === "source_incomplete"
              ? {
                  status: "incomplete",
                  failureCodes: [],
                  message: caught.message,
                }
              : { status: "error", message: caught.message });
          return;
        }
        setter({
          status: "error",
          message: caught instanceof Error
            ? caught.message
            : "The canonical billing request failed.",
        });
      }
    };

    if (needsCudos) {
      void request<CudosEnvelope>(
        cudosUrl(connectionId),
        "sutra.finops-cudos.v1",
        validCudosEnvelope,
        setCudos,
      );
    }
    if (needsCostIntelligence) {
      void request<CostIntelligenceEnvelope>(
        costIntelligenceUrl(connectionId),
        "sutra.finops-cost-intelligence.v1",
        validCostIntelligenceEnvelope,
        setCostIntelligence,
      );
    }
    if (needsKpi) {
      void request<KpiEnvelope>(
        kpiUrl(connectionId),
        "sutra.finops-kpi.v1",
        validKpiEnvelope,
        setKpi,
      );
    }
    return () => controller.abort();
  }, [
    connectionId,
    needsCostIntelligence,
    needsCudos,
    needsKpi,
    reloadToken,
  ]);

  const activeStates = useMemo(() => [
    ...(needsCudos ? [cudos] : []),
    ...(needsCostIntelligence ? [costIntelligence] : []),
    ...(needsKpi ? [kpi] : []),
  ], [
    costIntelligence,
    cudos,
    kpi,
    needsCostIntelligence,
    needsCudos,
    needsKpi,
  ]);

  useEffect(() => {
    if (onAvailabilityChange === undefined) return;
    if (
      connectionId !== null
      && activeStates.some((state) =>
        state.status === "idle"
        || state.status === "loading"
        || !stateBelongsToConnection(state, connectionId))
    ) {
      onAvailabilityChange("checking");
      return;
    }
    onAvailabilityChange(
      activeStates.some(({ status }) => status === "ready")
        ? "canonical"
        : "legacy",
    );
  }, [activeStates, connectionId, onAvailabilityChange]);

  if (connectionId === null) return null;

  return (
    <div className={styles.foundationalRoot}>
      {section === "overview" || section === "services" ? (
        <FinopsCurIntelligencePanels
          connectionId={connectionId}
          key={`${connectionId}:${section}`}
          section={section}
        />
      ) : null}
      {needsCudos ? (
        <BoundaryAndContent
          title="CUDOS"
          state={cudos}
          onRetry={retry}
        >
          {statusReady(cudos) && cudos.envelope.connectionId === connectionId && section === "overview"
            ? <CudosOverview envelope={cudos.envelope} />
            : null}
          {statusReady(cudos) && cudos.envelope.connectionId === connectionId && section === "explorer"
            ? <CudosExplorer envelope={cudos.envelope} />
            : null}
          {statusReady(cudos) && cudos.envelope.connectionId === connectionId && section === "commitments"
            ? <CudosCommitments envelope={cudos.envelope} />
            : null}
          {statusReady(cudos) && cudos.envelope.connectionId === connectionId && section === "services"
            ? <CudosServices envelope={cudos.envelope} />
            : null}
        </BoundaryAndContent>
      ) : null}
      {needsCostIntelligence ? (
        <BoundaryAndContent
          title="Cost Intelligence"
          state={costIntelligence}
          onRetry={retry}
        >
          {statusReady(costIntelligence) && costIntelligence.envelope.connectionId === connectionId && section === "allocation"
            ? <CostIntelligenceAllocation envelope={costIntelligence.envelope} />
            : null}
          {statusReady(costIntelligence) && costIntelligence.envelope.connectionId === connectionId && section === "explorer"
            ? <CostIntelligenceExplorer envelope={costIntelligence.envelope} />
            : null}
        </BoundaryAndContent>
      ) : null}
      {needsKpi ? (
        <BoundaryAndContent
          title="KPI scorecard"
          state={kpi}
          onRetry={retry}
        >
          {statusReady(kpi) && kpi.envelope.connectionId === connectionId
            ? <KpiScorecard envelope={kpi.envelope} />
            : null}
        </BoundaryAndContent>
      ) : null}
    </div>
  );
}

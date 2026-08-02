"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FinopsDashboardCatalogEntry } from "../../lib/finops-dashboard-catalog";
import type {
  PricingChangeGroup,
  PricingChangeSnapshot,
} from "../../lib/finops-pricing-change-analysis";
import {
  PRICING_CHANGE_OFFICIAL_DEFINITION,
  type PricingChangeOfficialDefinition,
} from "../../lib/finops-pricing-change-official-definition";
import {
  FinopsCapabilityShell,
  type FinopsCapabilityEvidence,
  type FinopsCapabilityViewState,
} from "./finops-capability-shell";
import styles from "./finops-pricing-change-dashboard.module.css";

type SourceState = "configuration_required" | "waiting" | "partial" | "stale" | "failed" | "empty" | "complete";

export interface PricingChangeDashboardEnvelope {
  readonly schema: "sutra.finops-pricing-change-dashboard.v1";
  readonly connectionId: string;
  readonly source: "VERSIONED_AWS_PRICE_LIST_BULK_FILES_AND_ACTIVE_CUR2_USAGE";
  readonly sourceState: SourceState;
  readonly runtimeState: "unavailable" | "collecting" | "failed" | "ready";
  readonly officialDefinition: PricingChangeOfficialDefinition;
  readonly latestAttemptStatus: string | null;
  readonly report: PricingChangeSnapshot | null;
  readonly evidence: {
    readonly snapshotId: string;
    readonly evidenceGenerationId: string;
    readonly contentSha256: string;
    readonly capturedAt: string;
    readonly active: boolean;
  } | null;
  readonly activation: { readonly available: false; readonly reason: string };
  readonly limitations: readonly string[];
}

interface Filters {
  readonly service: string;
  readonly payer: string;
  readonly linked: string;
  readonly region: string;
  readonly currency: string;
  readonly direction: "" | "increase" | "decrease" | "unchanged";
}

const EMPTY_FILTERS: Filters = {
  service: "", payer: "", linked: "", region: "", currency: "", direction: "",
};
const INTEGER = /^-?(?:0|[1-9]\d{0,127})$/u;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvelope(value: unknown, connectionId: string): PricingChangeDashboardEnvelope {
  if (
    !isRecord(value)
    || value.schema !== "sutra.finops-pricing-change-dashboard.v1"
    || value.connectionId !== connectionId
    || value.source !== "VERSIONED_AWS_PRICE_LIST_BULK_FILES_AND_ACTIVE_CUR2_USAGE"
    || typeof value.sourceState !== "string"
    || !new Set<SourceState>([
      "configuration_required", "waiting", "partial", "stale", "failed", "empty", "complete",
    ]).has(value.sourceState as SourceState)
    || typeof value.runtimeState !== "string"
    || !new Set(["unavailable", "collecting", "failed", "ready"]).has(value.runtimeState)
    || !isRecord(value.officialDefinition)
    || value.officialDefinition.schema !== PRICING_CHANGE_OFFICIAL_DEFINITION.schema
    || !isRecord(value.officialDefinition.source)
    || value.officialDefinition.source.commit !== PRICING_CHANGE_OFFICIAL_DEFINITION.source.commit
    || !Array.isArray(value.officialDefinition.artifacts)
    || !isRecord(value.officialDefinition.artifacts[0])
    || value.officialDefinition.artifacts[0].sha256 !== PRICING_CHANGE_OFFICIAL_DEFINITION.artifacts[0].sha256
    || !isRecord(value.officialDefinition.artifacts[1])
    || value.officialDefinition.artifacts[1].sha256 !== PRICING_CHANGE_OFFICIAL_DEFINITION.artifacts[1].sha256
    || !isRecord(value.officialDefinition.totals)
    || value.officialDefinition.totals.sheets !== 2
    || value.officialDefinition.totals.visuals !== 11
    || !isRecord(value.activation)
    || value.activation.available !== false
    || typeof value.activation.reason !== "string"
    || !Array.isArray(value.limitations)
    || value.limitations.some((entry) => typeof entry !== "string")
    || (value.report !== null && (
      !isRecord(value.report)
      || value.report.schemaVersion !== "sutra.pricing-change.snapshot.v1"
      || !Array.isArray(value.report.groups)
      || !Array.isArray(value.report.exclusions)
      || !Array.isArray(value.report.catalogEvidence)
    ))
  ) throw new Error("Sutra returned an invalid Pricing Change Analysis report.");
  return value as unknown as PricingChangeDashboardEnvelope;
}

function formatMicros(value: string, currency: string): string {
  if (!INTEGER.test(value) || !/^[A-Z]{3}$/u.test(currency)) return "Not available";
  const amount = BigInt(value);
  const negative = amount < BigInt(0);
  const absolute = negative ? -amount : amount;
  const whole = (absolute / BigInt(1_000_000)).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const fraction = (absolute % BigInt(1_000_000)).toString().padStart(6, "0").replace(/0+$/u, "");
  return `${currency} ${negative ? "−" : ""}${whole}${fraction === "" ? ".00" : `.${fraction}`}`;
}

function direction(group: PricingChangeGroup): Filters["direction"] {
  const amount = BigInt(group.modeledChange.roundedMicros);
  return amount > BigInt(0) ? "increase" : amount < BigInt(0) ? "decrease" : "unchanged";
}

function options(groups: readonly PricingChangeGroup[], field: keyof Pick<PricingChangeGroup, "serviceCode" | "payerAccountId" | "linkedAccountId" | "region" | "currency">): readonly string[] {
  return [...new Set(groups.map((group) => group[field]))].sort();
}

function percentage(value: string, maximum: bigint): string {
  if (!INTEGER.test(value) || maximum <= BigInt(0)) return "0%";
  const amount = BigInt(value);
  const absolute = amount < BigInt(0) ? -amount : amount;
  return `${(absolute * BigInt(100)) / maximum}%`;
}

export function PricingChangeOfficialDefinitionPanel({
  definition,
}: {
  readonly definition: PricingChangeOfficialDefinition;
}) {
  return <section className={styles.official} aria-label="Official Pricing Change Analysis definition coverage">
    <header className={styles.officialHeader}>
      <div>
        <small>AWS CID {definition.source.version} · complete embedded definition</small>
        <h3>{definition.totals.sheets} sheets · {definition.totals.visuals} upstream visuals audited</h3>
        <p>Manifest <code>{definition.artifacts[0].sha256.slice(0, 12)}…</code> · definition <code>{definition.artifacts[1].sha256.slice(0, 12)}…</code>. Counts come from the decoded public definition, never a screenshot.</p>
      </div>
      <dl>
        <div><dt>Controls</dt><dd>{definition.totals.controlPlacements}</dd></div>
        <div><dt>Parameters</dt><dd>{definition.totals.parameterDeclarations}</dd></div>
        <div><dt>Calculated fields</dt><dd>{definition.totals.calculatedFields}</dd></div>
        <div><dt>Filter groups</dt><dd>{definition.totals.filterGroups}</dd></div>
      </dl>
    </header>
    <div className={styles.officialArtifacts} aria-label="Published Pricing Change Analysis artifacts">
      {definition.artifacts.map((artifact) => <article key={artifact.kind}>
        <strong>{artifact.kind.replaceAll("_", " ")}</strong>
        <code>{artifact.sha256.slice(0, 16)}…</code>
        <small>{artifact.hashBasis}</small>
      </article>)}
    </div>
    <div className={styles.officialSheets}>
      {definition.sheets.map((sheet) => <details key={sheet.id} open={sheet.name !== "About"}>
        <summary><span><strong>{sheet.name}</strong><small>{sheet.visualCount} visual{sheet.visualCount === 1 ? "" : "s"} · {sheet.controls.length} control placements</small></span></summary>
        <div className={styles.officialVisuals}>
          {sheet.visuals.map((item) => <article key={item.id} data-coverage={item.coverage}>
            <div><span>{item.type.replace("Visual", "")}</span><strong>{item.title}</strong></div>
            <p>{item.nativeEvidence}</p>
            <small><strong>Remaining:</strong> {item.remainingGap}</small>
          </article>)}
        </div>
        <div className={styles.officialControls} aria-label={`${sheet.name} official controls`}>
          {sheet.controls.map((item) => <span key={`${item.placement}:${item.type}:${item.title}`} data-state={item.nativeState}>
            {item.title} · {item.placement} · {item.nativeState.toLocaleLowerCase().replace("_", " ")}
          </span>)}
        </div>
      </details>)}
    </div>
    <p className={styles.officialDisclosure}>{definition.disclosures[2]}</p>
  </section>;
}

export function FinopsPricingChangeReportView({ report }: { readonly report: PricingChangeSnapshot }) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const groups = useMemo(() => report.groups.filter((group) =>
    (filters.service === "" || group.serviceCode === filters.service)
    && (filters.payer === "" || group.payerAccountId === filters.payer)
    && (filters.linked === "" || group.linkedAccountId === filters.linked)
    && (filters.region === "" || group.region === filters.region)
    && (filters.currency === "" || group.currency === filters.currency)
    && (filters.direction === "" || direction(group) === filters.direction)), [filters, report.groups]);
  const maximum = report.summary.modeledTotalsByCurrency.flatMap((total) => [
    BigInt(total.baselineModeledCost.roundedMicros),
    BigInt(total.comparisonModeledCost.roundedMicros),
  ]).reduce((largest, value) => {
    const absolute = value < BigInt(0) ? -value : value;
    return absolute > largest ? absolute : largest;
  }, BigInt(0));
  const update = (field: keyof Filters, value: string) => setFilters((current) => ({ ...current, [field]: value }));
  return (
    <div className={styles.workspace}>
      <p className={styles.scopeNote} role="note">
        Actual CUR 2.0 usage is held constant. Only exact, version-pinned public AWS catalog matches are modeled; excluded rows remain visible and no invoice or savings claim is inferred.
      </p>
      <form className={styles.filters} aria-label="Pricing Change Analysis filters">
        <label>Service<select value={filters.service} onChange={(event) => update("service", event.target.value)}><option value="">All services</option>{options(report.groups, "serviceCode").map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>Payer account<select value={filters.payer} onChange={(event) => update("payer", event.target.value)}><option value="">All payer accounts</option>{options(report.groups, "payerAccountId").map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>Linked account<select value={filters.linked} onChange={(event) => update("linked", event.target.value)}><option value="">All linked accounts</option>{options(report.groups, "linkedAccountId").map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>Region<select value={filters.region} onChange={(event) => update("region", event.target.value)}><option value="">All Regions</option>{options(report.groups, "region").map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>Currency<select value={filters.currency} onChange={(event) => update("currency", event.target.value)}><option value="">All currencies</option>{options(report.groups, "currency").map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>Modeled direction<select value={filters.direction} onChange={(event) => update("direction", event.target.value)}><option value="">All directions</option><option value="increase">Increase</option><option value="decrease">Decrease</option><option value="unchanged">Unchanged</option></select></label>
      </form>

      <section className={styles.kpis} aria-label="Pricing Change Analysis coverage summary">
        <div className={styles.kpi}><span>Input usage lines</span><strong>{report.summary.inputLineCount.toLocaleString("en-US")}</strong></div>
        <div className={styles.kpi}><span>Exactly modeled</span><strong>{report.summary.modeledLineCount.toLocaleString("en-US")}</strong></div>
        <div className={styles.kpi}><span>Excluded</span><strong>{report.summary.excludedLineCount.toLocaleString("en-US")}</strong></div>
        <div className={styles.kpi}><span>Catalog evidence</span><strong>{report.summary.catalogSnapshotCount} snapshots · {report.summary.catalogTermCount.toLocaleString("en-US")} terms</strong></div>
      </section>

      <section className={styles.section} aria-labelledby="pricing-change-comparison">
        <div className={styles.sectionHeader}><div><h3 id="pricing-change-comparison">Baseline and comparison catalog impact</h3><p>Totals remain separate by currency; no conversion or cross-currency sum is performed.</p></div></div>
        <div className={styles.currencyGrid}>{report.summary.modeledTotalsByCurrency.map((total) => {
          const changeClass = BigInt(total.modeledChange.roundedMicros) > BigInt(0) ? styles.changePositive : BigInt(total.modeledChange.roundedMicros) < BigInt(0) ? styles.changeNegative : styles.changeNeutral;
          return <article className={styles.currencyCard} key={total.currency}><h4>{total.currency}</h4>
            <div className={styles.barRow}><span>Baseline</span><div className={styles.barTrack}><div className={styles.bar} style={{ width: percentage(total.baselineModeledCost.roundedMicros, maximum) }} /></div><strong>{formatMicros(total.baselineModeledCost.roundedMicros, total.currency)}</strong></div>
            <div className={styles.barRow}><span>Comparison</span><div className={styles.barTrack}><div className={`${styles.bar} ${styles.barComparison}`} style={{ width: percentage(total.comparisonModeledCost.roundedMicros, maximum) }} /></div><strong>{formatMicros(total.comparisonModeledCost.roundedMicros, total.currency)}</strong></div>
            <p className={changeClass}>Modeled change: <strong>{formatMicros(total.modeledChange.roundedMicros, total.currency)}</strong></p>
          </article>;
        })}</div>
      </section>

      <section className={styles.section} aria-labelledby="pricing-change-drilldown">
        <div className={styles.sectionHeader}><div><h3 id="pricing-change-drilldown">Service, payer, linked account, and Region drilldown</h3><p>{groups.length.toLocaleString("en-US")} of {report.groups.length.toLocaleString("en-US")} bounded groups shown.</p></div></div>
        {groups.length === 0 ? <p className={styles.emptyFilter}>The complete materialization has no groups matching these filters.</p> : <div className={styles.tableWrap}><table><caption>Exact public-catalog what-if groups</caption><thead><tr><th>Service</th><th>Payer</th><th>Linked account</th><th>Region</th><th>Term / unit</th><th>Baseline</th><th>Comparison</th><th>Modeled change</th><th>Lines</th></tr></thead><tbody>{groups.map((group) => <tr key={[group.serviceCode, group.payerAccountId, group.linkedAccountId, group.region, group.currency, group.usageUnit, group.termType].join("|")}><th scope="row">{group.serviceCode}</th><td>{group.payerAccountId}</td><td>{group.linkedAccountId}</td><td>{group.region}</td><td><span className={styles.pill}>{group.termType} · {group.usageUnit}</span></td><td>{formatMicros(group.baselineModeledCost.roundedMicros, group.currency)}</td><td>{formatMicros(group.comparisonModeledCost.roundedMicros, group.currency)}</td><td className={direction(group) === "increase" ? styles.changePositive : direction(group) === "decrease" ? styles.changeNegative : styles.changeNeutral}>{formatMicros(group.modeledChange.roundedMicros, group.currency)}</td><td>{group.modeledLineCount.toLocaleString("en-US")}</td></tr>)}</tbody></table></div>}
      </section>

      <section className={styles.section} aria-labelledby="pricing-change-exclusions">
        <div className={styles.sectionHeader}><div><h3 id="pricing-change-exclusions">Excluded usage and mapping coverage</h3><p>Missing or inapplicable catalog evidence is never filled, fuzzy-matched, or priced with a neighboring tier.</p></div></div>
        {report.exclusions.length === 0 ? <p>No usage rows were excluded from this materialization.</p> : <div className={styles.tableWrap}><table><caption>Evidence-honest exclusion groups</caption><thead><tr><th>Reason</th><th>Service</th><th>Payer / linked</th><th>Region</th><th>Term / unit</th><th>Lines</th><th>Excluded usage</th></tr></thead><tbody>{report.exclusions.map((item) => <tr key={[item.reason, item.serviceCode, item.payerAccountId, item.linkedAccountId, item.region, item.usageUnit, item.termType].join("|")}><th scope="row">{item.reason}</th><td>{item.serviceCode}</td><td>{item.payerAccountId}<br />{item.linkedAccountId}</td><td>{item.region}</td><td>{item.termType} · {item.usageUnit}</td><td>{item.excludedLineCount}</td><td>{item.excludedUsage.exactNumerator} / {item.excludedUsage.exactDenominator} {item.excludedUsage.unit}</td></tr>)}</tbody></table></div>}
      </section>

      <details className={styles.evidence}><summary>Immutable Price List and CUR 2.0 lineage</summary><dl><div><dt>Usage window</dt><dd>{report.usagePeriodStartAt} — {report.usagePeriodEndAt}</dd></div><div><dt>Catalog dates</dt><dd>{report.baselineEffectiveAt} → {report.comparisonEffectiveAt}</dd></div><div><dt>Active CUR generation</dt><dd>{report.activeCur2GenerationId}</dd></div></dl><div className={styles.tableWrap}><table><caption>Version-pinned AWS Price List evidence</caption><thead><tr><th>Role</th><th>Service / Region</th><th>Version</th><th>Requested / effective</th><th>Price List ARN</th><th>File SHA-256</th></tr></thead><tbody>{report.catalogEvidence.map((item) => <tr key={item.snapshotId}><th scope="row">{item.role}</th><td>{item.serviceCode}<br />{item.region} · {item.currency}</td><td>{item.catalogVersion}</td><td>{item.requestedEffectiveAt}<br />{item.catalogEffectiveAt}</td><td>{item.priceListArn}</td><td>{item.priceListFileSha256}</td></tr>)}</tbody></table></div></details>
    </div>
  );
}

function presentation(state: SourceState): { readonly view: FinopsCapabilityViewState; readonly title: string; readonly detail: string } {
  switch (state) {
    case "configuration_required": return { view: "configuration_required", title: "Version-pinned pricing evidence is not configured", detail: "Sutra requires a server-owned active CUR 2.0 generation plus exact baseline and comparison AWS Price List files. Browser data and current-price substitutions are rejected." };
    case "waiting": return { view: "waiting", title: "Waiting for a complete immutable capture", detail: "Collection has not produced a terminal materialization. No zero-impact result is inferred." };
    case "partial": return { view: "partial", title: "Pricing comparison coverage is partial", detail: "Only exact accepted mappings are retained; exclusions and incomplete source coverage remain explicit." };
    case "stale": return { view: "stale", title: "Pricing or CUR evidence is stale", detail: "Retained lineage is shown for audit, but modeled impact is not presented as current." };
    case "failed": return { view: "failed", title: "The latest pricing evidence could not be verified", detail: "Sutra did not return modeled values from an unbound, missing, or invalid evidence object." };
    case "empty": return { view: "empty", title: "Complete capture contains no usage", detail: "Source coverage completed with zero usage rows; no cost or impact value is inferred." };
    case "complete": return { view: "complete", title: "Exact public-catalog comparison loaded", detail: "Every input usage row was matched to version-pinned catalog evidence. Results remain a what-if model, not an invoice, quote, discount, forecast, or savings claim." };
  }
}

function shellEvidence(envelope: PricingChangeDashboardEnvelope): FinopsCapabilityEvidence | null {
  if (envelope.evidence === null) return null;
  return {
    sourceLabel: "Active CUR 2.0 usage + versioned AWS Price List Bulk files",
    collectedAt: envelope.evidence.capturedAt,
    dataThroughAt: envelope.report?.activeCur2GeneratedAt ?? null,
    freshnessAgeHours: null,
    freshnessSlaHours: 48,
    acceptedRecords: envelope.report?.summary.modeledLineCount ?? null,
    rejectedRecords: envelope.report?.summary.excludedLineCount ?? null,
    generationId: envelope.evidence.evidenceGenerationId,
    contentSha256: envelope.evidence.contentSha256,
    limitations: envelope.limitations,
  };
}

export function FinopsPricingChangeDashboard({ connectionId, dashboard, onOpenSharedAnalysis }: { readonly connectionId: string | null; readonly dashboard: FinopsDashboardCatalogEntry; readonly onOpenSharedAnalysis: () => void }) {
  const [request, setRequest] = useState<{ readonly loading: boolean; readonly envelope: PricingChangeDashboardEnvelope | null; readonly error: string | null }>({ loading: true, envelope: null, error: null });
  const load = useCallback(async () => {
    if (connectionId === null) return;
    setRequest({ loading: true, envelope: null, error: null });
    try {
      const response = await fetch(`/api/v1/finops/pricing-change-analysis?${new URLSearchParams({ connectionId }).toString()}`, { credentials: "same-origin", cache: "no-store" });
      const body = await response.json() as unknown;
      if (!response.ok) throw new Error("Sutra could not load Pricing Change Analysis evidence.");
      setRequest({ loading: false, envelope: parseEnvelope(body, connectionId), error: null });
    } catch (error) {
      setRequest({ loading: false, envelope: null, error: error instanceof Error ? error.message : "Sutra could not load Pricing Change Analysis evidence." });
    }
  }, [connectionId]);
  useEffect(() => {
    if (connectionId === null) return;
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [connectionId, load]);
  const state: SourceState = connectionId === null ? "configuration_required" : request.loading ? "waiting" : request.error !== null ? "failed" : request.envelope?.sourceState ?? "failed";
  const copy = presentation(state);
  const envelope = request.envelope;
  return <FinopsCapabilityShell dashboard={dashboard} state={copy.view} stateTitle={copy.title} stateDetail={request.error ?? copy.detail} evidence={envelope === null ? null : shellEvidence(envelope)} actions={<><button className="button button-secondary" type="button" disabled={connectionId === null || request.loading} onClick={() => void load()}>Retry report</button><button className="button button-secondary" type="button" onClick={onOpenSharedAnalysis}>Open shared cost explorer</button><a className="button button-secondary" href={dashboard.documentationUrl} target="_blank" rel="noreferrer">AWS guidance</a></>}>
    <PricingChangeOfficialDefinitionPanel definition={envelope?.officialDefinition ?? PRICING_CHANGE_OFFICIAL_DEFINITION} />
    {envelope?.report === null || envelope?.report === undefined ? null : <FinopsPricingChangeReportView report={envelope.report} />}
  </FinopsCapabilityShell>;
}

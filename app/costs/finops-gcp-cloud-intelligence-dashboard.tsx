"use client";

/**
 * ADD-03 — Cloud Intelligence Dashboard for GCP (catalog id `gcp_cid`).
 *
 * Scope and truth boundary, stated once here and repeated in the UI itself:
 *
 * - This dashboard is EXCLUDED from the current 27-dashboard release and its
 *   tracker maturity is `PARTIAL_PIPELINE`. Nothing in this file promotes it.
 * - No GCP billing connection exists in this runtime. The Workload Identity /
 *   BigQuery billing-export adapter is not deployed, so the dominant rendered
 *   state is an explicit "GCP provider connection is not implemented"
 *   configuration-required state.
 * - AWS evidence, fixtures and cross-cloud aggregates are never substituted for
 *   GCP data. A sheet with no provider evidence shows a labelled unavailable
 *   state, never a zero and never a borrowed number.
 *
 * What IS real and therefore rendered unconditionally: the hash-pinned official
 * definition of the upstream awslabs GCP Cost Dashboard — 7 sheets, 60 visuals,
 * 54 control placements, 14 parameter declarations, 53 calculated fields, 172
 * filter groups, 2 datasets, 3 views — together with each sheet's coverage
 * classification and its named remaining gaps. A reader can therefore see
 * exactly what the official dashboard contains and exactly what Sutra does not
 * yet reproduce.
 *
 * Money: the GCP Cloud Billing export carries signed integer NANOS (BigQuery
 * NUMERIC scale), not micro-units. `formatMicrosExact` from the foundational
 * panels would misstate every GCP figure by a factor of one thousand, so this
 * file carries `formatNanosExact`, which mirrors it exactly — same unicode
 * minus, same grouping, same two-decimal floor — while never converting the
 * value to a Number. Charts convert only for geometry.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChartState, RankingBars, TimeSeriesChart } from "../components/charts";
import { StateBadge } from "./finops-foundational-panels";
import {
  FinopsSheetBlock,
  FinopsSheetShell,
  foundationalStyles as shell,
} from "./finops-foundational-sheet-shell";
import type { FinopsSheetDescriptor, FinopsSheetInventory } from "./finops-foundational-sheets";
import {
  gcpFormulaSafeCsvCell,
  type GcpCalculatedOpportunity,
  type GcpMoneyTotal,
} from "../../lib/finops-gcp-cloud-intelligence";
import {
  GCP_CLOUD_INTELLIGENCE_OFFICIAL_DEFINITION,
  type GcpCloudIntelligenceOfficialDefinition,
} from "../../lib/finops-gcp-cloud-intelligence-official-definition";
import styles from "./finops-gcp-cloud-intelligence-dashboard.module.css";

/* ------------------------------------------------------------------ *
 * Transport shapes — exactly the fields `/api/v1/finops/gcp-cloud-
 * intelligence` returns. Nothing outside these shapes is rendered.
 * ------------------------------------------------------------------ */

/** Query parameters the route accepts, all optional. */
export interface GcpCloudIntelligenceFilters {
  readonly invoiceMonth?: string;
  readonly projectId?: string;
  readonly service?: string;
  readonly sku?: string;
  readonly region?: string;
  readonly currency?: string;
  readonly labelKey?: string;
  readonly labelValue?: string;
}
type Filters = GcpCloudIntelligenceFilters;

/** A grouped total. `name` is `"<CURRENCY>|<label>"`; `amountNanos` is exact. */
interface Series {
  readonly name: string;
  readonly amountNanos: string;
}

interface GcpSourceOption {
  readonly sourceId: string;
  readonly billingAccountId: string;
  readonly exportProjectId: string;
  readonly location: string;
}

/** The successful arm: an accepted billing-export generation exists. */
export interface GcpCloudIntelligenceEnvelope {
  readonly sourceId: string;
  readonly sources: readonly GcpSourceOption[];
  readonly sourceState: string;
  readonly officialDefinition: GcpCloudIntelligenceOfficialDefinition;
  readonly views: readonly string[];
  readonly actualBilled: readonly GcpMoneyTotal[];
  readonly rowCount: number;
  readonly costTrendByInvoiceMonth: readonly Series[];
  readonly costByProject: readonly Series[];
  readonly costByService: readonly Series[];
  readonly costBySku: readonly Series[];
  readonly costByRegion: readonly Series[];
  readonly costByResource: readonly Series[];
  readonly costByType: readonly Series[];
  readonly creditsByType: readonly Series[];
  readonly kubernetesCostByCluster: readonly Series[];
  readonly calculatedOpportunities: {
    readonly state: string;
    readonly rows: readonly GcpCalculatedOpportunity[];
    readonly totalByCurrency: readonly Series[];
  };
  readonly coverage: {
    readonly detailedUsageExport: boolean;
    readonly pricingExport: boolean;
    readonly gkeCostAllocation: boolean;
    readonly dataThroughAt: string | null;
  };
  readonly filterOptions: {
    readonly invoiceMonths: readonly string[];
    readonly projects: readonly string[];
    readonly services: readonly string[];
    readonly skus: readonly string[];
    readonly regions: readonly string[];
    readonly currencies: readonly string[];
    readonly labelKeys: readonly string[];
  };
  readonly freshness: Readonly<Record<string, unknown>>;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly activation: Readonly<Record<string, unknown>>;
  readonly semantics: Readonly<Record<string, unknown>>;
  readonly history: readonly Readonly<Record<string, unknown>>[];
  readonly limitations: readonly string[];
  readonly collection: Readonly<Record<string, unknown>>;
}

/**
 * The three report-independent arms of the route: no source registered, more
 * than one source and none selected, and a registered source with no accepted
 * generation. All three carry `dashboard: null` and the pinned definition.
 */
export interface GcpCloudIntelligenceDiscovery {
  readonly schema: string;
  readonly sourceId?: string;
  readonly sourceState: string;
  readonly dashboard: null;
  readonly selectionRequired: boolean;
  readonly sources: readonly GcpSourceOption[];
  readonly officialDefinition: GcpCloudIntelligenceOfficialDefinition;
  readonly activation?: Readonly<Record<string, unknown>>;
}

export type GcpCloudIntelligenceResponse =
  | GcpCloudIntelligenceEnvelope
  | GcpCloudIntelligenceDiscovery;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when the response carries no accepted generation. */
export function isGcpDiscoveryResponse(
  response: GcpCloudIntelligenceResponse,
): response is GcpCloudIntelligenceDiscovery {
  return (response as { readonly dashboard?: unknown }).dashboard === null;
}

/** Read a string field out of an untyped evidence record without inventing one. */
function text(record: Readonly<Record<string, unknown>> | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Guards the pinned audit. The dashboard refuses to render provider evidence
 * against a definition whose commit or embedded-definition hash has moved.
 */
function hasPinnedOfficialDefinition(
  value: unknown,
): value is Readonly<Record<string, unknown>> & {
  readonly officialDefinition: GcpCloudIntelligenceOfficialDefinition;
} {
  if (
    !isRecord(value)
    || !isRecord(value.officialDefinition)
    || !isRecord(value.officialDefinition.source)
    || !isRecord(value.officialDefinition.totals)
  ) return false;
  return value.officialDefinition.schema === "sutra.finops-gcp-cloud-intelligence-official-definition.v1"
    && value.officialDefinition.source.commit === "d0b5983db3a0931a63fcc21a9f7e2764483cfcaf"
    && value.officialDefinition.source.manifestSha256 === "78ed3d8245be60aea8f212e38f1458d6ea5be8b9f0fe660deee71f494ec7087c"
    && value.officialDefinition.source.embeddedDefinitionSha256 === "f0c8192efe855309d5cd63189b9a7c10e0819b2ee7eb64e124fae47588347b07"
    && value.officialDefinition.totals.sheets === 7
    && value.officialDefinition.totals.visuals === 60;
}

/* ------------------------------------------------------------------ *
 * Exact money and chart geometry
 * ------------------------------------------------------------------ */

const INTEGER_NANOS = /^-?(?:0|[1-9]\d*)$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const NANOS_PER_UNIT = BigInt(1_000_000_000);

/**
 * Signed integer nanos to text, exactly. Never converts to Number, so a value
 * of any magnitude prints every digit it was given. A missing value is the
 * labelled string "Not available" — never a zero.
 */
export function formatNanosExact(nanos: string | null, currency: string): string {
  if (nanos === null || !INTEGER_NANOS.test(nanos) || !CURRENCY.test(currency)) return "Not available";
  const amount = BigInt(nanos);
  const negative = amount < BigInt(0);
  const absolute = negative ? -amount : amount;
  const whole = (absolute / NANOS_PER_UNIT).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const rawFraction = (absolute % NANOS_PER_UNIT).toString().padStart(9, "0");
  const significant = rawFraction.replace(/0+$/u, "");
  const fraction = significant.length < 2 ? significant.padEnd(2, "0") : significant;
  return `${negative ? "−" : ""}${currency} ${whole}.${fraction}`;
}

/**
 * Nanos to currency units for geometry only. The integer and fractional parts
 * are converted separately so magnitude is not capped the way a single
 * `Number(nanos) / 1e9` would cap it. A malformed value returns null and is
 * dropped from the plot rather than being drawn as an assumed zero.
 */
function nanosToUnits(nanos: string | null): number | null {
  if (nanos === null || !INTEGER_NANOS.test(nanos)) return null;
  const amount = BigInt(nanos);
  const negative = amount < BigInt(0);
  const absolute = negative ? -amount : amount;
  const whole = Number(absolute / NANOS_PER_UNIT);
  const fraction = Number(absolute % NANOS_PER_UNIT) / 1_000_000_000;
  if (!Number.isFinite(whole)) return null;
  return (negative ? -1 : 1) * (whole + fraction);
}

function formatUnits(value: number, currency: string): string {
  if (!Number.isFinite(value)) return "Not available";
  const code = CURRENCY.test(currency) ? currency : "USD";
  const magnitude = Math.abs(value);
  const fractionDigits = magnitude >= 1_000 ? 0 : magnitude >= 1 ? 2 : 6;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  }).format(value).replace("-", "−");
}

/** Split a `"<CURRENCY>|<label>"` series key without losing labels that contain `|`. */
function splitSeries(name: string): { readonly currency: string; readonly label: string } {
  const separator = name.indexOf("|");
  if (separator < 0) return { currency: "", label: name };
  return { currency: name.slice(0, separator), label: name.slice(separator + 1) };
}

function currenciesOf(rows: readonly Series[]): readonly string[] {
  return [...new Set(rows.map((row) => splitSeries(row.name).currency))].sort();
}

/* ------------------------------------------------------------------ *
 * The 7 official sheets, normalized onto the shared sheet shell
 * ------------------------------------------------------------------ */

/**
 * Gap carried by every sheet: there is no provider connection, so no rendered
 * value on any sheet is derived from GCP evidence in this runtime.
 */
const NO_CONNECTION_GAP =
  "No GCP billing connection exists in this runtime: the Workload Identity / BigQuery billing-export adapter is not deployed, so this sheet renders no provider value.";

const SHEET_PURPOSE: Readonly<Record<string, string>> = Object.freeze({
  Summary: "Invoice totals, realized credits, invoice-month trend and project, service, SKU, region and resource allocation.",
  "Compute Engine": "Compute Engine service, SKU, project, resource and zone or region cost detail.",
  "Cloud SQL": "Cloud SQL instance service, SKU, project and region cost detail.",
  "Big Query": "BigQuery analysis, storage and reservation cost detail. Sutra uses the provider spelling BigQuery.",
  Network: "Networking service and SKU cost by project and region, including egress usage units.",
  Kubernetes: "GKE cluster cost, available only where GKE cost allocation is enabled and a supplied cluster label proves the grouping.",
  About: "Pinned upstream commits, artifact hashes, exact source totals, activation state, lineage and named limitations.",
});

/**
 * Exact-match prefixes on the provider-supplied service description used to
 * scope a service sheet. This is a filter over values the export supplies, not
 * a classification Sutra invents: a sheet with no matching supplied description
 * shows an explicit unavailable state rather than a guess.
 */
const SHEET_SERVICE_PREFIX: Readonly<Record<string, string>> = Object.freeze({
  "Compute Engine": "Compute Engine",
  "Cloud SQL": "Cloud SQL",
  "Big Query": "BigQuery",
  Network: "Network",
});

/** Stable tab slug per official sheet name. */
function sheetSlug(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return slug === "" ? "sheet" : slug;
}

/**
 * Build the shared sheet inventory straight from the pinned definition, so the
 * shell cannot present a sheet upstream does not publish, nor omit one it does.
 *
 * Every sheet is classified `PARTIAL`. None is upgraded to `SUPPORTED`: while no
 * provider generation exists, no sheet is covered, and the audit's own
 * classification literal travels alongside as the badge label.
 */
export function gcpOfficialSheetInventory(
  definition: GcpCloudIntelligenceOfficialDefinition,
): FinopsSheetInventory {
  const sheets: readonly FinopsSheetDescriptor[] = definition.sheets.map((sheet) => ({
    key: sheetSlug(sheet.name),
    name: sheet.name,
    visualCount: sheet.visualCount,
    controlCount: sheet.parameterControls.length + sheet.filterControls.length,
    support: "PARTIAL" as const,
    supportLabel: sheet.nativeCoverage,
    gaps: [sheet.remainingGap, NO_CONNECTION_GAP],
    formulaIds: [],
  }));
  return {
    sheets,
    totalSheets: definition.totals.sheets,
    totalVisuals: definition.totals.visuals,
    totalControls: definition.totals.parameterControls + definition.totals.filterControls,
    supportedSheets: 0,
    partialSheets: sheets.length,
    source: {
      repository: definition.source.repository,
      commit: definition.source.commit,
      path: definition.source.manifestPath,
      sha256: definition.source.embeddedDefinitionSha256,
      version: definition.source.publishedVersion,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Small presentational pieces
 * ------------------------------------------------------------------ */

function Tile({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
}) {
  return (
    <div className={shell.tile}>
      <span className={shell.tileLabel}>{label}</span>
      <span className={shell.tileValue}>{value}</span>
      {detail === undefined ? null : <span className={shell.tileDetail}>{detail}</span>}
    </div>
  );
}

/**
 * The explicit unavailable state for one sheet or one block. Always visible,
 * always labelled, always names why. This is what stands in place of a number.
 */
function Unavailable({ title, reason }: { readonly title: string; readonly reason: string }) {
  return (
    <div className={styles.unavailable} role="status">
      <strong>{title}</strong>
      <p>{reason}</p>
    </div>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string | undefined;
  readonly options: readonly string[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <select value={value ?? ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">All</option>
        {options.map((option) => <option key={option}>{option}</option>)}
      </select>
    </label>
  );
}

/**
 * One grouped total set as ranked bars, one chart per currency. Currencies are
 * never combined, and the exact nanos travel in the chart's own data table.
 */
function SeriesRanking({
  ariaLabel,
  rows,
  emptyReason,
  maxItems = 12,
}: {
  readonly ariaLabel: string;
  readonly rows: readonly Series[];
  readonly emptyReason: string;
  readonly maxItems?: number;
}) {
  const currencies = currenciesOf(rows);
  if (currencies.length === 0) {
    return <ChartState title="No collected evidence" detail={emptyReason} />;
  }
  return (
    <>
      {currencies.map((currency) => (
        <RankingBars
          ariaLabel={`${ariaLabel} in ${currency}`}
          items={rows
            .filter((row) => splitSeries(row.name).currency === currency)
            .map((row) => ({
              id: row.name,
              label: splitSeries(row.name).label,
              value: nanosToUnits(row.amountNanos) ?? Number.NaN,
              detail: formatNanosExact(row.amountNanos, currency),
            }))}
          formatValue={(value) => formatUnits(value, currency)}
          key={currency}
          maxItems={maxItems}
          sort
        />
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The pinned official definition panel (report-independent evidence)
 * ------------------------------------------------------------------ */

export function GcpCloudIntelligenceOfficialDefinitionPanel({
  definition,
}: {
  readonly definition: GcpCloudIntelligenceOfficialDefinition;
}) {
  const controls = definition.totals.parameterControls + definition.totals.filterControls;
  return (
    <section className={styles.panel} aria-label="Official GCP Cloud Intelligence definition coverage">
      <div className={styles.head}>
        <div>
          <h3>Official GCP definition coverage</h3>
          <p>
            {definition.totals.sheets} sheets · {definition.totals.visuals} visuals · {controls} controls
          </p>
        </div>
        <small>
          {definition.source.commit.slice(0, 12)} · {definition.source.embeddedDefinitionSha256.slice(0, 16)}…
        </small>
      </div>

      <div className={styles.cards}>
        {definition.sheets.map((sheet) => (
          <article key={sheet.id}>
            <small>{sheet.name}</small>
            <strong>{sheet.visualCount}</strong>
            <span>
              {sheet.parameterControls.length + sheet.filterControls.length} controls · {sheet.nativeCoverage}
            </span>
            <p>{sheet.nativeEvidence}</p>
          </article>
        ))}
      </div>

      <details className={styles.evidence}>
        <summary>Published artifacts, exact structure, and remaining gaps</summary>
        <div className={styles.scroll}>
          <table>
            <caption>Official GCP sheet inventory and Sutra coverage</caption>
            <thead>
              <tr>
                <th>Sheet</th>
                <th>Visuals</th>
                <th>Parameter controls</th>
                <th>Filter controls</th>
                <th>Remaining gap</th>
              </tr>
            </thead>
            <tbody>
              {definition.sheets.map((sheet) => (
                <tr key={sheet.id}>
                  <th scope="row">{sheet.name}</th>
                  <td>{sheet.visualCount}</td>
                  <td>{sheet.parameterControls.join(" · ") || "None"}</td>
                  <td>{sheet.filterControls.join(" · ") || "None"}</td>
                  <td>{sheet.remainingGap}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Manifest <code>{definition.source.manifestSha256}</code> · embedded definition{" "}
          <code>{definition.source.embeddedDefinitionSha256}</code>. Exact counts describe pinned source
          objects; pixel, geometry, query-result, and interaction parity are not claimed.
        </p>
        <p>
          {definition.nativeBinding.state.replaceAll("_", " ")}. The permanent Workload Identity / BigQuery
          adapter and live provider generation remain unavailable.
        </p>
        <ul>
          {definition.artifacts.map((artifact) => (
            <li key={`${artifact.kind}:${artifact.path}`}>
              <strong>{artifact.kind.replaceAll("_", " ")}</strong> · <code>{artifact.sha256}</code> ·{" "}
              {artifact.hashBasis}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Provider connection state — the dominant state of this dashboard
 * ------------------------------------------------------------------ */

/**
 * Prominent, unmissable statement that GCP is not wired up. It leads the page in
 * every report-independent arm and stays visible even when a generation exists,
 * because the permanent provider adapter is still not deployed.
 */
export function GcpProviderConnectionState({
  definition,
  sourceState,
  activation,
}: {
  readonly definition: GcpCloudIntelligenceOfficialDefinition;
  readonly sourceState: string;
  readonly activation: Readonly<Record<string, unknown>> | undefined;
}) {
  const reason = text(activation, "reason") ?? definition.nativeBinding.state;
  return (
    <section
      className={styles.provider}
      role="status"
      aria-label="GCP provider connection state"
    >
      <div className={styles.providerHead}>
        <strong className={styles.providerTitle}>GCP provider connection is not implemented</strong>
        <span className={styles.pill}>Configuration required</span>
        <StateBadge state={sourceState} />
      </div>
      <p>
        Sutra has no GCP billing connection in this runtime. No Cloud Billing detailed usage export, no
        pricing export and no GKE cost allocation feed is bound, and the Workload Identity / BigQuery
        adapter that would read them is not deployed. Every cost, credit, saving and cluster figure on
        this dashboard is therefore withheld and labelled, not estimated.
      </p>
      <dl className={styles.providerFacts}>
        <div>
          <dt>Reported source state</dt>
          <dd>{sourceState.replaceAll("_", " ")}</dd>
        </div>
        <div>
          <dt>Activation reason</dt>
          <dd>{reason.replaceAll("_", " ")}</dd>
        </div>
        <div>
          <dt>Permanent runtime adapter</dt>
          <dd>{definition.nativeBinding.permanentRuntimeAdapterAvailable ? "Available" : "Not available"}</dd>
        </div>
        <div>
          <dt>Live provider generation</dt>
          <dd>{definition.nativeBinding.liveProviderGenerationAvailable ? "Available" : "Not available"}</dd>
        </div>
        <div>
          <dt>Workload Identity required</dt>
          <dd>{definition.nativeBinding.workloadIdentityRequired ? "Yes" : "No"}</dd>
        </div>
        <div>
          <dt>Service-account key accepted</dt>
          <dd>{definition.nativeBinding.serviceAccountKeyAccepted ? "Yes" : "Never"}</dd>
        </div>
      </dl>
      <p className={styles.note}>
        AWS trust roles, AWS billing evidence and cross-cloud aggregates are not accepted as GCP evidence
        and are never displayed here. A GCP figure appears only when a same-tenant GCP billing source
        delivers it.
      </p>
    </section>
  );
}

/** Release-scope and maturity disclosure. This dashboard is not being shipped. */
function GcpScopeDisclosure() {
  return (
    <div className={styles.scope}>
      <span>Catalog id <code>gcp_cid</code></span>
      <span>Excluded from the 27-dashboard release</span>
      <span>Tracker maturity PARTIAL_PIPELINE</span>
      <span>Presentation only — not delivered, not connected</span>
    </div>
  );
}

/** The named gaps that stay explicitly unavailable regardless of any response. */
const EXPLICIT_UNAVAILABLE: readonly { readonly title: string; readonly detail: string }[] = Object.freeze([
  {
    title: "Workload Identity / BigQuery billing-export adapter",
    detail: "Not implemented. No identity binding is issued and no service-account key is ever accepted.",
  },
  {
    title: "Live provider generation and reconciliation",
    detail: "Unavailable. There is no accepted GCP generation to reconcile, so no freshness or acceptance claim is made.",
  },
  {
    title: "Six-level project hierarchy parity (L1–L6)",
    detail: "Unavailable. The upstream hierarchy parameter controls are not reproduced and no level is inferred from labels.",
  },
  {
    title: "Exact interactions and visual geometry",
    detail: "Not claimed. Sankey, waterfall and heat-map geometry, cross-visual actions and pixel layout are outside the audited counts.",
  },
]);

function GcpUnavailablePanel({ definition }: { readonly definition: GcpCloudIntelligenceOfficialDefinition }) {
  return (
    <section className={styles.panel} aria-label="Explicitly unavailable GCP capabilities">
      <h3>Explicitly unavailable</h3>
      <dl className={styles.providerFacts}>
        {EXPLICIT_UNAVAILABLE.map((item) => (
          <div key={item.title}>
            <dt>{item.title}</dt>
            <dd>{item.detail}</dd>
          </div>
        ))}
      </dl>
      <ul>
        {definition.disclosures.map((disclosure) => <li key={disclosure}>{disclosure}</li>)}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Sheet bodies
 * ------------------------------------------------------------------ */

function exportOpportunities(rows: readonly GcpCalculatedOpportunity[]): void {
  const header = [
    "opportunity_id", "source", "project_id", "service", "resource", "region", "currency",
    "estimated_monthly_savings_nanos", "state", "observed_at", "source_sha256",
  ];
  const body = rows.map((row) => [
    row.opportunityId, row.source, row.projectId, row.serviceDescription, row.resourceGlobalName,
    row.locationRegion, row.currency, row.estimatedMonthlySavingsNanos, row.state, row.observedAt,
    row.sourceRecordSha256,
  ].map(gcpFormulaSafeCsvCell).join(","));
  const url = URL.createObjectURL(
    new Blob([[header.join(","), ...body].join("\n")], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "sutra-gcp-calculated-opportunities.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Summary sheet: totals, invoice-month trend, allocation, credits, opportunities. */
function SummarySheet({ report }: { readonly report: GcpCloudIntelligenceEnvelope }) {
  const trendCurrencies = currenciesOf(report.costTrendByInvoiceMonth);
  return (
    <div className={shell.blocks}>
      <FinopsSheetBlock
        description="Provider invoice facts. Cost before credits and realized credits are export facts; calculated pricing variance is never merged into either."
        title="Actual billed totals"
      >
        {report.actualBilled.length === 0 ? (
          <Unavailable
            reason="The active generation supplied no currency total, so no billed amount is shown. This is an absence of evidence, not a zero bill."
            title="No billed total in the active generation"
          />
        ) : (
          <div className={shell.tiles}>
            {report.actualBilled.flatMap((total) => [
              <Tile
                detail={`${report.rowCount.toLocaleString()} billing rows in scope`}
                key={`${total.currency}-net`}
                label={`Net billed · ${total.currency}`}
                value={formatNanosExact(total.netBilledCostNanos, total.currency)}
              />,
              <Tile
                key={`${total.currency}-before`}
                label={`Cost before credits · ${total.currency}`}
                value={formatNanosExact(total.costBeforeCreditsNanos, total.currency)}
              />,
              <Tile
                key={`${total.currency}-credits`}
                label={`Realized credits · ${total.currency}`}
                value={formatNanosExact(total.creditsNanos, total.currency)}
              />,
              <Tile
                detail="Calculated, not billed"
                key={`${total.currency}-variance`}
                label={`Pricing variance · ${total.currency}`}
                value={formatNanosExact(total.calculatedPricingVarianceNanos, total.currency)}
              />,
            ])}
          </div>
        )}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Net billed cost per invoice month, one series per currency. A month with no delivered generation is a gap in the line, never a zero point."
        title="Cost trend by invoice month"
      >
        {trendCurrencies.length === 0 ? (
          <ChartState
            detail="No invoice month was delivered by a GCP billing export, so no trend can be plotted."
            title="No invoice-month evidence"
          />
        ) : trendCurrencies.map((currency) => (
          <TimeSeriesChart
            ariaLabel={`Net billed GCP cost by invoice month in ${currency}`}
            formatValue={(value) => formatUnits(value, currency)}
            key={currency}
            mode="area"
            series={[{
              id: `invoice-month-${currency}`,
              label: `${currency} net billed`,
              points: report.costTrendByInvoiceMonth
                .filter((row) => splitSeries(row.name).currency === currency)
                .map((row) => ({
                  label: splitSeries(row.name).label,
                  value: nanosToUnits(row.amountNanos),
                })),
            }]}
          />
        ))}
      </FinopsSheetBlock>

      <FinopsSheetBlock description="Allocation across the dimensions the detailed usage export supplies." title="Cost allocation">
        <div className={shell.blockGrid}>
          <SeriesRanking
            ariaLabel="GCP net billed cost by project"
            emptyReason="No project was supplied by a delivered export."
            rows={report.costByProject}
          />
          <SeriesRanking
            ariaLabel="GCP net billed cost by service"
            emptyReason="No service description was supplied by a delivered export."
            rows={report.costByService}
          />
          <SeriesRanking
            ariaLabel="GCP net billed cost by region"
            emptyReason="No location region was supplied by a delivered export."
            rows={report.costByRegion}
          />
          <SeriesRanking
            ariaLabel="GCP net billed cost by SKU"
            emptyReason="No SKU description was supplied by a delivered export."
            rows={report.costBySku}
          />
          <SeriesRanking
            ariaLabel="GCP net billed cost by resource"
            emptyReason="No resource name was supplied by a delivered export."
            rows={report.costByResource}
          />
          <SeriesRanking
            ariaLabel="GCP net billed cost by cost type"
            emptyReason="No cost type was supplied by a delivered export."
            rows={report.costByType}
          />
        </div>
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Realized credits and discounts by provider credit type. Negative amounts keep their real sign."
        title="Credits and discounts"
      >
        <SeriesRanking
          ariaLabel="GCP realized credits by type"
          emptyReason="No credit record was supplied by a delivered export."
          rows={report.creditsByType}
        />
      </FinopsSheetBlock>

      <FinopsSheetBlock
        actions={report.calculatedOpportunities.rows.length === 0 ? undefined : (
          <button onClick={() => exportOpportunities(report.calculatedOpportunities.rows)} type="button">
            Export formula-safe CSV
          </button>
        )}
        description="Calculated economics, held in a separate channel. Never merged into actual billed cost or realized provider credits."
        title="Calculated opportunities"
      >
        {report.calculatedOpportunities.rows.length === 0 ? (
          <Unavailable
            reason={`Opportunity channel state ${report.calculatedOpportunities.state.replaceAll("_", " ")}. No recommender or pricing-variance record was supplied, and none is inferred.`}
            title="No calculated opportunity in the active generation"
          />
        ) : (
          <div className={shell.tableWrap}>
            <table className={shell.table}>
              <caption>Calculated GCP opportunities, separate from billed cost</caption>
              <thead>
                <tr>
                  <th>Project / service</th>
                  <th>Resource / region</th>
                  <th>Source</th>
                  <th>Estimated monthly savings</th>
                  <th>State</th>
                  <th>Observed</th>
                </tr>
              </thead>
              <tbody>
                {report.calculatedOpportunities.rows.map((row) => (
                  <tr key={row.opportunityId}>
                    <td>
                      {row.projectId ?? "Project not supplied"}
                      <br />
                      {row.serviceDescription}
                    </td>
                    <td>
                      {row.resourceGlobalName ?? "Resource not supplied"}
                      <br />
                      {row.locationRegion ?? "Region not supplied"}
                    </td>
                    <td>{row.source.replaceAll("_", " ")}</td>
                    <td>{formatNanosExact(row.estimatedMonthlySavingsNanos, row.currency)}</td>
                    <td><span className={styles.pill}>{row.state}</span></td>
                    <td>{row.observedAt.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FinopsSheetBlock>
    </div>
  );
}

/**
 * A service sheet (Compute Engine, Cloud SQL, Big Query, Network). Scoped by
 * exact prefix match on the supplied service description; if nothing matches,
 * the sheet says so rather than showing the whole bill under a service heading.
 */
function ServiceSheet({
  report,
  sheetName,
}: {
  readonly report: GcpCloudIntelligenceEnvelope;
  readonly sheetName: string;
}) {
  const prefix = SHEET_SERVICE_PREFIX[sheetName] ?? sheetName;
  const rows = report.costByService.filter((row) => splitSeries(row.name).label.startsWith(prefix));
  return (
    <div className={shell.blocks}>
      <FinopsSheetBlock
        description={`Supplied service descriptions beginning "${prefix}". Sutra filters values the export supplied and classifies nothing itself.`}
        title={`${sheetName} cost`}
      >
        {rows.length === 0 ? (
          <Unavailable
            reason={`No delivered export row carries a service description beginning "${prefix}", so no ${sheetName} cost is shown. No value is attributed to this sheet by inference.`}
            title={`No supplied ${sheetName} evidence`}
          />
        ) : (
          <SeriesRanking
            ariaLabel={`GCP ${sheetName} net billed cost by service description`}
            emptyReason={`No ${sheetName} service description was supplied.`}
            rows={rows}
          />
        )}
      </FinopsSheetBlock>
      <FinopsSheetBlock
        description="What this sheet deliberately does not show."
        title="Sheet-level attribution limits"
      >
        <Unavailable
          reason="The report envelope carries SKU and resource totals for the whole scope, not per official sheet. Attributing them to this sheet would require a mapping the export does not supply, so they are shown only on the Summary sheet."
          title="Per-sheet SKU and resource attribution is unavailable"
        />
      </FinopsSheetBlock>
    </div>
  );
}

/** Kubernetes sheet: cluster cost only where GKE cost allocation proves it. */
function KubernetesSheet({ report }: { readonly report: GcpCloudIntelligenceEnvelope }) {
  return (
    <div className={shell.blocks}>
      <FinopsSheetBlock
        description="Cluster grouping comes only from a supplied goog-k8s-cluster-name label. No cluster is inferred from project, SKU or resource naming."
        title="Cost by GKE cluster"
      >
        {!report.coverage.gkeCostAllocation ? (
          <Unavailable
            reason="GKE cost allocation is not enabled on the billing source, so the export carries no cluster label and no cluster cost can be shown."
            title="GKE cost allocation is not enabled"
          />
        ) : (
          <SeriesRanking
            ariaLabel="GCP net billed cost by GKE cluster"
            emptyReason="GKE cost allocation is enabled but no delivered row carries a cluster label."
            rows={report.kubernetesCostByCluster}
          />
        )}
      </FinopsSheetBlock>
    </div>
  );
}

/** About sheet: the pinned source, activation, lineage and limitations. */
function AboutSheet({
  definition,
  report,
  sourceState,
}: {
  readonly definition: GcpCloudIntelligenceOfficialDefinition;
  readonly report: GcpCloudIntelligenceEnvelope | null;
  readonly sourceState: string;
}) {
  return (
    <div className={shell.blocks}>
      <FinopsSheetBlock
        description="Immutable public source of the upstream GCP Cost Dashboard, pinned by commit and content hash."
        title="Pinned upstream source"
      >
        <div className={shell.tiles}>
          <Tile label="Repository commit" value={definition.source.commit.slice(0, 12)} detail={definition.source.repository} />
          <Tile label="Manifest" value={definition.source.manifestPath} detail={definition.source.manifestSha256.slice(0, 24)} />
          <Tile label="Embedded definition" value={definition.source.embeddedDefinitionSha256.slice(0, 24)} detail="Decoded YAML scalar UTF-8 bytes" />
          <Tile label="Published version" value={definition.source.publishedVersion ?? "None published"} detail="No release version or changelog at the pinned commit" />
        </div>
      </FinopsSheetBlock>

      <FinopsSheetBlock description="Exact counts of pinned source objects. Not a parity claim." title="Exact source totals">
        <div className={shell.tiles}>
          <Tile label="Sheets" value={String(definition.totals.sheets)} />
          <Tile label="Visuals" value={String(definition.totals.visuals)} />
          <Tile
            detail={`${definition.totals.parameterControls} parameter · ${definition.totals.filterControls} filter`}
            label="Control placements"
            value={String(definition.totals.parameterControls + definition.totals.filterControls)}
          />
          <Tile label="Parameter declarations" value={String(definition.totals.parameterDeclarations)} />
          <Tile label="Calculated fields" value={String(definition.totals.calculatedFields)} />
          <Tile label="Filter groups" value={String(definition.totals.filterGroups)} />
          <Tile label="Datasets" value={String(definition.totals.datasets)} detail={definition.datasets.map((set) => set.identifier).join(" · ")} />
          <Tile label="Views" value={String(definition.totals.views)} detail={definition.views.join(" · ")} />
        </div>
      </FinopsSheetBlock>

      <FinopsSheetBlock description="Native binding state of the GCP provider adapter." title="Activation and lineage">
        {report === null ? (
          <Unavailable
            reason={`Source state ${sourceState.replaceAll("_", " ")}. There is no accepted GCP generation, so no lineage, freshness, capture, BigQuery job id or query hash exists to display.`}
            title="No accepted generation, so no lineage exists"
          />
        ) : (
          <details className={styles.evidence} open>
            <summary>Freshness, evidence, activation, exact-money semantics, collection and history</summary>
            <pre>{JSON.stringify({
              freshness: report.freshness,
              evidence: report.evidence,
              activation: report.activation,
              semantics: report.semantics,
              collection: report.collection,
              history: report.history,
            }, null, 2)}</pre>
          </details>
        )}
      </FinopsSheetBlock>

      <FinopsSheetBlock description="Named limitations that travel with the evidence." title="Limitations">
        <ul className={styles.gapList}>
          {(report?.limitations ?? []).map((limitation) => <li key={limitation}>{limitation}</li>)}
          {definition.disclosures.map((disclosure) => <li key={disclosure}>{disclosure}</li>)}
        </ul>
      </FinopsSheetBlock>
    </div>
  );
}

/**
 * Body for one sheet. With no accepted generation — the state of this runtime —
 * every sheet renders its own labelled unavailable state, and the sheet's
 * official visual and control counts stay visible through the shell's coverage
 * disclosure above it.
 */
function SheetBody({
  definition,
  report,
  sheet,
  sourceState,
}: {
  readonly definition: GcpCloudIntelligenceOfficialDefinition;
  readonly report: GcpCloudIntelligenceEnvelope | null;
  readonly sheet: FinopsSheetDescriptor;
  readonly sourceState: string;
}) {
  if (sheet.name === "About") {
    return <AboutSheet definition={definition} report={report} sourceState={sourceState} />;
  }
  if (report === null) {
    return (
      <div className={shell.blocks}>
        <FinopsSheetBlock
          description={SHEET_PURPOSE[sheet.name] ?? "Official sheet content."}
          title={`${sheet.name} — no GCP evidence`}
        >
          <Unavailable
            reason={`GCP provider connection is not implemented, so the ${sheet.visualCount} official ${sheet.visualCount === 1 ? "visual" : "visuals"} on this sheet have no evidence to render. Source state ${sourceState.replaceAll("_", " ")}. No AWS value, aggregate or estimate is substituted.`}
            title="Withheld: no accepted GCP billing generation"
          />
        </FinopsSheetBlock>
      </div>
    );
  }
  if (sheet.name === "Summary") return <SummarySheet report={report} />;
  if (sheet.name === "Kubernetes") return <KubernetesSheet report={report} />;
  return <ServiceSheet report={report} sheetName={sheet.name} />;
}

/* ------------------------------------------------------------------ *
 * Presentational component — renders from a response, never fetches
 * ------------------------------------------------------------------ */

export interface FinopsGcpCloudIntelligencePresentationProps {
  /** The parsed API body, either arm. Null means nothing was returned at all. */
  readonly response: GcpCloudIntelligenceResponse | null;
  readonly filters?: Filters;
  readonly onFiltersChange?: (filters: Filters) => void;
  readonly onSelectSource?: (sourceId: string) => void;
}

/**
 * The whole dashboard as a pure function of a response. Exported so tests and
 * server rendering can exercise every state without a network call.
 */
export function FinopsGcpCloudIntelligencePresentation({
  response,
  filters = {},
  onFiltersChange,
  onSelectSource,
}: FinopsGcpCloudIntelligencePresentationProps) {
  const definition = response?.officialDefinition ?? GCP_CLOUD_INTELLIGENCE_OFFICIAL_DEFINITION;
  const inventory = useMemo(() => gcpOfficialSheetInventory(definition), [definition]);
  const [activeSheet, setActiveSheet] = useState(inventory.sheets[0]?.key ?? "summary");

  const discovery = response !== null && isGcpDiscoveryResponse(response) ? response : null;
  const report = response !== null && !isGcpDiscoveryResponse(response) ? response : null;
  const sourceState = response?.sourceState ?? definition.nativeBinding.state;
  const activation = report?.activation ?? discovery?.activation;
  const sources = response?.sources ?? [];
  const sheet = inventory.sheets.find((candidate) => candidate.key === activeSheet)
    ?? inventory.sheets[0];

  const set = (key: keyof Filters, value: string) =>
    onFiltersChange?.({ ...filters, [key]: value === "" ? undefined : value });

  const toolbar: ReactNode = report === null ? undefined : (
    <div className={styles.filters}>
      <Select label="Invoice month" onChange={(value) => set("invoiceMonth", value)} options={report.filterOptions.invoiceMonths} value={filters.invoiceMonth} />
      <Select label="Project" onChange={(value) => set("projectId", value)} options={report.filterOptions.projects} value={filters.projectId} />
      <Select label="Service" onChange={(value) => set("service", value)} options={report.filterOptions.services} value={filters.service} />
      <Select label="SKU" onChange={(value) => set("sku", value)} options={report.filterOptions.skus} value={filters.sku} />
      <Select label="Region" onChange={(value) => set("region", value)} options={report.filterOptions.regions} value={filters.region} />
      <Select label="Currency" onChange={(value) => set("currency", value)} options={report.filterOptions.currencies} value={filters.currency} />
      <Select label="Label key" onChange={(value) => set("labelKey", value)} options={report.filterOptions.labelKeys} value={filters.labelKey} />
    </div>
  );

  return (
    <section className={styles.root} aria-label="Cloud Intelligence Dashboard for GCP">
      <div className={styles.hero}>
        <div>
          <span className={styles.eyebrow}>Google Cloud · Cloud Billing export · ADD-03</span>
          <h2>Cloud Intelligence Dashboard for GCP</h2>
          <p>
            The 7 sheets, 60 visuals and 54 control placements AWS publishes for the GCP Cost Dashboard,
            presented against the evidence Sutra actually holds — which, for GCP, is the pinned definition
            and nothing else.
          </p>
        </div>
        <div className={styles.badges}>
          <span>{definition.totals.sheets} official sheets</span>
          <span>{definition.totals.visuals} official visuals</span>
          <span>{report === null ? "No billing rows" : `${report.rowCount.toLocaleString()} billing rows`}</span>
        </div>
      </div>

      <GcpScopeDisclosure />

      <GcpProviderConnectionState activation={activation} definition={definition} sourceState={sourceState} />

      {sources.length === 0 ? null : (
        <section className={styles.selection} aria-label="Registered GCP billing sources">
          <h3>Registered GCP billing sources</h3>
          <p className={styles.note}>
            A registered source is a configuration record only. It does not imply a delivered export, an
            accepted generation or any billed amount.
          </p>
          <div className={styles.cards}>
            {sources.map((source) => (
              <button key={source.sourceId} onClick={() => onSelectSource?.(source.sourceId)} type="button">
                <strong>{source.billingAccountId}</strong>
                <span>{source.exportProjectId} · {source.location}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {report === null ? null : (
        <section className={styles.panel} aria-label="GCP export coverage gates">
          <h3>Coverage gates</h3>
          <div className={styles.coverage}>
            <span className={report.coverage.detailedUsageExport ? styles.ok : styles.missing}>Detailed usage export</span>
            <span className={report.coverage.pricingExport ? styles.ok : styles.missing}>Pricing export</span>
            <span className={report.coverage.gkeCostAllocation ? styles.ok : styles.missing}>GKE cost allocation</span>
            <span className={report.coverage.dataThroughAt === null ? styles.missing : styles.ok}>
              {report.coverage.dataThroughAt === null ? "No delivery" : `Data through ${report.coverage.dataThroughAt.slice(0, 10)}`}
            </span>
          </div>
        </section>
      )}

      {sheet === undefined ? null : (
        <FinopsSheetShell
          activeKey={sheet.key}
          idPrefix="gcp-cid"
          inventory={inventory}
          onSelectSheet={setActiveSheet}
          toolbar={toolbar}
        >
          <SheetBody definition={definition} report={report} sheet={sheet} sourceState={sourceState} />
        </FinopsSheetShell>
      )}

      <GcpUnavailablePanel definition={definition} />
    </section>
  );
}

/**
 * Preserved export: the report-bearing view. Now a thin adapter over the
 * presentational component so there is one rendering path, not two.
 */
export function FinopsGcpCloudIntelligenceReportView({
  report,
  filters,
  onFiltersChange,
}: {
  readonly report: GcpCloudIntelligenceEnvelope;
  readonly filters: Filters;
  readonly onFiltersChange: (filters: Filters) => void;
}) {
  return (
    <FinopsGcpCloudIntelligencePresentation
      filters={filters}
      onFiltersChange={onFiltersChange}
      response={report}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Data-loading component — the export the shared registry imports
 * ------------------------------------------------------------------ */

interface LoadState {
  readonly loading: boolean;
  readonly report: GcpCloudIntelligenceEnvelope | null;
  readonly discovery: GcpCloudIntelligenceDiscovery | null;
  readonly selection: readonly GcpSourceOption[];
  readonly error: string | null;
  readonly officialDefinition: GcpCloudIntelligenceOfficialDefinition;
}

/**
 * ADD-03 entry point. Signature is unchanged: an optional `initialSourceId`, so
 * the shared dashboard registry keeps calling it with no props.
 */
export function FinopsGcpCloudIntelligenceDashboard({
  initialSourceId = null,
}: {
  readonly initialSourceId?: string | null;
}) {
  const [filters, setFilters] = useState<Filters>({});
  const [sourceId, setSourceId] = useState<string | null>(initialSourceId);
  const [state, setState] = useState<LoadState>({
    loading: true,
    report: null,
    discovery: null,
    selection: [],
    error: null,
    officialDefinition: GCP_CLOUD_INTELLIGENCE_OFFICIAL_DEFINITION,
  });

  /**
   * The request is scheduled on the next frame rather than run in the effect
   * body, so no state is written synchronously during the effect and a rapid
   * filter change cannot cascade renders.
   */
  useEffect(() => {
    const controller = new AbortController();
    const parameters = new URLSearchParams();
    if (sourceId !== null) parameters.set("sourceId", sourceId);
    for (const [key, value] of Object.entries(filters)) if (value) parameters.set(key, value);

    const frame = window.requestAnimationFrame(() => {
      setState((current) => ({ ...current, loading: true, error: null }));
      void fetch(`/api/v1/finops/gcp-cloud-intelligence?${parameters}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("GCP Cloud Intelligence request failed");
          return response.json() as Promise<unknown>;
        })
        .then((body) => {
          if (!hasPinnedOfficialDefinition(body)) throw new Error("GCP official definition was not recognized");
          if ("dashboard" in body && body.dashboard === null) {
            const discovery = body as unknown as GcpCloudIntelligenceDiscovery;
            setState({
              loading: false,
              report: null,
              discovery,
              selection: discovery.selectionRequired ? discovery.sources : [],
              error: null,
              officialDefinition: body.officialDefinition,
            });
            return;
          }
          setState({
            loading: false,
            report: body as unknown as GcpCloudIntelligenceEnvelope,
            discovery: null,
            selection: [],
            error: null,
            officialDefinition: body.officialDefinition,
          });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setState((current) => ({
            ...current,
            loading: false,
            report: null,
            discovery: null,
            selection: [],
            error: error instanceof Error ? error.message : "GCP Cloud Intelligence request failed",
          }));
        });
    });

    return () => {
      window.cancelAnimationFrame(frame);
      controller.abort();
    };
  }, [sourceId, filters]);

  const official=<GcpCloudIntelligenceOfficialDefinitionPanel definition={state.officialDefinition}/>;

  // Transport failure. The pinned definition still renders; nothing is guessed.
  if (state.error !== null) {
    return (
      <div className={styles.root}>
        {official}
        <div className={styles.error} role="alert">{state.error}</div>
      </div>
    );
  }

  // In flight.
  if (state.loading) {
    return (
      <div className={styles.root}>
        {official}
        <div className={styles.loading} role="status">Reading GCP billing evidence…</div>
      </div>
    );
  }

  // More than one registered source and none selected.
  if (state.selection.length > 0) {
    return (
      <div className={styles.root}>
        {official}
        <FinopsGcpCloudIntelligencePresentation onSelectSource={setSourceId} response={state.discovery} />
      </div>
    );
  }

  // The state of this runtime: no source, or a source with no accepted
  // generation. PARTIAL_PIPELINE — locally complete presentation only.
  if (state.report === null || (sourceId !== null && state.report.sourceId !== sourceId)) {
    return (
      <div className={styles.root}>
        {official}
        <FinopsGcpCloudIntelligencePresentation onSelectSource={setSourceId} response={state.discovery} />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {official}
      <FinopsGcpCloudIntelligencePresentation
        filters={filters}
        onFiltersChange={setFilters}
        onSelectSource={setSourceId}
        response={state.report}
      />
    </div>
  );
}

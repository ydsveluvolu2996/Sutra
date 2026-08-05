"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { BarChart, RankingBars, TimeSeriesChart } from "../components/charts";
import {
  EndpointBoundary,
  StateBadge,
  formatBasisPoints,
  type EndpointState,
} from "./finops-foundational-panels";
import {
  FinopsSheetBlock,
  FinopsSheetShell,
  foundationalStyles as shell,
} from "./finops-foundational-sheet-shell";
import { sheetKey, type FinopsSheetDescriptor, type FinopsSheetInventory } from "./finops-foundational-sheets";
import { formatCount, microsToUnits } from "./finops-foundational-money";
import { SUSTAINABILITY_OFFICIAL_DEFINITION } from "../../lib/finops-sustainability-official-definition";
import type { buildSustainabilityDashboard } from "../../lib/finops-sustainability-dashboard";
import type {
  SustainabilityProxyDimensions,
  SustainabilityProxyMetric,
} from "../../lib/finops-sustainability-carbon";
import styles from "./finops-sustainability-carbon-dashboard.module.css";

/**
 * ADD-08 Sustainability Proxy Metrics and Carbon Emissions, presented as the six
 * sheets the pinned AWS CID definition publishes rather than as one flat page.
 *
 * The governing rule of this vertical is that it carries two different kinds of
 * evidence which are never reconciled with each other:
 *
 * 1. Sutra CUR2-derived **proxy estimates** — normalized technical resource-use
 *    quantities (vCPU-hours, GB-hours, GB-seconds, GB, requests) computed from
 *    the active billing generation. They are not energy and not emissions.
 * 2. AWS **provider-reported carbon** — MTCO2e published by the AWS
 *    CARBON_EMISSIONS data export under two mutually exclusive accounting
 *    methods: location-based (LBM) and market-based (MBM).
 *
 * Nothing here sums, averages, ratios or co-plots those two channels as one
 * series, and every figure states which channel it came from and in which unit.
 * LBM and MBM are likewise never added: they are alternative methods for the
 * same footprint, so they are drawn as separate labelled series.
 *
 * Quantities arrive as integer micro-unit decimal strings. Exact figures are
 * printed by `formatMicroQuantityExact`, which stays in BigInt and never
 * converts to a number; charts call `microsToUnits` only to obtain geometry, and
 * a value too large to convert exactly is dropped rather than rounded. Shares are
 * exact BigInt basis points rendered through `formatBasisPoints`; where a share
 * cannot be formed the percentage is withheld with its reason instead of being
 * estimated. `formatMicrosExact` is deliberately not used: it is currency-gated
 * by design and this vertical publishes no monetary field at all.
 */

const INTEGER_MICROS = /^-?(?:0|[1-9]\d*)$/u;

/** The label that must accompany every Sutra-derived resource-use figure. */
const PROXY_CHANNEL = "Sutra CUR2-derived proxy estimate";
/** The label that must accompany every AWS-published emissions figure. */
const CARBON_CHANNEL = "AWS provider-reported carbon";

type BuiltSustainabilityDashboard = ReturnType<typeof buildSustainabilityDashboard>;

/** One immutable stored generation, exactly as the route returns it. */
export interface SustainabilitySnapshotHistoryItem {
  readonly generationId: string;
  readonly sourceCaptureId: string;
  readonly sourceState: string;
  readonly proxyState: string;
  readonly carbonState: string;
  readonly completedAtIso: string;
  readonly proxyRowCount: number;
  readonly carbonRowCount: number;
  readonly contentSha256: string;
}

/** Server-validated query parameters of `/api/v1/finops/sustainability-carbon`. */
export interface SustainabilityFilters {
  readonly accountId?: string;
  readonly region?: string;
  readonly service?: string;
  readonly workloadTagValue?: string;
  readonly proxyMetric?: string;
  readonly carbonModelVersion?: string;
  readonly carbonProductCode?: string;
}

/**
 * The dashboard envelope. Every member is a field the route actually emits: the
 * canonical projection spread in full, plus the transport-level evidence the
 * route adds around it.
 */
export interface SustainabilityDashboardEnvelope extends BuiltSustainabilityDashboard {
  readonly connectionId: string;
  readonly sourceState:
    | "complete" | "partial" | "stale" | "empty" | "failed" | "configuration_required";
  readonly runtimeState: "ready" | "unavailable" | "failed" | "collecting";
  readonly history: readonly SustainabilitySnapshotHistoryItem[];
  readonly filterOptions: {
    readonly accounts: readonly string[];
    readonly regions: readonly string[];
    readonly services: readonly string[];
    readonly workloadTags: readonly string[];
    readonly proxyMetrics: readonly string[];
    readonly carbonModels: readonly string[];
    readonly carbonProducts: readonly string[];
  };
  readonly freshness: {
    readonly proxy: {
      readonly dataThroughAt: string | null;
      readonly ageHours: number | null;
      readonly staleAfterHours: number;
    };
    readonly providerCarbon: {
      readonly publishedAt: string | null;
      readonly ageHours: number | null;
      readonly staleAfterHours: number;
    };
  };
  readonly evidence: {
    readonly generationId: string;
    readonly activeGenerationId: string | null;
    readonly latestGenerationId: string | null;
    readonly sourceCaptureId: string;
    readonly contentSha256: string;
    readonly newerIncomplete: boolean;
  };
  readonly collection: {
    readonly state: string;
    readonly jobContractAvailable: boolean;
    readonly providerAdapterAvailable: boolean;
    readonly registeredInSharedRuntime: boolean;
    readonly reason: string;
  };
  readonly disclosures: readonly string[];
}

/** The route's alternative envelope: nothing is materialized yet. */
interface SustainabilityConfigurationEnvelope {
  readonly dashboard: null;
  readonly sourceState: "configuration_required";
  readonly collection: SustainabilityDashboardEnvelope["collection"];
  readonly officialDefinition: typeof SUSTAINABILITY_OFFICIAL_DEFINITION;
}

type ProxyRow = BuiltSustainabilityDashboard["proxy"]["series"][number];
type CarbonRow = BuiltSustainabilityDashboard["providerCarbon"]["series"][number];

/* ------------------------------------------------------------------------- *
 * Exact arithmetic and formatting
 * ------------------------------------------------------------------------- */

/**
 * Exact micro-unit quantity with its unit always attached. Never converts to a
 * number, so a value of any magnitude prints every one of its six decimals.
 * A null or malformed value is an explicit unavailable state, never a zero.
 */
export function formatMicroQuantityExact(
  micros: string | null | undefined,
  unit: string,
): string {
  if (typeof micros !== "string" || !INTEGER_MICROS.test(micros)) return "Not available";
  const amount = BigInt(micros);
  const negative = amount < BigInt(0);
  const absolute = negative ? -amount : amount;
  const whole = (absolute / BigInt(1_000_000)).toString()
    .replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const raw = (absolute % BigInt(1_000_000)).toString().padStart(6, "0");
  const significant = raw.replace(/0+$/u, "");
  const fraction = significant.length < 2 ? significant.padEnd(2, "0") : significant;
  return `${negative ? "−" : ""}${whole}.${fraction} ${unit}`;
}

/** Sum of present micro values, or null when no value was collected at all. */
function sumMicros(values: readonly (string | null | undefined)[]): string | null {
  const present = values.filter(
    (value): value is string => typeof value === "string" && INTEGER_MICROS.test(value),
  );
  return present.length === 0
    ? null
    : present.reduce((total, value) => total + BigInt(value), BigInt(0)).toString();
}

/** Exact integer basis points of `part` within `total`, or null when withheld. */
function shareBasisPoints(part: string | null, total: string | null): string | null {
  if (part === null || total === null) return null;
  if (!INTEGER_MICROS.test(part) || !INTEGER_MICROS.test(total)) return null;
  const denominator = BigInt(total);
  if (denominator <= BigInt(0)) return null;
  return ((BigInt(part) * BigInt(10_000)) / denominator).toString();
}

/** Axis and tooltip formatter for a converted quantity, unit always shown. */
function formatQuantity(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "Not available";
  const magnitude = Math.abs(value);
  const fractionDigits = magnitude >= 1_000 ? 0 : magnitude >= 1 ? 2 : 6;
  const formatted = new Intl.NumberFormat("en-US", { maximumFractionDigits: fractionDigits })
    .format(value)
    .replace("-", "−");
  return `${formatted} ${unit}`;
}

function readable(token: string): string {
  return token.replace(/_/gu, " ");
}

function groupRows<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
): readonly (readonly [string, readonly T[]])[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [row]); else bucket.push(row);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

/* ------------------------------------------------------------------------- *
 * The pinned official sheet inventory
 * ------------------------------------------------------------------------- */

/**
 * Audited gap for each official sheet: the dimensions the AWS sheet draws that
 * Sutra cannot deliver from the evidence it holds. They travel with the sheet so
 * a rendered sheet never implies coverage it does not have.
 */
const SHEET_GAPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "regional-footprint": Object.freeze([
    "Regional renewable-energy mix and the footprint map are unavailable: no pinned regional reference delivers a renewable classification or Region coordinates.",
    "Region proxies are shown per metric only; quantities in different units are never combined into one regional total.",
  ]),
  "compute-proxies": Object.freeze([
    "Processor architecture and EC2 instance family are unavailable: CUR2 carries no versioned classifier for either, and neither is inferred from usage types.",
  ]),
  "storage-proxies": Object.freeze([
    "EBS volume type and S3 storage class are unavailable: no versioned storage-class classifier is delivered with the proxy rows.",
  ]),
  "data-transfer-networking-proxies": Object.freeze([
    "Data-transfer path classification is unavailable: intra-Region, inter-Region and internet paths are not separable without a versioned path classifier.",
    "Idle NAT Gateway and Elastic Load Balancer evidence is unavailable: idleness is a resource observation the billing evidence does not contain.",
  ]),
  "carbon-emissions": Object.freeze([
    "Provider carbon is published per payer account, Region, product code and model version only. It is never allocated to workload tags, resources or proxy quantities.",
  ]),
  about: Object.freeze([
    "Native sheets mirror the pinned definition structure and counts; they do not claim pixel or interaction parity with QuickSight.",
  ]),
});

/**
 * The six official sheets, derived from the hash-pinned definition so this view
 * can neither invent nor omit a sheet. Only `EVIDENCE_BACKED` normalizes to
 * fully covered: every other classification, including any future one, falls
 * towards disclosure.
 */
export const FINOPS_SUSTAINABILITY_SHEETS: FinopsSheetInventory = Object.freeze({
  sheets: Object.freeze(SUSTAINABILITY_OFFICIAL_DEFINITION.sheets.map((sheet) => {
    const key = sheetKey(sheet.name);
    return Object.freeze({
      key,
      name: sheet.name,
      visualCount: sheet.visualCount,
      controlCount: sheet.controlCount,
      support: sheet.coverage === "EVIDENCE_BACKED" ? ("SUPPORTED" as const) : ("PARTIAL" as const),
      supportLabel: sheet.coverage,
      gaps: SHEET_GAPS[key] ?? Object.freeze([]),
      formulaIds: Object.freeze([]),
    });
  })),
  totalSheets: SUSTAINABILITY_OFFICIAL_DEFINITION.sheetCount,
  totalVisuals: SUSTAINABILITY_OFFICIAL_DEFINITION.visualCount,
  totalControls: SUSTAINABILITY_OFFICIAL_DEFINITION.controlCount,
  supportedSheets: SUSTAINABILITY_OFFICIAL_DEFINITION.sheets
    .filter((sheet) => sheet.coverage === "EVIDENCE_BACKED").length,
  partialSheets: SUSTAINABILITY_OFFICIAL_DEFINITION.sheets
    .filter((sheet) => sheet.coverage !== "EVIDENCE_BACKED").length,
  source: Object.freeze({
    repository: "aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: SUSTAINABILITY_OFFICIAL_DEFINITION.commit,
    path: SUSTAINABILITY_OFFICIAL_DEFINITION.path,
    sha256: SUSTAINABILITY_OFFICIAL_DEFINITION.artifactSha256,
    version: SUSTAINABILITY_OFFICIAL_DEFINITION.dimensionContractVersion,
  }),
});

const METRIC_LABEL: Readonly<Record<SustainabilityProxyMetric, string>> = Object.freeze({
  COMPUTE_VCPU_HOURS: "Compute vCPU-hours",
  COMPUTE_MEMORY_GB_HOURS: "Compute memory GB-hours",
  LAMBDA_GB_SECONDS: "Lambda GB-seconds",
  STORAGE_GB_HOURS: "Storage GB-hours",
  STORAGE_REQUESTS: "Storage requests",
  DATA_TRANSFER_GB: "Data transfer GB",
  DATABASE_VCPU_HOURS: "Database vCPU-hours",
});

/** Which official proxy metrics belong to which official proxy sheet. */
const SHEET_METRICS: Readonly<Record<string, readonly SustainabilityProxyMetric[]>> = Object.freeze({
  "compute-proxies": Object.freeze([
    "COMPUTE_VCPU_HOURS", "COMPUTE_MEMORY_GB_HOURS", "LAMBDA_GB_SECONDS", "DATABASE_VCPU_HOURS",
  ] as const),
  "storage-proxies": Object.freeze(["STORAGE_GB_HOURS", "STORAGE_REQUESTS"] as const),
  "data-transfer-networking-proxies": Object.freeze(["DATA_TRANSFER_GB"] as const),
});

/**
 * Dimensions the official AWS sheets slice by that this vertical cannot deliver.
 * Each names the proxy-dimension evidence fields that would have to arrive, with
 * a pinned source and version, before the slice could be drawn.
 */
const UNAVAILABLE_DIMENSIONS: readonly {
  readonly id: string;
  readonly title: string;
  readonly sheetKeys: readonly string[];
  readonly evidenceKeys: readonly (keyof SustainabilityProxyDimensions)[];
  readonly reason: string;
}[] = Object.freeze([
  {
    id: "regional-renewable-mix",
    title: "Regional renewable-energy mix and footprint map",
    sheetKeys: ["regional-footprint"],
    evidenceKeys: ["renewableEnergyClass", "regionLatitudeE6", "regionLongitudeE6"],
    reason: "A renewable classification and Region coordinates require the pinned regional reference. Neither is inferred from a Region code, so the map and the renewable mix stay unavailable pending versioned evidence.",
  },
  {
    id: "processor-family",
    title: "Processor architecture and EC2 instance family",
    sheetKeys: ["compute-proxies"],
    evidenceKeys: ["processorArchitecture", "instanceFamily"],
    reason: "Processor family and instance family require an exact CUR2 or provider classifier with a pinned version. Parsing them out of usage-type strings would be a guess, so both stay unavailable pending versioned evidence.",
  },
  {
    id: "storage-class",
    title: "EBS volume type and S3 storage class",
    sheetKeys: ["storage-proxies"],
    evidenceKeys: ["storageClass"],
    reason: "Storage class requires a versioned classifier delivered with the proxy row. It stays unavailable pending versioned evidence, so storage quantities are not split by class.",
  },
  {
    id: "transfer-path",
    title: "Data-transfer path classification",
    sheetKeys: ["data-transfer-networking-proxies"],
    evidenceKeys: ["transferPath"],
    reason: "Separating intra-Region, inter-Region and internet transfer requires a versioned path classifier. It stays unavailable pending versioned evidence, so transfer GB remains a single undifferentiated proxy quantity.",
  },
  {
    id: "idle-network",
    title: "Idle NAT Gateway and Elastic Load Balancer evidence",
    sheetKeys: ["data-transfer-networking-proxies"],
    evidenceKeys: ["idleNetworkResource"],
    reason: "Idleness is a resource observation, not a billing fact. No idle-resource evidence is delivered, so idle network resources stay unavailable pending versioned evidence and are never reported as none.",
  },
]);

const DIMENSION_LABEL: Readonly<Record<keyof SustainabilityProxyDimensions, string>> = Object.freeze({
  processorArchitecture: "Processor architecture",
  instanceFamily: "EC2 instance family",
  storageClass: "EBS / S3 storage class",
  transferPath: "Data-transfer path",
  idleNetworkResource: "Idle NAT / ELB evidence",
  regionLatitudeE6: "Region latitude (e6)",
  regionLongitudeE6: "Region longitude (e6)",
  renewableEnergyClass: "Renewable-energy classification",
});

/* ------------------------------------------------------------------------- *
 * Small presentational primitives
 * ------------------------------------------------------------------------- */

/** The provenance label that must sit beside every figure in this vertical. */
function ChannelTag({ channel }: { readonly channel: "proxy" | "carbon" }) {
  return (
    <span
      className={`${styles.channelTag} ${channel === "proxy" ? styles.channelProxy : styles.channelCarbon}`}
    >
      {channel === "proxy" ? PROXY_CHANNEL : CARBON_CHANNEL}
    </span>
  );
}

function Tile({
  label, value, detail, channel,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly channel?: "proxy" | "carbon";
}) {
  return (
    <div className={shell.tile}>
      {channel === undefined ? null : <ChannelTag channel={channel} />}
      <span className={shell.tileLabel}>{label}</span>
      <span className={shell.tileValue}>{value}</span>
      {detail === undefined ? null : <span className={shell.tileDetail}>{detail}</span>}
    </div>
  );
}

function NoEvidence({ reason }: { readonly reason: string }) {
  return (
    <div className={shell.coverage} data-support="PARTIAL" role="status">
      <div className={shell.coverageHead}>
        <strong>No evidence for this view in the active generation</strong>
      </div>
      <ul className={shell.coverageGaps}><li>{reason}</li></ul>
    </div>
  );
}

/**
 * An official dimension this vertical does not deliver. The dimension evidence
 * that would unlock it is reported from the proxy rows themselves, so a future
 * versioned delivery flips the state rather than the copy.
 */
function UnavailableDimensionPanel({
  entry, series,
}: {
  readonly entry: (typeof UNAVAILABLE_DIMENSIONS)[number];
  readonly series: readonly ProxyRow[];
}) {
  const evidence = entry.evidenceKeys.map((key) => {
    const present = series.flatMap((row) => {
      const dimension = row.dimensions?.[key];
      return dimension === undefined ? [] : [dimension];
    });
    const ready = present.filter((value) => value.state === "ready" && value.value !== null);
    return {
      key,
      readyCount: ready.length,
      totalCount: series.length,
      values: [...new Set(ready.map((value) => value.value as string))].sort(),
      sources: [...new Set(ready.map((value) =>
        `${value.sourceField ?? "no source field"} @ ${value.sourceVersion ?? "no version"}`))].sort(),
    };
  });
  const anyReady = evidence.some((value) => value.readyCount > 0);

  return (
    <section
      aria-label={`${entry.title} availability`}
      className={styles.unavailable}
      data-state={anyReady ? "PARTIAL" : "UNAVAILABLE"}
      role="note"
    >
      <div className={styles.unavailableHead}>
        <strong>{entry.title}</strong>
        <StateBadge state={anyReady ? "partial" : "unavailable"} />
      </div>
      <p>
        {anyReady
          ? "Some rows now carry pinned evidence for this dimension. Rows without it stay unavailable and are not back-filled."
          : "Unavailable pending versioned evidence."}
        {" "}{entry.reason}
      </p>
      <div className={shell.tableWrap}>
        <table className={shell.table}>
          <caption>
            Evidence required before this official slice can be drawn. A missing dimension is
            unavailable, never an empty category and never zero.
          </caption>
          <thead>
            <tr>
              <th scope="col">Dimension</th>
              <th scope="col">State</th>
              <th className={shell.numeric} scope="col">Rows with evidence</th>
              <th scope="col">Evidence-backed values</th>
              <th scope="col">Pinned source and version</th>
            </tr>
          </thead>
          <tbody>
            {evidence.map((value) => (
              <tr key={value.key}>
                <th scope="row">{DIMENSION_LABEL[value.key]}</th>
                <td><StateBadge state={value.readyCount > 0 ? "partial" : "unavailable"} /></td>
                <td className={shell.numeric}>
                  {formatCount(value.readyCount)} / {formatCount(value.totalCount)}
                </td>
                <td>
                  {value.values.length === 0
                    ? "Unavailable — not inferred"
                    : value.values.join(", ")}
                </td>
                <td>
                  {value.sources.length === 0
                    ? "No pinned source or version delivered"
                    : value.sources.join("; ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Latest trend row per proxy metric, by usage period. */
function latestProxyTrendByMetric(report: SustainabilityDashboardEnvelope) {
  return groupRows(report.proxy.trends, (trend) => trend.metric)
    .map(([metric, rows]) => ({
      metric: metric as SustainabilityProxyMetric,
      row: rows.slice().sort((left, right) =>
        left.usagePeriod.localeCompare(right.usagePeriod))[rows.length - 1],
    }));
}

/**
 * The standing cross-channel band, above the six sheet tabs and never dismissed.
 *
 * It carries the separation statement plus the latest figure of each channel, so
 * the two kinds of evidence are declared before any sheet is read and neither can
 * be seen without the other's boundary. Figures here repeat what the Compute,
 * Carbon Emissions and About sheets show in full; the repetition is deliberate,
 * because the separation rule has to be visible on every sheet, not only on the
 * sheet that happens to be open.
 */
function ChannelSeparationNotice({ report }: { readonly report: SustainabilityDashboardEnvelope }) {
  const definition = report.officialDefinition;
  const proxyLatest = latestProxyTrendByMetric(report);
  const carbonTrends = report.providerCarbon.trends.slice()
    .sort((left, right) => left.usagePeriod.localeCompare(right.usagePeriod));
  const carbonLatest = carbonTrends.length === 0 ? null : carbonTrends[carbonTrends.length - 1];
  const targets = report.proxy.targets;

  return (
    <section aria-label="Both channels at a glance" className={styles.separation}>
      <p className={styles.summaryNotice}>
        <strong>Two separate evidence channels.</strong> Resource-use proxy metrics are not carbon
        emissions, and AWS provider carbon estimates are not attributed to workload tags, resources
        or proxy quantities.
      </p>
      <p className={styles.separationRule}>
        Official definition coverage · {definition.sheetCount} sheets / {definition.visualCount}{" "}
        visuals / {definition.controlCount} controls · pinned {definition.commit.slice(0, 12)}
      </p>

      <div className={styles.separationChannels}>
        <article className={`${styles.separationChannel} ${styles.channelProxy}`}>
          <ChannelTag channel="proxy" />
          <h4>Resource-use proxy trends</h4>
          {proxyLatest.length === 0 ? (
            <p>
              No CUR2 proxy quantity is available for the current scope. Unavailable evidence, not
              zero resource use.
            </p>
          ) : (
            <ul className={shell.coverageGaps}>
              {proxyLatest.map((entry) => (
                <li key={entry.metric}>
                  {METRIC_LABEL[entry.metric]} · {entry.row.usagePeriod} ·{" "}
                  {formatMicroQuantityExact(entry.row.valueMicros, entry.row.unit)}
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className={`${styles.separationChannel} ${styles.channelCarbon}`}>
          <ChannelTag channel="carbon" />
          <h4>AWS provider carbon-emissions trends</h4>
          {carbonLatest === null ? (
            <p>
              No AWS CARBON_EMISSIONS row is available for the current scope. Unavailable or
              collecting evidence, never zero emissions.
            </p>
          ) : (
            <ul className={shell.coverageGaps}>
              <li>
                {carbonLatest.usagePeriod} · model {carbonLatest.modelVersion} · location-based
                method (LBM) total{" "}
                {carbonLatest.totalLbmMicroMtco2e === null
                  ? "not published"
                  : formatMicroQuantityExact(carbonLatest.totalLbmMicroMtco2e, carbonLatest.unit)}
              </li>
              <li>
                {carbonLatest.usagePeriod} · market-based method (MBM) total{" "}
                {carbonLatest.totalMbmMicroMtco2e === null
                  ? "not published"
                  : formatMicroQuantityExact(carbonLatest.totalMbmMicroMtco2e, carbonLatest.unit)}
              </li>
              <li>
                Provider carbon scopes ({carbonLatest.usagePeriod}) · scope 1{" "}
                {formatMicroQuantityExact(carbonLatest.scope1MicroMtco2e, carbonLatest.unit)} · scope
                2 LBM {formatMicroQuantityExact(carbonLatest.scope2LbmMicroMtco2e, carbonLatest.unit)}{" "}
                · scope 2 MBM{" "}
                {formatMicroQuantityExact(carbonLatest.scope2MbmMicroMtco2e, carbonLatest.unit)} ·
                scope 3 LBM{" "}
                {formatMicroQuantityExact(carbonLatest.scope3LbmMicroMtco2e, carbonLatest.unit)} ·
                scope 3 MBM{" "}
                {formatMicroQuantityExact(carbonLatest.scope3MbmMicroMtco2e, carbonLatest.unit)}
              </li>
            </ul>
          )}
        </article>
      </div>

      <div className={styles.separationChannels}>
        <article className={styles.separationChannel}>
          <h4>Governed technical proxy targets</h4>
          {targets.workloadTagGoals.length === 0 ? (
            <p>
              Target not configured for any workload in scope. A missing target is not treated as
              achieved.
            </p>
          ) : (
            <ul className={shell.coverageGaps}>
              {targets.configured
                ? targets.workloadTagGoals.map((goal) => (
                  <li key={goal.targetId}>
                    {goal.workloadTagValue ?? "All workloads in scope"} ·{" "}
                    {METRIC_LABEL[goal.metric]} · target{" "}
                    {formatMicroQuantityExact(goal.targetValueMicros, goal.unit)} ·{" "}
                    {readable(goal.state.toLowerCase())}
                  </li>
                ))
                : targets.workloadTagGoals.map((goal) => (
                  <li key={goal.workloadTagValue ?? "all-workloads"}>
                    {goal.workloadTagValue ?? "All workloads in scope"} · Target not configured
                  </li>
                ))}
            </ul>
          )}
          <p>Targets govern technical resource use only and are never carbon targets.</p>
        </article>

        <article className={styles.separationChannel}>
          <h4>Technical resource plans</h4>
          {report.proxy.technicalPlans.length === 0 ? (
            <p>No period-over-period movement can be formed from the available proxy evidence.</p>
          ) : (
            <ul className={shell.coverageGaps}>
              {report.proxy.technicalPlans.map((plan) => (
                <li key={plan.metric}>
                  {METRIC_LABEL[plan.metric]} · {readable(plan.direction.toLowerCase())} ·{" "}
                  {plan.latestPeriod}
                </li>
              ))}
            </ul>
          )}
          <p>A technical resource plan is not a carbon reduction claim.</p>
        </article>
      </div>

      <details className={styles.provenance}>
        <summary>Provenance, separation, and limitations</summary>
        <ul className={shell.coverageGaps}>
          <li>
            Proxy generation {report.lineage.proxyGenerationId ?? "not delivered"} · manifest{" "}
            {report.lineage.proxyManifestSha256 ?? "not delivered"} · data through{" "}
            {report.lineage.proxyDataThroughAtIso ?? "not delivered"}
          </li>
          <li>
            Carbon export {report.lineage.carbonExportArn ?? "not delivered"} · generation{" "}
            {report.lineage.carbonGenerationId ?? "not delivered"} · published{" "}
            {report.lineage.carbonPublishedAtIso ?? "not published"} ·{" "}
            {report.lineage.carbonPublicationKind === null
              ? "publication kind not published"
              : readable(report.lineage.carbonPublicationKind)}
          </li>
          <li>
            Carbon model versions:{" "}
            {report.lineage.carbonModelVersions.length === 0
              ? "none published"
              : report.lineage.carbonModelVersions.join(", ")}
          </li>
          <li>Collection: {readable(report.collection.reason)}</li>
          {report.limitations.map((limitation) => <li key={limitation}>{readable(limitation)}</li>)}
          {report.disclosures.map((disclosure) => <li key={disclosure}>{disclosure}</li>)}
        </ul>
      </details>

      <div className={styles.separationChannels}>
        <article className={`${styles.separationChannel} ${styles.channelProxy}`}>
          <ChannelTag channel="proxy" />
          <p>
            Normalized technical resource use in vCPU-hours, GB-hours, GB-seconds, GB and requests.
            Interpretation: {readable(report.proxy.interpretation)}. These quantities are not energy
            and not emissions.
          </p>
        </article>
        <article className={`${styles.separationChannel} ${styles.channelCarbon}`}>
          <ChannelTag channel="carbon" />
          <p>
            MTCO2e published by the AWS CARBON_EMISSIONS export. Interpretation:{" "}
            {readable(report.providerCarbon.interpretation)}. These values are not attributed to
            workload tags, resources or proxy quantities.
          </p>
        </article>
      </div>
      <p className={styles.separationRule}>
        Proxy estimates converted to carbon:{" "}
        <b>{report.separation.proxyConvertedToCarbon ? "yes" : "never"}</b>
        {" · "}Provider carbon allocated to workloads:{" "}
        <b>{report.separation.carbonAllocatedToWorkloads ? "yes" : "never"}</b>
        {" · "}The two channels{" "}
        {report.separation.seriesMayBeComparedVisuallyButNotMathematicallyCombined
          ? "may be compared visually but are never mathematically combined"
          : "are not comparable"}.
      </p>
    </section>
  );
}

function SourceStateNotice({ report }: { readonly report: SustainabilityDashboardEnvelope }) {
  const message = report.sourceState === "complete"
    ? null
    : report.sourceState === "partial"
      ? "One or both evidence channels are partial. The accepted complete head is retained while the newer attempt remains audit history."
      : report.sourceState === "stale"
        ? "Proxy or provider-carbon evidence is outside its own independent freshness objective. The two objectives are never averaged."
        : report.sourceState === "empty"
          ? "Complete empty evidence is not a zero-usage and not a zero-emissions claim."
          : report.sourceState === "configuration_required"
            ? "CUR2 proxy materialization and the version-pinned AWS CARBON_EMISSIONS export are not fully configured."
            : "The latest materialization failed and cannot replace accepted evidence.";
  if (message === null) return null;
  return (
    <div
      className={`${styles.state} ${report.sourceState === "failed" ? styles.error : styles.warning}`}
      role={report.sourceState === "failed" ? "alert" : "status"}
    >
      <StateBadge state={report.sourceState} /> {message}
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * Sheet 1 — Regional Footprint
 * ------------------------------------------------------------------------- */

function RegionalFootprintSheet({ report }: { readonly report: SustainabilityDashboardEnvelope }) {
  const proxyByMetric = groupRows(report.proxy.series, (row) => `${row.metric}|${row.unit}`);
  const carbonRegions = groupRows(report.providerCarbon.series, (row) => row.regionCode ?? "");

  return (
    <div className={shell.blocks}>
      <FinopsSheetBlock
        description="Regional resource use, one chart per official proxy metric. Quantities in different units are never added into a single regional total."
        title={`Region proxies — ${PROXY_CHANNEL}`}
      >
        {proxyByMetric.length === 0 ? (
          <NoEvidence reason="The active generation carries no CUR2 proxy row, so no Region can be ranked. That is an absence of evidence, not zero resource use." />
        ) : proxyByMetric.map(([key, rows]) => {
          const metric = rows[0].metric;
          const unit = rows[0].unit;
          const regions = groupRows(rows, (row) => row.region ?? "");
          const total = sumMicros(rows.map((row) => row.valueMicros));
          return (
            <div key={key}>
              <ChannelTag channel="proxy" />
              <RankingBars
                ariaLabel={`${METRIC_LABEL[metric]} by Region in ${unit} — ${PROXY_CHANNEL}`}
                caption={`${METRIC_LABEL[metric]} in ${unit}. A proxy estimate of resource use, not emissions.`}
                formatValue={(value) => formatQuantity(value, unit)}
                items={regions.flatMap(([region, regionRows]) => {
                  const micros = sumMicros(regionRows.map((row) => row.valueMicros));
                  const units = microsToUnits(micros);
                  const share = shareBasisPoints(micros, total);
                  return units === null ? [] : [{
                    id: `${key}:${region === "" ? "unattributed" : region}`,
                    label: region === "" ? "Region not supplied by the source row" : region,
                    value: units,
                    detail: share === null
                      ? `${formatCount(regionRows.length)} rows · share withheld: no positive metric total to divide by`
                      : `${formatBasisPoints(share)} of ${unit} · ${formatCount(regionRows.length)} rows`,
                    tone: "teal" as const,
                  }];
                })}
                sort
              />
              <p className={shell.goalMeta}>
                Exact metric total: {formatMicroQuantityExact(total, unit)} ({PROXY_CHANNEL}).
              </p>
            </div>
          );
        })}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Provider-published MTCO2e by Region code. Location-based and market-based methods are drawn separately and are never added together."
        title={`Region carbon — ${CARBON_CHANNEL}`}
      >
        {carbonRegions.length === 0 ? (
          <NoEvidence reason="No AWS CARBON_EMISSIONS row is present for the selected filters, so provider carbon by Region is unavailable rather than zero." />
        ) : (
          <>
            <ChannelTag channel="carbon" />
            {(["Lbm", "Mbm"] as const).map((method) => {
              const label = method === "Lbm"
                ? "location-based method (LBM)"
                : "market-based method (MBM)";
              const items = carbonRegions.flatMap(([region, rows]) => {
                const micros = sumMicros(rows.map((row) =>
                  method === "Lbm" ? row.totalLbmMicroMtco2e : row.totalMbmMicroMtco2e));
                const units = microsToUnits(micros);
                return units === null ? [] : [{
                  id: `${method}:${region === "" ? "unattributed" : region}`,
                  label: region === "" ? "Region code not published" : region,
                  value: units,
                  detail: `${formatMicroQuantityExact(micros, "MTCO2e")} · ${formatCount(rows.length)} rows`,
                  tone: method === "Lbm" ? ("violet" as const) : ("amber" as const),
                }];
              });
              return items.length === 0 ? (
                <p className={shell.goalMeta} key={method}>
                  No Region publishes a total under the {label}. The method total is not published
                  for these rows and is withheld rather than shown as zero.
                </p>
              ) : (
                <RankingBars
                  ariaLabel={`Provider-reported carbon by Region in MTCO2e under the ${label}`}
                  caption={`Provider-reported MTCO2e under the ${label}. Never added to the other method and never derived from a proxy estimate.`}
                  formatValue={(value) => formatQuantity(value, "MTCO2e")}
                  items={items}
                  key={method}
                  sort
                />
              );
            })}
          </>
        )}
      </FinopsSheetBlock>

      {UNAVAILABLE_DIMENSIONS
        .filter((entry) => entry.sheetKeys.includes("regional-footprint"))
        .map((entry) => (
          <UnavailableDimensionPanel entry={entry} key={entry.id} series={report.proxy.series} />
        ))}
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * Sheets 2-4 — proxy metric sheets
 * ------------------------------------------------------------------------- */

function ProxyMetricSheet({
  report, sheet, metrics,
}: {
  readonly report: SustainabilityDashboardEnvelope;
  readonly sheet: FinopsSheetDescriptor;
  readonly metrics: readonly SustainabilityProxyMetric[];
}) {
  const trends = report.proxy.trends.filter((trend) => metrics.includes(trend.metric));
  const plans = report.proxy.technicalPlans.filter((plan) => metrics.includes(plan.metric));
  const sheetSeries = report.proxy.series.filter((row) => metrics.includes(row.metric));

  return (
    <div className={shell.blocks}>
      {trends.length === 0 ? (
        <NoEvidence
          reason={`No CUR2 proxy row in the active generation normalized into ${metrics.map((metric) => METRIC_LABEL[metric]).join(", ")}. This sheet has no evidence for the selected filters; it is not a claim of zero resource use.`}
        />
      ) : metrics.map((metric) => {
        const rows = trends.filter((trend) => trend.metric === metric)
          .slice()
          .sort((left, right) => left.usagePeriod.localeCompare(right.usagePeriod));
        if (rows.length === 0) {
          return (
            <FinopsSheetBlock key={metric} title={`${METRIC_LABEL[metric]} — ${PROXY_CHANNEL}`}>
              <NoEvidence reason={`No row normalized into ${METRIC_LABEL[metric]} for the selected filters. The metric is unavailable for this scope rather than zero.`} />
            </FinopsSheetBlock>
          );
        }
        const unit = rows[0].unit;
        const latest = rows[rows.length - 1];
        return (
          <FinopsSheetBlock
            description={`Normalized ${unit} per usage period from the active CUR2 generation. A proxy estimate of technical resource use — not energy, not MTCO2e.`}
            key={metric}
            title={`${METRIC_LABEL[metric]} — ${PROXY_CHANNEL}`}
          >
            <div className={shell.tiles}>
              <Tile
                channel="proxy"
                detail={`Period ${latest.usagePeriod} · ${formatCount(latest.sourceRowCount)} CUR2 rows`}
                label={`Latest ${METRIC_LABEL[metric].toLowerCase()}`}
                value={formatMicroQuantityExact(latest.valueMicros, unit)}
              />
              <Tile
                detail="Periods carrying a normalized quantity in the active generation"
                label="Periods with evidence"
                value={formatCount(rows.length)}
              />
              <Tile
                detail="Source rows behind every period shown"
                label="Contributing CUR2 rows"
                value={formatCount(rows.reduce((total, row) => total + row.sourceRowCount, 0))}
              />
            </div>
            <TimeSeriesChart
              ariaLabel={`${METRIC_LABEL[metric]} trend in ${unit} — ${PROXY_CHANNEL}`}
              caption={`${PROXY_CHANNEL} in ${unit}. A period with no collected quantity is a gap, never a zero, and this series is never plotted together with provider carbon.`}
              formatValue={(value) => formatQuantity(value, unit)}
              includeZero
              mode="area"
              series={[{
                id: metric,
                label: `${METRIC_LABEL[metric]} (${unit})`,
                points: rows.map((row) => ({
                  label: row.usagePeriod,
                  value: microsToUnits(row.valueMicros),
                })),
                tone: "teal",
              }]}
            />
          </FinopsSheetBlock>
        );
      })}

      {plans.length === 0 ? null : (
        <FinopsSheetBlock
          description="Period-over-period movement in the proxy quantity, with the review action it implies. A resource-efficiency plan is never stated as a carbon reduction."
          title={`Technical resource plans — ${PROXY_CHANNEL}`}
        >
          <div className={shell.tableWrap}>
            <table className={shell.table}>
              <caption>
                Direction is the exact signed difference between the latest two periods in
                micro-normalized units. With no previous period the direction is unknown, not flat.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  <th scope="col">Latest period</th>
                  <th className={shell.numeric} scope="col">Latest quantity</th>
                  <th className={shell.numeric} scope="col">Change from previous period</th>
                  <th scope="col">Direction</th>
                  <th scope="col">Review action</th>
                  <th scope="col">Claim boundary</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => {
                  const unit = report.proxy.trends
                    .find((trend) => trend.metric === plan.metric)?.unit ?? "normalized units";
                  return (
                    <tr key={plan.metric}>
                      <th scope="row">{METRIC_LABEL[plan.metric]}</th>
                      <td>{plan.latestPeriod}</td>
                      <td className={shell.numeric}>
                        {formatMicroQuantityExact(plan.latestValueMicros, unit)}
                      </td>
                      <td className={shell.numeric}>
                        {plan.deltaMicros === null
                          ? `No previous period (${plan.previousPeriod ?? "none collected"})`
                          : formatMicroQuantityExact(plan.deltaMicros, unit)}
                      </td>
                      <td><StateBadge state={plan.direction.toLowerCase()} /></td>
                      <td>{plan.action}</td>
                      <td>{readable(plan.claim)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </FinopsSheetBlock>
      )}

      <FinopsSheetBlock
        description="Service and workload-tag context for the metrics on this sheet, using only values the source rows carry."
        title={`Service and workload split — ${PROXY_CHANNEL}`}
      >
        {sheetSeries.length === 0
          ? <NoEvidence reason="No source row for these metrics, so no service split can be shown." />
          : metrics.flatMap((metric) => {
            const rows = sheetSeries.filter((row) => row.metric === metric);
            if (rows.length === 0) return [];
            const unit = rows[0].unit;
            const total = sumMicros(rows.map((row) => row.valueMicros));
            const services = groupRows(rows, (row) => row.service);
            return [(
              <div key={metric}>
                <ChannelTag channel="proxy" />
                <RankingBars
                  ariaLabel={`${METRIC_LABEL[metric]} by service in ${unit} — ${PROXY_CHANNEL}`}
                  caption={`${METRIC_LABEL[metric]} in ${unit} by billing service.`}
                  formatValue={(value) => formatQuantity(value, unit)}
                  items={services.flatMap(([service, serviceRows]) => {
                    const micros = sumMicros(serviceRows.map((row) => row.valueMicros));
                    const units = microsToUnits(micros);
                    const share = shareBasisPoints(micros, total);
                    const tags = [...new Set(serviceRows
                      .map((row) => row.workloadTagValue)
                      .filter((value): value is string => value !== null))].sort();
                    return units === null ? [] : [{
                      id: `${metric}:${service}`,
                      label: service,
                      value: units,
                      detail: `${share === null ? "share withheld: no positive metric total" : formatBasisPoints(share)} · workload tags: ${tags.length === 0 ? "none carried on these rows" : tags.join(", ")}`,
                      tone: "teal" as const,
                    }];
                  })}
                  sort
                />
              </div>
            )];
          })}
      </FinopsSheetBlock>

      {UNAVAILABLE_DIMENSIONS
        .filter((entry) => entry.sheetKeys.includes(sheet.key))
        .map((entry) => (
          <UnavailableDimensionPanel entry={entry} key={entry.id} series={report.proxy.series} />
        ))}
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * Sheet 5 — Carbon Emissions
 * ------------------------------------------------------------------------- */

function CarbonDimensionBlock({
  title, rows, keyOf, missingLabel, emptyReason,
}: {
  readonly title: string;
  readonly rows: readonly CarbonRow[];
  readonly keyOf: (row: CarbonRow) => string;
  readonly missingLabel: string;
  readonly emptyReason: string;
}) {
  const groups = groupRows(rows, keyOf);
  const items = groups.flatMap(([key, keyRows]) => {
    const micros = sumMicros(keyRows.map((row) => row.totalLbmMicroMtco2e));
    const units = microsToUnits(micros);
    return units === null ? [] : [{
      id: key === "" ? "unpublished" : key,
      label: key === "" ? missingLabel : key,
      value: units,
      detail: `${formatMicroQuantityExact(micros, "MTCO2e")} · ${formatCount(keyRows.length)} rows`,
      tone: "violet" as const,
    }];
  });
  return (
    <FinopsSheetBlock
      description="Provider-published MTCO2e under the location-based method only. The market-based method is a separate accounting basis and is not added here."
      title={`${title} — ${CARBON_CHANNEL}`}
    >
      <ChannelTag channel="carbon" />
      {items.length === 0
        ? <NoEvidence reason={`${emptyReason} No total is published under the location-based method for these rows, so the breakdown is unavailable rather than zero.`} />
        : (
          <RankingBars
            ariaLabel={`${title} in MTCO2e under the location-based method — ${CARBON_CHANNEL}`}
            formatValue={(value) => formatQuantity(value, "MTCO2e")}
            items={items}
            sort
          />
        )}
    </FinopsSheetBlock>
  );
}

function CarbonEmissionsSheet({ report }: { readonly report: SustainabilityDashboardEnvelope }) {
  const trends = report.providerCarbon.trends.slice()
    .sort((left, right) => left.usagePeriod.localeCompare(right.usagePeriod));

  if (trends.length === 0) {
    return (
      <NoEvidence reason="No AWS CARBON_EMISSIONS row is present for the selected filters. Provider carbon is unavailable or still collecting; it is never reported as zero emissions." />
    );
  }

  const latest = trends[trends.length - 1];
  const lbmTotal = sumMicros(trends.map((trend) => trend.totalLbmMicroMtco2e));
  const mbmTotal = sumMicros(trends.map((trend) => trend.totalMbmMicroMtco2e));
  const firstProxyTrend = report.proxy.trends.length === 0 ? null : report.proxy.trends[0];

  return (
    <div className={shell.blocks}>
      <FinopsSheetBlock
        description="Provider-published MTCO2e per usage period. LBM and MBM are alternative accounting methods for the same footprint: they appear as separate labelled series and are never summed, averaged or netted."
        title={`Emissions trend — ${CARBON_CHANNEL}`}
      >
        <ChannelTag channel="carbon" />
        <div className={shell.tiles}>
          <Tile
            channel="carbon"
            detail={`Latest published period ${latest.usagePeriod} · model ${latest.modelVersion}`}
            label="Latest total, location-based method (LBM)"
            value={latest.totalLbmMicroMtco2e === null
              ? "Not published by AWS for this period"
              : formatMicroQuantityExact(latest.totalLbmMicroMtco2e, latest.unit)}
          />
          <Tile
            channel="carbon"
            detail={`Latest published period ${latest.usagePeriod} · model ${latest.modelVersion}`}
            label="Latest total, market-based method (MBM)"
            value={latest.totalMbmMicroMtco2e === null
              ? "Not published by AWS for this period"
              : formatMicroQuantityExact(latest.totalMbmMicroMtco2e, latest.unit)}
          />
          <Tile
            channel="carbon"
            detail="Summed across published periods within one accounting method only"
            label="Published periods, LBM total"
            value={lbmTotal === null
              ? "No period publishes an LBM total"
              : formatMicroQuantityExact(lbmTotal, "MTCO2e")}
          />
          <Tile
            channel="carbon"
            detail="Summed across published periods within one accounting method only"
            label="Published periods, MBM total"
            value={mbmTotal === null
              ? "No period publishes an MBM total"
              : formatMicroQuantityExact(mbmTotal, "MTCO2e")}
          />
        </div>
        <TimeSeriesChart
          ariaLabel="Provider-reported carbon in MTCO2e per usage period, location-based and market-based methods shown as separate series"
          caption={`${CARBON_CHANNEL} in MTCO2e. Two accounting methods, never combined. A period AWS did not publish is a gap, never a zero. No proxy estimate appears in this chart.`}
          formatValue={(value) => formatQuantity(value, "MTCO2e")}
          includeZero
          mode="line"
          series={[
            {
              id: "lbm",
              label: "Location-based method (LBM), MTCO2e",
              points: trends.map((trend) => ({
                label: trend.usagePeriod,
                value: microsToUnits(trend.totalLbmMicroMtco2e),
              })),
              tone: "violet",
            },
            {
              id: "mbm",
              label: "Market-based method (MBM), MTCO2e",
              points: trends.map((trend) => ({
                label: trend.usagePeriod,
                value: microsToUnits(trend.totalMbmMicroMtco2e),
              })),
              tone: "amber",
            },
          ]}
        />
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Scopes 1, 2 and 3 for the latest published period, kept within a single accounting method. Scope 2 and scope 3 exist once per method and the two methods never share a column."
        title={`Emission scopes — ${CARBON_CHANNEL}`}
      >
        <ChannelTag channel="carbon" />
        <BarChart
          ariaLabel="Latest published period emission scopes in MTCO2e, location-based and market-based methods side by side"
          caption={`${CARBON_CHANNEL} for ${latest.usagePeriod}. Grouped, never stacked: adding LBM to MBM would double count the same footprint.`}
          categories={["Scope 1", "Scope 2", "Scope 3"]}
          formatValue={(value) => formatQuantity(value, "MTCO2e")}
          layout="grouped"
          series={[
            {
              id: "lbm",
              label: "Location-based method (LBM), MTCO2e",
              values: [
                microsToUnits(latest.scope1MicroMtco2e),
                microsToUnits(latest.scope2LbmMicroMtco2e),
                microsToUnits(latest.scope3LbmMicroMtco2e),
              ],
              tone: "violet",
            },
            {
              id: "mbm",
              label: "Market-based method (MBM), MTCO2e",
              values: [
                microsToUnits(latest.scope1MicroMtco2e),
                microsToUnits(latest.scope2MbmMicroMtco2e),
                microsToUnits(latest.scope3MbmMicroMtco2e),
              ],
              tone: "amber",
            },
          ]}
        />
        <div className={shell.tableWrap}>
          <table className={shell.table}>
            <caption>
              Exact provider-published MTCO2e per period and model version. Scope 1 is published
              once and is common to both methods; a total AWS did not publish stays unpublished.
            </caption>
            <thead>
              <tr>
                <th scope="col">Usage period</th>
                <th scope="col">Model version</th>
                <th className={shell.numeric} scope="col">Total (LBM)</th>
                <th className={shell.numeric} scope="col">Total (MBM)</th>
                <th className={shell.numeric} scope="col">Scope 1</th>
                <th className={shell.numeric} scope="col">Scope 2 (LBM)</th>
                <th className={shell.numeric} scope="col">Scope 2 (MBM)</th>
                <th className={shell.numeric} scope="col">Scope 3 (LBM)</th>
                <th className={shell.numeric} scope="col">Scope 3 (MBM)</th>
              </tr>
            </thead>
            <tbody>
              {trends.map((trend) => (
                <tr key={`${trend.usagePeriod}:${trend.modelVersion}`}>
                  <th scope="row">{trend.usagePeriod}</th>
                  <td>{trend.modelVersion}</td>
                  <td className={shell.numeric}>
                    {trend.totalLbmMicroMtco2e === null
                      ? "Not published"
                      : formatMicroQuantityExact(trend.totalLbmMicroMtco2e, trend.unit)}
                  </td>
                  <td className={shell.numeric}>
                    {trend.totalMbmMicroMtco2e === null
                      ? "Not published"
                      : formatMicroQuantityExact(trend.totalMbmMicroMtco2e, trend.unit)}
                  </td>
                  <td className={shell.numeric}>
                    {formatMicroQuantityExact(trend.scope1MicroMtco2e, trend.unit)}
                  </td>
                  <td className={shell.numeric}>
                    {formatMicroQuantityExact(trend.scope2LbmMicroMtco2e, trend.unit)}
                  </td>
                  <td className={shell.numeric}>
                    {formatMicroQuantityExact(trend.scope2MbmMicroMtco2e, trend.unit)}
                  </td>
                  <td className={shell.numeric}>
                    {formatMicroQuantityExact(trend.scope3LbmMicroMtco2e, trend.unit)}
                  </td>
                  <td className={shell.numeric}>
                    {formatMicroQuantityExact(trend.scope3MbmMicroMtco2e, trend.unit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </FinopsSheetBlock>

      <CarbonDimensionBlock
        emptyReason="No product code is published on the carbon rows in scope."
        keyOf={(row) => row.productCode ?? ""}
        missingLabel="Product code not published"
        rows={report.providerCarbon.series}
        title="Emissions by product code"
      />
      <CarbonDimensionBlock
        emptyReason="No usage account is published on the carbon rows in scope."
        keyOf={(row) => row.usageAccountId}
        missingLabel="Usage account not published"
        rows={report.providerCarbon.series}
        title="Emissions by usage account"
      />

      <FinopsSheetBlock
        description="Which pinned emissions model produced each published figure. Model versions are not reconciled with one another, and a change of model does not create a trend."
        title={`Model versions and publication — ${CARBON_CHANNEL}`}
      >
        <div className={shell.tiles}>
          <Tile
            detail={report.lineage.carbonModelVersions.length === 0
              ? "No model version is published on the rows in scope"
              : report.lineage.carbonModelVersions.join(", ")}
            label="Published model versions"
            value={formatCount(report.lineage.carbonModelVersions.length)}
          />
          <Tile
            detail="Publication kind of the accepted export"
            label="Publication"
            value={report.lineage.carbonPublicationKind === null
              ? "Not published"
              : readable(report.lineage.carbonPublicationKind)}
          />
          <Tile
            channel="carbon"
            detail={`Freshness objective ${formatCount(report.freshness.providerCarbon.staleAfterHours)} hours, independent of the proxy objective`}
            label="Provider carbon published at"
            value={report.freshness.providerCarbon.publishedAt ?? "Not published"}
          />
        </div>
        <p className={shell.goalMeta}>
          Provider carbon is published per payer account, Region, product code and model version
          only. Sutra does not allocate it to workload tags, resources or proxy quantities, and no
          figure on this sheet is derived from a proxy estimate.
        </p>
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="The two channels side by side over the same periods, as visual context only. There is no arithmetic between the panels: no ratio, no intensity metric and no conversion."
        title="Side-by-side channel context — compared visually, never combined"
      >
        <div className={styles.compare}>
          <article className={`${styles.compareChannel} ${styles.channelProxy}`}>
            <ChannelTag channel="proxy" />
            {firstProxyTrend === null ? (
              <NoEvidence reason="No proxy quantity is available for the same periods, so only the provider-carbon panel can be shown." />
            ) : (
              <TimeSeriesChart
                ariaLabel={`${METRIC_LABEL[firstProxyTrend.metric]} trend in ${firstProxyTrend.unit} — ${PROXY_CHANNEL}`}
                caption={`${PROXY_CHANNEL} in ${firstProxyTrend.unit}.`}
                formatValue={(value) => formatQuantity(value, firstProxyTrend.unit)}
                series={[{
                  id: `compare-${firstProxyTrend.metric}`,
                  label: `${METRIC_LABEL[firstProxyTrend.metric]} (${firstProxyTrend.unit})`,
                  points: report.proxy.trends
                    .filter((trend) => trend.metric === firstProxyTrend.metric)
                    .slice()
                    .sort((left, right) => left.usagePeriod.localeCompare(right.usagePeriod))
                    .map((trend) => ({
                      label: trend.usagePeriod,
                      value: microsToUnits(trend.valueMicros),
                    })),
                  tone: "teal",
                }]}
              />
            )}
          </article>
          <article className={`${styles.compareChannel} ${styles.channelCarbon}`}>
            <ChannelTag channel="carbon" />
            <TimeSeriesChart
              ariaLabel={`Provider-reported carbon totals in MTCO2e under the location-based method — ${CARBON_CHANNEL}`}
              caption={`${CARBON_CHANNEL} in MTCO2e, location-based method.`}
              formatValue={(value) => formatQuantity(value, "MTCO2e")}
              series={[{
                id: "compare-lbm",
                label: "Location-based method (LBM), MTCO2e",
                points: trends.map((trend) => ({
                  label: trend.usagePeriod,
                  value: microsToUnits(trend.totalLbmMicroMtco2e),
                })),
                tone: "violet",
              }]}
            />
          </article>
        </div>
      </FinopsSheetBlock>
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * Sheet 6 — About: governance, provenance and limitations
 * ------------------------------------------------------------------------- */

/** Convert a typed decimal quantity into exact integer micros, or null. */
function decimalToMicros(value: string): string | null {
  if (!/^(?:0|[1-9]\d{0,20})(?:\.\d{1,6})?$/u.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return (BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, "0"))).toString();
}

function SustainabilityTargetForm({
  report, onSaved,
}: {
  readonly report: SustainabilityDashboardEnvelope;
  readonly onSaved?: () => void;
}) {
  const options = report.filterOptions.proxyMetrics.length > 0
    ? report.filterOptions.proxyMetrics
    : Object.keys(METRIC_LABEL);
  const latest = report.proxy.trends[report.proxy.trends.length - 1];
  const [metric, setMetric] = useState<string>(latest?.metric ?? options[0]);
  const [periodStart, setPeriodStart] = useState<string>(latest?.usagePeriod ?? "");
  const [target, setTarget] = useState("0");
  const [reason, setReason] = useState("Approved technical resource-use threshold");
  const [status, setStatus] = useState<string | null>(null);

  const submit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    const targetValueMicros = decimalToMicros(target);
    if (targetValueMicros === null) {
      setStatus("Enter a non-negative quantity with at most six decimal places.");
      return;
    }
    setStatus("Saving an immutable governed target version…");
    try {
      const response = await fetch(
        `/api/v1/finops/sustainability-carbon/targets?connectionId=${encodeURIComponent(report.connectionId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            metric, periodStart, targetValueMicros,
            workloadTagKey: null, workloadTagValue: null, reason,
          }),
        },
      );
      if (!response.ok) throw new Error("rejected");
      setStatus("A new immutable target version was saved.");
      onSaved?.();
    } catch {
      setStatus("The target could not be saved. No target version was created.");
    }
  }, [metric, onSaved, periodStart, reason, report.connectionId, target]);

  return (
    <form
      aria-label="Create a governed technical proxy target"
      className={styles.form}
      onSubmit={submit}
    >
      <div className={styles.formFields}>
        <label className={shell.field}>
          Proxy metric
          <select onChange={(event) => setMetric(event.target.value)} value={metric}>
            {options.map((option) => (
              <option key={option} value={option}>
                {METRIC_LABEL[option as SustainabilityProxyMetric] ?? readable(option)}
              </option>
            ))}
          </select>
        </label>
        <label className={shell.field}>
          Period start
          <input
            onChange={(event) => setPeriodStart(event.target.value)}
            required
            type="month"
            value={periodStart}
          />
        </label>
        <label className={shell.field}>
          Target quantity in the displayed unit
          <input
            inputMode="decimal"
            onChange={(event) => setTarget(event.target.value)}
            required
            value={target}
          />
        </label>
        <label className={shell.field}>
          Governance reason
          <input
            maxLength={1024}
            onChange={(event) => setReason(event.target.value)}
            required
            value={reason}
          />
        </label>
        <button type="submit">Save immutable target version</button>
      </div>
      {status === null ? null : <p className={shell.goalMeta} role="status">{status}</p>}
      <p className={shell.goalMeta}>
        The quantity is converted to exact integer micro-units before submission; a value that is
        not an exact non-negative decimal is refused rather than rounded. Targets govern technical
        resource use only and are never carbon targets.
      </p>
    </form>
  );
}

function GovernedTargetsBlock({
  report, onTargetsChanged,
}: {
  readonly report: SustainabilityDashboardEnvelope;
  readonly onTargetsChanged?: () => void;
}) {
  const targets = report.proxy.targets;
  return (
    <FinopsSheetBlock
      description={`Governance: ${readable(targets.reason)}. Targets are absolute technical resource-use thresholds and are never carbon targets, avoided emissions or reduction claims.`}
      title={`Governed technical proxy targets — ${PROXY_CHANNEL}`}
    >
      {targets.workloadTagGoals.length === 0 ? (
        <NoEvidence reason="No server-owned technical target is configured for the workloads in scope. A missing target is not treated as achieved." />
      ) : (
        <div className={shell.tableWrap}>
          <table className={shell.table}>
            <caption>
              Immutable server-owned target versions. A target with no measured actual is
              collecting, never met.
            </caption>
            <thead>
              <tr>
                <th scope="col">Workload</th>
                <th scope="col">Metric</th>
                <th scope="col">Period</th>
                <th className={shell.numeric} scope="col">Target</th>
                <th className={shell.numeric} scope="col">Measured actual</th>
                <th scope="col">State</th>
                <th scope="col">Governance</th>
              </tr>
            </thead>
            <tbody>
              {targets.configured
                ? targets.workloadTagGoals.map((goal) => (
                  <tr key={goal.targetId}>
                    <th scope="row">
                      {goal.workloadTagValue === null
                        ? "All workloads in scope"
                        : `${goal.workloadTagKey ?? "tag"} = ${goal.workloadTagValue}`}
                    </th>
                    <td>{METRIC_LABEL[goal.metric]}</td>
                    <td>{goal.periodStart}</td>
                    <td className={shell.numeric}>
                      {formatMicroQuantityExact(goal.targetValueMicros, goal.unit)}
                    </td>
                    <td className={shell.numeric}>
                      {goal.actualValueMicros === null
                        ? "No measured quantity yet"
                        : formatMicroQuantityExact(goal.actualValueMicros, goal.unit)}
                    </td>
                    <td><StateBadge state={goal.state.toLowerCase()} /></td>
                    <td>
                      {readable(goal.interpretation)}
                      <br />
                      version {goal.versionId} · {goal.versionedAt} · {goal.reason}
                    </td>
                  </tr>
                ))
                : targets.workloadTagGoals.map((goal) => (
                  <tr key={goal.workloadTagValue ?? "all-workloads"}>
                    <th scope="row">{goal.workloadTagValue ?? "All workloads in scope"}</th>
                    <td>Not configured</td>
                    <td>Not configured</td>
                    <td className={shell.numeric}>No target version exists</td>
                    <td className={shell.numeric}>Not evaluated without a target</td>
                    <td><StateBadge state={goal.state.toLowerCase()} /></td>
                    <td>{readable(targets.reason)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
      <SustainabilityTargetForm onSaved={onTargetsChanged} report={report} />
    </FinopsSheetBlock>
  );
}

function AboutSheet({
  report, onTargetsChanged,
}: {
  readonly report: SustainabilityDashboardEnvelope;
  readonly onTargetsChanged?: () => void;
}) {
  return (
    <div className={shell.blocks}>
      <SustainabilityOfficialDefinitionPanel definition={report.officialDefinition} />

      <FinopsSheetBlock
        description="Each channel has its own lineage and its own freshness objective. They are never merged into one provenance record or one age."
        title="Lineage and freshness of both channels"
      >
        <div className={shell.tiles}>
          <Tile
            channel="proxy"
            detail={`Manifest ${report.lineage.proxyManifestSha256 ?? "not delivered"}`}
            label="CUR2 proxy generation"
            value={report.lineage.proxyGenerationId ?? "Not delivered"}
          />
          <Tile
            channel="proxy"
            detail={report.freshness.proxy.ageHours === null
              ? `Age unavailable · objective ${formatCount(report.freshness.proxy.staleAfterHours)} hours`
              : `Age ${formatCount(report.freshness.proxy.ageHours)} hours · objective ${formatCount(report.freshness.proxy.staleAfterHours)} hours`}
            label="Proxy data through"
            value={report.freshness.proxy.dataThroughAt ?? "Not delivered"}
          />
          <Tile
            channel="carbon"
            detail={`Export ${report.lineage.carbonExportArn ?? "not delivered"}`}
            label="Carbon export generation"
            value={report.lineage.carbonGenerationId ?? "Not delivered"}
          />
          <Tile
            channel="carbon"
            detail={report.freshness.providerCarbon.ageHours === null
              ? `Age unavailable · objective ${formatCount(report.freshness.providerCarbon.staleAfterHours)} hours`
              : `Age ${formatCount(report.freshness.providerCarbon.ageHours)} hours · objective ${formatCount(report.freshness.providerCarbon.staleAfterHours)} hours`}
            label="Carbon published at"
            value={report.freshness.providerCarbon.publishedAt ?? "Not published"}
          />
          <Tile
            detail={`Capture ${report.evidence.sourceCaptureId} · content ${report.evidence.contentSha256}`}
            label="Accepted generation"
            value={report.evidence.generationId}
          />
          <Tile
            detail={report.evidence.newerIncomplete
              ? "A newer generation exists but is incomplete; the accepted head is retained and the newer attempt stays audit history."
              : "The accepted head is the latest stored generation."}
            label="Runtime state"
            value={readable(report.runtimeState)}
          />
        </div>
        <p className={shell.goalMeta}>
          Carbon manifest {report.lineage.carbonManifestSha256 ?? "not delivered"} · active head{" "}
          {report.evidence.activeGenerationId ?? "none accepted"} · latest stored{" "}
          {report.evidence.latestGenerationId ?? "none stored"}.
        </p>
      </FinopsSheetBlock>

      <GovernedTargetsBlock onTargetsChanged={onTargetsChanged} report={report} />

      <FinopsSheetBlock
        description="Official dimensions this vertical does not deliver, gathered in one place so the boundary of the view is auditable from a single sheet."
        title="Unavailable official dimensions"
      >
        {UNAVAILABLE_DIMENSIONS.map((entry) => (
          <UnavailableDimensionPanel entry={entry} key={entry.id} series={report.proxy.series} />
        ))}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Collection state of the shared runtime that materializes both channels. An unregistered materializer means evidence is not collecting, which is not the same as no usage and not the same as no emissions."
        title="Collection runtime"
      >
        <div className={shell.tiles}>
          <Tile
            detail={readable(report.collection.reason)}
            label="Collection state"
            value={readable(report.collection.state)}
          />
          <Tile
            label="Job contract available"
            value={report.collection.jobContractAvailable ? "Yes" : "No"}
          />
          <Tile
            label="Provider adapter available"
            value={report.collection.providerAdapterAvailable ? "Yes" : "No"}
          />
          <Tile
            label="Registered in the shared runtime"
            value={report.collection.registeredInSharedRuntime ? "Yes" : "No"}
          />
        </div>
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Every immutable stored generation, with each channel's own state. History is never rewritten to match the accepted head."
        title="Immutable generation history"
      >
        {report.history.length === 0 ? (
          <NoEvidence reason="No generation has been stored for this connection yet." />
        ) : (
          <div className={shell.tableWrap}>
            <table className={shell.table}>
              <caption>
                Newest first. Row counts are source rows, not quantities and not emissions.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Generation</th>
                  <th scope="col">Completed</th>
                  <th scope="col">Snapshot state</th>
                  <th scope="col">Proxy channel</th>
                  <th scope="col">Carbon channel</th>
                  <th className={shell.numeric} scope="col">Proxy rows</th>
                  <th className={shell.numeric} scope="col">Carbon rows</th>
                </tr>
              </thead>
              <tbody>
                {report.history.map((item) => (
                  <tr key={item.generationId}>
                    <th scope="row">{item.generationId}</th>
                    <td>{item.completedAtIso}</td>
                    <td><StateBadge state={item.sourceState} /></td>
                    <td><StateBadge state={item.proxyState} /></td>
                    <td><StateBadge state={item.carbonState} /></td>
                    <td className={shell.numeric}>{formatCount(item.proxyRowCount)}</td>
                    <td className={shell.numeric}>{formatCount(item.carbonRowCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="The canonical engine's own limitations and the disclosures the API attaches to every response."
        title="Limitations and disclosures"
      >
        <ul className={shell.coverageGaps}>
          {report.limitations.map((limitation) => <li key={limitation}>{readable(limitation)}</li>)}
          {report.disclosures.map((disclosure) => <li key={disclosure}>{disclosure}</li>)}
        </ul>
      </FinopsSheetBlock>
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * Official definition coverage
 * ------------------------------------------------------------------------- */

export function SustainabilityOfficialDefinitionPanel({
  definition,
}: {
  readonly definition: typeof SUSTAINABILITY_OFFICIAL_DEFINITION;
}) {
  return (
    <section
      aria-label="Pinned official Sustainability definition coverage"
      className={shell.block}
    >
      <header className={shell.blockHead}>
        <div>
          <h4>
            Official definition coverage · {definition.sheetCount} sheets /{" "}
            {definition.visualCount} visuals / {definition.controlCount} controls
          </h4>
          <p>
            Frozen source {definition.commit.slice(0, 12)} · artifact SHA-256{" "}
            {definition.artifactSha256} · dimension contract{" "}
            {definition.dimensionContractVersion}
          </p>
        </div>
      </header>
      <div className={shell.tableWrap}>
        <table className={shell.table}>
          <caption>
            Counts describe the pinned AWS QuickSight definition. Native sheets mirror its
            structure; they do not claim pixel or interaction parity.
          </caption>
          <thead>
            <tr>
              <th scope="col">Official sheet</th>
              <th className={shell.numeric} scope="col">Visuals</th>
              <th className={shell.numeric} scope="col">Controls</th>
              <th scope="col">Sutra area</th>
              <th scope="col">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {definition.sheets.map((sheet) => (
              <tr key={sheet.name}>
                <th scope="row">{sheet.name}</th>
                <td className={shell.numeric}>{formatCount(sheet.visualCount)}</td>
                <td className={shell.numeric}>{formatCount(sheet.controlCount)}</td>
                <td>{sheet.localArea}</td>
                <td><StateBadge state={sheet.coverage.toLowerCase()} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul aria-label="Evidence-gated dimensions" className={shell.coverageGaps}>
        {definition.evidenceGatedDimensions.map((dimension) => (
          <li key={dimension}>{dimension}</li>
        ))}
      </ul>
      <p className={shell.goalMeta}>
        <a href={definition.sourceUrl} rel="noopener noreferrer" target="_blank">
          Pinned AWS CID Sustainability definition
        </a>
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------------- *
 * Sheet dispatch and shell
 * ------------------------------------------------------------------------- */

/**
 * One official sheet's content. Exported so every sheet can be rendered and
 * asserted directly, without driving the fetch lifecycle.
 */
export function FinopsSustainabilitySheetContent({
  report, sheet, onTargetsChanged,
}: {
  readonly report: SustainabilityDashboardEnvelope;
  readonly sheet: FinopsSheetDescriptor;
  readonly onTargetsChanged?: () => void;
}) {
  const metrics = SHEET_METRICS[sheet.key];
  if (metrics !== undefined) {
    return <ProxyMetricSheet metrics={metrics} report={report} sheet={sheet} />;
  }
  switch (sheet.key) {
    case "regional-footprint": return <RegionalFootprintSheet report={report} />;
    case "carbon-emissions": return <CarbonEmissionsSheet report={report} />;
    case "about": return <AboutSheet onTargetsChanged={onTargetsChanged} report={report} />;
    default:
      return (
        <NoEvidence
          reason={`Sutra has no projection for the official sheet ${sheet.name}. The sheet is listed because AWS publishes it; it is not presented as delivered.`}
        />
      );
  }
}

function FilterSelect({
  label, value, options, onChange,
}: {
  readonly label: string;
  readonly value: string | undefined;
  readonly options: readonly string[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className={shell.field}>
      {label}
      <select onChange={(event) => onChange(event.target.value)} value={value ?? ""}>
        <option value="">All</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

/**
 * Presentation for a loaded Sustainability report: the standing channel
 * separation notice, the six official sheet tabs and the active sheet.
 *
 * Takes the envelope directly and performs no fetching, so a test or a
 * server-side snapshot can render any sheet exactly as a browser would.
 */
export function FinopsSustainabilitySheets({
  report, initialSheetKey, filters, onFiltersChange, onTargetsChanged,
}: {
  readonly report: SustainabilityDashboardEnvelope;
  readonly initialSheetKey?: string;
  readonly filters?: SustainabilityFilters;
  readonly onFiltersChange?: (filters: SustainabilityFilters) => void;
  readonly onTargetsChanged?: () => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string>(
    initialSheetKey ?? FINOPS_SUSTAINABILITY_SHEETS.sheets[0].key,
  );
  const sheet = useMemo(
    () => FINOPS_SUSTAINABILITY_SHEETS.sheets.find((entry) => entry.key === selectedKey)
      ?? FINOPS_SUSTAINABILITY_SHEETS.sheets[0],
    [selectedKey],
  );

  const active: SustainabilityFilters = filters ?? report.filters;
  const set = (key: keyof SustainabilityFilters, value: string) => {
    onFiltersChange?.({ ...active, [key]: value === "" ? undefined : value });
  };

  const toolbar = onFiltersChange === undefined ? undefined : (
    <>
      <FilterSelect
        label="Account"
        onChange={(value) => set("accountId", value)}
        options={report.filterOptions.accounts}
        value={active.accountId}
      />
      <FilterSelect
        label="Region"
        onChange={(value) => set("region", value)}
        options={report.filterOptions.regions}
        value={active.region}
      />
      <FilterSelect
        label="Service (proxy channel)"
        onChange={(value) => set("service", value)}
        options={report.filterOptions.services}
        value={active.service}
      />
      <FilterSelect
        label="Workload tag (proxy channel)"
        onChange={(value) => set("workloadTagValue", value)}
        options={report.filterOptions.workloadTags}
        value={active.workloadTagValue}
      />
      <FilterSelect
        label="Proxy metric"
        onChange={(value) => set("proxyMetric", value)}
        options={report.filterOptions.proxyMetrics}
        value={active.proxyMetric}
      />
      <FilterSelect
        label="Carbon model version"
        onChange={(value) => set("carbonModelVersion", value)}
        options={report.filterOptions.carbonModels}
        value={active.carbonModelVersion}
      />
      <FilterSelect
        label="Carbon product code"
        onChange={(value) => set("carbonProductCode", value)}
        options={report.filterOptions.carbonProducts}
        value={active.carbonProductCode}
      />
    </>
  );

  return (
    <>
      <SourceStateNotice report={report} />
      <ChannelSeparationNotice report={report} />
      <FinopsSheetShell
        activeKey={sheet.key}
        idPrefix="sustainability"
        inventory={FINOPS_SUSTAINABILITY_SHEETS}
        onSelectSheet={setSelectedKey}
        toolbar={toolbar}
      >
        <FinopsSustainabilitySheetContent
          onTargetsChanged={onTargetsChanged}
          report={report}
          sheet={sheet}
        />
      </FinopsSheetShell>
    </>
  );
}

/**
 * Retained container-facing view. Keeps its original props so any existing
 * caller keeps working, and delegates to the presentational sheet shell.
 */
export function FinopsSustainabilityCarbonReportView({
  report, filters, onFiltersChange, onTargetsChanged,
}: {
  readonly report: SustainabilityDashboardEnvelope;
  readonly filters: SustainabilityFilters;
  readonly onFiltersChange: (filters: SustainabilityFilters) => void;
  readonly onTargetsChanged?: () => void;
}) {
  return (
    <FinopsSustainabilitySheets
      filters={filters}
      onFiltersChange={onFiltersChange}
      onTargetsChanged={onTargetsChanged}
      report={report}
    />
  );
}

/* ------------------------------------------------------------------------- *
 * Container
 * ------------------------------------------------------------------------- */

function hasPinnedOfficialDefinition(
  value: unknown,
): value is typeof SUSTAINABILITY_OFFICIAL_DEFINITION {
  if (typeof value !== "object" || value === null) return false;
  const definition = value as Readonly<Record<string, unknown>>;
  return definition.schemaVersion === SUSTAINABILITY_OFFICIAL_DEFINITION.schemaVersion
    && definition.commit === SUSTAINABILITY_OFFICIAL_DEFINITION.commit
    && definition.artifactSha256 === SUSTAINABILITY_OFFICIAL_DEFINITION.artifactSha256
    && definition.sheetCount === 6
    && definition.visualCount === 25
    && definition.controlCount === 17
    && Array.isArray(definition.sheets)
    && definition.sheets.length === 6;
}

/**
 * ADD-08 container. Owns only the endpoint lifecycle: the exported component
 * name and its `connectionId` prop are the shared dashboard registry's contract
 * and do not change.
 */
export function FinopsSustainabilityCarbonDashboard({
  connectionId,
}: {
  readonly connectionId: string | null;
}) {
  const [filters, setFilters] = useState<SustainabilityFilters>({});
  const [refresh, setRefresh] = useState(0);

  /**
   * Identity of the request the view is currently allowed to show. A stored
   * result belongs to exactly one request key, so a result from a superseded
   * connection, filter set or reload can never be displayed as if it answered
   * the current one, and "loading" is derived from the absence of a matching
   * result rather than written into state from inside the effect.
   */
  const requestKey = useMemo(
    () => JSON.stringify([connectionId, filters, refresh]),
    [connectionId, filters, refresh],
  );
  const [result, setResult] = useState<{
    readonly key: string;
    readonly state: EndpointState<SustainabilityDashboardEnvelope>;
    readonly configuration: {
      readonly definition: typeof SUSTAINABILITY_OFFICIAL_DEFINITION;
      readonly reason: string;
    } | null;
  } | null>(null);

  useEffect(() => {
    if (connectionId === null) return;
    const controller = new AbortController();
    const parameters = new URLSearchParams({ connectionId });
    for (const [key, value] of Object.entries(filters)) {
      if (typeof value === "string" && value !== "") parameters.set(key, value);
    }
    fetch(`/api/v1/finops/sustainability-carbon?${parameters.toString()}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("The Sustainability dashboard request failed");
        return await response.json() as
          SustainabilityDashboardEnvelope | SustainabilityConfigurationEnvelope;
      })
      .then((envelope) => {
        if (!hasPinnedOfficialDefinition(envelope.officialDefinition)) {
          throw new Error("Sutra returned an unrecognized official Sustainability definition");
        }
        if ("dashboard" in envelope && envelope.dashboard === null) {
          setResult({
            key: requestKey,
            state: { status: "configuration_required" },
            configuration: {
              definition: envelope.officialDefinition,
              reason: envelope.collection.reason,
            },
          });
          return;
        }
        setResult({
          key: requestKey,
          state: { status: "ready", envelope: envelope as SustainabilityDashboardEnvelope },
          configuration: null,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setResult({
          key: requestKey,
          state: {
            status: "error",
            message: error instanceof Error
              ? error.message
              : "The Sustainability dashboard request failed",
          },
          configuration: null,
        });
      });
    return () => controller.abort();
  }, [connectionId, filters, requestKey]);

  const reload = useCallback(() => setRefresh((value) => value + 1), []);
  const current = result !== null && result.key === requestKey ? result : null;
  const state: EndpointState<SustainabilityDashboardEnvelope> = connectionId === null
    ? { status: "idle" }
    : current === null ? { status: "loading" } : current.state;
  const configuration = current?.configuration ?? null;
  const envelope = state.status === "ready" ? state.envelope : null;

  return (
    <section
      aria-label="Sustainability proxy metrics and carbon emissions dashboard"
      className={shell.shell}
    >
      {connectionId === null ? (
        <div className={`${styles.state} ${styles.warning}`} role="status">
          Connect an active AWS trust-role account before Sustainability evidence can be collected.
        </div>
      ) : null}

      {state.status === "loading" || state.status === "error" ? (
        <EndpointBoundary
          onRetry={reload}
          state={state}
          title="the Sustainability proxy metrics and carbon emissions dashboard"
        />
      ) : null}

      {configuration === null ? null : (
        <>
          <div className={`${styles.state} ${styles.warning}`} role="status">
            <StateBadge state="configuration_required" /> Configure active CUR2 proxy
            materialization and a version-pinned AWS CARBON_EMISSIONS export before either channel
            can deliver evidence. Reason: {readable(configuration.reason)}. Nothing here is reported
            as zero usage or zero emissions.
          </div>
          <SustainabilityOfficialDefinitionPanel definition={configuration.definition} />
        </>
      )}

      {envelope === null || envelope.connectionId !== connectionId ? null : (
        <FinopsSustainabilitySheets
          filters={filters}
          onFiltersChange={setFilters}
          onTargetsChanged={reload}
          report={envelope}
        />
      )}
    </section>
  );
}

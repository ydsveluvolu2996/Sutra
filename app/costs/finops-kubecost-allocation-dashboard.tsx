"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart, RankingBars, ShareBar, TimeSeriesChart } from "../components/charts";
import { StateBadge, formatMicrosExact } from "./finops-foundational-panels";
import { FinopsSheetBlock, foundationalStyles as shared } from "./finops-foundational-sheet-shell";
import { formatCount, formatUnits, microsToUnits } from "./finops-foundational-money";
import {
  KUBECOST_EXPORT_CONTRACT,
  type KubecostAllocationGroup,
  type KubecostAllocationKind,
  type KubecostCostComponent,
  type KubecostExactDecimal,
  type KubecostMetric,
} from "../../lib/finops-kubecost-allocation";
import {
  KUBECOST_OFFICIAL_DEFINITION,
  type KubecostOfficialArea,
  type KubecostOfficialDefinition,
} from "../../lib/finops-kubecost-official-definition";
import styles from "./finops-kubecost-allocation-dashboard.module.css";

/**
 * ADD-06 Kubecost Containers Cost Allocation, presented as the three
 * purpose-level tabs AWS documents.
 *
 * AWS publishes a CID manifest, one 62-column SPICE dataset, one Terraform
 * Athena view query and the exporter, but its QuickSight template is
 * service-hosted: no sheet, visual, control or parameter total exists at the
 * pinned commit. This view therefore organizes by the three *documented* areas
 * and states that object totals are unavailable, instead of inventing counts the
 * way a sheet-count tab strip would.
 *
 * Honesty contract, in addition to the chart kit's own:
 * - Kubecost money is an exact rational (numerator/denominator) of currency
 *   units, so it is printed by exact decimal expansion and never by a float. A
 *   value with no terminating decimal is shown as its exact fraction rather than
 *   as a rounded number. CUR2 reconciliation amounts are integer micro-units and
 *   go through `formatMicrosExact`; only chart geometry converts, via
 *   `microsToUnits`.
 * - Idle, shared, external, unmounted and unallocated cost are named shares of
 *   their own. They are never distributed onto workloads, and the export
 *   contract flags that govern that are shown.
 * - Missing evidence is a labelled state. An absent dimension, an unmeasured
 *   efficiency or a withheld percentage says so; none of them become zero.
 * - Negative amounts keep their sign, and a composition is refused rather than
 *   drawn when a part is negative.
 * - Kubecost and OpenCost are kept distinct: OpenCost is supplemental Sutra
 *   evidence and is never counted as official AWS dashboard coverage.
 */

interface Aggregate {
  readonly identity: string;
  readonly currency: string;
  readonly totalCost: KubecostExactDecimal;
  readonly groupCount: number;
}
interface Efficiency {
  readonly metric: string;
  readonly requestedOrProvisioned: KubecostExactDecimal;
  readonly used: KubecostExactDecimal;
  readonly ratio: KubecostExactDecimal | null;
  readonly contributingGroupCount: number;
  readonly state: string;
}
interface ComponentCost {
  readonly component: string;
  readonly currency: string;
  readonly totalCost: KubecostExactDecimal;
  readonly contributingGroupCount: number;
}
interface HourlyCost {
  readonly windowStartIso: string;
  readonly windowEndIso: string;
  readonly currency: string;
  readonly totalCost: KubecostExactDecimal;
  readonly rowCount: number;
}
interface Filters {
  readonly accountId?: string;
  readonly clusterId?: string;
  readonly namespace?: string;
  readonly nodeCapacityType?: string;
  readonly nodeInstanceType?: string;
  readonly allocationKind?: string;
  readonly currency?: string;
}

/**
 * Reconciliation, coverage, lineage, freshness and evidence come from the route
 * as JSON, so every field is treated as optional and absence is disclosed. The
 * engine's own types are stricter; this view must not crash or imply a value
 * when a transport carries less than the engine promised.
 */
interface ReconciliationCurrency {
  readonly currency: string;
  readonly kubecostTotal: KubecostExactDecimal | null;
  readonly cur2TotalMicros: string | null;
  readonly delta: KubecostExactDecimal | null;
  readonly withinTolerance: boolean | null;
}
interface Reconciliation {
  readonly state?: string;
  readonly authoritativeSpendSource?: string;
  readonly presentationPolicy?: string;
  readonly toleranceMicros?: string;
  readonly currencies?: readonly ReconciliationCurrency[];
}
interface Coverage {
  readonly expectedObjects?: number;
  readonly processedObjects?: number;
  readonly failedObjects?: number;
  readonly expectedClusters?: number;
  readonly capturedClusters?: number;
  readonly rowsExhausted?: boolean;
}
interface ExportLineage {
  readonly provider?: string;
  readonly exporterName?: string;
  readonly exporterVersion?: string;
  readonly schemaName?: string;
  readonly schemaVersion?: string;
  readonly manifestSha256?: string;
  readonly querySha256?: string;
  readonly costModelSha256?: string;
  readonly objectCount?: number;
  readonly versionPinnedObjectCount?: number;
}
interface Freshness {
  readonly dataThroughAt?: string;
  readonly ageHours?: number;
  readonly staleAfterHours?: number;
}
interface EvidencePins {
  readonly generationId?: string;
  readonly activeGenerationId?: string | null;
  readonly latestGenerationId?: string | null;
  readonly sourceCaptureId?: string;
  readonly contentSha256?: string;
  readonly activeCur2GenerationId?: string;
  readonly billingPeriod?: string;
  readonly newerIncomplete?: boolean;
}

export interface KubecostDashboardEnvelope {
  readonly schema: string;
  readonly connectionId: string;
  readonly sourceState: "complete" | "partial" | "stale" | "empty" | "failed" | "configuration_required";
  readonly officialDefinition: KubecostOfficialDefinition;
  readonly filters: Filters;
  readonly resultCount: number;
  readonly rows: readonly KubecostAllocationGroup[];
  readonly nextCursor: string | null;
  readonly executiveSummary: {
    readonly totals: readonly { readonly currency: string; readonly totalCost: KubecostExactDecimal }[];
    readonly componentCosts: readonly ComponentCost[];
    readonly efficiencies: readonly Efficiency[];
  };
  readonly hourlyCosts: readonly HourlyCost[];
  readonly byAccount: readonly (Aggregate & { readonly accountId: string })[];
  readonly topClusters: readonly (Aggregate & { readonly clusterId: string })[];
  readonly pivots: {
    readonly namespaces: readonly Aggregate[];
    readonly controllers: readonly Aggregate[];
    readonly workloads: readonly Aggregate[];
    readonly nodes: readonly Aggregate[];
  };
  readonly eksBreakdown: {
    readonly capacityTypes: readonly Aggregate[];
    readonly instanceTypes: readonly Aggregate[];
    readonly nodeGroups: readonly Aggregate[];
    readonly architectures: readonly Aggregate[];
  };
  readonly reconciliation: Reconciliation;
  readonly coverage: Coverage;
  readonly source: ExportLineage;
  readonly history: readonly Readonly<Record<string, unknown>>[];
  readonly freshness: Freshness;
  readonly evidence: EvidencePins;
  readonly collection: {
    readonly jobContractAvailable: boolean;
    readonly providerAdapterAvailable: boolean;
    readonly runtimeState: "unavailable" | "collecting" | "failed" | "ready";
    readonly sharedWorkerRegistered: boolean;
    readonly reason: string;
  };
  readonly disclosures: readonly string[];
}

/* ------------------------------------------------------------------ exact money */

interface Rational { readonly n: bigint; readonly d: bigint }

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const FIVE = BigInt(5);
const TEN = BigInt(10);
const HUNDRED = BigInt(100);
const MICROS_PER_UNIT = BigInt(1_000_000);
const NUMERATOR = /^-?(?:0|[1-9]\d{0,79})$/u;
const DENOMINATOR = /^[1-9]\d{0,79}$/u;

function gcd(left: bigint, right: bigint): bigint {
  let a = left < ZERO ? -left : left;
  let b = right < ZERO ? -right : right;
  while (b !== ZERO) { const remainder = a % b; a = b; b = remainder; }
  return a === ZERO ? ONE : a;
}

function reduce(value: Rational): Rational {
  const factor = gcd(value.n, value.d);
  return { n: value.n / factor, d: value.d / factor };
}

/** Parse an engine rational, refusing anything that is not canonical. */
function rational(value: KubecostExactDecimal | null | undefined): Rational | null {
  if (value === null || value === undefined) return null;
  if (typeof value.numerator !== "string" || typeof value.denominator !== "string") return null;
  if (!NUMERATOR.test(value.numerator) || !DENOMINATOR.test(value.denominator)) return null;
  return reduce({ n: BigInt(value.numerator), d: BigInt(value.denominator) });
}

function addRational(left: Rational, right: Rational): Rational {
  return reduce({ n: left.n * right.d + right.n * left.d, d: left.d * right.d });
}

/** Sums exact rationals, or refuses the sum when any input is not canonical. */
function sumExact(values: readonly (KubecostExactDecimal | null | undefined)[]): Rational | null {
  let total: Rational = { n: ZERO, d: ONE };
  for (const value of values) {
    const parsed = rational(value);
    if (parsed === null) return null;
    total = addRational(total, parsed);
  }
  return total;
}

function compareRational(left: Rational, right: Rational): number {
  const difference = left.n * right.d - right.n * left.d;
  return difference === ZERO ? 0 : difference > ZERO ? 1 : -1;
}

function group3(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

/**
 * Exact decimal expansion, or null when the reduced denominator has a prime
 * factor other than two or five and therefore no terminating decimal exists.
 */
function exactDecimal(value: Rational, minimumFractionDigits: number): string | null {
  let rest = value.d;
  let twos = 0;
  let fives = 0;
  while (rest % TWO === ZERO) { rest /= TWO; twos += 1; }
  while (rest % FIVE === ZERO) { rest /= FIVE; fives += 1; }
  if (rest !== ONE) return null;
  const places = Math.max(twos, fives, minimumFractionDigits);
  const scaled = value.n * TEN ** BigInt(places) / value.d;
  const negative = scaled < ZERO;
  const absolute = (negative ? -scaled : scaled).toString().padStart(places + 1, "0");
  const whole = places === 0 ? absolute : absolute.slice(0, absolute.length - places);
  const fraction = places === 0 ? "" : absolute.slice(absolute.length - places);
  return `${negative ? "−" : ""}${group3(whole)}${fraction === "" ? "" : `.${fraction}`}`;
}

/** Exact currency amount. Never rounds, never converts to a Number. */
function formatExact(value: KubecostExactDecimal | null | undefined, currency: string): string {
  const parsed = rational(value);
  if (parsed === null) return "Not available";
  const decimal = exactDecimal(parsed, 2);
  if (decimal !== null) return `${currency} ${decimal}`;
  return `${currency} exactly ${parsed.n.toString()}/${parsed.d.toString()} (no terminating decimal)`;
}

function formatExactRational(value: Rational | null, currency: string): string {
  if (value === null) return "Not available";
  return formatExact({ numerator: value.n.toString(), denominator: value.d.toString() }, currency);
}

/** Exact percentage of a ratio, or the exact fraction when it does not terminate. */
function formatRatioPercent(value: KubecostExactDecimal | null | undefined): string {
  const parsed = rational(value);
  if (parsed === null) return "Not measured";
  const scaled = reduce({ n: parsed.n * HUNDRED, d: parsed.d });
  const decimal = exactDecimal(scaled, 2);
  if (decimal !== null) return `${decimal}%`;
  return `exactly ${scaled.n.toString()}/${scaled.d.toString()}% (no terminating decimal)`;
}

/**
 * Geometry-only conversion. The exact figure is always printed as text and in
 * every chart's data table; this rounds to the nearest micro purely so a bar or
 * a line has a length, and drops values too large to convert exactly.
 */
function rationalForGeometry(value: Rational | null): number | null {
  if (value === null) return null;
  const scaled = value.n * MICROS_PER_UNIT;
  const quotient = scaled / value.d;
  const remainder = scaled % value.d;
  const twiceRemainder = (remainder < ZERO ? -remainder : remainder) * TWO;
  const rounded = twiceRemainder >= value.d
    ? quotient + (value.n < ZERO ? -ONE : ONE)
    : quotient;
  return microsToUnits(rounded.toString());
}

function geometryOf(value: KubecostExactDecimal | null | undefined): number | null {
  return rationalForGeometry(rational(value));
}

/* ------------------------------------------------------------- domain vocabulary */

const KIND_ORDER: readonly KubecostAllocationKind[] = [
  "WORKLOAD", "IDLE", "SHARED", "EXTERNAL", "UNALLOCATED", "UNMOUNTED",
];

/**
 * Every non-workload kind is named. Nothing here folds into "workload": Kubecost
 * is collected with idle split out and unshared, so idle and unallocated cost
 * must be readable as their own cost, not as a surcharge on someone's namespace.
 */
const KIND_LABEL: Readonly<Record<KubecostAllocationKind, string>> = Object.freeze({
  WORKLOAD: "Workload allocation",
  IDLE: "Idle cluster capacity (named, never shared onto workloads)",
  SHARED: "Shared cost (named, not distributed)",
  EXTERNAL: "External cost",
  UNALLOCATED: "Unallocated cluster cost (named, never shared onto workloads)",
  UNMOUNTED: "Unmounted persistent volumes",
});

const KIND_TONE: Readonly<Record<KubecostAllocationKind, "teal" | "amber" | "violet" | "orange" | "red" | "slate">> = Object.freeze({
  WORKLOAD: "teal",
  IDLE: "amber",
  SHARED: "violet",
  EXTERNAL: "orange",
  UNALLOCATED: "red",
  UNMOUNTED: "slate",
});

const COMPONENT_ORDER: readonly KubecostCostComponent[] = [
  "CPU", "RAM", "GPU", "NETWORK", "PV", "LOAD_BALANCER", "SHARED", "EXTERNAL",
];

const METRICS: readonly KubecostMetric[] = ["CPU", "RAM"];

function readable(token: string): string {
  return token.replaceAll("_", " ");
}

/** A dimension the pinned export did not publish is unavailable, not a value. */
function dimensionLabel(identity: string): string {
  if (identity === "UNAVAILABLE") return "Dimension not published by the export";
  if (identity === "UNALLOCATED") return "Unallocated (no such dimension on the row)";
  if (identity === "NONE/UNALLOCATED") return "No controller (unallocated)";
  return identity;
}

function stateText(state: KubecostDashboardEnvelope["sourceState"]): string | null {
  if (state === "complete") return null;
  if (state === "partial") return "Coverage or reconciliation is partial. The newer attempt has not replaced the accepted complete head.";
  if (state === "stale") return "The accepted allocation evidence is older than the 24-hour objective.";
  if (state === "empty") return "The complete export contains no allocations for this filter scope.";
  if (state === "configuration_required") return "Kubecost/OpenCost export ingestion is not configured for this connection.";
  return "The latest export failed; failed evidence cannot replace the accepted head.";
}

function options(values: readonly (string | null)[]) {
  return [...new Set(values.filter((value): value is string => value !== null))].sort();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPinnedOfficialDefinition(value: unknown): value is KubecostOfficialDefinition {
  return isRecord(value) && isRecord(value.cidFrameworkAudit) && isRecord(value.quickSightDefinition)
    && Array.isArray(value.artifacts) && isRecord(value.artifacts[0])
    && value.schema === KUBECOST_OFFICIAL_DEFINITION.schema
    && value.sourceCommit === KUBECOST_OFFICIAL_DEFINITION.sourceCommit
    && value.cidFrameworkAudit.commit === KUBECOST_OFFICIAL_DEFINITION.cidFrameworkAudit.commit
    && value.artifacts[0].sha256 === KUBECOST_OFFICIAL_DEFINITION.artifacts[0]?.sha256
    && value.quickSightDefinition.publishedInRepository === false
    && value.quickSightDefinition.sheetCount === null
    && value.quickSightDefinition.visualCount === null;
}

/* ---------------------------------------------------------- derived page evidence */

function currenciesOf(rows: readonly KubecostAllocationGroup[]): readonly string[] {
  return [...new Set(rows.map((row) => row.currency))].sort();
}

interface KindTotal {
  readonly kind: KubecostAllocationKind;
  readonly total: Rational | null;
  readonly groupCount: number;
}

function kindTotals(rows: readonly KubecostAllocationGroup[], currency: string): readonly KindTotal[] {
  return KIND_ORDER.map((kind) => {
    const matching = rows.filter((row) => row.currency === currency && row.allocationKind === kind);
    return {
      kind,
      groupCount: matching.length,
      total: matching.length === 0 ? null : sumExact(matching.map((row) => row.totalCost)),
    };
  });
}

interface MetricEfficiency {
  readonly metric: KubecostMetric;
  readonly requested: Rational | null;
  readonly used: Rational | null;
  readonly ratio: Rational | null;
  readonly contributingGroupCount: number;
  readonly state: "complete" | "partial" | "unavailable";
}

/** Aggregate usage-versus-request efficiency for a set of groups, exactly. */
function metricEfficiency(
  rows: readonly KubecostAllocationGroup[],
  metric: KubecostMetric,
): MetricEfficiency {
  const evidence = rows.flatMap((row) => row.efficiencies.filter((item) =>
    item.metric === metric && item.requestedOrProvisioned !== null && item.used !== null));
  const requested = evidence.length === 0
    ? null
    : sumExact(evidence.map((item) => item.requestedOrProvisioned));
  const used = evidence.length === 0 ? null : sumExact(evidence.map((item) => item.used));
  const ratio = requested === null || used === null || requested.n === ZERO
    ? null
    : reduce({ n: used.n * requested.d, d: used.d * requested.n });
  return {
    metric,
    requested,
    used,
    ratio,
    contributingGroupCount: evidence.length,
    state: evidence.length === 0 ? "unavailable" : evidence.length === rows.length ? "complete" : "partial",
  };
}

const HALF: Rational = { n: ONE, d: TWO };
const WHOLE: Rational = { n: ONE, d: ONE };

/**
 * Container request-versus-usage signal. This is an observation with a stated
 * rule, not a resize, savings or capacity recommendation, and an unmeasured
 * container says so instead of scoring zero.
 */
function rightsizingSignal(row: KubecostAllocationGroup): string {
  const cpu = row.efficiencies.find((item) => item.metric === "CPU");
  const parsed = rational(cpu?.ratio ?? null);
  if (parsed === null) {
    return "Not measured — the accepted export carries no request/usage pair for this container";
  }
  if (compareRational(parsed, HALF) < 0) return "Observed usage below half of request — review candidate";
  if (compareRational(parsed, WHOLE) > 0) return "Observed usage above request — review candidate";
  return "Observed usage within request";
}

/* ----------------------------------------------------------------- small pieces */

function Tile({
  label, value, detail,
}: { readonly label: string; readonly value: string; readonly detail?: string }) {
  return (
    <div className={shared.tile}>
      <span className={shared.tileLabel}>{label}</span>
      <span className={shared.tileValue}>{value}</span>
      {detail === undefined ? null : <span className={shared.tileDetail}>{detail}</span>}
    </div>
  );
}

/** An explicit, labelled absence. Never a zero and never an inference. */
function Unavailable({ title, reasons }: { readonly title: string; readonly reasons: readonly string[] }) {
  return (
    <div className={shared.coverage} data-support="PARTIAL" role="status">
      <div className={shared.coverageHead}><strong>{title}</strong></div>
      <ul className={shared.coverageGaps}>
        {reasons.map((reason) => <li key={reason}>{reason}</li>)}
      </ul>
    </div>
  );
}

/**
 * Page scope of a derived figure. Aggregates the API computes cover every
 * matching group; anything derived here covers only the returned page, and says
 * which of the two it is.
 */
function PageScope({ report }: { readonly report: KubecostDashboardEnvelope }) {
  const complete = report.rows.length >= report.resultCount;
  return (
    <p className={shared.goalMeta}>
      Derived from the {formatCount(report.rows.length)} allocation
      {report.rows.length === 1 ? " group" : " groups"} returned for this page
      of {formatCount(report.resultCount)} matching.
      {complete
        ? " This page covers every matching group in the filter scope."
        : " It is a page-scoped figure, not the full filter scope; the remaining groups are reachable through the page cursor."}
    </p>
  );
}

/* ------------------------------------------------------------- official evidence */

export function KubecostOfficialSourcePanel({ definition }: { readonly definition: KubecostOfficialDefinition }) {
  return (
    <section className={styles.panel} aria-label="Official Kubecost dashboard source coverage">
      <h3>Official Kubecost source audit</h3>
      <p className={styles.muted}>
        AWS documents three purpose-level tabs. The linked repository publishes the CID manifest, one
        62-column SPICE dataset, one Terraform Athena view query, exporter, and deployment source.
        Its QuickSight template is service-hosted, so sheet, visual, control, parameter,
        calculated-field, filter-group, and pixel-geometry totals remain unknown rather than inferred.
      </p>
      <div className={styles.grid}>
        {definition.documentedAreas.map((area) => (
          <article className={styles.card} key={area.name}>
            <small>AWS-documented area · {area.nativeCoverage.toLocaleLowerCase()}</small>
            <strong>{area.name}</strong>
            <span>{area.documentedPurpose}</span>
            <span><b>Native:</b> {area.nativeEvidence}</span>
            <span><b>Remaining:</b> {area.remainingGap}</span>
          </article>
        ))}
      </div>
      <div className={styles.notice}>
        <strong>Supplemental OpenCost boundary.</strong> {definition.supplementalOpenCost.disclosure}
      </div>
      <details className={styles.evidence}>
        <summary>Immutable official artifacts and unpublished definition boundary</summary>
        <p>
          Official repository <code>{definition.sourceCommit}</code> · CID framework{" "}
          <code>{definition.cidFrameworkAudit.commit}</code> contains{" "}
          {definition.cidFrameworkAudit.kubecostDashboardSpecificArtifactCount} Kubecost-specific
          artifacts. Complete QuickSight definition: unpublished; exact object totals: null.
        </p>
        <ul>
          {definition.artifacts.map((artifact) => (
            <li key={artifact.kind}>
              <strong>{readable(artifact.kind)}</strong> · <code>{artifact.sha256}</code> · {artifact.hashBasis}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

/* --------------------------------------------------------------- Executive tab */

function ExecutiveArea({ report }: { readonly report: KubecostDashboardEnvelope }) {
  const currencies = report.executiveSummary.totals.map((total) => total.currency);
  const pageCurrencies = currenciesOf(report.rows);

  return (
    <div className={shared.blocks}>
      <FinopsSheetBlock
        description="Exact allocated cost, per currency, over every group matching the current filter scope. Currencies are never combined or converted."
        title="Allocated cost and efficiency"
      >
        <div className={shared.tiles}>
          {report.executiveSummary.totals.length === 0
            ? <Tile label="Total allocated cost" value="Not available" detail="No accepted allocation group matches this filter scope." />
            : report.executiveSummary.totals.map((total) => (
              <Tile
                detail="Attribution over authoritative CUR2 spend — never added to it"
                key={total.currency}
                label={`Total allocated cost · ${total.currency}`}
                value={formatExact(total.totalCost, total.currency)}
              />
            ))}
          {report.executiveSummary.efficiencies.map((item) => (
            <Tile
              detail={`${readable(item.state).toLowerCase()} · ${formatCount(item.contributingGroupCount)} contributing groups`}
              key={item.metric}
              label={`${item.metric} usage vs requests`}
              value={item.ratio === null
                ? "Not measured — no request/usage pair in the accepted export"
                : formatRatioPercent(item.ratio)}
            />
          ))}
          {report.executiveSummary.componentCosts.map((item) => (
            <Tile
              detail={`${formatCount(item.contributingGroupCount)} exact component groups`}
              key={`${item.currency}:${item.component}`}
              label={`${readable(item.component)} cost · ${item.currency}`}
              value={formatExact(item.totalCost, item.currency)}
            />
          ))}
        </div>
        {report.executiveSummary.efficiencies.some((item) => item.ratio === null) ? (
          <p className={shared.goalMeta}>
            An efficiency percentage is withheld when the accepted export publishes no request or
            usage quantity for a metric, or when the summed request is zero. Sutra does not
            substitute a node, price or name-derived estimate for a missing quantity.
          </p>
        ) : null}
      </FinopsSheetBlock>

      {currencies.map((currency) => {
        const components = report.executiveSummary.componentCosts.filter((item) => item.currency === currency);
        return components.length === 0 ? null : (
          <FinopsSheetBlock
            description="Cost by metric component. Bars keep their sign, so a negative component is visible rather than hidden in a ring."
            key={`components-${currency}`}
            title={`Component cost composition · ${currency}`}
          >
            <BarChart
              ariaLabel={`Allocated cost by cost component in ${currency}`}
              categories={components.map((item) => readable(item.component))}
              formatValue={(value) => formatUnits(value, currency)}
              series={[{
                id: "component",
                label: `${currency} allocated cost`,
                values: components.map((item) => geometryOf(item.totalCost)),
              }]}
            />
          </FinopsSheetBlock>
        );
      })}

      {pageCurrencies.map((currency) => {
        const totals = kindTotals(report.rows, currency);
        const present = totals.filter((item) => item.groupCount > 0 && item.total !== null);
        const anyNegative = present.some((item) => item.total !== null && item.total.n < ZERO);
        const positiveTotal = present.reduce(
          (accumulator, item) => item.total === null ? accumulator : addRational(accumulator, item.total),
          { n: ZERO, d: ONE } as Rational,
        );
        const shareable = !anyNegative && positiveTotal.n > ZERO;
        return (
          <FinopsSheetBlock
            description={`Idle, unallocated, shared, external and unmounted cost are named shares of their own. The export contract pins shareIdle=${String(KUBECOST_EXPORT_CONTRACT.query.shareIdle)} and splitIdle=${String(KUBECOST_EXPORT_CONTRACT.query.splitIdle)}, so no idle or unallocated cost is silently distributed onto a workload.`}
            key={`kinds-${currency}`}
            title={`Idle and unallocated share · ${currency}`}
          >
            {shareable ? (
              <ShareBar
                ariaLabel={`Allocated cost share by allocation kind in ${currency}`}
                formatValue={(value) => formatUnits(value, currency)}
                segments={present.flatMap((item) => {
                  const units = rationalForGeometry(item.total);
                  return units === null ? [] : [{
                    id: item.kind,
                    label: KIND_LABEL[item.kind],
                    value: units,
                    tone: KIND_TONE[item.kind],
                  }];
                })}
              />
            ) : (
              <>
                <p className={shared.goalMeta}>
                  A proportional share is withheld here: {anyNegative
                    ? "at least one kind carries a negative amount, and a share of a set containing a negative part would misstate every other part."
                    : "the total of the named kinds is not positive, so no part can be expressed as a proportion of it."}
                  {" "}The exact signed amounts are shown instead.
                </p>
                <BarChart
                  ariaLabel={`Signed allocated cost by allocation kind in ${currency}`}
                  categories={present.map((item) => item.kind)}
                  formatValue={(value) => formatUnits(value, currency)}
                  series={[{
                    id: "kind",
                    label: `${currency} allocated cost`,
                    values: present.map((item) => rationalForGeometry(item.total)),
                  }]}
                />
              </>
            )}
            <div className={shared.tableWrap}>
              <table className={shared.table}>
                <caption>
                  Every allocation kind the contract defines is listed. A kind with no group on this
                  page is absent evidence, not zero cost.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Allocation kind</th>
                    <th className={shared.numeric} scope="col">Exact cost</th>
                    <th className={shared.numeric} scope="col">Groups</th>
                  </tr>
                </thead>
                <tbody>
                  {totals.map((item) => (
                    <tr key={item.kind}>
                      <th scope="row">{KIND_LABEL[item.kind]}</th>
                      <td className={shared.numeric}>
                        {item.groupCount === 0
                          ? <span className={styles.unknown}>Not present in this page of evidence</span>
                          : formatExactRational(item.total, currency)}
                      </td>
                      <td className={shared.numeric}>{formatCount(item.groupCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PageScope report={report} />
          </FinopsSheetBlock>
        );
      })}

      <FinopsSheetBlock
        description="Account and cluster attribution over the whole filter scope, on the exact aggregates the API computes."
        title="Total cost by account and top spending clusters"
      >
        {currencies.length === 0 ? (
          <Unavailable
            reasons={["No accepted allocation group matches this filter scope, so no account or cluster ranking exists."]}
            title="No account or cluster evidence"
          />
        ) : currencies.map((currency) => (
          <div key={`ranking-${currency}`}>
            <RankingBars
              ariaLabel={`Total cost by account in ${currency}`}
              caption={`Accounts carrying ${currency} container allocation.`}
              formatValue={(value) => formatUnits(value, currency)}
              items={report.byAccount.filter((item) => item.currency === currency).flatMap((item) => {
                const units = geometryOf(item.totalCost);
                return units === null ? [] : [{
                  id: `account-${item.accountId}`,
                  label: `Account ${item.accountId}`,
                  value: units,
                  detail: `${formatCount(item.groupCount)} allocation groups · ${formatExact(item.totalCost, currency)}`,
                }];
              })}
              sort
            />
            <RankingBars
              ariaLabel={`Top spending clusters in ${currency}`}
              caption={`Clusters carrying ${currency} container allocation.`}
              formatValue={(value) => formatUnits(value, currency)}
              items={report.topClusters.filter((item) => item.currency === currency).flatMap((item) => {
                const units = geometryOf(item.totalCost);
                return units === null ? [] : [{
                  id: `cluster-${item.clusterId}`,
                  label: item.clusterId,
                  value: units,
                  detail: `${formatCount(item.groupCount)} allocation groups · ${formatExact(item.totalCost, currency)}`,
                  tone: "teal" as const,
                }];
              })}
              sort
              tone="teal"
            />
          </div>
        ))}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Daily windows exactly as the official export delivers them. A window with no accepted row is a gap, never a zero."
        title="Daily allocated-cost trend"
      >
        {report.hourlyCosts.length === 0 ? (
          <Unavailable
            reasons={["The accepted export carries no windowed allocation for this filter scope, so no trend can be drawn."]}
            title="No windowed allocation evidence"
          />
        ) : currencies.map((currency) => {
          const windows = report.hourlyCosts.filter((item) => item.currency === currency);
          return (
            <TimeSeriesChart
              ariaLabel={`Daily allocated cost in ${currency}`}
              formatValue={(value) => formatUnits(value, currency)}
              key={`trend-${currency}`}
              mode="area"
              series={[{
                id: `trend-${currency}`,
                label: `${currency} allocated cost`,
                points: windows.map((item) => ({
                  label: item.windowStartIso.slice(0, 10),
                  value: geometryOf(item.totalCost),
                })),
              }]}
            />
          );
        })}
        <div className={shared.tableWrap}>
          <table className={shared.table}>
            <caption>Exact windowed allocation, with the source row count behind each window.</caption>
            <thead>
              <tr>
                <th scope="col">UTC window</th>
                <th scope="col">Currency</th>
                <th className={shared.numeric} scope="col">Exact allocated cost</th>
                <th className={shared.numeric} scope="col">Source rows</th>
              </tr>
            </thead>
            <tbody>
              {report.hourlyCosts.map((item) => (
                <tr key={`${item.windowStartIso}:${item.currency}`}>
                  <th scope="row">
                    <time dateTime={item.windowStartIso}>{item.windowStartIso.replace("T", " ").slice(0, 16)}</time>
                    {" – "}
                    {item.windowEndIso.replace("T", " ").slice(0, 16)}
                  </th>
                  <td>{item.currency}</td>
                  <td className={shared.numeric}>{formatExact(item.totalCost, item.currency)}</td>
                  <td className={shared.numeric}>{formatCount(item.rowCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Cluster efficiency is the exact sum of published request and usage quantities, per metric. A cluster with no published pair is unmeasured, not efficient."
        title="Cluster efficiency"
      >
        {report.rows.length === 0 ? (
          <Unavailable
            reasons={["No allocation group is on this page, so no cluster efficiency can be summed."]}
            title="No cluster efficiency evidence"
          />
        ) : (
          <>
            <div className={shared.tableWrap}>
              <table className={shared.table}>
                <caption>
                  Quantities keep their source units: CPU in core-hours, RAM in byte-hours. They are
                  never converted into each other or into money.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Cluster</th>
                    <th scope="col">Metric</th>
                    <th className={shared.numeric} scope="col">Requested / provisioned</th>
                    <th className={shared.numeric} scope="col">Used</th>
                    <th className={shared.numeric} scope="col">Efficiency</th>
                    <th scope="col">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {[...new Set(report.rows.map((row) => row.clusterId))].sort().flatMap((clusterId) => {
                    const clusterRows = report.rows.filter((row) => row.clusterId === clusterId);
                    return METRICS.map((metric) => {
                      const summary = metricEfficiency(clusterRows, metric);
                      return (
                        <tr key={`${clusterId}:${metric}`}>
                          <th scope="row">{clusterId}</th>
                          <td>{metric}</td>
                          <td className={shared.numeric}>
                            {summary.requested === null
                              ? <span className={styles.unknown}>Not published</span>
                              : exactDecimal(summary.requested, 0) ?? `${summary.requested.n.toString()}/${summary.requested.d.toString()}`}
                          </td>
                          <td className={shared.numeric}>
                            {summary.used === null
                              ? <span className={styles.unknown}>Not published</span>
                              : exactDecimal(summary.used, 0) ?? `${summary.used.n.toString()}/${summary.used.d.toString()}`}
                          </td>
                          <td className={shared.numeric}>
                            {summary.ratio === null
                              ? <span className={styles.unknown}>Not measured</span>
                              : formatRatioPercent({ numerator: summary.ratio.n.toString(), denominator: summary.ratio.d.toString() })}
                          </td>
                          <td>
                            <StateBadge state={summary.state} />{" "}
                            {formatCount(summary.contributingGroupCount)} of {formatCount(clusterRows.length)} groups
                          </td>
                        </tr>
                      );
                    });
                  })}
                </tbody>
              </table>
            </div>
            <PageScope report={report} />
          </>
        )}
      </FinopsSheetBlock>
    </div>
  );
}

/* -------------------------------------------------------- Workloads Explorer tab */

function WorkloadsArea({ report }: { readonly report: KubecostDashboardEnvelope }) {
  const pageCurrencies = currenciesOf(report.rows);
  const pivots = [
    { key: "namespaces", label: "namespaces", entries: report.pivots.namespaces },
    { key: "controllers", label: "controllers", entries: report.pivots.controllers },
    { key: "workloads", label: "workloads", entries: report.pivots.workloads },
    { key: "nodes", label: "nodes", entries: report.pivots.nodes },
  ] as const;

  return (
    <div className={shared.blocks}>
      {pageCurrencies.map((currency) => {
        const namespaces = [...new Set(report.rows
          .filter((row) => row.currency === currency)
          .map((row) => row.namespace ?? "UNALLOCATED"))].sort();
        const componentsPresent = COMPONENT_ORDER.filter((component) => report.rows
          .some((row) => row.currency === currency
            && row.componentCosts.some((item) => item.component === component)));
        return namespaces.length === 0 ? null : (
          <FinopsSheetBlock
            description="Stacked by cost component within one currency. A component the export does not carry for a namespace is not collected, not zero, and a namespace with no name is shown as unallocated rather than dropped."
            key={`stack-${currency}`}
            title={`Namespace cost by component · ${currency}`}
          >
            <BarChart
              ariaLabel={`Namespace cost stacked by cost component in ${currency}`}
              categories={namespaces.map((namespace) => dimensionLabel(namespace))}
              formatValue={(value) => formatUnits(value, currency)}
              layout="stacked"
              series={componentsPresent.map((component) => ({
                id: component,
                label: readable(component),
                values: namespaces.map((namespace) => {
                  const matching = report.rows.filter((row) => row.currency === currency
                    && (row.namespace ?? "UNALLOCATED") === namespace);
                  const parts = matching.flatMap((row) => row.componentCosts
                    .filter((item) => item.component === component)
                    .map((item) => item.exact));
                  return parts.length === 0 ? null : rationalForGeometry(sumExact(parts));
                }),
              }))}
            />
            <PageScope report={report} />
          </FinopsSheetBlock>
        );
      })}

      {pivots.map((pivot) => (
        <FinopsSheetBlock
          description="Exact aggregate over every group in the filter scope, ranked by allocated cost."
          key={pivot.key}
          title={`Pivot by ${pivot.label}`}
        >
          {pivot.entries.length === 0 ? (
            <Unavailable
              reasons={[`The filter scope produced no ${pivot.label} aggregate, so nothing is ranked.`]}
              title={`No ${pivot.label} pivot evidence`}
            />
          ) : [...new Set(pivot.entries.map((entry) => entry.currency))].sort().map((currency) => (
            <RankingBars
              ariaLabel={`Allocated cost by ${pivot.label} in ${currency}`}
              formatValue={(value) => formatUnits(value, currency)}
              key={`${pivot.key}-${currency}`}
              items={pivot.entries.filter((entry) => entry.currency === currency).flatMap((entry) => {
                const units = geometryOf(entry.totalCost);
                return units === null ? [] : [{
                  id: `${pivot.key}-${entry.identity}`,
                  label: dimensionLabel(entry.identity),
                  value: units,
                  detail: `${formatCount(entry.groupCount)} groups · ${formatExact(entry.totalCost, currency)}`,
                  tone: (entry.identity === "UNALLOCATED" || entry.identity === "UNAVAILABLE"
                    ? "amber"
                    : "blue") as "amber" | "blue",
                }];
              })}
              sort
            />
          ))}
        </FinopsSheetBlock>
      ))}

      <FinopsSheetBlock
        description="Cluster, namespace, controller, workload, pod, container and node exactly as the accepted export publishes them. A dimension the export omits is shown as unavailable and is never inferred from a name."
        title="Workload allocation rows"
      >
        {report.rows.length === 0 ? (
          <Unavailable
            reasons={["No accepted allocation group matches this filter scope and page cursor."]}
            title="No workload rows"
          />
        ) : (
          <>
            <div className={shared.tableWrap}>
              <table className={shared.table}>
                <caption>
                  Request-versus-usage signals are observations against a stated rule: they are not
                  resize, savings, purchase or capacity recommendations.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Account / cluster</th>
                    <th scope="col">Namespace</th>
                    <th scope="col">Controller / workload</th>
                    <th scope="col">Pod / container</th>
                    <th scope="col">Node / instance</th>
                    <th scope="col">Kind</th>
                    <th className={shared.numeric} scope="col">Exact total</th>
                    <th className={shared.numeric} scope="col">CPU efficiency</th>
                    <th className={shared.numeric} scope="col">RAM efficiency</th>
                    <th scope="col">Request vs usage signal</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row, index) => {
                    const cpu = row.efficiencies.find((item) => item.metric === "CPU");
                    const ram = row.efficiencies.find((item) => item.metric === "RAM");
                    return (
                      <tr key={`${row.sourceRowIds[0] ?? row.clusterId}:${row.currency}:${index}`}>
                        <th scope="row">{row.usageAccountId}<br />{row.clusterId}</th>
                        <td>{row.namespace ?? <span className={styles.unknown}>Unallocated</span>}</td>
                        <td>
                          {row.controllerKind ?? "No controller kind"} / {row.controller ?? "No controller"}
                          <br />{row.workload ?? "No workload"}
                        </td>
                        <td>
                          {row.pod ?? "No pod"}<br />{row.container ?? "No container"}
                        </td>
                        <td>
                          {row.node ?? <span className={styles.unknown}>Node not published</span>}
                          <br />
                          {row.nodeInstanceType ?? <span className={styles.unknown}>Instance type not published</span>}
                          {" · "}
                          {row.nodeCapacityType ?? <span className={styles.unknown}>Capacity type not published</span>}
                        </td>
                        <td><span className={styles.pill}>{row.allocationKind}</span></td>
                        <td className={shared.numeric}>{formatExact(row.totalCost, row.currency)}</td>
                        <td className={shared.numeric}>{formatRatioPercent(cpu?.ratio ?? null)}</td>
                        <td className={shared.numeric}>{formatRatioPercent(ram?.ratio ?? null)}</td>
                        <td>{rightsizingSignal(row)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className={shared.goalMeta}>
              {report.nextCursor === null
                ? "This page carries every matching allocation group."
                : `${formatCount(Math.max(0, report.resultCount - report.rows.length))} further matching groups are not on this page; the API returns cursor ${report.nextCursor}.`}
            </p>
          </>
        )}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Namespace-level attribution suitable for showback, with unallocated cluster cost named as its own row instead of being spread across teams."
        title="Showback / chargeback evidence"
      >
        {report.pivots.namespaces.length === 0 ? (
          <Unavailable
            reasons={["The filter scope produced no namespace aggregate, so there is no showback attribution to present."]}
            title="No showback evidence"
          />
        ) : (
          <div className={shared.tableWrap}>
            <table className={shared.table}>
              <caption>
                Reconciled showback evidence. Unallocated and idle cluster cost is presented as its
                own named attribution and is never charged silently to a namespace.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Namespace</th>
                  <th scope="col">Currency</th>
                  <th className={shared.numeric} scope="col">Exact allocated cost</th>
                  <th className={shared.numeric} scope="col">Groups</th>
                </tr>
              </thead>
              <tbody>
                {report.pivots.namespaces.map((item) => (
                  <tr key={`${item.identity}:${item.currency}`}>
                    <th scope="row">
                      {item.identity === "UNALLOCATED"
                        ? <span className={styles.unknown}>Unallocated cluster cost (named, not distributed)</span>
                        : item.identity}
                    </th>
                    <td>{item.currency}</td>
                    <td className={shared.numeric}>{formatExact(item.totalCost, item.currency)}</td>
                    <td className={shared.numeric}>{formatCount(item.groupCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={shared.goalMeta}>
          This is read-only evidence attribution. No invoice, journal entry, transfer or chargeback
          posting is created by this dashboard.
        </p>
      </FinopsSheetBlock>
    </div>
  );
}

/* ------------------------------------------------------------- EKS Breakdown tab */

function EksArea({ report }: { readonly report: KubecostDashboardEnvelope }) {
  const dimensions = [
    { key: "capacity", title: "Capacity type", entries: report.eksBreakdown.capacityTypes },
    { key: "instance", title: "Instance type", entries: report.eksBreakdown.instanceTypes },
    { key: "nodegroup", title: "Node group", entries: report.eksBreakdown.nodeGroups },
    { key: "architecture", title: "Architecture", entries: report.eksBreakdown.architectures },
  ] as const;

  return (
    <div className={shared.blocks}>
      {dimensions.map((dimension) => (
        <FinopsSheetBlock
          description="Accepted only from the pinned 62-column official export. A row whose dimension the export omits is grouped as unpublished and keeps its exact cost; the dimension is never inferred from an instance name or a price."
          key={dimension.key}
          title={`${dimension.title} breakdown`}
        >
          {dimension.entries.length === 0 ? (
            <Unavailable
              reasons={[`No accepted group in this filter scope carries a ${dimension.title.toLowerCase()} aggregate.`]}
              title={`No ${dimension.title.toLowerCase()} evidence`}
            />
          ) : (
            <>
              {[...new Set(dimension.entries.map((entry) => entry.currency))].sort().map((currency) => (
                <RankingBars
                  ariaLabel={`Allocated cost by ${dimension.title.toLowerCase()} in ${currency}`}
                  formatValue={(value) => formatUnits(value, currency)}
                  key={`${dimension.key}-${currency}`}
                  items={dimension.entries.filter((entry) => entry.currency === currency).flatMap((entry) => {
                    const units = geometryOf(entry.totalCost);
                    return units === null ? [] : [{
                      id: `${dimension.key}-${entry.identity}`,
                      label: dimensionLabel(entry.identity),
                      value: units,
                      detail: `${formatCount(entry.groupCount)} groups · ${formatExact(entry.totalCost, currency)}`,
                      tone: (entry.identity === "UNAVAILABLE" ? "amber" : "blue") as "amber" | "blue",
                    }];
                  })}
                  sort
                />
              ))}
              <div className={shared.tableWrap}>
                <table className={shared.table}>
                  <caption>
                    Group counts are allocation groups, not pods. Pod counts are not published by
                    this projection and are not derived from group counts.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{dimension.title}</th>
                      <th scope="col">Currency</th>
                      <th className={shared.numeric} scope="col">Exact allocated cost</th>
                      <th className={shared.numeric} scope="col">Allocation groups</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dimension.entries.map((entry) => (
                      <tr key={`${dimension.key}:${entry.identity}:${entry.currency}`}>
                        <th scope="row">
                          {entry.identity === "UNAVAILABLE"
                            ? <span className={styles.unknown}>{dimensionLabel(entry.identity)}</span>
                            : entry.identity}
                        </th>
                        <td>{entry.currency}</td>
                        <td className={shared.numeric}>{formatExact(entry.totalCost, entry.currency)}</td>
                        <td className={shared.numeric}>{formatCount(entry.groupCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </FinopsSheetBlock>
      ))}

      <FinopsSheetBlock
        description="What this documented area cannot show from the accepted evidence."
        title="Explicitly unavailable in this vertical"
      >
        <Unavailable
          reasons={[
            "Node allocatable capacity is not published: the accepted projection carries request and usage quantities per allocation group, not node capacity, so node headroom and node-level utilization are unavailable rather than derived.",
            "Instance-level sizing is not published: the export carries the instance type as a dimension only, with no vCPU, memory, generation or price attribute, so no instance comparison, family recommendation or resize target is presented.",
            "Pod distribution and pod coverage counts are unavailable: this projection aggregates allocation groups, and a group count is not a pod count.",
            "A dimension absent from a row stays absent. Sutra never infers capacity type, architecture, node group or instance type from a node name, an image identifier or a price.",
          ]}
          title="Node capacity and instance dimensions"
        />
      </FinopsSheetBlock>
    </div>
  );
}

/* ------------------------------------------------------------------ tab plumbing */

/**
 * One documented area's content. Exported so a test can render each area
 * directly, with no fetch and no tab interaction.
 */
export function FinopsKubecostAreaContent({
  report, area,
}: { readonly report: KubecostDashboardEnvelope; readonly area: KubecostOfficialArea }) {
  switch (area.name) {
    case "Executive Summary": return <ExecutiveArea report={report} />;
    case "Workloads Explorer": return <WorkloadsArea report={report} />;
    case "EKS Breakdown": return <EksArea report={report} />;
    default: return (
      <Unavailable
        reasons={[`Sutra has no projection for the documented area "${area.name}". It is listed because AWS documents it, and it is not presented as delivered.`]}
        title="No projection for this documented area"
      />
    );
  }
}

function AreaDisclosure({ area }: { readonly area: KubecostOfficialArea }) {
  return (
    <section
      aria-label={`${area.name} coverage`}
      className={shared.coverage}
      data-support={area.nativeCoverage}
    >
      <div className={shared.coverageHead}>
        <strong>{area.name}</strong>
        <span className={shared.coverageBadge} data-support={area.nativeCoverage}>
          {readable(area.nativeCoverage)}
        </span>
        <span className={shared.coverageMeta}>
          Official visual, control and parameter totals: unavailable — the QuickSight definition is
          service-hosted and unpublished at the pinned commit
        </span>
      </div>
      <ul className={shared.coverageGaps}>
        <li><b>AWS-documented purpose:</b> {area.documentedPurpose}</li>
        <li><b>Native evidence:</b> {area.nativeEvidence}</li>
        <li><b>Remaining gap:</b> {area.remainingGap}</li>
      </ul>
    </section>
  );
}

function ProvenancePanel({ report }: { readonly report: KubecostDashboardEnvelope }) {
  const reconciliation = report.reconciliation ?? {};
  const currencies = reconciliation.currencies ?? [];
  const coverage = report.coverage ?? {};
  const lineage = report.source ?? {};
  const freshness = report.freshness ?? {};
  const pins = report.evidence ?? {};
  const provider = lineage.provider ?? null;

  return (
    <details className={`${styles.panel} ${styles.evidence}`}>
      <summary>Reconciliation, provenance, coverage, and history</summary>

      <h4>Reconciliation to the active CUR2 generation</h4>
      <p>
        State: <StateBadge state={(reconciliation.state ?? "unavailable").toLowerCase()} />{" "}
        {reconciliation.presentationPolicy === undefined
          ? "Presentation policy not published by this response."
          : readable(reconciliation.presentationPolicy).toLowerCase()}
        {reconciliation.toleranceMicros === undefined
          ? ""
          : ` · tolerance ${reconciliation.toleranceMicros} micro-units`}
      </p>
      {currencies.length === 0 ? (
        <Unavailable
          reasons={["This response carries no per-currency reconciliation, so agreement with CUR2 is unavailable rather than assumed."]}
          title="Reconciliation unavailable"
        />
      ) : (
        <div className={shared.tableWrap}>
          <table className={shared.table}>
            <caption>
              Kubecost totals are exact currency units; CUR2 totals are exact integer micro-units.
              The two are compared, never added together.
            </caption>
            <thead>
              <tr>
                <th scope="col">Currency</th>
                <th className={shared.numeric} scope="col">Kubecost attribution</th>
                <th className={shared.numeric} scope="col">Active CUR2 total</th>
                <th className={shared.numeric} scope="col">Kubecost minus CUR2</th>
                <th scope="col">Within tolerance</th>
              </tr>
            </thead>
            <tbody>
              {currencies.map((item) => (
                <tr key={item.currency}>
                  <th scope="row">{item.currency}</th>
                  <td className={shared.numeric}>{formatExact(item.kubecostTotal, item.currency)}</td>
                  <td className={shared.numeric}>
                    {item.cur2TotalMicros === null
                      ? <span className={styles.unknown}>Not available</span>
                      : formatMicrosExact(item.cur2TotalMicros, item.currency)}
                  </td>
                  <td className={shared.numeric}>
                    {item.delta === null
                      ? <span className={styles.unknown}>Not available</span>
                      : formatExact(item.delta, item.currency)}
                  </td>
                  <td>
                    {item.withinTolerance === null
                      ? <span className={styles.unknown}>Unknown</span>
                      : item.withinTolerance ? "Yes" : "No"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4>Export provenance and coverage</h4>
      <div className={shared.tiles}>
        <Tile
          detail={provider === "OPENCOST"
            ? "Supplemental Sutra source — never counted as official AWS Kubecost dashboard coverage"
            : provider === "KUBECOST"
              ? "Official self-hosted Kubecost export"
              : "Provider not published by this response"}
          label="Attribution provider"
          value={provider ?? "Not available"}
        />
        <Tile
          label="Objects processed"
          value={coverage.processedObjects === undefined || coverage.expectedObjects === undefined
            ? "Not available"
            : `${formatCount(coverage.processedObjects)} of ${formatCount(coverage.expectedObjects)}`}
          detail={coverage.failedObjects === undefined
            ? "Failed-object count not published"
            : `${formatCount(coverage.failedObjects)} failed`}
        />
        <Tile
          label="Clusters captured"
          value={coverage.capturedClusters === undefined || coverage.expectedClusters === undefined
            ? "Not available"
            : `${formatCount(coverage.capturedClusters)} of ${formatCount(coverage.expectedClusters)}`}
          detail={coverage.rowsExhausted === true ? "Row bound reached for this capture" : undefined}
        />
        <Tile
          detail={freshness.staleAfterHours === undefined
            ? undefined
            : `Objective: ${formatCount(freshness.staleAfterHours)} hours`}
          label="Evidence age"
          value={freshness.ageHours === undefined ? "Not available" : `${freshness.ageHours} hours`}
        />
        <Tile
          label="Data through"
          value={freshness.dataThroughAt ?? "Not available"}
        />
        <Tile
          detail={pins.newerIncomplete === true
            ? "A newer incomplete attempt exists and has not replaced this accepted head"
            : undefined}
          label="Active CUR2 generation"
          value={pins.activeCur2GenerationId ?? "Not available"}
        />
      </div>
      <ul className={shared.formulaList}>
        {lineage.exporterName === undefined
          ? <li>Exporter identity not published by this response.</li>
          : <li>exporter {lineage.exporterName} {lineage.exporterVersion ?? ""}</li>}
        {lineage.schemaName === undefined
          ? null
          : <li>schema {lineage.schemaName} {lineage.schemaVersion ?? ""}</li>}
        {lineage.manifestSha256 === undefined ? null : <li>manifest {lineage.manifestSha256}</li>}
        {lineage.querySha256 === undefined ? null : <li>query {lineage.querySha256}</li>}
        {lineage.costModelSha256 === undefined ? null : <li>cost model {lineage.costModelSha256}</li>}
        {lineage.objectCount === undefined
          ? null
          : <li>{formatCount(lineage.objectCount)} objects, {formatCount(lineage.versionPinnedObjectCount ?? 0)} version-pinned</li>}
        {pins.sourceCaptureId === undefined ? null : <li>capture {pins.sourceCaptureId}</li>}
        {pins.generationId === undefined ? null : <li>generation {pins.generationId}</li>}
        {pins.contentSha256 === undefined ? null : <li>content {pins.contentSha256}</li>}
      </ul>

      <h4>Disclosures</h4>
      <ul className={shared.coverageGaps}>
        {report.disclosures.length === 0
          ? <li>No disclosure was published with this response.</li>
          : report.disclosures.map((disclosure) => <li key={disclosure}>{disclosure}</li>)}
      </ul>

      <h4>Accepted-head history</h4>
      {report.history.length === 0
        ? <p>No prior accepted head is published for this connection.</p>
        : <pre>{JSON.stringify(report.history, null, 2)}</pre>}
    </details>
  );
}

/**
 * Presentation for a loaded Kubecost report: the disclosure chrome, the three
 * AWS-documented purpose tabs and the active tab. Takes the envelope directly so
 * it can be rendered from a test or a server snapshot with no fetching.
 */
export function FinopsKubecostAllocationSheets({
  report, initialAreaName,
}: {
  readonly report: KubecostDashboardEnvelope;
  readonly initialAreaName?: KubecostOfficialArea["name"];
}) {
  const areas = useMemo<readonly KubecostOfficialArea[]>(
    () => (report.officialDefinition?.documentedAreas?.length ?? 0) > 0
      ? report.officialDefinition.documentedAreas
      : KUBECOST_OFFICIAL_DEFINITION.documentedAreas,
    [report.officialDefinition],
  );
  const [activeName, setActiveName] = useState<string>(initialAreaName ?? areas[0]!.name);
  const active = areas.find((area) => area.name === activeName) ?? areas[0]!;
  const status = stateText(report.sourceState);
  const provider = report.source?.provider ?? null;

  return (
    <section aria-label="Kubecost containers cost allocation dashboard" className={styles.root}>
      <div className={styles.notice}>
        <strong>Allocation, not additional spend.</strong> Official coverage is Kubecost
        self-hosted; OpenCost is a clearly supplemental Sutra source. Either attribution source is
        reconciled to the pinned active CUR2 generation and must never be added to CUR2. Currencies
        remain separate. Showback / chargeback evidence here is read-only attribution and posts
        nothing.
      </div>
      {provider === "OPENCOST" ? (
        <div className={`${styles.state} ${styles.warning}`} role="status">
          <strong>Supplemental OpenCost evidence.</strong>{" "}
          {KUBECOST_OFFICIAL_DEFINITION.supplementalOpenCost.disclosure}
        </div>
      ) : null}
      <div className={styles.state} role="status">
        <strong>Collection runtime:</strong> {report.collection.runtimeState}.{" "}
        {report.collection.sharedWorkerRegistered
          ? "The local worker binding is registered."
          : "The provider path is implemented and awaiting its shared worker hook."}
        {" "}<StateBadge state={report.sourceState} /> {readable(report.collection.reason).toLowerCase()}
      </div>
      {status === null ? null : (
        <div
          className={`${styles.state} ${report.sourceState === "failed" ? styles.error : styles.warning}`}
          role="status"
        >
          {status}
        </div>
      )}

      <div className={shared.shell}>
        <div className={shared.shellHead}>
          <p className={shared.inventory}>
            <span><b>{areas.length}</b> AWS-documented purpose tabs</span>
            <span>official visual and control totals: <b>unavailable</b></span>
            <span className={shared.inventoryPin}>
              pinned {(report.officialDefinition?.sourceCommit ?? KUBECOST_OFFICIAL_DEFINITION.sourceCommit).slice(0, 12)}
              {" · dataset "}
              {report.officialDefinition?.publishedData?.inputColumnCount
                ?? KUBECOST_OFFICIAL_DEFINITION.publishedData.inputColumnCount} columns
            </span>
          </p>
        </div>

        <div aria-label="Official Kubecost dashboard tabs" className={shared.tabs} role="tablist">
          {areas.map((area) => {
            const selected = area.name === active.name;
            return (
              <button
                aria-controls={`kubecost-panel-${area.name.replaceAll(" ", "-")}`}
                aria-selected={selected}
                className={selected
                  ? `${shared.tab} ${shared.tabActive}`
                  : area.nativeCoverage === "PARTIAL" ? `${shared.tab} ${shared.tabPartial}` : shared.tab}
                id={`kubecost-tab-${area.name.replaceAll(" ", "-")}`}
                key={area.name}
                onClick={() => setActiveName(area.name)}
                role="tab"
                tabIndex={selected ? 0 : -1}
                type="button"
              >
                {area.name}
                <span className={shared.tabCount}>{readable(area.nativeCoverage).toLowerCase()}</span>
              </button>
            );
          })}
        </div>

        <div
          aria-labelledby={`kubecost-tab-${active.name.replaceAll(" ", "-")}`}
          className={shared.panel}
          id={`kubecost-panel-${active.name.replaceAll(" ", "-")}`}
          role="tabpanel"
          tabIndex={0}
        >
          <AreaDisclosure area={active} />
          <FinopsKubecostAreaContent area={active} report={report} />
        </div>
      </div>

      <ProvenancePanel report={report} />
    </section>
  );
}

/**
 * The stateful filter chrome plus the presentational view. Signature is
 * unchanged: a shared registry and the vertical's tests depend on it.
 */
export function FinopsKubecostAllocationReportView({
  report, filters, onFiltersChange,
}: {
  readonly report: KubecostDashboardEnvelope;
  readonly filters: Filters;
  readonly onFiltersChange: (filters: Filters) => void;
}) {
  const set = (key: keyof Filters, value: string) =>
    onFiltersChange({ ...filters, [key]: value || undefined });
  const selects = [
    { key: "accountId" as const, label: "Account", values: options(report.rows.map((row) => row.usageAccountId)) },
    { key: "clusterId" as const, label: "Cluster", values: options(report.rows.map((row) => row.clusterId)) },
    { key: "namespace" as const, label: "Namespace", values: options(report.rows.map((row) => row.namespace)) },
    { key: "nodeCapacityType" as const, label: "Capacity type", values: options(report.rows.map((row) => row.nodeCapacityType)) },
    { key: "nodeInstanceType" as const, label: "Instance type", values: options(report.rows.map((row) => row.nodeInstanceType)) },
    { key: "allocationKind" as const, label: "Allocation kind", values: KIND_ORDER },
    { key: "currency" as const, label: "Currency", values: options(report.rows.map((row) => row.currency)) },
  ];

  return (
    <>
      <div aria-label="Workloads Explorer filters" className={styles.filters}>
        {selects.map((select) => (
          <label key={select.key}>
            {select.label}
            <select onChange={(event) => set(select.key, event.target.value)} value={filters[select.key] ?? ""}>
              <option value="">All</option>
              {select.values.map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
        ))}
      </div>
      <p className={shared.goalMeta}>
        Filter options are the values present in the returned page of accepted evidence. A dimension
        the export never published cannot be filtered on and is not offered as a choice.
      </p>
      <FinopsKubecostAllocationSheets report={report} />
    </>
  );
}

export function FinopsKubecostAllocationDashboard({ connectionId }: { readonly connectionId: string | null }) {
  const [filters, setFilters] = useState<Filters>({});
  const [state, setState] = useState<{
    report: KubecostDashboardEnvelope | null;
    error: string | null;
    configurationRequired: boolean;
    officialDefinition: KubecostOfficialDefinition;
  }>({ report: null, error: null, configurationRequired: false, officialDefinition: KUBECOST_OFFICIAL_DEFINITION });

  useEffect(() => {
    if (connectionId === null) return;
    const controller = new AbortController();
    const parameters = new URLSearchParams({ connectionId });
    for (const [key, value] of Object.entries(filters)) if (value) parameters.set(key, value);
    fetch(`/api/v1/finops/kubecost-allocation?${parameters.toString()}`, {
      signal: controller.signal, headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Kubecost allocation request failed");
        return response.json() as Promise<
          KubecostDashboardEnvelope | { readonly dashboard: null; readonly officialDefinition: KubecostOfficialDefinition }
        >;
      })
      .then((report) => {
        if (!hasPinnedOfficialDefinition(report.officialDefinition)) {
          throw new Error("Sutra returned an unrecognized official Kubecost source audit");
        }
        if ("dashboard" in report && report.dashboard === null) {
          setState({ report: null, error: null, configurationRequired: true, officialDefinition: report.officialDefinition });
        } else {
          setState({
            report: report as KubecostDashboardEnvelope,
            error: null,
            configurationRequired: false,
            officialDefinition: report.officialDefinition,
          });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState((current) => ({
            report: null,
            error: error instanceof Error ? error.message : "Kubecost allocation request failed",
            configurationRequired: false,
            officialDefinition: current.officialDefinition,
          }));
        }
      });
    return () => controller.abort();
  }, [connectionId, filters]);

  let content;
  if (connectionId === null) {
    content = (
      <div className={`${styles.state} ${styles.warning}`} role="status">
        <strong>Unavailable.</strong> Connect an active AWS trust-role account before configuring
        Kubecost allocation.
      </div>
    );
  } else if (state.configurationRequired) {
    content = (
      <div className={`${styles.state} ${styles.warning}`} role="status">
        <strong>Unavailable.</strong> Configure the official self-hosted Kubecost exporter (or
        Sutra&apos;s supplemental OpenCost source) and its signed versioned-object ingest binding. No
        allocation state is synthesized.
      </div>
    );
  } else if (state.error !== null) {
    content = <div className={`${styles.state} ${styles.error}`} role="alert"><strong>Failed.</strong> {state.error}</div>;
  } else if (state.report === null || state.report.connectionId !== connectionId) {
    content = <div className={styles.state} role="status"><strong>Collecting.</strong> Loading reconciled container allocation…</div>;
  } else {
    content = (
      <FinopsKubecostAllocationReportView
        filters={filters}
        onFiltersChange={setFilters}
        report={state.report}
      />
    );
  }

  return (
    <section className={styles.root}>
      <KubecostOfficialSourcePanel definition={state.officialDefinition} />
      {content}
    </section>
  );
}

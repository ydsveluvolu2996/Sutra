"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart, RankingBars, ShareBar } from "../components/charts";
import { StateBadge, formatMicrosExact } from "./finops-foundational-panels";
import { formatCount, formatUnits, microsToUnits } from "./finops-foundational-money";
import { buildDataTransferEvidenceCsv } from "../../lib/finops-data-transfer-export";
import type {
  DataTransferCategory,
  DataTransferCategorySummary,
  DataTransferCostBasis,
  DataTransferCostSummary,
  DataTransferDrilldown,
  DataTransferSnapshot,
} from "../../lib/finops-data-transfer";
import type {
  DataTransferDocumentedVisualPurpose,
  DataTransferOfficialAudit,
} from "../../lib/finops-data-transfer-official-audit";
import styles from "./finops-data-transfer-dashboard.module.css";

/**
 * ADD-10 Data Transfer, presented as the five purposes AWS documents for the
 * official DataTransfer Cost Analysis dashboard.
 *
 * The pinned audit is explicit that AWS publishes no QuickSight definition,
 * template body or changelog for this dashboard, so its exact sheet, visual and
 * control totals are unavailable. This view therefore organises itself by the
 * five documented purposes and never states a sheet or visual count: an
 * unavailable total is disclosed as unavailable rather than guessed.
 *
 * Every figure comes from `/api/v1/finops/data-transfer`, which returns the
 * canonical `buildDataTransferAnalysis` snapshot. Money is an integer count of
 * currency micro-units carried as a string: exact figures print through
 * `formatMicrosExact`, which never converts to a number, and a value is
 * converted with `microsToUnits` only to give a chart its geometry. Byte
 * evidence stays in exact signed micro-bytes. A missing cost, byte total,
 * endpoint or provider dimension is a labelled absence, never a zero, and a
 * group with no charge on the selected basis is never presented as paid
 * transfer.
 */

const INTEGER_MICROS = /^-?(?:0|[1-9]\d*)$/u;
const ALL = "ALL";
const NOT_REPORTED = "NOT_REPORTED";

const COST_BASES: readonly DataTransferCostBasis[] = Object.freeze([
  "unblended", "net", "amortized", "list", "contracted", "public",
]);

/** Categories the taxonomy produces that no documented purpose claims. */
const RESIDUAL_CATEGORIES: readonly DataTransferCategory[] =
  Object.freeze(["UNKNOWN", "UNCLASSIFIED"]);

/** The AWS-published rule id for the Global Accelerator fixed fee. */
const ACCELERATOR_FIXED_FEE_RULE = "GLOBAL_ACCELERATOR_FIXED_FEE_V1";

export type DataTransferPurposeLens =
  | "summary"
  | "internet_accelerator"
  | "region"
  | "availability_zone"
  | "cloudfront";

export interface DataTransferPurposeArea {
  readonly key: string;
  /** Null means every classified category, used only by the summary purpose. */
  readonly categories: readonly DataTransferCategory[] | null;
  readonly lens: DataTransferPurposeLens;
  readonly description: string;
}

/**
 * Native projection for each documented purpose, keyed by the exact purpose
 * text in the pinned audit. A purpose without an entry here renders as an
 * explicit absence rather than being quietly dropped or reinterpreted.
 */
const PURPOSE_AREAS: Readonly<Record<string, DataTransferPurposeArea>> = Object.freeze({
  "Data Transfer Summary": Object.freeze({
    key: "summary",
    categories: null,
    lens: "summary" as const,
    description:
      "Charged transfer by classified category, separated by currency and cost basis, with the classification and byte-normalisation coverage that qualifies it.",
  }),
  "Internet data transfer and AWS Global Accelerator cost estimation details": Object.freeze({
    key: "internet-and-global-accelerator",
    categories: Object.freeze(["INTERNET", "GLOBAL_ACCELERATOR"] as const),
    lens: "internet_accelerator" as const,
    description:
      "Billed internet egress and Global Accelerator CUR2 evidence. Accelerator fixed fees are separated from transfer premiums, and nothing here is a forward price simulation.",
  }),
  "Regional data transfer details": Object.freeze({
    key: "regional",
    categories: Object.freeze(["INTER_REGION"] as const),
    lens: "region" as const,
    description:
      "Inter-Region transfer with the provider-reported source and destination when the CUR2 generation carries them. A CUR Region field is never substituted for a missing endpoint.",
  }),
  "Data transfer Availability Zone details": Object.freeze({
    key: "availability-zone",
    categories: Object.freeze(["INTER_AZ"] as const),
    lens: "availability_zone" as const,
    description:
      "Inter-AZ regional transfer by CUR Region, Availability Zone and resource. Inter-AZ rows identify one dimension set, not both traffic endpoints.",
  }),
  "CloudFront cost and usage analysis": Object.freeze({
    key: "cloudfront",
    categories: Object.freeze(["CLOUDFRONT"] as const),
    lens: "cloudfront" as const,
    description:
      "CloudFront distinguished by its provider product code and documented usage type, with exact cost, direction, location and unit evidence. No CDN telemetry is claimed.",
  }),
});

export interface DataTransferAvailablePeriod {
  readonly period: string;
  readonly generationId: string;
  readonly committedAtIso: string;
}

/** The exact envelope `/api/v1/finops/data-transfer` returns. */
export interface DataTransferDashboardEnvelope {
  readonly connectionId: string;
  readonly selectedPeriod: string | null;
  readonly availablePeriods: readonly DataTransferAvailablePeriod[];
  readonly officialAudit: DataTransferOfficialAudit;
  readonly report: DataTransferSnapshot | null;
  readonly sourceState: string;
}

/** Stable tab/panel key for a documented purpose. */
export function dataTransferPurposeKey(purpose: string): string {
  const area = PURPOSE_AREAS[purpose];
  if (area !== undefined) return area.key;
  return `unmapped-${purpose.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "")}`;
}

function readable(value: string): string {
  return value.replaceAll("_", " ");
}

function groupDigits(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

/** Exact signed micro-bytes, never converted to a number. */
function formatMicrobytesExact(micros: string | null): string {
  if (micros === null || !INTEGER_MICROS.test(micros)) return "Not available";
  const negative = micros.startsWith("-");
  const digits = negative ? micros.slice(1) : micros;
  return `${negative ? "−" : ""}${groupDigits(digits)} µB`;
}

function costFor(
  costs: readonly DataTransferCostSummary[],
  basis: DataTransferCostBasis,
): DataTransferCostSummary | null {
  return costs.find((cost) => cost.basis === basis) ?? null;
}

function costMicros(
  costs: readonly DataTransferCostSummary[],
  basis: DataTransferCostBasis,
): string | null {
  const total = costFor(costs, basis)?.totalMicros ?? null;
  return total !== null && INTEGER_MICROS.test(total) ? total : null;
}

/**
 * A group is charged only when the selected basis carries a real non-zero
 * amount. A missing amount is unavailable evidence and a zero amount is proven
 * absence of charge; neither may be presented as paid transfer.
 */
function isCharged(
  costs: readonly DataTransferCostSummary[],
  basis: DataTransferCostBasis,
): boolean {
  const micros = costMicros(costs, basis);
  return micros !== null && BigInt(micros) !== BigInt(0);
}

interface ExactTotal {
  readonly micros: string | null;
  readonly contributingGroups: number;
  readonly missingGroups: number;
}

/** Exact bigint sum of the present amounts, with the absences counted. */
function exactTotal(
  rows: readonly { readonly costs: readonly DataTransferCostSummary[] }[],
  basis: DataTransferCostBasis,
): ExactTotal {
  let total = BigInt(0);
  let contributing = 0;
  let missing = 0;
  for (const row of rows) {
    const micros = costMicros(row.costs, basis);
    if (micros === null) {
      missing += 1;
      continue;
    }
    total += BigInt(micros);
    contributing += 1;
  }
  return {
    micros: contributing === 0 ? null : total.toString(),
    contributingGroups: contributing,
    missingGroups: missing,
  };
}

function Tile({ label, value, detail }: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
}) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      {detail === undefined ? null : <span className={styles.tileDetail}>{detail}</span>}
    </div>
  );
}

function Absence({ title, detail }: { readonly title: string; readonly detail: string }) {
  return (
    <div className={styles.absence} role="status">
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function Block({ title, description, actions, children }: {
  readonly title: string;
  readonly description?: string;
  readonly actions?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <section className={styles.block} aria-label={title}>
      <header className={styles.blockHead}>
        <div>
          <h4>{title}</h4>
          {description === undefined ? null : <p>{description}</p>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

/**
 * The published-artifact boundary. Sheet, visual and control totals are the
 * audit's explicit nulls, so they are printed as unavailable.
 */
function OfficialBoundary({ audit }: { readonly audit: DataTransferOfficialAudit }) {
  const totals = audit.exactObjectTotals;
  const entries: readonly (readonly [string, number | null])[] = [
    ["Sheets", totals.sheets],
    ["Visuals", totals.visuals],
    ["Parameter controls", totals.parameterControls],
    ["Filter controls", totals.filterControls],
    ["Parameter declarations", totals.parameterDeclarations],
    ["Calculated fields", totals.calculatedFields],
    ["Filter groups", totals.filterGroups],
    ["Datasets", totals.datasets],
  ];
  return (
    <details className={styles.boundary}>
      <summary>
        Official AWS coverage · no QuickSight definition is published, so exact object
        totals are unavailable
      </summary>
      <div className={styles.boundaryGrid}>
        <dl>
          <div><dt>Pinned commit</dt><dd>{audit.source.commit}</dd></div>
          <div><dt>Manifest</dt><dd>{audit.source.manifestPath}</dd></div>
          <div><dt>Manifest SHA-256</dt><dd>{audit.source.manifestSha256}</dd></div>
          <div><dt>Embedded query SHA-256</dt><dd>{audit.source.embeddedQuerySha256}</dd></div>
          <div><dt>External template reference</dt><dd>{audit.source.externalTemplateId}</dd></div>
          <div><dt>Official dataset</dt><dd>{audit.source.datasetIdentifier}</dd></div>
        </dl>
        <div>
          <strong>Published artifacts</strong>
          <ul>
            <li>Manifest: {audit.publishedArtifacts.manifest.published ? "published and hash-pinned" : "not published"}</li>
            <li>Inline Athena query: {audit.publishedArtifacts.query.published ? "published and hash-pinned" : "not published"}</li>
            <li>QuickSight definition: {audit.publishedArtifacts.quickSightDefinition.published ? "published" : "not published"}</li>
            <li>QuickSight template body: {audit.publishedArtifacts.templateBody.published ? "published" : "not published"}</li>
            <li>Changelog: {audit.publishedArtifacts.changelog.published ? "published" : "not published"}</li>
          </ul>
        </div>
        <div>
          <strong>Exact object totals</strong>
          <ul>
            {entries.map(([label, value]) => (
              <li key={label}>
                {label}: {value === null ? "not available — AWS publishes no definition" : formatCount(value)}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <strong>Control evidence</strong>
          <ul>
            <li>{readable(audit.controlPurposeEvidence.toLowerCase())}.</li>
            <li>
              The currency, cost-basis, category, direction, account, service, Region,
              source, destination and transfer-type controls below are native Sutra
              filters and are not claimed as QuickSight controls.
            </li>
          </ul>
        </div>
      </div>
      <div className={styles.tableWrap} tabIndex={0}>
        <table className={styles.table}>
          <caption>
            The five documented purposes and what native CUR2 evidence covers each. These
            are AWS guidance bullets, not proof of five QuickSight visual objects.
          </caption>
          <thead>
            <tr>
              <th scope="col">Documented purpose</th>
              <th scope="col">Coverage</th>
              <th scope="col">Native evidence</th>
              <th scope="col">Remaining gap</th>
            </tr>
          </thead>
          <tbody>
            {audit.documentedVisualPurposes.map((item) => (
              <tr key={item.purpose}>
                <th scope="row">{item.purpose}</th>
                <td>{readable(item.coverage)}</td>
                <td>{item.nativeEvidence}</td>
                <td>{item.remainingGap}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className={styles.disclosures}>
        {audit.disclosures.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </details>
  );
}

/** Lineage and freshness for the active immutable generation. */
function SourceEvidence({ report }: { readonly report: DataTransferSnapshot }) {
  const source = report.source;
  return (
    <section className={styles.evidence} aria-label="Data transfer source evidence and freshness">
      <div className={styles.evidenceTitle}>
        <span aria-hidden="true">CUR2</span>
        <div>
          <strong>Active generation evidence</strong>
          <small>{report.scope.exportName} · {report.scope.billingPeriod}</small>
        </div>
        <StateBadge state={report.state.toLowerCase()} />
      </div>
      <dl>
        <div><dt>Generation</dt><dd>{source.generationId}</dd></div>
        <div><dt>Manifest SHA-256</dt><dd>{source.manifestSha256 ?? "Not available"}</dd></div>
        <div>
          <dt>Source status</dt>
          <dd>{readable(source.status)}{source.errorCode === null ? "" : ` · ${readable(source.errorCode)}`}</dd>
        </div>
        <div>
          <dt>Data through</dt>
          <dd>{source.dataThroughAtIso ?? "Not available — source timestamps were not retained"}</dd>
        </div>
        <div>
          <dt>Age against {formatCount(source.freshnessSlaHours)}h SLA</dt>
          <dd>{source.ageHours === null ? "Not available" : `${formatCount(source.ageHours)}h`}</dd>
        </div>
        <div>
          <dt>Manifest object coverage</dt>
          <dd>
            {source.objectCoverage.status === "unavailable"
              ? "Not available — manifest object counts were not retained"
              : `${formatCount(source.objectCoverage.processedObjectCount ?? 0)} of ${formatCount(source.objectCoverage.manifestObjectCount ?? 0)} objects`}
          </dd>
        </div>
        <div><dt>Taxonomy</dt><dd>{report.taxonomy.version} · {report.taxonomy.sha256.slice(0, 16)}…</dd></div>
      </dl>
    </section>
  );
}

interface DimensionFilters {
  readonly direction: string;
  readonly account: string;
  readonly service: string;
  readonly region: string;
  readonly sourceLocation: string;
  readonly destinationLocation: string;
  readonly transferType: string;
}

const EMPTY_FILTERS: DimensionFilters = Object.freeze({
  direction: ALL,
  account: ALL,
  service: ALL,
  region: ALL,
  sourceLocation: ALL,
  destinationLocation: ALL,
  transferType: ALL,
});

function optionsOf(
  rows: readonly DataTransferDrilldown[],
  select: (row: DataTransferDrilldown) => string,
): readonly string[] {
  return [...new Set(rows.map(select))].sort();
}

/** A selection that no longer exists in the current purpose falls back to all. */
function resolved(selected: string, options: readonly string[]): string {
  return selected !== ALL && options.includes(selected) ? selected : ALL;
}

function matches(selected: string, value: string): boolean {
  return selected === ALL || selected === value;
}

function FilterSelect({ label, value, options, onChange }: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className={styles.field}>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value={ALL}>All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option === NOT_REPORTED ? "Not reported" : readable(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** One evidence row per drilldown group, with every absence named. */
function DrilldownTable({ rows, basis, caption }: {
  readonly rows: readonly DataTransferDrilldown[];
  readonly basis: DataTransferCostBasis;
  readonly caption: string;
}) {
  return (
    <div className={styles.tableWrap} tabIndex={0}>
      <table className={styles.table}>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Category / direction</th>
            <th scope="col">Source → destination</th>
            <th scope="col">Account / provider</th>
            <th scope="col">Region / AZ / resource</th>
            <th className={styles.numeric} scope="col">{readable(basis)} cost</th>
            <th className={styles.numeric} scope="col">Normalized bytes</th>
            <th scope="col">Classification evidence</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cost = costFor(row.costs, basis);
            return (
              <tr key={groupKey(row)}>
                <th scope="row">
                  {readable(row.category)}
                  <small>{row.direction === "UNKNOWN" ? "Direction not reported" : readable(row.direction)}</small>
                </th>
                <td>
                  {row.path.sourceLocation ?? "Source not reported"} → {row.path.destinationLocation ?? "Destination not reported"}
                  <small>
                    {row.path.sourceLocationType ?? "Location type not reported"} · {readable(row.path.evidence)}
                  </small>
                </td>
                <td>
                  {row.usageAccountId}
                  <small>
                    {row.provider.serviceName ?? row.provider.serviceCode ?? row.service}
                    {" · "}
                    {row.provider.productName ?? row.provider.productCode ?? "Product not reported"}
                    {" · "}
                    {row.provider.operation ?? "Operation not reported"}
                    {" · "}
                    {row.provider.transferType ?? "Transfer type not reported"}
                  </small>
                </td>
                <td>
                  {row.region ?? "Region not reported"}
                  <small>
                    {row.availabilityZone ?? "AZ not reported"} · {row.resourceId ?? "Resource not reported"}
                  </small>
                </td>
                <td className={styles.numeric}>
                  {formatMicrosExact(cost?.totalMicros ?? null, row.currency)}
                  <small>
                    {cost === null || cost.coverage === "unavailable"
                      ? `No ${basis} amount on any of the ${formatCount(row.rowCount)} source rows`
                      : `${readable(cost.coverage)} · ${formatCount(cost.missingRowCount)} rows without this basis`}
                  </small>
                </td>
                <td className={styles.numeric}>
                  {formatMicrobytesExact(row.normalizedBytesMicros)}
                  <small>
                    {row.normalizedBytesMicros === null
                      ? "Unit missing or outside the pinned taxonomy"
                      : row.quantities.map((quantity) => `${quantity.sourceUnit}: ${groupDigits(quantity.quantityMicros.replace("-", ""))}`).join(" · ")}
                  </small>
                </td>
                <td>
                  {row.classificationRuleIds.map(readable).join(", ")}
                  <small>
                    {formatCount(row.rowCount)} rows · {row.usageTypes.join(", ") || "Usage type not reported"}
                    {row.usageTypesTruncated ? " · usage-type list truncated" : ""}
                    {row.sourceLineIdsTruncated
                      ? ` · ${formatCount(row.sourceLineIdCount)} source lines, evidence list truncated`
                      : ` · ${formatCount(row.sourceLineIdCount)} source lines`}
                  </small>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function groupKey(row: DataTransferDrilldown): string {
  return JSON.stringify([
    row.category, row.direction, row.currency, row.usageAccountId, row.service,
    row.region, row.availabilityZone, row.resourceId, row.path.sourceLocation,
    row.path.sourceLocationType, row.path.destinationLocation,
    row.provider.serviceCode, row.provider.serviceName, row.provider.productCode,
    row.provider.productName, row.provider.operation, row.provider.transferType,
  ]);
}

interface RankedGroup {
  readonly id: string;
  readonly label: string;
  readonly micros: string;
}

/** Sum the charged groups per label; uncharged groups are counted, not plotted. */
function rankCharged(
  rows: readonly DataTransferDrilldown[],
  basis: DataTransferCostBasis,
  label: (row: DataTransferDrilldown) => string,
): { readonly ranked: readonly RankedGroup[]; readonly unchargedGroups: number } {
  const totals = new Map<string, bigint>();
  let uncharged = 0;
  for (const row of rows) {
    if (!isCharged(row.costs, basis)) {
      uncharged += 1;
      continue;
    }
    const key = label(row);
    totals.set(key, (totals.get(key) ?? BigInt(0)) + BigInt(costMicros(row.costs, basis)!));
  }
  return {
    ranked: [...totals.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, micros]) => ({ id: key, label: key, micros: micros.toString() })),
    unchargedGroups: uncharged,
  };
}

function ChargedRanking({ rows, basis, currency, label, title, description }: {
  readonly rows: readonly DataTransferDrilldown[];
  readonly basis: DataTransferCostBasis;
  readonly currency: string;
  readonly label: (row: DataTransferDrilldown) => string;
  readonly title: string;
  readonly description: string;
}) {
  const { ranked, unchargedGroups } = rankCharged(rows, basis, label);
  const items = ranked.flatMap((group) => {
    const value = microsToUnits(group.micros);
    return value === null ? [] : [{ id: group.id, label: group.label, value }];
  });
  const dropped = ranked.length - items.length;
  return (
    <Block description={description} title={title}>
      {items.length === 0 ? (
        <Absence
          title="No charged transfer to rank"
          detail={`None of the ${formatCount(rows.length)} evidence groups carries a non-zero ${basis} amount in ${currency}, so no paid transfer is presented. The groups remain listed below with their real cost state.`}
        />
      ) : (
        <RankingBars
          ariaLabel={`${title} by ${basis} cost in ${currency}`}
          caption={`Only groups with a non-zero ${basis} charge are plotted; ${formatCount(unchargedGroups)} group${unchargedGroups === 1 ? "" : "s"} carry no ${basis} charge and are not presented as paid transfer.`}
          formatValue={(value) => formatUnits(value, currency)}
          items={items}
          sort
        />
      )}
      {dropped > 0 ? (
        <p className={styles.note}>
          {formatCount(dropped)} charged group{dropped === 1 ? " is" : "s are"} omitted from the chart
          because the exact micro-unit total exceeds the range a plot coordinate represents without
          rounding. The exact amounts remain in the table below.
        </p>
      ) : null}
    </Block>
  );
}

function TotalTiles({ rows, basis, currency, label }: {
  readonly rows: readonly DataTransferDrilldown[];
  readonly basis: DataTransferCostBasis;
  readonly currency: string;
  readonly label: string;
}) {
  const total = exactTotal(rows, basis);
  const charged = rows.filter((row) => isCharged(row.costs, basis)).length;
  const bytes = rows.reduce<{ micros: bigint; contributing: number; missing: number }>(
    (accumulator, row) => row.normalizedBytesMicros === null
      || !INTEGER_MICROS.test(row.normalizedBytesMicros)
      ? { ...accumulator, missing: accumulator.missing + 1 }
      : {
          micros: accumulator.micros + BigInt(row.normalizedBytesMicros),
          contributing: accumulator.contributing + 1,
          missing: accumulator.missing,
        },
    { micros: BigInt(0), contributing: 0, missing: 0 },
  );
  return (
    <div className={styles.tiles}>
      <Tile
        detail={total.missingGroups === 0
          ? `All ${formatCount(total.contributingGroups)} groups carry this basis`
          : `${formatCount(total.missingGroups)} of ${formatCount(rows.length)} groups carry no ${basis} amount and are excluded from this total`}
        label={`${label} · ${readable(basis)} total`}
        value={formatMicrosExact(total.micros, currency)}
      />
      <Tile
        detail={`of ${formatCount(rows.length)} evidence groups`}
        label="Groups incurring a charge"
        value={formatCount(charged)}
      />
      <Tile
        detail={bytes.missing === 0
          ? `Normalized from ${formatCount(bytes.contributing)} groups with pinned units`
          : `${formatCount(bytes.missing)} group${bytes.missing === 1 ? "" : "s"} have a missing or unpinned unit and are excluded`}
        label="Normalized transfer"
        value={bytes.contributing === 0 ? "Not available" : formatMicrobytesExact(bytes.micros.toString())}
      />
    </div>
  );
}

/** Purpose 1: the currency- and basis-separated charged summary. */
function SummaryPurpose({ report, basis, currency, rows }: {
  readonly report: DataTransferSnapshot;
  readonly basis: DataTransferCostBasis;
  readonly currency: string;
  readonly rows: readonly DataTransferDrilldown[];
}) {
  const summaries = report.categorySummaries.filter((item) => item.currency === currency);
  const documented = summaries.filter((item) => !RESIDUAL_CATEGORIES.includes(item.category));
  const residual = summaries.filter((item) => RESIDUAL_CATEGORIES.includes(item.category));
  const coverage = report.coverage;

  const shareCandidates = documented.map((item) => ({
    category: item.category,
    micros: costMicros(item.costs, basis),
  }));
  const shareable = shareCandidates.every((item) =>
    item.micros !== null && BigInt(item.micros) >= BigInt(0))
    && shareCandidates.some((item) => item.micros !== null && BigInt(item.micros) > BigInt(0));
  const shareReason = shareCandidates.some((item) => item.micros === null)
    ? `at least one category has no ${basis} amount, so a share of an unknown total cannot be stated`
    : shareCandidates.some((item) => item.micros !== null && BigInt(item.micros) < BigInt(0))
      ? "at least one category total is negative after credits or corrections, and a negative part of a total is not a share"
      : "no category carries a positive charge on this basis";

  return (
    <div className={styles.blocks}>
      <div className={styles.tiles}>
        <Tile
          detail={`${readable(coverage.classification)} classification`}
          label="Transfer candidate rows"
          value={formatCount(coverage.transferCandidateRowCount)}
        />
        <Tile
          detail={`${formatCount(coverage.unclassifiedRowCount)} unclassified · ${formatCount(coverage.unknownRowCount)} unknown`}
          label="Classified rows"
          value={formatCount(coverage.classifiedRowCount)}
        />
        <Tile
          detail={`${formatCount(coverage.byteNormalizedRowCount)} rows normalized · ${formatCount(coverage.missingQuantityRowCount)} without quantity · ${formatCount(coverage.unknownUnitRowCount)} with an unpinned unit`}
          label="Byte normalization"
          value={readable(coverage.byteNormalization)}
        />
        <Tile
          detail={coverage.missingUsageTypeRowCount === 0
            ? "Every candidate row carried a usage type"
            : `${formatCount(coverage.missingUsageTypeRowCount)} candidate rows had no usage type`}
          label="Rows excluded as non-transfer"
          value={formatCount(coverage.excludedNonTransferRowCount)}
        />
      </div>

      {summaries.length === 0 ? (
        <Absence
          title={`No classified transfer in ${currency}`}
          detail="The active generation produced no data-transfer category for this currency. This is the absence of classified evidence, not a zero cost."
        />
      ) : (
        <Block
          description={`Signed ${basis} cost by classified category in ${currency}. Credits and corrections keep their sign, so a bar can point below the axis.`}
          title="Charged transfer by category"
        >
          <BarChart
            ariaLabel={`Signed ${basis} data-transfer cost by category in ${currency}`}
            categories={summaries.map((item) => readable(item.category))}
            formatValue={(value) => formatUnits(value, currency)}
            series={[{
              id: "category",
              label: `${currency} ${basis}`,
              values: summaries.map((item) => microsToUnits(costMicros(item.costs, basis))),
            }]}
          />
          {shareable ? (
            <ShareBar
              ariaLabel={`Share of charged ${basis} transfer cost by documented category in ${currency}`}
              formatValue={(value) => formatUnits(value, currency)}
              segments={documented.flatMap((item, index) => {
                const value = microsToUnits(costMicros(item.costs, basis));
                return value === null ? [] : [{
                  id: item.category,
                  label: readable(item.category),
                  value,
                  tone: ([
                    "blue", "amber", "teal", "violet", "green",
                  ] as const)[index % 5],
                }];
              })}
            />
          ) : (
            <p className={styles.note}>
              A percentage composition is withheld for this selection because {shareReason}.
              The exact signed amounts are shown above and in the table below.
            </p>
          )}
          <CategoryTable basis={basis} summaries={summaries} />
        </Block>
      )}

      <Block
        description="Groups the pinned taxonomy could not attribute to a documented purpose. They stay visible instead of being folded into a covered category."
        title="Unclassified and unknown transfer candidates"
      >
        {residual.length === 0 ? (
          <p className={styles.note}>
            Every transfer candidate in {currency} matched a pinned AWS-documented usage-type
            pattern, so no unclassified or unknown category exists for this selection.
          </p>
        ) : (
          <CategoryTable basis={basis} summaries={residual} />
        )}
      </Block>

      <TotalTiles basis={basis} currency={currency} label="All classified transfer" rows={rows} />

      <Block
        description="How far each provider dimension reaches in the active generation. A partial or unavailable dimension limits the purpose rather than being read as an absent value."
        title="Provider dimension coverage"
      >
        <ul className={styles.coverageList}>
          {(Object.entries(coverage.dimensions) as readonly (readonly [string, string])[])
            .map(([dimension, state]) => (
              <li key={dimension}>
                <span>{readable(dimension.replace(/([A-Z])/gu, " $1").toLowerCase())}</span>
                <StateBadge state={state} />
              </li>
            ))}
        </ul>
      </Block>
    </div>
  );
}

function CategoryTable({ summaries, basis }: {
  readonly summaries: readonly DataTransferCategorySummary[];
  readonly basis: DataTransferCostBasis;
}) {
  return (
    <div className={styles.tableWrap} tabIndex={0}>
      <table className={styles.table}>
        <caption>
          Exact signed {readable(basis)} cost, direction counts and byte evidence per category.
          Every currency stays separate and no missing figure is replaced with a zero.
        </caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th className={styles.numeric} scope="col">Rows</th>
            <th scope="col">Direction</th>
            <th className={styles.numeric} scope="col">{readable(basis)} cost</th>
            <th scope="col">Cost coverage</th>
            <th className={styles.numeric} scope="col">Normalized bytes</th>
          </tr>
        </thead>
        <tbody>
          {summaries.map((item) => {
            const cost = costFor(item.costs, basis);
            return (
              <tr key={`${item.category}:${item.currency}`}>
                <th scope="row">{readable(item.category)}</th>
                <td className={styles.numeric}>{formatCount(item.rowCount)}</td>
                <td>
                  {formatCount(item.directionCounts.OUTBOUND)} outbound ·{" "}
                  {formatCount(item.directionCounts.INBOUND)} inbound ·{" "}
                  {formatCount(item.directionCounts.UNKNOWN)} not reported
                </td>
                <td className={styles.numeric}>
                  {formatMicrosExact(cost?.totalMicros ?? null, item.currency)}
                </td>
                <td>
                  <StateBadge state={cost?.coverage ?? "unavailable"} />
                  <small>
                    {cost === null || cost.coverage === "unavailable"
                      ? `No source row carried an amount on the ${basis} basis`
                      : `${formatCount(cost.contributingRowCount)} of ${formatCount(item.rowCount)} rows`}
                  </small>
                </td>
                <td className={styles.numeric}>
                  {formatMicrobytesExact(item.normalizedBytesMicros)}
                  <small>
                    {item.normalizedBytesMicros === null
                      ? `${formatCount(item.missingOrUnknownUnitRowCount)} rows have a missing or unpinned unit, so no total is claimed`
                      : `${formatCount(item.byteNormalizedRowCount)} rows normalized`}
                  </small>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Purpose 2: internet egress and Global Accelerator. */
function InternetAcceleratorPurpose({ rows, basis, currency }: {
  readonly rows: readonly DataTransferDrilldown[];
  readonly basis: DataTransferCostBasis;
  readonly currency: string;
}) {
  const fixedFee = rows.filter((row) =>
    row.classificationRuleIds.includes(ACCELERATOR_FIXED_FEE_RULE));
  const transfer = rows.filter((row) =>
    !row.classificationRuleIds.includes(ACCELERATOR_FIXED_FEE_RULE));
  const fee = exactTotal(fixedFee, basis);
  return (
    <div className={styles.blocks}>
      <TotalTiles basis={basis} currency={currency} label="Internet and Accelerator" rows={rows} />
      <ChargedRanking
        basis={basis}
        currency={currency}
        description="Billed egress and Accelerator premium by the provider's own transfer type, falling back to the reported product only when the transfer type is absent."
        label={(row) => `${readable(row.category)} · ${row.provider.transferType ?? row.provider.productName ?? row.provider.productCode ?? "Transfer type not reported"}`}
        rows={transfer}
        title="Charged transfer by provider transfer type"
      />
      <Block
        description="The Global Accelerator fixed fee is an accelerator-hours charge, not transferred bytes, so it is totalled apart from transfer premiums and never added to a byte figure."
        title="Global Accelerator fixed fee"
      >
        {fixedFee.length === 0 ? (
          <p className={styles.note}>
            No row in this generation matched the published {readable(ACCELERATOR_FIXED_FEE_RULE)}
            {" "}rule, so no fixed fee is reported for {currency}.
          </p>
        ) : (
          <div className={styles.tiles}>
            <Tile
              detail={fee.missingGroups === 0
                ? `${formatCount(fee.contributingGroups)} fixed-fee groups`
                : `${formatCount(fee.missingGroups)} fixed-fee groups carry no ${basis} amount and are excluded`}
              label={`Fixed fee · ${readable(basis)}`}
              value={formatMicrosExact(fee.micros, currency)}
            />
            <Tile
              detail="A fixed fee is charged per accelerator, so no transferred-byte figure exists for it"
              label="Fixed-fee bytes"
              value="Not applicable"
            />
          </div>
        )}
      </Block>
      <EvidenceRows basis={basis} currency={currency} rows={rows} />
      <p className={styles.note}>
        These are billed CUR2 amounts for the selected period. Sutra does not simulate a future
        internet-egress or Accelerator price, and no unpublished QuickSight estimation visual is
        reproduced.
      </p>
    </div>
  );
}

/** Purpose 3: inter-Region detail keyed on the provider-reported endpoints. */
function RegionPurpose({ rows, basis, currency }: {
  readonly rows: readonly DataTransferDrilldown[];
  readonly basis: DataTransferCostBasis;
  readonly currency: string;
}) {
  const routed = rows.filter((row) =>
    row.path.sourceLocation !== null && row.path.destinationLocation !== null);
  const unrouted = rows.length - routed.length;
  return (
    <div className={styles.blocks}>
      <TotalTiles basis={basis} currency={currency} label="Inter-Region transfer" rows={rows} />
      {routed.length === 0 ? (
        <Absence
          title="No provider-reported Region pair"
          detail={`None of the ${formatCount(rows.length)} inter-Region groups reports both a source and a destination location. Sutra does not substitute the CUR Region or Availability Zone field for a missing endpoint, so no path is drawn.`}
        />
      ) : (
        <ChargedRanking
          basis={basis}
          currency={currency}
          description="Only groups whose CUR2 generation reports both endpoints are routed. A missing endpoint stays missing."
          label={(row) => `${row.path.sourceLocation ?? "Source not reported"} → ${row.path.destinationLocation ?? "Destination not reported"}`}
          rows={routed}
          title="Charged transfer by provider-reported Region pair"
        />
      )}
      {unrouted > 0 ? (
        <p className={styles.note}>
          {formatCount(unrouted)} inter-Region group{unrouted === 1 ? "" : "s"} could not be routed
          because the active generation reports no source or destination location for them. They are
          listed below with their endpoints marked as not reported.
        </p>
      ) : null}
      <EvidenceRows basis={basis} currency={currency} rows={rows} />
    </div>
  );
}

/** Purpose 4: inter-AZ detail on the CUR dimension set. */
function AvailabilityZonePurpose({ rows, basis, currency }: {
  readonly rows: readonly DataTransferDrilldown[];
  readonly basis: DataTransferCostBasis;
  readonly currency: string;
}) {
  const zoned = rows.filter((row) => row.availabilityZone !== null).length;
  return (
    <div className={styles.blocks}>
      <TotalTiles basis={basis} currency={currency} label="Inter-AZ transfer" rows={rows} />
      <ChargedRanking
        basis={basis}
        currency={currency}
        description="Grouped on the CUR Region and Availability Zone dimensions of the charged line, which are line dimensions rather than the two endpoints of the traffic."
        label={(row) => `${row.region ?? "Region not reported"} / ${row.availabilityZone ?? "AZ not reported"}`}
        rows={rows}
        title="Charged inter-AZ transfer by Region and Availability Zone"
      />
      <p className={styles.note}>
        {formatCount(zoned)} of {formatCount(rows.length)} inter-AZ groups carry an Availability Zone
        dimension. An inter-AZ line does not identify both zones of the traffic, and a historical
        generation collected before the provider fields were retained needs rematerialization before
        those fields can appear.
      </p>
      <EvidenceRows basis={basis} currency={currency} rows={rows} />
    </div>
  );
}

/** Purpose 5: CloudFront, distinguished by product code and usage type. */
function CloudFrontPurpose({ rows, basis, currency }: {
  readonly rows: readonly DataTransferDrilldown[];
  readonly basis: DataTransferCostBasis;
  readonly currency: string;
}) {
  return (
    <div className={styles.blocks}>
      <TotalTiles basis={basis} currency={currency} label="CloudFront transfer" rows={rows} />
      <ChargedRanking
        basis={basis}
        currency={currency}
        description="CloudFront rows are matched only when the provider product code and the documented usage-type pattern both agree, so an ambiguous row stays unclassified instead of being counted here."
        label={(row) => `${row.provider.operation ?? row.provider.productName ?? row.provider.productCode ?? "Operation not reported"} · ${row.region ?? "Region not reported"}`}
        rows={rows}
        title="Charged CloudFront transfer by operation and Region"
      />
      <p className={styles.note}>
        This is billed CloudFront cost and usage evidence only. No CDN telemetry, cache-hit ratio,
        request performance or forward pricing is available from the CUR, and none is inferred.
      </p>
      <EvidenceRows basis={basis} currency={currency} rows={rows} />
    </div>
  );
}

function EvidenceRows({ rows, basis, currency }: {
  readonly rows: readonly DataTransferDrilldown[];
  readonly basis: DataTransferCostBasis;
  readonly currency: string;
}) {
  return (
    <Block
      description="One row per evidence group, with every unreported provider dimension named rather than blank."
      title={`Evidence groups (${formatCount(rows.length)})`}
    >
      {rows.length === 0 ? (
        <Absence
          title="No evidence group for this purpose"
          detail={`The active generation classified no ${currency} row into this purpose under the pinned taxonomy. This is a proven absence for the selected period, not a zero cost.`}
        />
      ) : (
        <DrilldownTable
          basis={basis}
          caption={`Exact signed ${readable(basis)} cost and byte evidence per provider-reported group in ${currency}.`}
          rows={rows}
        />
      )}
    </Block>
  );
}

function PurposePanel({ report, purpose, area, basis, currency, rows }: {
  readonly report: DataTransferSnapshot;
  readonly purpose: DataTransferDocumentedVisualPurpose;
  readonly area: DataTransferPurposeArea | undefined;
  readonly basis: DataTransferCostBasis;
  readonly currency: string;
  readonly rows: readonly DataTransferDrilldown[];
}) {
  if (area === undefined) {
    return (
      <Absence
        title={`No native projection for "${purpose.purpose}"`}
        detail="This purpose is listed because AWS guidance documents it. Sutra has no canonical CUR2 projection for it and does not present one as delivered."
      />
    );
  }
  switch (area.lens) {
    case "summary":
      return <SummaryPurpose basis={basis} currency={currency} report={report} rows={rows} />;
    case "internet_accelerator":
      return <InternetAcceleratorPurpose basis={basis} currency={currency} rows={rows} />;
    case "region":
      return <RegionPurpose basis={basis} currency={currency} rows={rows} />;
    case "availability_zone":
      return <AvailabilityZonePurpose basis={basis} currency={currency} rows={rows} />;
    case "cloudfront":
      return <CloudFrontPurpose basis={basis} currency={currency} rows={rows} />;
  }
}

/**
 * Presentation for a loaded Data Transfer envelope. Takes the envelope directly
 * so a test or a server-side snapshot can render every purpose without any
 * fetching.
 */
export function FinopsDataTransferPurposes({ envelope, initialPurposeKey }: {
  readonly envelope: DataTransferDashboardEnvelope;
  readonly initialPurposeKey?: string;
}) {
  const audit = envelope.officialAudit;
  const purposes = audit.documentedVisualPurposes;
  const firstKey = purposes.length === 0
    ? ""
    : dataTransferPurposeKey(purposes[0]!.purpose);
  const [purposeKey, setPurposeKey] = useState(initialPurposeKey ?? firstKey);
  const [basis, setBasis] = useState<DataTransferCostBasis>("amortized");
  const [currency, setCurrency] = useState<string | null>(null);
  const [filters, setFilters] = useState<DimensionFilters>(EMPTY_FILTERS);

  const report = envelope.report;
  const currencies = useMemo(
    () => report === null
      ? []
      : [...new Set(report.drilldowns.map((row) => row.currency))].sort(),
    [report],
  );
  const activeCurrency = currency !== null && currencies.includes(currency)
    ? currency
    : currencies[0] ?? null;

  const setFilter = useCallback((key: keyof DimensionFilters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
  }, []);

  if (report === null) {
    return (
      <Absence
        title="No data-transfer analysis for this connection"
        detail={`The endpoint reports a source state of ${readable(envelope.sourceState)}. Data transfer evidence appears once an immutable active CUR 2.0 generation for the selected billing period is delivered, accepted and activated. Nothing is shown as zero in the meantime.`}
      />
    );
  }

  const purpose = purposes.find((item) => dataTransferPurposeKey(item.purpose) === purposeKey)
    ?? purposes[0]
    ?? null;
  const area = purpose === null ? undefined : PURPOSE_AREAS[purpose.purpose];

  const purposeRows = activeCurrency === null || area === undefined
    ? []
    : report.drilldowns.filter((row) =>
      row.currency === activeCurrency
      && (area.categories === null || area.categories.includes(row.category)));

  const directionOptions = optionsOf(purposeRows, (row) => row.direction);
  const accountOptions = optionsOf(purposeRows, (row) => row.usageAccountId);
  const serviceOptions = optionsOf(purposeRows, (row) => row.service);
  const regionOptions = optionsOf(purposeRows, (row) => row.region ?? NOT_REPORTED);
  const sourceOptions = optionsOf(purposeRows, (row) => row.path.sourceLocation ?? NOT_REPORTED);
  const destinationOptions = optionsOf(purposeRows, (row) =>
    row.path.destinationLocation ?? NOT_REPORTED);
  const transferTypeOptions = optionsOf(purposeRows, (row) =>
    row.provider.transferType ?? NOT_REPORTED);

  const active: DimensionFilters = {
    direction: resolved(filters.direction, directionOptions),
    account: resolved(filters.account, accountOptions),
    service: resolved(filters.service, serviceOptions),
    region: resolved(filters.region, regionOptions),
    sourceLocation: resolved(filters.sourceLocation, sourceOptions),
    destinationLocation: resolved(filters.destinationLocation, destinationOptions),
    transferType: resolved(filters.transferType, transferTypeOptions),
  };
  const filtered = purposeRows.filter((row) =>
    matches(active.direction, row.direction)
    && matches(active.account, row.usageAccountId)
    && matches(active.service, row.service)
    && matches(active.region, row.region ?? NOT_REPORTED)
    && matches(active.sourceLocation, row.path.sourceLocation ?? NOT_REPORTED)
    && matches(active.destinationLocation, row.path.destinationLocation ?? NOT_REPORTED)
    && matches(active.transferType, row.provider.transferType ?? NOT_REPORTED));

  const exportFiltered = () => {
    const csv = buildDataTransferEvidenceCsv(report, filtered, basis);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `sutra-data-transfer-${report.scope.billingPeriod}-${purposeKey}-${basis}.csv`;
    anchor.click();
    URL.revokeObjectURL(href);
  };

  return (
    <div className={styles.workspace}>
      <SourceEvidence report={report} />
      <OfficialBoundary audit={audit} />

      <div className={styles.filters} role="group" aria-label="Data transfer controls">
        <label className={styles.field}>
          Currency
          <select
            disabled={currencies.length === 0}
            onChange={(event) => setCurrency(event.target.value)}
            value={activeCurrency ?? ""}
          >
            {currencies.length === 0
              ? <option value="">No currency reported</option>
              : currencies.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          Cost basis
          <select
            onChange={(event) => setBasis(event.target.value as DataTransferCostBasis)}
            value={basis}
          >
            {COST_BASES.map((item) => <option key={item} value={item}>{readable(item)}</option>)}
          </select>
        </label>
        <FilterSelect
          label="Direction"
          onChange={(value) => setFilter("direction", value)}
          options={directionOptions}
          value={active.direction}
        />
        <FilterSelect
          label="Account"
          onChange={(value) => setFilter("account", value)}
          options={accountOptions}
          value={active.account}
        />
        <FilterSelect
          label="Service"
          onChange={(value) => setFilter("service", value)}
          options={serviceOptions}
          value={active.service}
        />
        <FilterSelect
          label="Region"
          onChange={(value) => setFilter("region", value)}
          options={regionOptions}
          value={active.region}
        />
        <FilterSelect
          label="Source"
          onChange={(value) => setFilter("sourceLocation", value)}
          options={sourceOptions}
          value={active.sourceLocation}
        />
        <FilterSelect
          label="Destination"
          onChange={(value) => setFilter("destinationLocation", value)}
          options={destinationOptions}
          value={active.destinationLocation}
        />
        <FilterSelect
          label="Transfer type"
          onChange={(value) => setFilter("transferType", value)}
          options={transferTypeOptions}
          value={active.transferType}
        />
        <button
          className={styles.export}
          disabled={filtered.length === 0}
          onClick={exportFiltered}
          type="button"
        >
          Export filtered evidence
        </button>
      </div>

      <div aria-label="AWS-documented dashboard purposes" className={styles.tabs} role="tablist">
        {purposes.map((item) => {
          const key = dataTransferPurposeKey(item.purpose);
          const selected = purpose !== null && key === dataTransferPurposeKey(purpose.purpose);
          return (
            <button
              aria-controls={`data-transfer-panel-${key}`}
              aria-selected={selected}
              className={selected ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              id={`data-transfer-tab-${key}`}
              key={key}
              onClick={() => setPurposeKey(key)}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {item.purpose}
            </button>
          );
        })}
      </div>

      {purpose === null ? (
        <Absence
          title="No documented purpose is published"
          detail="The pinned audit lists no documented visual purpose for this dashboard, so no purpose area is presented."
        />
      ) : (
        <div
          aria-labelledby={`data-transfer-tab-${dataTransferPurposeKey(purpose.purpose)}`}
          className={styles.panel}
          id={`data-transfer-panel-${dataTransferPurposeKey(purpose.purpose)}`}
          role="tabpanel"
          tabIndex={0}
        >
          <header className={styles.purposeHead}>
            <div>
              <p className="eyebrow">AWS-documented purpose</p>
              <h3>{purpose.purpose}</h3>
              <p>{area?.description ?? "No native projection is claimed for this purpose."}</p>
            </div>
            <StateBadge state={purpose.coverage.toLowerCase()} />
          </header>
          <ul className={styles.gaps}>
            <li><b>Native evidence.</b> {purpose.nativeEvidence}</li>
            <li><b>Remaining gap.</b> {purpose.remainingGap}</li>
          </ul>
          {activeCurrency === null ? (
            <Absence
              title="No currency-bearing transfer evidence"
              detail="The active generation produced no data-transfer group with a currency, so no purpose area can be quantified. This is missing evidence, not a zero bill."
            />
          ) : (
            <PurposePanel
              area={area}
              basis={basis}
              currency={activeCurrency}
              purpose={purpose}
              report={report}
              rows={filtered}
            />
          )}
        </div>
      )}

      <footer className={styles.footer}>
        <strong>Analysis limits</strong>
        <ul>
          {report.limitations.map((item) => <li key={item}>{item}</li>)}
          <li>
            AWS publishes no QuickSight definition, template body or changelog for this
            dashboard, so its exact sheet, visual and control totals are unavailable and no
            object-count parity is claimed.
          </li>
        </ul>
      </footer>
    </div>
  );
}

type LoadState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "ready"; readonly envelope: DataTransferDashboardEnvelope }
  | { readonly status: "error"; readonly message: string };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEnvelope(body: unknown, connectionId: string): DataTransferDashboardEnvelope {
  if (
    !isRecord(body)
    || body.connectionId !== connectionId
    || typeof body.sourceState !== "string"
    || !Array.isArray(body.availablePeriods)
    || !("report" in body)
    || !isRecord(body.officialAudit)
    || body.officialAudit.schema !== "sutra.data-transfer-official-audit.v1"
  ) {
    throw new Error("The data-transfer response did not match its tenant-bound contract.");
  }
  if (
    body.report !== null
    && (
      !isRecord(body.report)
      || body.report.schemaVersion !== "sutra.finops-data-transfer-snapshot.v1"
    )
  ) {
    throw new Error("The data-transfer snapshot schema was not recognized.");
  }
  return body as unknown as DataTransferDashboardEnvelope;
}

/**
 * ADD-10 Data Transfer dashboard. Loads the canonical endpoint for the selected
 * billing period and hands the envelope to the presentational component.
 */
export function FinopsDataTransferDashboard({ connectionId }: {
  readonly connectionId: string | null;
}) {
  const [nonce, setNonce] = useState(0);
  const [period, setPeriod] = useState<string | null>(null);
  /**
   * Only settled results are stored, keyed by the request that produced them, so
   * `idle` and `loading` are derived rather than written. That keeps the effect
   * free of synchronous state writes and makes a late response for a superseded
   * request impossible to display.
   */
  const [settled, setSettled] = useState<{
    readonly key: string;
    readonly state: LoadState;
  } | null>(null);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const requestKey = connectionId === null
    ? null
    : `${nonce}:${connectionId}:${period ?? ""}`;

  useEffect(() => {
    if (connectionId === null || requestKey === null) return;
    const controller = new AbortController();
    let active = true;
    const query = new URLSearchParams({ connectionId, groupLimit: "250" });
    if (period !== null) query.set("period", period);
    void (async () => {
      try {
        const response = await fetch(`/api/v1/finops/data-transfer?${query.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const message = isRecord(body) && isRecord(body.error)
            && typeof body.error.message === "string"
            ? body.error.message
            : "The immutable CUR2 data-transfer request failed.";
          throw new Error(message);
        }
        const envelope = readEnvelope(body, connectionId);
        if (active) {
          setSettled({ key: requestKey, state: { status: "ready", envelope } });
        }
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setSettled({
          key: requestKey,
          state: {
            status: "error",
            message: error instanceof Error
              ? error.message
              : "Sutra could not load the data-transfer analysis.",
          },
        });
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [connectionId, period, requestKey]);

  const state: LoadState = connectionId === null
    ? { status: "idle" }
    : settled !== null && settled.key === requestKey
      ? settled.state
      : { status: "loading" };
  const envelope = state.status === "ready" ? state.envelope : null;

  return (
    <section aria-label="Data Transfer dashboard" className={styles.shell}>
      <header className={styles.head}>
        <div>
          <p className="eyebrow">AWS Cloud Intelligence · Additional</p>
          <h2>Data Transfer cost analysis</h2>
          <p>
            Charged internet, Global Accelerator, inter-Region, inter-AZ and CloudFront transfer
            from one immutable active CUR 2.0 generation, organised by the five purposes AWS
            documents for this dashboard.
          </p>
        </div>
        {envelope === null || envelope.availablePeriods.length === 0 ? null : (
          <label className={styles.field}>
            Billing period
            <select
              onChange={(event) => setPeriod(event.target.value)}
              value={period ?? envelope.selectedPeriod ?? ""}
            >
              {envelope.availablePeriods.map((item) => (
                <option key={item.generationId} value={item.period}>{item.period}</option>
              ))}
            </select>
          </label>
        )}
      </header>

      {connectionId === null ? (
        <Absence
          title="No cloud connection selected"
          detail="Select an active AWS trust-role connection to read its immutable data-transfer evidence."
        />
      ) : null}
      {state.status === "loading" ? (
        <div className={styles.absence} role="status">
          <strong>Loading immutable data-transfer evidence</strong>
          <p>Reading the bounded active CUR 2.0 generation for this customer connection.</p>
        </div>
      ) : null}
      {state.status === "error" ? (
        <div className={styles.absence} role="alert">
          <strong>The data-transfer analysis could not be loaded</strong>
          <p>{state.message}</p>
          <button className={styles.export} onClick={reload} type="button">Retry</button>
        </div>
      ) : null}
      {envelope === null ? null : <FinopsDataTransferPurposes envelope={envelope} />}
    </section>
  );
}

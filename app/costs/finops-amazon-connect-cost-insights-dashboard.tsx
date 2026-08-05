"use client";

import { useEffect, useState } from "react";
import { BarChart, RankingBars, ShareBar, TimeSeriesChart } from "../components/charts";
import type { AmazonConnectOfficialDefinition } from "../../lib/finops-amazon-connect-official-definition";
import type { FinopsDashboardCatalogEntry } from "../../lib/finops-dashboard-catalog";
import { FinopsCapabilityShell, type FinopsCapabilityViewState } from "./finops-capability-shell";
import { StateBadge, formatBasisPoints, formatMicrosExact } from "./finops-foundational-panels";
import { FinopsSheetBlock, foundationalStyles as sheetStyles } from "./finops-foundational-sheet-shell";
import { formatCount, formatUnits, microsToUnits } from "./finops-foundational-money";
import type { FinopsSheetDescriptor } from "./finops-foundational-sheets";
import { sheetKey } from "./finops-foundational-sheets";
import styles from "./finops-amazon-connect-cost-insights-dashboard.module.css";

/**
 * ADD-11 Amazon Connect Cost Insights, presented as the eight sheets the pinned
 * AWS CID definition actually publishes rather than as concern-based panels.
 *
 * The sheet set, the per-sheet visual and control counts, the coverage
 * classification and the named remaining gap all come from
 * `AMAZON_CONNECT_OFFICIAL_DEFINITION`, so this view can neither invent a sheet
 * nor quietly upgrade one. A sheet AWS documents but Sutra cannot back with
 * governed evidence — `Contact Center` — renders its audited unavailability
 * instead of filling the space.
 *
 * Honesty rules enforced here:
 * - Money is an integer count of currency micro-units carried as a string.
 *   Exact figures print through `formatMicrosExact`, which never converts to a
 *   number; charts convert only for geometry through `microsToUnits`, and a
 *   value that cannot convert exactly is dropped from the plot rather than
 *   rounded.
 * - Usage quantities are micro-units of the *source unit*, never money, and are
 *   printed with that unit or an explicit "unit not supplied".
 * - Absent evidence is a labelled state. Nothing absent becomes a zero, and a
 *   share that cannot be computed exactly is withheld with its reason.
 * - Negative amounts (credits, refunds, negative amortization) keep their sign;
 *   composition visuals refuse to draw them as a share.
 * - Privacy: this vertical is aggregated and HMAC-redacted upstream. Phone
 *   numbers, raw contact ids, contact/endpoint tokens and caller identity are
 *   never returned by the API and are never rendered or reconstructed here.
 */

type Filters = {
  instanceAlias: string;
  service: string;
  chargeFamily: string;
  channel: string;
  direction: string;
  countryCode: string;
  phoneNumberType: string;
  usageUnit: string;
};

const EMPTY: Filters = {
  instanceAlias: "",
  service: "",
  chargeFamily: "",
  channel: "",
  direction: "",
  countryCode: "",
  phoneNumberType: "",
  usageUnit: "",
};

interface Aggregate {
  costMicros: string;
  quantityMicros: string;
  unit: string | null;
}

interface CollectionState {
  jobContractAvailable: true;
  providerAdapterAvailable: boolean;
  state?: "unavailable" | "collecting" | "failed" | "ready";
  reason: string;
  lastAttemptAt?: string | null;
  acceptedGenerationId?: string | null;
}

export interface AmazonConnectCostInsightsDashboardData {
  filters: Record<string, string | null>;
  window: { days: 30; startDay: string; endDay: string };
  filterOptions: {
    instanceAliases: string[];
    services: string[];
    chargeFamilies: string[];
    channels: string[];
    directions: string[];
    countries: string[];
    phoneNumberTypes: string[];
    usageUnits: string[];
  };
  overview: {
    instanceCount: number;
    phoneNumberCount: number;
    costMicros: string;
    unattributedCostMicros: string;
    usageRowCount: number;
    tokenizedContactCount: number;
  };
  instances: {
    instanceLabel: string;
    status: string;
    inboundCallsEnabled: boolean;
    outboundCallsEnabled: boolean;
    observedAtIso: string;
    phoneNumberCount: number;
    costMicros: string;
  }[];
  telecom: ({
    countryCode: string | null;
    phoneNumberType: string | null;
    direction: string;
    rowCount: number;
  } & Aggregate)[];
  dailyUsage: ({
    day: string;
    service: string;
    chargeFamily: string;
    channel: string;
    direction: string;
    usageType: string | null;
    rowCount: number;
  } & Aggregate)[];
  callPatterns: ({
    instanceLabel: string;
    channel: string;
    direction: string;
    countryCode: string | null;
    phoneNumberType: string | null;
    contactCount: number;
  } & Aggregate)[];
  phoneInventory: {
    instanceLabel: string;
    countryCode: string;
    phoneNumberType: string;
    status: string;
    count: number;
  }[];
  privacySafeContactDetails: {
    instanceLabel: string;
    channel: string;
    direction: string;
    countryCode: string | null;
    phoneNumberType: string | null;
    distinctTokenizedContactCount: number;
    totalCostMicros: string;
    totalUsageMicros: string;
    unit: string | null;
    detailLevel: string;
  }[];
  limitations: string[];
}

export interface Report {
  schema: string;
  connectionId: string;
  sourceState: string;
  officialDefinition: AmazonConnectOfficialDefinition;
  dashboard: AmazonConnectCostInsightsDashboardData;
  history: {
    generationId: string;
    completedAtIso: string;
    state: string;
    instanceCount: number;
    phoneAggregateCount: number;
    costRowCount: number;
    currency: string;
    costBasis: string;
  }[];
  freshness: { dataThroughAt: string; ageHours: number; staleAfterHours: number };
  provenance: {
    generationId: string;
    activeGenerationId: string | null;
    latestGenerationId: string | null;
    newerIncomplete: boolean;
    captureId: string;
    billingGenerationId: string;
    billingManifestSha256: string;
    costBasis: string;
    currency: string;
  };
  privacy: {
    rawPhoneNumbersReturned: false;
    rawContactIdsReturned: false;
    contactTokensReturned: false;
    callerPiiReturned: false;
    standardUiDetailLevel: string;
    privilegedTokenLookupRouteAvailable: false;
  };
  collection: CollectionState;
}

interface ConfigurationEnvelope {
  schema: string;
  connectionId: string;
  sourceState: string;
  officialDefinition: AmazonConnectOfficialDefinition;
  dashboard: null;
  collection: CollectionState;
}

/* ------------------------------------------------------------------ money --- */

const MICROS = /^-?(?:0|[1-9]\d*)$/u;

/** Parse a canonical integer micro string, or null when it is not one. */
function micros(value: string | null | undefined): bigint | null {
  return typeof value === "string" && MICROS.test(value) ? BigInt(value) : null;
}

/**
 * Exact integer sum of micro strings. A single malformed member makes the whole
 * sum unavailable rather than silently smaller.
 */
function sumMicros(values: readonly string[]): string | null {
  let total = BigInt(0);
  for (const value of values) {
    const parsed = micros(value);
    if (parsed === null) return null;
    total += parsed;
  }
  return total.toString();
}

/**
 * Exact share in integer basis points. Withheld (null) when the denominator is
 * absent, zero or negative, or either side is malformed — a share of a
 * non-positive whole is not a fact.
 */
function shareBasisPoints(part: string | null, whole: string | null): string | null {
  const numerator = micros(part);
  const denominator = micros(whole);
  if (numerator === null || denominator === null || denominator <= BigInt(0)) return null;
  return ((numerator * BigInt(10_000)) / denominator).toString();
}

/**
 * Usage quantity, exact. These are micro-units of the source unit — minutes,
 * numbers, requests — and are never money, so they are never given a currency.
 */
function formatUsageExact(quantityMicros: string, unit: string | null): string {
  const parsed = micros(quantityMicros);
  if (parsed === null) return "Not available";
  const negative = parsed < BigInt(0);
  const absolute = negative ? -parsed : parsed;
  const whole = (absolute / BigInt(1_000_000)).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const fraction = (absolute % BigInt(1_000_000)).toString().padStart(6, "0").replace(/0+$/u, "");
  const value = `${negative ? "−" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
  return `${value} ${unit === null ? "(unit not supplied)" : unit}`;
}

function readable(value: string): string {
  return value.replaceAll("_", " ");
}

/** Group rows by a derived key, preserving first-seen order. */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): { key: string; rows: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const existing = groups.get(id);
    if (existing === undefined) groups.set(id, [row]);
    else existing.push(row);
  }
  return [...groups].map(([id, values]) => ({ key: id, rows: values }));
}

/* ----------------------------------------------------------- sheet audit --- */

/**
 * The eight official sheets, normalized for disclosure. Support never upgrades:
 * only `SUPPORTED` counts as fully covered, so `PARTIAL`, `UNAVAILABLE` and the
 * `About` sheet all keep their audited literal beside a partial badge.
 */
function sheetDescriptors(
  definition: AmazonConnectOfficialDefinition,
): readonly (FinopsSheetDescriptor & { readonly controls: readonly string[]; readonly evidence: string })[] {
  return definition.sheets.map((sheet) => ({
    key: sheetKey(sheet.name),
    name: sheet.name,
    visualCount: sheet.visualCount,
    controlCount: sheet.parameterControls.length + sheet.filterControls.length,
    support: sheet.nativeCoverage === "SUPPORTED" ? "SUPPORTED" : "PARTIAL",
    supportLabel: sheet.nativeCoverage,
    gaps: [sheet.remainingGap],
    formulaIds: [],
    controls: [...sheet.parameterControls, ...sheet.filterControls],
    evidence: sheet.nativeEvidence,
  }));
}

type Sheet = ReturnType<typeof sheetDescriptors>[number];

/** Per-sheet coverage, audited gap and exact official control list. */
function SheetCoverage({ sheet }: { readonly sheet: Sheet }) {
  return (
    <section
      aria-label={`${sheet.name} coverage`}
      className={sheetStyles.coverage}
      data-support={sheet.support}
    >
      <div className={sheetStyles.coverageHead}>
        <strong>{sheet.name}</strong>
        <span className={sheetStyles.coverageBadge} data-support={sheet.support}>
          {readable(sheet.supportLabel)}
        </span>
        <span className={sheetStyles.coverageMeta}>
          {sheet.visualCount} official {sheet.visualCount === 1 ? "visual" : "visuals"}
          {" · "}
          {sheet.controlCount} {sheet.controlCount === 1 ? "control" : "controls"}
        </span>
      </div>
      <ul className={sheetStyles.coverageGaps}>
        <li>Native evidence: {sheet.evidence}</li>
        {sheet.gaps.map((gap) => <li key={gap}>Audited gap: {gap}</li>)}
      </ul>
      {sheet.controls.length === 0 ? null : (
        <ul aria-label={`${sheet.name} official controls`} className={sheetStyles.formulaList}>
          {sheet.controls.map((control, index) => (
            <li key={`${control}:${index}`}>{control}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Tile({
  label, value, detail,
}: { readonly label: string; readonly value: string; readonly detail?: string }) {
  return (
    <div className={sheetStyles.tile}>
      <span className={sheetStyles.tileLabel}>{label}</span>
      <span className={sheetStyles.tileValue}>{value}</span>
      {detail === undefined ? null : <span className={sheetStyles.tileDetail}>{detail}</span>}
    </div>
  );
}

/** An explicit labelled absence. Never a zero, never an empty panel. */
function NoEvidence({ reason }: { readonly reason: string }) {
  return (
    <div className={sheetStyles.coverage} data-support="PARTIAL" role="status">
      <div className={sheetStyles.coverageHead}>
        <strong>Evidence unavailable for this sheet</strong>
        <StateBadge state="unavailable" />
      </div>
      <ul className={sheetStyles.coverageGaps}><li>{reason}</li></ul>
    </div>
  );
}

/* ------------------------------------------------------- official source --- */

export function AmazonConnectOfficialDefinitionPanel({
  definition,
}: {
  readonly definition: AmazonConnectOfficialDefinition;
}) {
  return (
    <section className={styles.official} aria-label="Official Amazon Connect definition coverage">
      <header>
        <div>
          <h3>Official AWS definition coverage</h3>
          <p>
            {definition.totals.sheets} sheets · {definition.totals.visuals} visuals ·{" "}
            {definition.totals.parameterControls + definition.totals.filterControls} controls
          </p>
        </div>
        <small>
          {definition.source.latestDocumentedVersion} · {definition.source.commit.slice(0, 12)} ·{" "}
          {definition.source.manifestSha256.slice(0, 16)}…
        </small>
      </header>
      <div className={styles.officialGrid}>
        {definition.sheets.map((sheet) => (
          <article key={sheet.id}>
            <div>
              <strong>{sheet.name}</strong>
              <span>
                {sheet.visualCount} visuals ·{" "}
                {sheet.parameterControls.length + sheet.filterControls.length} controls
              </span>
            </div>
            <small>{sheet.documentedPurpose ?? "Additional About sheet proven by the definition."}</small>
            <p><b>{readable(sheet.nativeCoverage)}</b> · {sheet.nativeEvidence}</p>
            <details>
              <summary>Exact controls and remaining gap</summary>
              <p>{[...sheet.parameterControls, ...sheet.filterControls].join(" · ") || "No controls"}</p>
              <p>{sheet.remainingGap}</p>
            </details>
          </article>
        ))}
      </div>
      <p className={styles.officialNote}>
        Definition SHA-256 <code>{definition.source.embeddedDefinitionSha256}</code>. Exact counts
        describe the pinned public QuickSight source; native views do not claim pixel, geometry,
        query-result or interaction parity. <code>resource_connect_view</code> has no public dataset
        body or producing query at this commit.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------- 1 Overview --- */

function OverviewSheet({ report }: { readonly report: Report }) {
  const data = report.dashboard;
  const currency = report.provenance.currency;
  const total = data.overview.costMicros;
  const unattributed = data.overview.unattributedCostMicros;
  const totalMicros = micros(total);
  const unattributedMicros = micros(unattributed);
  const attributed = totalMicros === null || unattributedMicros === null
    ? null
    : (totalMicros - unattributedMicros).toString();
  const unattributedShare = shareBasisPoints(unattributed, total);

  const families = groupBy(data.dailyUsage, (row) => row.chargeFamily)
    .map((group) => ({ family: group.key, costMicros: sumMicros(group.rows.map((row) => row.costMicros)) }));

  const attributedUnits = microsToUnits(attributed);
  const unattributedUnits = microsToUnits(unattributed);
  const shareDrawable = attributedUnits !== null
    && unattributedUnits !== null
    && attributedUnits >= 0
    && unattributedUnits >= 0
    && attributedUnits + unattributedUnits > 0;

  return (
    <div className={sheetStyles.blocks}>
      <FinopsSheetBlock
        description={`Amazon Connect and Contact Center Telecom charges on the ${readable(report.provenance.costBasis)} basis, in ${currency}, from one immutable active CUR2 generation.`}
        title="Connect and telecom position"
      >
        <div className={sheetStyles.tiles}>
          <Tile
            detail={`${readable(report.provenance.costBasis)} · exact CUR2 micros`}
            label="Connect + telecom cost"
            value={formatMicrosExact(total, currency)}
          />
          <Tile
            detail={unattributedShare === null
              ? "Share withheld: the period total is not a positive amount"
              : `${formatBasisPoints(unattributedShare)} of the period total`}
            label="Unattributed to a governed instance"
            value={formatMicrosExact(unattributed, currency)}
          />
          <Tile
            detail={`${formatCount(data.overview.usageRowCount)} CUR2 billing rows in window`}
            label="Contact-center account"
            value={`${formatCount(data.overview.instanceCount)} governed instances`}
          />
          <Tile
            detail="Aggregated counts only; no telephone value is retained"
            label="Phone-number inventory"
            value={formatCount(data.overview.phoneNumberCount)}
          />
          <Tile
            detail="Distinct count only; tokens hidden"
            label="Tokenized contact coverage"
            value={formatCount(data.overview.tokenizedContactCount)}
          />
          <Tile
            detail={`${data.window.startDay} to ${data.window.endDay}`}
            label="Window"
            value={`${data.window.days} days`}
          />
        </div>

        {shareDrawable ? (
          <ShareBar
            ariaLabel={`Instance-attributed against unattributed Connect cost in ${currency}`}
            formatValue={(value) => formatUnits(value, currency)}
            segments={[
              { id: "attributed", label: "Attributed to a governed instance", value: attributedUnits, tone: "teal" },
              { id: "unattributed", label: "Unattributed", value: unattributedUnits, tone: "amber" },
            ]}
          />
        ) : (
          <p className={sheetStyles.goalMeta}>
            The attributed/unattributed composition is withheld: a share is only drawn when both
            parts are collected, non-negative and sum to a positive total. Signed amounts remain
            exact in the tiles above.
          </p>
        )}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Charge families keep their sign, so a credit or refund reduces the bar instead of being drawn as a share of it."
        title="Cost by official charge family"
      >
        {families.length === 0 ? (
          <NoEvidence reason="The active generation carries no billing row in this 30-day window, so no charge family can be summed. This is a proven absence for the window, not a zero bill." />
        ) : (
          <BarChart
            ariaLabel={`Connect cost by charge family in ${currency}`}
            categories={families.map((entry) => readable(entry.family))}
            formatValue={(value) => formatUnits(value, currency)}
            series={[{
              id: "charge-family",
              label: `${readable(report.provenance.costBasis)} cost`,
              values: families.map((entry) => microsToUnits(entry.costMicros)),
            }]}
          />
        )}
      </FinopsSheetBlock>
    </div>
  );
}

/* -------------------------------------------------------- 2 Contact Center -- */

function ContactCenterSheet({ report }: { readonly report: Report }) {
  const data = report.dashboard;
  const currency = report.provenance.currency;
  return (
    <div className={sheetStyles.blocks}>
      <FinopsSheetBlock
        description="Governed Connect scope only."
        title="Contact-center account analysis"
      >
        <p className={sheetStyles.goalMeta}>
          <strong>Coverage boundary:</strong> this view contains Connect instance configuration and
          Connect/telecom CUR2 spend only. The official CID sheet also analyzes supporting
          AWS-service spend in Connect-enabled accounts; that broader evidence plane is not
          configured and is not inferred here, so those costs are absent rather than zero.
        </p>
        {data.instances.length === 0 ? (
          <NoEvidence reason="No governed Connect instance was observed in the accepted capture, so no instance-level configuration or attributed cost exists to show." />
        ) : (
          <>
            <div className={sheetStyles.tableWrap}>
              <table className={sheetStyles.table}>
                <caption>
                  One row per governed instance, with the instance-attributed CUR2 cost kept exact
                  in micro-units.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Instance</th>
                    <th scope="col">Status</th>
                    <th scope="col">Voice enablement</th>
                    <th scope="col">Observed</th>
                    <th className={sheetStyles.numeric} scope="col">Phone inventory</th>
                    <th className={sheetStyles.numeric} scope="col">Connect-attributed cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.instances.map((instance) => (
                    <tr key={instance.instanceLabel}>
                      <th scope="row">{instance.instanceLabel}</th>
                      <td><StateBadge state={instance.status.toLowerCase()} /></td>
                      <td>
                        {instance.inboundCallsEnabled ? "Inbound enabled" : "Inbound disabled"}
                        {" · "}
                        {instance.outboundCallsEnabled ? "Outbound enabled" : "Outbound disabled"}
                      </td>
                      <td>{instance.observedAtIso}</td>
                      <td className={sheetStyles.numeric}>{formatCount(instance.phoneNumberCount)}</td>
                      <td className={sheetStyles.numeric}>
                        {formatMicrosExact(instance.costMicros, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <RankingBars
              ariaLabel={`Connect-attributed cost by governed instance in ${currency}`}
              formatValue={(value) => formatUnits(value, currency)}
              items={data.instances.flatMap((instance) => {
                const units = microsToUnits(instance.costMicros);
                return units === null ? [] : [{
                  id: instance.instanceLabel,
                  label: instance.instanceLabel,
                  value: units,
                  detail: `${formatCount(instance.phoneNumberCount)} numbers`,
                }];
              })}
              sort
            />
          </>
        )}
        <p className={sheetStyles.goalMeta}>
          Per-instance API pagination and permission-validation flags are recorded in the accepted
          capture but are not carried on this endpoint, so instance completeness is reported here
          only through the bounded generation history on the About sheet.
        </p>
      </FinopsSheetBlock>
    </div>
  );
}

/* ------------------------------------------------------------- 3 Connect --- */

function ConnectSheet({ report }: { readonly report: Report }) {
  const data = report.dashboard;
  const currency = report.provenance.currency;
  const voice = data.dailyUsage.filter((row) => row.channel === "VOICE");
  const perDay = groupBy(voice, (row) => row.day)
    .map((group) => ({ day: group.key, costMicros: sumMicros(group.rows.map((row) => row.costMicros)) }))
    .sort((left, right) => left.day.localeCompare(right.day));

  return (
    <div className={sheetStyles.blocks}>
      <FinopsSheetBlock
        description="Inbound, outbound and transfer voice billing rows, kept separate by charge family, usage type and source unit."
        title="Connect voice usage and cost"
      >
        {voice.length === 0 ? (
          <NoEvidence reason="No billing row in this window carried the VOICE channel. Voice cost and usage are therefore unavailable for the window, not zero." />
        ) : (
          <>
            <TimeSeriesChart
              ariaLabel={`Daily voice channel cost in ${currency}`}
              formatValue={(value) => formatUnits(value, currency)}
              mode="line"
              series={[{
                id: "voice",
                label: `Voice ${readable(report.provenance.costBasis)} cost`,
                points: perDay.map((entry) => ({
                  label: entry.day,
                  value: microsToUnits(entry.costMicros),
                })),
              }]}
            />
            <div className={sheetStyles.tableWrap}>
              <table className={sheetStyles.table}>
                <caption>
                  A day absent from this table carried no collected voice row; it is a gap in the
                  window rather than a day that cost nothing.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Day</th>
                    <th scope="col">Direction</th>
                    <th scope="col">Charge family</th>
                    <th scope="col">Usage type</th>
                    <th className={sheetStyles.numeric} scope="col">Usage</th>
                    <th className={sheetStyles.numeric} scope="col">Rows</th>
                    <th className={sheetStyles.numeric} scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {voice.map((row, index) => (
                    <tr key={`${row.day}:${row.direction}:${row.chargeFamily}:${index}`}>
                      <th scope="row">{row.day}</th>
                      <td>{row.direction}</td>
                      <td>{readable(row.chargeFamily)}</td>
                      <td>{row.usageType ?? "Not supplied"}</td>
                      <td className={sheetStyles.numeric}>
                        {formatUsageExact(row.quantityMicros, row.unit)}
                      </td>
                      <td className={sheetStyles.numeric}>{formatCount(row.rowCount)}</td>
                      <td className={sheetStyles.numeric}>
                        {formatMicrosExact(row.costMicros, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </FinopsSheetBlock>
    </div>
  );
}

/* ------------------------------------------------------------- 4 Telecom --- */

function TelecomSheet({ report }: { readonly report: Report }) {
  const data = report.dashboard;
  const currency = report.provenance.currency;
  return (
    <div className={sheetStyles.blocks}>
      <FinopsSheetBlock
        description="No telephone number value is retained anywhere in this vertical; country and number type are billing classifications."
        title="Telecom by number type and country"
      >
        {data.telecom.length === 0 ? (
          <NoEvidence reason="No telecom-classified billing row was collected for this window, so number-type and country aggregates are unavailable rather than zero." />
        ) : (
          <>
            <RankingBars
              ariaLabel={`Telecom cost by country, number type and direction in ${currency}`}
              formatValue={(value) => formatUnits(value, currency)}
              items={data.telecom.flatMap((row, index) => {
                const units = microsToUnits(row.costMicros);
                return units === null ? [] : [{
                  id: `${row.countryCode ?? "unattributed"}:${row.phoneNumberType ?? "unattributed"}:${row.direction}:${index}`,
                  label: `${row.countryCode ?? "Unattributed"} · ${row.phoneNumberType ?? "Unattributed"} · ${row.direction}`,
                  value: units,
                  detail: formatUsageExact(row.quantityMicros, row.unit),
                }];
              })}
              sort
            />
            <div className={sheetStyles.tableWrap}>
              <table className={sheetStyles.table}>
                <caption>
                  Telecom aggregates in exact micro-units. An unattributed country or number type
                  is shown as unattributed, never folded into a known one.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Country</th>
                    <th scope="col">Number type</th>
                    <th scope="col">Direction</th>
                    <th className={sheetStyles.numeric} scope="col">Usage</th>
                    <th className={sheetStyles.numeric} scope="col">Rows</th>
                    <th className={sheetStyles.numeric} scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.telecom.map((row, index) => (
                    <tr key={`${row.countryCode}:${row.phoneNumberType}:${row.direction}:${index}`}>
                      <th scope="row">{row.countryCode ?? "Unattributed"}</th>
                      <td>{row.phoneNumberType ?? "Unattributed"}</td>
                      <td>{row.direction}</td>
                      <td className={sheetStyles.numeric}>
                        {formatUsageExact(row.quantityMicros, row.unit)}
                      </td>
                      <td className={sheetStyles.numeric}>{formatCount(row.rowCount)}</td>
                      <td className={sheetStyles.numeric}>
                        {formatMicrosExact(row.costMicros, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Pre-broker aggregate phone inventory: counts by instance, country, number type and claim status. Individual numbers are never collected."
        title="Phone-number inventory"
      >
        {data.phoneInventory.length === 0 ? (
          <NoEvidence reason="The accepted capture returned no phone-inventory aggregate for the selected filters, so inventory counts are unavailable." />
        ) : (
          <div className={sheetStyles.tableWrap}>
            <table className={sheetStyles.table}>
              <caption>Aggregate claim counts only — no telephone value is stored or rendered.</caption>
              <thead>
                <tr>
                  <th scope="col">Instance</th>
                  <th scope="col">Country</th>
                  <th scope="col">Number type</th>
                  <th scope="col">Status</th>
                  <th className={sheetStyles.numeric} scope="col">Count</th>
                </tr>
              </thead>
              <tbody>
                {data.phoneInventory.map((row, index) => (
                  <tr key={`${row.instanceLabel}:${row.countryCode}:${row.phoneNumberType}:${index}`}>
                    <th scope="row">{row.instanceLabel}</th>
                    <td>{row.countryCode}</td>
                    <td>{row.phoneNumberType}</td>
                    <td><StateBadge state={row.status.toLowerCase()} /></td>
                    <td className={sheetStyles.numeric}>{formatCount(row.count)}</td>
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

/* --------------------------------------------------------- 5 Daily Usage --- */

function DailyUsageSheet({ report }: { readonly report: Report }) {
  const data = report.dashboard;
  const currency = report.provenance.currency;
  const perDay = groupBy(data.dailyUsage, (row) => row.day)
    .map((group) => ({ day: group.key, costMicros: sumMicros(group.rows.map((row) => row.costMicros)) }))
    .sort((left, right) => left.day.localeCompare(right.day));
  const directions = groupBy(data.dailyUsage, (row) => row.direction)
    .map((group) => ({ direction: group.key, costMicros: sumMicros(group.rows.map((row) => row.costMicros)) }));
  const units = groupBy(
    data.dailyUsage,
    (row) => `${row.chargeFamily} ${row.unit ?? ""}`,
  ).flatMap((group) => {
    const first = group.rows[0];
    if (first === undefined) return [];
    return [{
      chargeFamily: first.chargeFamily,
      unit: first.unit,
      quantityMicros: sumMicros(group.rows.map((row) => row.quantityMicros)),
      costMicros: sumMicros(group.rows.map((row) => row.costMicros)),
      rowCount: group.rows.reduce((sum, row) => sum + row.rowCount, 0),
    }];
  });

  return (
    <div className={sheetStyles.blocks}>
      <FinopsSheetBlock
        description={`${data.window.startDay} to ${data.window.endDay}, a fixed ${data.window.days}-day CUR2 window.`}
        title="30-day daily cost and usage"
      >
        {perDay.length === 0 ? (
          <NoEvidence reason="The fixed 30-day window contains no collected billing row, so no daily trend exists. An empty window is not a window of zeros." />
        ) : (
          <>
            <TimeSeriesChart
              ariaLabel={`Daily Amazon Connect and telecom cost in ${currency}`}
              formatValue={(value) => formatUnits(value, currency)}
              mode="area"
              series={[{
                id: "daily",
                label: `${readable(report.provenance.costBasis)} cost`,
                points: perDay.map((entry) => ({
                  label: entry.day,
                  value: microsToUnits(entry.costMicros),
                })),
              }]}
            />
            <BarChart
              ariaLabel={`Cost by call direction in ${currency}`}
              categories={directions.map((entry) => entry.direction)}
              formatValue={(value) => formatUnits(value, currency)}
              series={[{
                id: "direction",
                label: `${readable(report.provenance.costBasis)} cost`,
                values: directions.map((entry) => microsToUnits(entry.costMicros)),
              }]}
            />
          </>
        )}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Inbound and outbound minutes, phone-number charges and other Connect usage stay separated by charge family and source unit; unlike units are never added together."
        title="Usage by charge family and source unit"
      >
        {units.length === 0 ? (
          <NoEvidence reason="No usage row was collected in the window, so no charge family or source unit can be totalled." />
        ) : (
          <div className={sheetStyles.tableWrap}>
            <table className={sheetStyles.table}>
              <caption>
                Quantities are micro-units of the stated source unit. A row with no supplied unit
                says so instead of being assumed to be minutes.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Charge family</th>
                  <th scope="col">Source unit</th>
                  <th className={sheetStyles.numeric} scope="col">Usage</th>
                  <th className={sheetStyles.numeric} scope="col">Rows</th>
                  <th className={sheetStyles.numeric} scope="col">Cost</th>
                </tr>
              </thead>
              <tbody>
                {units.map((row, index) => (
                  <tr key={`${row.chargeFamily}:${row.unit ?? "none"}:${index}`}>
                    <th scope="row">{readable(row.chargeFamily)}</th>
                    <td>{row.unit ?? "Unit not supplied"}</td>
                    <td className={sheetStyles.numeric}>
                      {row.quantityMicros === null
                        ? "Not available"
                        : formatUsageExact(row.quantityMicros, row.unit)}
                    </td>
                    <td className={sheetStyles.numeric}>{formatCount(row.rowCount)}</td>
                    <td className={sheetStyles.numeric}>
                      {formatMicrosExact(row.costMicros, currency)}
                    </td>
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

/* -------------------------------------------------------- 6 Call Details --- */

function CallDetailsSheet({ report }: { readonly report: Report }) {
  const data = report.dashboard;
  const currency = report.provenance.currency;
  return (
    <div className={sheetStyles.blocks}>
      <FinopsSheetBlock
        description="Aggregated CUR2 call-pattern rows. Billing country is a charge classification, not caller location, and usage is not labelled duration unless the source unit proves it."
        title="Call patterns, durations and regions"
      >
        {data.callPatterns.length === 0 ? (
          <NoEvidence reason="No call-pattern aggregate was produced for this window, so channel, direction and billing-country distribution are unavailable rather than empty." />
        ) : (
          <>
            <RankingBars
              ariaLabel={`Aggregated call-pattern cost by instance, channel and direction in ${currency}`}
              formatValue={(value) => formatUnits(value, currency)}
              items={data.callPatterns.flatMap((row, index) => {
                const value = microsToUnits(row.costMicros);
                return value === null ? [] : [{
                  id: `${row.instanceLabel}:${row.channel}:${row.direction}:${index}`,
                  label: `${row.instanceLabel} · ${row.channel} · ${row.direction}`,
                  value,
                  detail: `${formatCount(row.contactCount)} distinct tokenized contacts`,
                }];
              })}
              sort
            />
            <div className={sheetStyles.tableWrap}>
              <table className={sheetStyles.table}>
                <caption>
                  Contact counts are distinct counts of HMAC-redacted tokens. The tokens themselves
                  are not returned by the API and cannot be reconstructed from this table.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Instance</th>
                    <th scope="col">Channel / direction</th>
                    <th scope="col">Billing country</th>
                    <th scope="col">Number type</th>
                    <th className={sheetStyles.numeric} scope="col">Distinct contacts</th>
                    <th className={sheetStyles.numeric} scope="col">Usage (source unit)</th>
                    <th className={sheetStyles.numeric} scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.callPatterns.map((row, index) => (
                    <tr key={`${row.instanceLabel}:${row.channel}:${row.direction}:${index}`}>
                      <th scope="row">{row.instanceLabel}</th>
                      <td>{row.channel} · {row.direction}</td>
                      <td>{row.countryCode ?? "Unattributed"}</td>
                      <td>{row.phoneNumberType ?? "Unattributed"}</td>
                      <td className={sheetStyles.numeric}>{formatCount(row.contactCount)}</td>
                      <td className={sheetStyles.numeric}>
                        {formatUsageExact(row.quantityMicros, row.unit)}
                      </td>
                      <td className={sheetStyles.numeric}>
                        {formatMicrosExact(row.costMicros, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </FinopsSheetBlock>
    </div>
  );
}

/* ------------------------------------------------------- 7 Contact Search -- */

function ContactSearchSheet({ report }: { readonly report: Report }) {
  const data = report.dashboard;
  const currency = report.provenance.currency;
  return (
    <div className={sheetStyles.blocks}>
      <FinopsSheetBlock
        description="Aggregated token counts only."
        title="Privacy-safe contact search and details"
      >
        <div className={styles.privacy}>
          <strong>Ordinary FinOps access cannot search a raw contact ID or phone number.</strong>{" "}
          This sheet supports governed instance, channel, direction, country and number-type
          filters and returns only distinct tokenized-contact counts with aggregate billing facts.
          Privileged exact-token lookup is disabled until a separate approval, audit and
          expiring-grant route exists.
        </div>
        <div className={sheetStyles.tiles}>
          <Tile
            detail="Standard UI detail level"
            label="Detail level"
            value={readable(report.privacy.standardUiDetailLevel)}
          />
          <Tile
            detail="Distinct count only; tokens hidden"
            label="Tokenized contacts in window"
            value={formatCount(data.overview.tokenizedContactCount)}
          />
          <Tile
            detail="Enforced by the endpoint, not by this view"
            label="Raw phone numbers / contact IDs"
            value={report.privacy.rawPhoneNumbersReturned || report.privacy.rawContactIdsReturned
              ? "Returned"
              : "Never returned"}
          />
          <Tile
            detail="A separate approved and audited route does not exist yet"
            label="Privileged token lookup"
            value={report.privacy.privilegedTokenLookupRouteAvailable ? "Available" : "Unavailable"}
          />
        </div>
        {data.privacySafeContactDetails.length === 0 ? (
          <NoEvidence reason="No aggregate carried a positive tokenized-contact count for these filters. Contact-level coverage is unavailable for the window; it is not evidence that no contact occurred." />
        ) : (
          <div className={sheetStyles.tableWrap}>
            <table className={sheetStyles.table}>
              <caption>
                Every row is an aggregate over governed billing dimensions. No caller identifier,
                endpoint, recording, transcript or agent attribute is present.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Instance</th>
                  <th scope="col">Pattern</th>
                  <th scope="col">Country / type</th>
                  <th scope="col">Detail level</th>
                  <th className={sheetStyles.numeric} scope="col">Distinct tokenized contacts</th>
                  <th className={sheetStyles.numeric} scope="col">Aggregate usage</th>
                  <th className={sheetStyles.numeric} scope="col">Aggregate cost</th>
                </tr>
              </thead>
              <tbody>
                {data.privacySafeContactDetails.map((row, index) => (
                  <tr key={`${row.instanceLabel}:${row.channel}:${row.direction}:${index}`}>
                    <th scope="row">{row.instanceLabel}</th>
                    <td>{row.channel} · {row.direction}</td>
                    <td>
                      {row.countryCode ?? "Unattributed"} · {row.phoneNumberType ?? "Unattributed"}
                    </td>
                    <td>{readable(row.detailLevel)}</td>
                    <td className={sheetStyles.numeric}>
                      {formatCount(row.distinctTokenizedContactCount)}
                    </td>
                    <td className={sheetStyles.numeric}>
                      {formatUsageExact(row.totalUsageMicros, row.unit)}
                    </td>
                    <td className={sheetStyles.numeric}>
                      {formatMicrosExact(row.totalCostMicros, currency)}
                    </td>
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

/* --------------------------------------------------------------- 8 About --- */

function AboutSheet({ report }: { readonly report: Report }) {
  const definition = report.officialDefinition;
  const data = report.dashboard;
  return (
    <div className={sheetStyles.blocks}>
      <FinopsSheetBlock
        description="The hash-pinned public AWS source this view mirrors."
        title="Pinned official source"
      >
        <div className={sheetStyles.tiles}>
          <Tile label="Dashboard" value={definition.source.dashboardName} />
          <Tile
            detail={definition.source.category}
            label="Documented version"
            value={definition.source.latestDocumentedVersion}
          />
          <Tile label="Commit" value={definition.source.commit} />
          <Tile label="Manifest SHA-256" value={definition.source.manifestSha256} />
          <Tile label="Definition SHA-256" value={definition.source.embeddedDefinitionSha256} />
          <Tile label="Changelog SHA-256" value={definition.source.changelogSha256} />
        </div>
        <p className={sheetStyles.goalMeta}>
          {definition.totals.sheets} sheets · {definition.totals.visuals} visuals ·{" "}
          {definition.totals.parameterControls} parameter controls ·{" "}
          {definition.totals.filterControls} filter controls ·{" "}
          {definition.totals.calculatedFields} calculated fields ·{" "}
          {definition.totals.filterGroups} filter groups · {definition.totals.datasets} datasets.
        </p>
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Published dataset contracts, and the one the public source does not publish."
        title="Data contracts"
      >
        <div className={sheetStyles.tableWrap}>
          <table className={sheetStyles.table}>
            <caption>
              An unpublished contract is recorded as unpublished. Its dataset body and producing
              query are absent at the pinned commit and are not reconstructed, guessed or emulated.
            </caption>
            <thead>
              <tr>
                <th scope="col">Identifier</th>
                <th scope="col">Dataset definition</th>
                <th scope="col">Producing query</th>
                <th className={sheetStyles.numeric} scope="col">Input columns</th>
                <th scope="col">Disclosure</th>
              </tr>
            </thead>
            <tbody>
              {definition.dataContracts.map((contract) => (
                <tr key={contract.identifier}>
                  <th scope="row">{contract.identifier}</th>
                  <td>
                    {contract.datasetDefinitionPublished
                      ? contract.datasetDefinitionPath ?? "Published"
                      : "Not published at the pinned commit"}
                  </td>
                  <td>
                    {contract.queryPublished
                      ? contract.queryPath ?? "Published"
                      : "Not published at the pinned commit"}
                  </td>
                  <td className={sheetStyles.numeric}>
                    {contract.inputColumnCount === null
                      ? "Unavailable"
                      : formatCount(contract.inputColumnCount)}
                  </td>
                  <td>{contract.disclosure}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Lineage of the snapshot rendered above, and the bounded immutable history behind it."
        title="Evidence lineage and freshness"
      >
        <div className={sheetStyles.tiles}>
          <Tile
            detail={`Selected generation ${report.provenance.generationId}`}
            label="Accepted generation"
            value={report.provenance.activeGenerationId ?? "No complete head"}
          />
          <Tile
            detail={report.provenance.newerIncomplete
              ? "A newer incomplete attempt exists and is disclosed, not activated"
              : "No newer attempt is pending"}
            label="Latest generation"
            value={report.provenance.latestGenerationId ?? "Not available"}
          />
          <Tile label="Capture" value={report.provenance.captureId} />
          <Tile
            detail={`Manifest ${report.provenance.billingManifestSha256}`}
            label="CUR2 generation"
            value={report.provenance.billingGenerationId}
          />
          <Tile
            detail={`${report.freshness.ageHours} hours old · stale after ${report.freshness.staleAfterHours}`}
            label="Data through"
            value={report.freshness.dataThroughAt}
          />
          <Tile
            detail={`Currency ${report.provenance.currency}`}
            label="Cost basis"
            value={readable(report.provenance.costBasis)}
          />
          <Tile
            detail={report.collection.reason}
            label="Collection state"
            value={report.collection.state === undefined
              ? report.collection.providerAdapterAvailable ? "Adapter available" : "Adapter unavailable"
              : readable(report.collection.state)}
          />
          <Tile
            detail="Source state reported by the endpoint"
            label="Snapshot state"
            value={readable(report.sourceState)}
          />
        </div>
        <div className={sheetStyles.tableWrap}>
          <table className={sheetStyles.table}>
            <caption>Immutable generation history, bounded by the endpoint to the most recent entries.</caption>
            <thead>
              <tr>
                <th scope="col">Completed</th>
                <th scope="col">State</th>
                <th className={sheetStyles.numeric} scope="col">Instances</th>
                <th className={sheetStyles.numeric} scope="col">Phone aggregates</th>
                <th className={sheetStyles.numeric} scope="col">Cost rows</th>
                <th scope="col">Basis / currency</th>
              </tr>
            </thead>
            <tbody>
              {report.history.map((entry) => (
                <tr key={entry.generationId}>
                  <th scope="row">{entry.completedAtIso}</th>
                  <td><StateBadge state={entry.state} /></td>
                  <td className={sheetStyles.numeric}>{formatCount(entry.instanceCount)}</td>
                  <td className={sheetStyles.numeric}>{formatCount(entry.phoneAggregateCount)}</td>
                  <td className={sheetStyles.numeric}>{formatCount(entry.costRowCount)}</td>
                  <td>{readable(entry.costBasis)} · {entry.currency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Stated limitations of this vertical, from the pinned audit and from the engine that produced the snapshot."
        title="Limitations and disclosures"
      >
        <ul className={sheetStyles.coverageGaps}>
          {data.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
          {definition.disclosures.map((disclosure) => <li key={disclosure}>{disclosure}</li>)}
        </ul>
      </FinopsSheetBlock>
    </div>
  );
}

/**
 * One official sheet's content. Exported so every sheet can be rendered and
 * asserted directly, without driving the fetch lifecycle.
 */
export function AmazonConnectCostInsightsSheetContent({
  report, sheet,
}: { readonly report: Report; readonly sheet: Sheet }) {
  switch (sheet.key) {
    case "overview": return <OverviewSheet report={report} />;
    case "contact-center": return <ContactCenterSheet report={report} />;
    case "connect": return <ConnectSheet report={report} />;
    case "telecom": return <TelecomSheet report={report} />;
    case "daily-usage": return <DailyUsageSheet report={report} />;
    case "call-details": return <CallDetailsSheet report={report} />;
    case "contact-search": return <ContactSearchSheet report={report} />;
    case "about": return <AboutSheet report={report} />;
    default:
      return (
        <NoEvidence
          reason={`Sutra has no native projection for the official sheet "${sheet.name}". The sheet is listed because the pinned definition publishes it; it is not presented as delivered.`}
        />
      );
  }
}

/**
 * Presentation for a loaded Amazon Connect report: the eight official sheets,
 * each with its audited coverage, gap and control list above its evidence.
 *
 * Takes the report envelope directly, so a test or a server-side snapshot can
 * render every sheet with no fetching and no filter plumbing. Sheets are stacked
 * rather than tabbed so that the whole disclosed surface — including the sheet
 * AWS publishes that Sutra cannot back — is present in one pass.
 */
export function AmazonConnectCostInsightsSheets({ report }: { readonly report: Report }) {
  const sheets = sheetDescriptors(report.officialDefinition);
  return (
    <div className={sheetStyles.shell}>
      <div className={sheetStyles.shellHead}>
        <p className={sheetStyles.inventory}>
          <span><b>{report.officialDefinition.totals.sheets}</b> official sheets</span>
          <span><b>{report.officialDefinition.totals.visuals}</b> visuals</span>
          <span>
            <b>
              {report.officialDefinition.totals.parameterControls
                + report.officialDefinition.totals.filterControls}
            </b> controls
          </span>
          <span>
            <b>{sheets.filter((sheet) => sheet.support === "SUPPORTED").length}</b> fully covered,{" "}
            <b>{sheets.filter((sheet) => sheet.support === "PARTIAL").length}</b> partial or
            unavailable
          </span>
          <span className={sheetStyles.inventoryPin}>
            pinned {report.officialDefinition.source.embeddedDefinitionSha256.slice(0, 12)} ·{" "}
            {report.officialDefinition.source.latestDocumentedVersion}
          </span>
        </p>
      </div>
      {sheets.map((sheet) => (
        <section aria-label={`${sheet.name} sheet`} className={sheetStyles.panel} key={sheet.key}>
          <SheetCoverage sheet={sheet} />
          <AmazonConnectCostInsightsSheetContent report={report} sheet={sheet} />
        </section>
      ))}
    </div>
  );
}

function Select({
  label, value, options, onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly onChange: (next: string) => void;
}) {
  return (
    <label>
      {label}
      <select onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="">All</option>
        {options.map((option) => <option key={option}>{option}</option>)}
      </select>
    </label>
  );
}

/**
 * The full report view: privacy boundary, the official governed filters, the
 * pinned definition audit and the eight official sheets.
 *
 * Props are unchanged from the previous implementation because a shared registry
 * and an existing vertical test both drive this component directly.
 */
export function AmazonConnectCostInsightsReportView({
  report, filters, onFiltersChange,
}: {
  readonly report: Report;
  readonly filters: Filters;
  readonly onFiltersChange: (next: Filters) => void;
}) {
  const options = report.dashboard.filterOptions;
  const set = (key: keyof Filters, value: string) => onFiltersChange({ ...filters, [key]: value });
  return (
    <section className={styles.root} aria-label="Amazon Connect Cost Insights">
      <AmazonConnectOfficialDefinitionPanel definition={report.officialDefinition} />

      <div className={styles.notice}>
        <strong>Privacy-safe billing intelligence.</strong> Costs and usage come from one immutable
        active CUR2 generation, aggregated and HMAC-redacted before storage. Phone numbers, raw
        contact IDs, HMAC tokens, caller identity, recordings, transcripts, and agent details are
        neither returned nor rendered.
      </div>

      {report.sourceState === "partial" ? (
        <div role="status" className={styles.warning}>
          A newer incomplete attempt is disclosed; the previous complete accepted head remains
          active. Nothing from the incomplete attempt is shown or blended in.
        </div>
      ) : null}

      <section className={styles.filters} aria-label="Connect cost filters">
        <Select
          label="Instance label"
          onChange={(value) => set("instanceAlias", value)}
          options={options.instanceAliases}
          value={filters.instanceAlias}
        />
        <Select
          label="Service"
          onChange={(value) => set("service", value)}
          options={options.services}
          value={filters.service}
        />
        <Select
          label="Charge family"
          onChange={(value) => set("chargeFamily", value)}
          options={options.chargeFamilies}
          value={filters.chargeFamily}
        />
        <Select
          label="Channel"
          onChange={(value) => set("channel", value)}
          options={options.channels}
          value={filters.channel}
        />
        <Select
          label="Direction"
          onChange={(value) => set("direction", value)}
          options={options.directions}
          value={filters.direction}
        />
        <Select
          label="Country"
          onChange={(value) => set("countryCode", value)}
          options={options.countries}
          value={filters.countryCode}
        />
        <Select
          label="Number type"
          onChange={(value) => set("phoneNumberType", value)}
          options={options.phoneNumberTypes}
          value={filters.phoneNumberType}
        />
        <Select
          label="Usage unit"
          onChange={(value) => set("usageUnit", value)}
          options={options.usageUnits}
          value={filters.usageUnit}
        />
        <button onClick={() => onFiltersChange(EMPTY)} type="button">Clear filters</button>
      </section>

      <AmazonConnectCostInsightsSheets report={report} />
    </section>
  );
}

/* ------------------------------------------------------------- container --- */

function shellState(state: string): FinopsCapabilityViewState {
  return state === "complete"
    ? "complete"
    : state === "empty"
      ? "empty"
      : state === "stale"
        ? "stale"
        : state === "partial"
          ? "partial"
          : state === "configuration_required" || state === "permission_required"
            ? "configuration_required"
            : "failed";
}

function hasOfficialDefinition(
  value: unknown,
  connectionId: string,
): value is Report | ConfigurationEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as Record<string, unknown>;
  const official = envelope.officialDefinition;
  if (typeof official !== "object" || official === null) return false;
  const audit = official as Record<string, unknown>;
  const source = audit.source;
  if (typeof source !== "object" || source === null) return false;
  const pinned = source as Record<string, unknown>;
  return envelope.schema === "sutra.finops-amazon-connect-cost-insights-dashboard.v1"
    && envelope.connectionId === connectionId
    && "dashboard" in envelope
    && audit.schema === "sutra.amazon-connect-official-definition.v1"
    && pinned.commit === "f9e36d88c47709f10e8fa784ad11d5cc0e728021"
    && pinned.embeddedDefinitionSha256
      === "c5078f8b73558a7ab1bc388e24dd52fae0ddd954f5097aec8e50b6552fdfc0b8";
}

export function FinopsAmazonConnectCostInsightsDashboard({
  connectionId, dashboard,
}: {
  connectionId: string | null;
  dashboard: FinopsDashboardCatalogEntry;
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [state, setState] = useState<{
    loading: boolean;
    report: Report | null;
    configuration: ConfigurationEnvelope | null;
    error: string | null;
  }>({ loading: true, report: null, configuration: null, error: null });

  useEffect(() => {
    if (connectionId === null) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ connectionId });
    for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
    const frame = window.requestAnimationFrame(() => {
      setState({ loading: true, report: null, configuration: null, error: null });
      void fetch(`/api/v1/finops/amazon-connect-cost-insights?${query}`, {
        signal: controller.signal,
        credentials: "same-origin",
      }).then(async (response) => {
        if (!response.ok) throw new Error("Amazon Connect cost request failed");
        return response.json() as Promise<unknown>;
      }).then((body) => {
        if (!hasOfficialDefinition(body, connectionId)) {
          setState({
            loading: false,
            report: null,
            configuration: null,
            error: "Amazon Connect official definition was not recognized",
          });
          return;
        }
        setState(body.dashboard === null
          ? { loading: false, report: null, configuration: body, error: null }
          : { loading: false, report: body, configuration: null, error: null });
      }, (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          loading: false,
          report: null,
          configuration: null,
          error: error instanceof Error ? error.message : "Amazon Connect cost request failed",
        });
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      controller.abort();
    };
  }, [connectionId, filters]);

  const r = connectionId !== null && state.report?.connectionId === connectionId
    ? state.report
    : null;
  const configuration = connectionId !== null
    && state.configuration?.connectionId === connectionId
    ? state.configuration
    : null;

  const shown = connectionId === null
    ? {
      state: "configuration_required" as const,
      title: "Connect AWS to configure Amazon Connect insights",
      detail: "An active AWS trust-role connection and governed Connect instance set are required.",
    }
    : state.error
      ? {
        state: "failed" as const,
        title: "Amazon Connect cost evidence could not be verified",
        detail: state.error,
      }
      : state.loading
        ? {
          state: "loading" as const,
          title: "Loading Amazon Connect cost evidence",
          detail: "Reading the immutable accepted CUR2-backed snapshot.",
        }
        : r === null && configuration?.sourceState === "collecting"
          ? {
            state: "loading" as const,
            title: "Collecting Amazon Connect cost evidence",
            detail: "The signed provider job is collecting governed instance and active CUR2 evidence.",
          }
          : r === null && configuration?.sourceState === "failed"
            ? {
              state: "failed" as const,
              title: "Amazon Connect cost collection failed",
              detail: configuration.collection.reason,
            }
            : r === null
              ? {
                state: "configuration_required" as const,
                title: "Amazon Connect materialization is not configured",
                detail: "Bind the signed provider adapter to governed instance ARNs and the active reconciled CUR2 generation.",
              }
              : {
                state: shellState(r.sourceState),
                title: "Amazon Connect Cost Insights",
                detail: "Eight official sheets of privacy-safe cost, usage, telecom, call-pattern and contact-summary evidence.",
              };

  const evidence = r === null ? null : {
    sourceLabel: "Active CUR2 + aggregated Amazon Connect configuration",
    collectedAt: r.history[0]?.completedAtIso ?? r.freshness.dataThroughAt,
    dataThroughAt: r.freshness.dataThroughAt,
    freshnessAgeHours: r.freshness.ageHours,
    freshnessSlaHours: r.freshness.staleAfterHours,
    acceptedRecords: r.dashboard.overview.usageRowCount,
    rejectedRecords: null,
    generationId: r.provenance.generationId,
    contentSha256: r.provenance.billingManifestSha256,
    limitations: r.dashboard.limitations,
  };

  return (
    <FinopsCapabilityShell
      dashboard={dashboard}
      state={shown.state}
      stateTitle={shown.title}
      stateDetail={shown.detail}
      evidence={evidence}
    >
      {r ? <AmazonConnectCostInsightsReportView report={r} filters={filters} onFiltersChange={setFilters}/> : configuration?<AmazonConnectOfficialDefinitionPanel definition={configuration.officialDefinition}/>:null}
    </FinopsCapabilityShell>
  );
}

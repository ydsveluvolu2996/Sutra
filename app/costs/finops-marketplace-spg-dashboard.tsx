"use client";

import { useEffect, useState } from "react";
import {
  BarChart,
  DonutChart,
  RankingBars,
  ShareBar,
  Sparkline,
  TimeSeriesChart,
} from "../components/charts";
import type { FinopsDashboardCatalogEntry } from "../../lib/finops-dashboard-catalog";
import {
  MARKETPLACE_SPG_OFFICIAL_DEFINITION,
  type MarketplaceSpgOfficialDefinition,
} from "../../lib/finops-marketplace-spg-official-definition";
import { FinopsCapabilityShell, type FinopsCapabilityViewState } from "./finops-capability-shell";
import { StateBadge, formatBasisPoints, formatMicrosExact } from "./finops-foundational-panels";
import { formatCount, formatUnits, microsToUnits } from "./finops-foundational-money";
import { FinopsSheetBlock, foundationalStyles as shell } from "./finops-foundational-sheet-shell";
import styles from "./finops-marketplace-spg-dashboard.module.css";

/**
 * ADD-05 AWS Marketplace Single Pane of Glass.
 *
 * The dashboard is organized by the pinned AWS catalog: five official tabs
 * holding twenty-three documented visual areas. The managed QuickSight analysis
 * tree for this dashboard is not published in the immutable source, so the
 * per-tab visual and control counts are explicitly unavailable and are never
 * invented — the areas are the unit of organization, and each one carries its
 * audited support classification and named limitation.
 *
 * Two evidence planes are presented side by side and never conflated:
 *
 * - Realized spend comes only from the active reconciled CUR2 generation.
 * - Agreements, terms, entitlements, licenses, grants and expiration are AWS
 *   Marketplace and License Manager control-plane facts. Known agreement
 *   commitment is not an invoice and is never added to CUR2 spend.
 *
 * Money is an integer count of currency micro-units carried as a string. Exact
 * figures print through `formatMicrosExact`, which never converts to a number;
 * charts convert only for geometry through `microsToUnits`, which drops any
 * value it cannot represent exactly. Absent evidence renders as a labelled state
 * rather than a zero, and a percentage that cannot be computed exactly is
 * withheld with its reason.
 */

type Filters = {
  accountId: string;
  product: string;
  seller: string;
  currency: string;
  billingPeriod: string;
  agreementStatus: string;
  expirationState: string;
  licenseStatus: string;
};

const EMPTY: Filters = {
  accountId: "", product: "", seller: "", currency: "", billingPeriod: "",
  agreementStatus: "", expirationState: "", licenseStatus: "",
};

interface SpendSummary {
  currency: string;
  billedAmountMicros: string;
  amortizedAmountMicros: string | null;
  rowCount: number;
}

interface RankedSpend extends SpendSummary { key: string }

interface Agreement {
  agreementId: string;
  sourceAccountId: string;
  status: string;
  acceptanceAt: string | null;
  startAt: string | null;
  endAt: string | null;
  offerId: string | null;
  productId: string | null;
  expirationState: string;
  estimatedCharges: { amountMicros: string; currency: string; meaning: string } | null;
  product: {
    productName: string;
    sellerDisplayName: string;
    deployedOnAws: string;
    fulfillmentTypes: readonly string[];
    approvedProductType?: string | null;
    approvedProductTypeEvidenceId?: string | null;
  } | null;
  terms: readonly {
    type: string;
    legalDocumentTypes: readonly string[];
    autoRenew: boolean | null;
    committedAmountMicros: string | null;
    pricingCurrency?: string | null;
  }[];
  entitlements: readonly { type: string; status: string; resourceType: string | null }[];
  charges: readonly {
    chargeId: string;
    chargeAt: string | null;
    money: { amount: string; currencyCode: string };
  }[];
}

interface License {
  licenseArn: string;
  beneficiaryAccountId: string;
  productName: string;
  licenseName: string;
  status: string;
  validity: { startAt: string; endAt: string } | null;
  entitlements: readonly {
    name: string;
    unit: string;
    value: string | null;
    maxCount: string | null;
    overageAllowed: boolean | null;
  }[];
}

interface Grant {
  grantArn: string;
  licenseArn: string;
  granteeAccountId: string;
  status: string;
  operations: readonly string[];
}

interface SpendRow {
  linkedAccountId: string;
  billingPeriod: string;
  invoiceId: string | null;
  productCode: string | null;
  productName: string;
  sellerName: string;
  chargeCategory: string;
  currency: string;
  billedAmountMicros: string;
  amortizedAmountMicros: string | null;
}

export interface MarketplaceSpgReport {
  schema: "sutra.finops-marketplace-spg-dashboard.v1";
  connectionId: string;
  sourceState: string;
  dashboard: {
    filters: Record<string, string | null>;
    filterOptions: {
      accounts: readonly string[];
      products: readonly string[];
      sellers: readonly string[];
      currencies: readonly string[];
      periods: readonly string[];
    };
    summaries: readonly SpendSummary[];
    trends: readonly ({ billingPeriod: string } & SpendSummary)[];
    spendBySeller: readonly RankedSpend[];
    spendByProduct: readonly RankedSpend[];
    spendByAccount: readonly RankedSpend[];
    spendByInvoice: readonly RankedSpend[];
    agreementDeployment: readonly {
      status: string;
      activeAgreementCount: number;
      lifecycleCommitments: readonly { currency: string; amountMicros: string }[];
    }[];
    agreementChargesByMonth: readonly { month: string; currency: string; amountMicros: string }[];
    licenseExpirationSummary: readonly { state: string; count: number }[];
    licenseStatusSummary: readonly { status: string; count: number }[];
    licenseProductSummary: readonly { productName: string; count: number }[];
    projectionTruncation: {
      filterOptions: boolean;
      spendRankings: boolean;
      agreementCharges: boolean;
      licenseProducts: boolean;
    };
    agreements: readonly Agreement[];
    agreementsTruncated: boolean;
    licenses: readonly License[];
    licensesTruncated: boolean;
    grants: readonly Grant[];
    grantsTruncated: boolean;
    spendRows: readonly SpendRow[];
    spendRowsTruncated: boolean;
    counts: {
      agreements: number;
      expiringWithin90Days: number;
      licenses: number;
      grants: number;
      activeGrants: number;
      spendRows: number;
    };
  };
  officialDefinition: MarketplaceSpgOfficialDefinition;
  history: readonly {
    generationId: string;
    capturedAt: string;
    state: string;
    agreementCount: number;
    licenseCount: number;
    grantCount: number;
    spendRowCount: number;
    spendSummaries: readonly SpendSummary[];
  }[];
  source: {
    organizationCoverage: string;
    channelStates: Record<string, string>;
    limitations: readonly string[];
  };
  freshness: { dataThroughAt: string; ageHours: number; staleAfterHours: number };
  provenance: {
    generationId: string;
    activeGenerationId: string | null;
    latestGenerationId: string | null;
    newerIncomplete: boolean;
    captureId: string;
    contentSha256: string;
    cur2GenerationId: string | null;
    cur2SourceEvidenceId: string | null;
    cur2Predicate: string | null;
  };
  separation: Record<string, string | boolean>;
  collection: RuntimeCollection;
  unsupportedOfficialViews: readonly string[];
}

interface RuntimeCollection {
  readonly jobContractAvailable: true;
  readonly providerAdapterAvailable: boolean;
  readonly state: "unavailable" | "collecting" | "failed" | "ready";
  readonly reason: string;
  readonly lastAttemptAt: string | null;
}

interface MarketplaceSpgConfigurationEnvelope {
  readonly dashboard: null;
  readonly officialDefinition: MarketplaceSpgOfficialDefinition;
  readonly collection: RuntimeCollection;
}

type OfficialTab = MarketplaceSpgOfficialDefinition["tabs"][number];

/** The three procurement product types the server may approve. Never inferred. */
const APPROVED_PRODUCT_TYPES = ["SOFTWARE", "DATA", "PROFESSIONAL_SERVICES"] as const;

const MICROS = /^-?(?:0|[1-9]\d*)$/u;

function hasPinnedOfficialDefinition(value: unknown): value is MarketplaceSpgOfficialDefinition {
  if (typeof value !== "object" || value === null) return false;
  const definition = value as Readonly<Record<string, unknown>>;
  const source = definition.source;
  return typeof source === "object" && source !== null
    && (source as Readonly<Record<string, unknown>>).commit === MARKETPLACE_SPG_OFFICIAL_DEFINITION.source.commit
    && (source as Readonly<Record<string, unknown>>).sha256 === MARKETPLACE_SPG_OFFICIAL_DEFINITION.source.sha256
    && definition.documentedTabCount === 5
    && definition.documentedVisualAreaCount === 23
    && Array.isArray(definition.tabs) && definition.tabs.length === 5;
}

function token(value: string | null | undefined, absent = "Not supplied"): string {
  return value === null || value === undefined || value === ""
    ? absent
    : value.replaceAll("_", " ");
}

/** Exact money, or an explicit labelled state. Absence is never a zero. */
function exactMoney(
  micros: string | null | undefined,
  currency: string,
  absent = "Not supplied",
): string {
  if (micros === null || micros === undefined) return absent;
  return formatMicrosExact(micros, currency);
}

/**
 * Exact money where the currency itself may be missing. The amount is never
 * dropped and never assigned a default currency: it is shown as raw integer
 * micro-units with the currency stated as unavailable.
 */
function exactMoneyUnknownCurrency(
  micros: string | null,
  currency: string | null | undefined,
): string {
  if (micros === null) return "Not supplied";
  if (typeof currency === "string" && /^[A-Z]{3}$/u.test(currency)) {
    return formatMicrosExact(micros, currency);
  }
  return `${micros} micro-units (currency not supplied)`;
}

function bigintOf(micros: string | null | undefined): bigint | null {
  return typeof micros === "string" && MICROS.test(micros) ? BigInt(micros) : null;
}

function sumMicros(values: readonly (string | null | undefined)[]): bigint | null {
  let total = BigInt(0);
  let counted = 0;
  for (const value of values) {
    const parsed = bigintOf(value);
    if (parsed === null) continue;
    total += parsed;
    counted += 1;
  }
  return counted === 0 ? null : total;
}

/**
 * Exact share of a currency total in basis points, or null when a share is not a
 * fact: a non-positive total, a negative part, or an unreadable amount. The
 * caller must explain a withheld share rather than print an estimate.
 */
function shareBasisPoints(part: string | null | undefined, total: bigint | null): string | null {
  const parsed = bigintOf(part);
  if (parsed === null || total === null || total <= BigInt(0) || parsed < BigInt(0)) return null;
  return ((parsed * BigInt(10_000)) / total).toString();
}

function byCurrency<T extends { currency: string }>(
  rows: readonly T[],
): readonly { currency: string; rows: readonly T[] }[] {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.currency) ?? [];
    bucket.push(row);
    grouped.set(row.currency, bucket);
  }
  return [...grouped]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, values]) => ({ currency, rows: values as readonly T[] }));
}

function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function exportSpend(rows: readonly SpendRow[]): void {
  const columns = [
    "billing_period", "account", "invoice", "product_code", "product", "seller",
    "charge_category", "currency", "billed_micros", "amortized_micros",
  ];
  const lines = rows.map((row) => [
    row.billingPeriod, row.linkedAccountId, row.invoiceId ?? "", row.productCode ?? "",
    row.productName, row.sellerName, row.chargeCategory, row.currency,
    row.billedAmountMicros, row.amortizedAmountMicros ?? "",
  ].map(csvCell).join(","));
  const url = URL.createObjectURL(new Blob([[columns.join(","), ...lines].join("\n")], {
    type: "text/csv;charset=utf-8",
  }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "sutra-marketplace-cur2-visible-rows.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

function Select({
  label, value, options, onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange(value: string): void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">All</option>
        {options.map((item) => <option key={item}>{item}</option>)}
      </select>
    </label>
  );
}

function view(state: string): FinopsCapabilityViewState {
  if (state === "complete") return "complete";
  if (state === "empty") return "empty";
  if (state === "stale") return "stale";
  if (state === "partial") return "partial";
  if (state === "configuration_required") return "configuration_required";
  return "failed";
}

function Tile({
  label, value, detail,
}: { readonly label: string; readonly value: string; readonly detail?: string }) {
  return (
    <div className={shell.tile}>
      <span className={shell.tileLabel}>{label}</span>
      <span className={shell.tileValue}>{value}</span>
      {detail === undefined ? null : <span className={shell.tileDetail}>{detail}</span>}
    </div>
  );
}

/**
 * An explicit, labelled absence. Every area that has no evidence in the accepted
 * generation says which evidence is missing, so a reader never reads silence as
 * a measured zero.
 */
function EvidenceGap({ title, reason }: { readonly title: string; readonly reason: string }) {
  return (
    <div className={shell.coverage} data-support="PARTIAL" role="status">
      <div className={shell.coverageHead}><strong>{title}</strong></div>
      <ul className={shell.coverageGaps}><li>{reason}</li></ul>
    </div>
  );
}

/** An area AWS publishes that the approved evidence contract cannot support. */
function UnavailableArea({
  title, reason, consequence,
}: { readonly title: string; readonly reason: string; readonly consequence: string }) {
  return (
    <div className={styles.unavailableArea} role="status">
      <strong>{title}</strong>
      <p>{reason}</p>
      <p>{consequence}</p>
    </div>
  );
}

export function MarketplaceSpgOfficialDefinitionPanel({
  definition,
}: { readonly definition: MarketplaceSpgOfficialDefinition }) {
  return (
    <section className={styles.definition} aria-label="Official AWS Marketplace dashboard coverage">
      <div>
        <span>Authoritative AWS catalog</span>
        <strong>
          {definition.documentedTabCount} tabs ·{" "}
          {definition.documentedVisualAreaCount} documented visual areas
        </strong>
        <small>
          Manifest pinned at {definition.source.commit.slice(0, 12)} · SHA-256{" "}
          {definition.source.sha256.slice(0, 16)}… · QuickSight controls are{" "}
          {definition.source.quickSightControlInventory.toLocaleLowerCase().replaceAll("_", " ")}.
        </small>
        <small>
          The managed QuickSight analysis tree is unpublished, so per-tab visual and control
          counts are unavailable rather than estimated. Documented areas are the unit of
          coverage in this view.
        </small>
      </div>
      <nav aria-label="Marketplace official dashboard tabs">
        {definition.tabs.map((tab) => (
          <a href={`#marketplace-${tab.id}`} key={tab.id}>
            {tab.label}<small>{tab.areas.length} areas</small>
          </a>
        ))}
      </nav>
      <details>
        <summary>Inspect documented-area support</summary>
        <div className={styles.coverageGrid}>
          {definition.tabs.map((tab) => (
            <section key={tab.id}>
              <h4>{tab.label}</h4>
              <ul>
                {tab.areas.map((area) => (
                  <li key={area.name}>
                    <span className={styles[area.support.toLocaleLowerCase()]}>{area.support}</span>
                    <strong>{area.name}</strong>
                    {"limitation" in area ? <small>{area.limitation}</small> : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </details>
      <p>
        Frozen source coverage remains visible without a provider report; unpublished
        QuickSight counts and geometry are not inferred.
      </p>
    </section>
  );
}

/** Per-tab area coverage, mirroring the audited support classification. */
function TabCoverage({ tab }: { readonly tab: OfficialTab }) {
  const unsupported = tab.areas.filter((area) => area.support === "UNAVAILABLE").length;
  const partial = tab.areas.filter((area) => area.support === "PARTIAL").length;
  return (
    <section
      className={shell.coverage}
      data-support={unsupported > 0 ? "UNAVAILABLE" : partial > 0 ? "PARTIAL" : "SUPPORTED"}
      aria-label={`${tab.label} documented area coverage`}
    >
      <div className={shell.coverageHead}>
        <strong>{tab.label}</strong>
        <span className={shell.coverageBadge} data-support={unsupported > 0 ? "UNAVAILABLE" : partial > 0 ? "PARTIAL" : "SUPPORTED"}>
          {tab.areas.length - partial - unsupported} supported · {partial} partial ·{" "}
          {unsupported} unavailable
        </span>
        <span className={shell.coverageMeta}>
          {tab.areas.length} documented areas · official visual count unavailable
        </span>
      </div>
      <ul className={shell.coverageGaps}>
        {tab.areas.map((area) => (
          <li key={area.name}>
            <b>{area.name}</b> — {area.support}
            {"limitation" in area ? ` · ${area.limitation}` : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A bounded CUR2 spend ranking: a real ranking chart for shape plus the exact
 * signed micro amounts, with per-currency share only where a share is a fact.
 */
function SpendRanking({
  title, description, dimension, items, absent,
}: {
  readonly title: string;
  readonly description: string;
  readonly dimension: string;
  readonly items: readonly RankedSpend[];
  readonly absent: string;
}) {
  const groups = byCurrency(items);
  return (
    <FinopsSheetBlock description={description} title={title}>
      {groups.length === 0 ? <EvidenceGap title="No ranked CUR2 evidence" reason={absent} /> : null}
      {groups.map(({ currency, rows }) => {
        const total = sumMicros(rows.map((row) => row.billedAmountMicros));
        const negative = rows.some((row) => (bigintOf(row.billedAmountMicros) ?? BigInt(0)) < BigInt(0));
        const plotted = rows.flatMap((row) => {
          const units = microsToUnits(row.billedAmountMicros);
          return units === null ? [] : [{ id: `${currency}-${row.key}`, label: row.key, value: units, detail: `${formatCount(row.rowCount)} CUR2 rows` }];
        });
        return (
          <div className={styles.currencyGroup} key={currency}>
            <h5>{currency}</h5>
            <RankingBars
              ariaLabel={`${title} by billed amount in ${currency}`}
              formatValue={(value) => formatUnits(value, currency)}
              items={plotted}
              sort
            />
            <div className={shell.tableWrap}>
              <table className={shell.table}>
                <caption>
                  Exact signed micro-unit amounts from the active reconciled CUR2 generation.
                  Amortized cost is shown only where CUR2 supplied it.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{dimension}</th>
                    <th className={shell.numeric} scope="col">Billed</th>
                    <th className={shell.numeric} scope="col">Amortized</th>
                    <th className={shell.numeric} scope="col">CUR2 rows</th>
                    <th className={shell.numeric} scope="col">Share of {currency} total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const share = shareBasisPoints(row.billedAmountMicros, total);
                    return (
                      <tr key={`${currency}-${row.key}`}>
                        <th scope="row">{row.key}</th>
                        <td className={shell.numeric}>{exactMoney(row.billedAmountMicros, currency)}</td>
                        <td className={shell.numeric}>
                          {exactMoney(row.amortizedAmountMicros, currency, "Not supplied by CUR2")}
                        </td>
                        <td className={shell.numeric}>{formatCount(row.rowCount)}</td>
                        <td className={shell.numeric}>{share === null ? "Withheld" : formatBasisPoints(share)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {total === null || total <= BigInt(0) || negative ? (
              <p className={shell.goalMeta}>
                Share is withheld for {currency}: {negative
                  ? "at least one ranked amount is negative, and a negative part is not a share of a whole"
                  : "the filtered currency total is not positive, so no proportion exists"}. The
                signed amounts above remain exact.
              </p>
            ) : (
              <ShareBar
                ariaLabel={`Concentration of ${currency} billed Marketplace spend by ${dimension.toLocaleLowerCase()}`}
                formatValue={(value) => formatUnits(value, currency)}
                segments={plotted.slice(0, 6).map((item, index) => ({
                  id: item.id, label: item.label, value: item.value, tone: index === 0 ? "teal" : undefined,
                }))}
              />
            )}
          </div>
        );
      })}
    </FinopsSheetBlock>
  );
}

/** Counted control-plane evidence. A count of zero over visible rows is a proven absence. */
function CountBars({
  ariaLabel, categories, counts, caption,
}: {
  readonly ariaLabel: string;
  readonly categories: readonly string[];
  readonly counts: readonly number[];
  readonly caption: string;
}) {
  return (
    <BarChart
      ariaLabel={ariaLabel}
      caption={caption}
      categories={categories.map((value) => token(value))}
      formatValue={formatCount}
      series={[{ id: "count", label: "Records", tone: "teal", values: counts }]}
    />
  );
}

/* ------------------------------------------------------------------ Tab 1 */

function SpendSummaryTab({ report }: { readonly report: MarketplaceSpgReport }) {
  const board = report.dashboard;
  const trendGroups = byCurrency(board.trends);
  const sellerGroups = byCurrency(board.spendBySeller);
  const productGroups = byCurrency(board.spendByProduct);

  return (
    <div className={shell.blocks}>
      <FinopsSheetBlock
        description="Reconciled Marketplace CUR2 evidence for the current filter. Currencies are never combined and amortized cost is kept apart from billed cost."
        title="Filtered CUR2 spend by currency"
      >
        {board.summaries.length === 0 ? (
          <EvidenceGap
            title="No CUR2 spend in the current filter"
            reason="The accepted generation contains no Marketplace CUR2 row matching these filters. This is an absence of collected rows, not a zero invoice."
          />
        ) : (
          <div className={shell.tiles}>
            {board.summaries.map((summary) => (
              <Tile
                detail={`${formatCount(summary.rowCount)} CUR2 rows · amortized ${exactMoney(summary.amortizedAmountMicros, summary.currency, "not supplied by CUR2")}`}
                key={summary.currency}
                label={`${summary.currency} billed Marketplace spend`}
                value={exactMoney(summary.billedAmountMicros, summary.currency)}
              />
            ))}
            <div className={shell.tile}>
              <span className={shell.tileLabel}>Control-plane record counts</span>
              <span className={shell.tileValue}>
                {formatCount(board.counts.agreements)} agreements
              </span>
              <span className={shell.tileDetail}>
                {formatCount(board.counts.licenses)} licenses ·{" "}
                {formatCount(board.counts.grants)} grants · never added to CUR2 spend
              </span>
            </div>
          </div>
        )}
        {board.summaries.map((summary) => {
          const values = board.trends
            .filter((point) => point.currency === summary.currency)
            .map((point) => microsToUnits(point.billedAmountMicros));
          return values.length === 0 ? null : (
            <div className={styles.sparkRow} key={`spark-${summary.currency}`}>
              <span>{summary.currency} billing-period shape</span>
              <Sparkline
                area
                ariaLabel={`${summary.currency} billed Marketplace spend across ${formatCount(values.length)} billing periods`}
                tone="teal"
                values={values}
              />
            </div>
          );
        })}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Billed and amortized CUR2 spend by billing period. A period with no collected row is a gap in the series, never a zero."
        title="Billing-period trend (supporting CUR2 evidence)"
      >
        {trendGroups.length === 0 ? (
          <EvidenceGap
            title="No billing-period trend"
            reason="No filtered CUR2 row carried a billing period, so no cadence can be plotted."
          />
        ) : trendGroups.map(({ currency, rows }) => (
          <TimeSeriesChart
            ariaLabel={`Marketplace billed and amortized spend by billing period in ${currency}`}
            caption={`${currency} only. Amortized points are absent where CUR2 did not supply an amortized amount.`}
            formatValue={(value) => formatUnits(value, currency)}
            key={currency}
            mode="area"
            series={[
              {
                id: `${currency}-billed`,
                label: `${currency} billed`,
                points: rows.map((row) => ({
                  label: row.billingPeriod,
                  value: microsToUnits(row.billedAmountMicros),
                })),
              },
              {
                id: `${currency}-amortized`,
                label: `${currency} amortized`,
                points: rows.map((row) => ({
                  label: row.billingPeriod,
                  value: microsToUnits(row.amortizedAmountMicros),
                })),
              },
            ]}
          />
        ))}
      </FinopsSheetBlock>

      <SpendRanking
        absent="No filtered CUR2 row carried a seller, so no cumulative seller ranking exists for this generation."
        description="Official area: Cumulative Spend by Seller. Bounded ranking over the filtered CUR2 rows."
        dimension="Seller"
        items={board.spendBySeller}
        title="Cumulative spend by seller"
      />

      <SpendRanking
        absent="No filtered CUR2 row carried a product name, so no cumulative product ranking exists for this generation."
        description="Official area: Cumulative Spend by Product."
        dimension="Product"
        items={board.spendByProduct}
        title="Cumulative spend by product"
      />

      <FinopsSheetBlock
        description="Official area: Spend by Seller. Billed and amortized are separate measures on one axis; an absent amortized amount is a gap."
        title="Spend by seller: billed against amortized"
      >
        {sellerGroups.length === 0 ? (
          <EvidenceGap
            title="No seller spend evidence"
            reason="The filtered CUR2 projection returned no seller row."
          />
        ) : sellerGroups.map(({ currency, rows }) => (
          <BarChart
            ariaLabel={`Billed and amortized Marketplace spend by seller in ${currency}`}
            caption={`${currency} only. Bars keep their real sign, so credits and refunds read as negative.`}
            categories={rows.map((row) => row.key)}
            formatValue={(value) => formatUnits(value, currency)}
            key={currency}
            series={[
              { id: "billed", label: "Billed", tone: "teal", values: rows.map((row) => microsToUnits(row.billedAmountMicros)) },
              { id: "amortized", label: "Amortized", tone: "violet", values: rows.map((row) => microsToUnits(row.amortizedAmountMicros)) },
            ]}
          />
        ))}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Official area: Spend and Usage by Seller Product — audited PARTIAL."
        title="Spend and usage by seller product"
      >
        <EvidenceGap
          title="Usage quantity and unit are unavailable"
          reason="Spend and CUR2 row evidence are available; usage quantity and unit are not present in the minimized projection, so no unit-cost or usage figure is shown for a Marketplace product."
        />
        {productGroups.length === 0 ? null : productGroups.map(({ currency, rows }) => (
          <div className={shell.tableWrap} key={currency}>
            <table className={shell.table}>
              <caption>{currency} product spend with its collected CUR2 row count in place of usage.</caption>
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th className={shell.numeric} scope="col">Billed</th>
                  <th className={shell.numeric} scope="col">Amortized</th>
                  <th className={shell.numeric} scope="col">CUR2 rows</th>
                  <th scope="col">Usage quantity</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${currency}-${row.key}`}>
                    <th scope="row">{row.key}</th>
                    <td className={shell.numeric}>{exactMoney(row.billedAmountMicros, currency)}</td>
                    <td className={shell.numeric}>
                      {exactMoney(row.amortizedAmountMicros, currency, "Not supplied by CUR2")}
                    </td>
                    <td className={shell.numeric}>{formatCount(row.rowCount)}</td>
                    <td>Not in projection</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </FinopsSheetBlock>

      <SpendRanking
        absent="No filtered CUR2 row carried an invoice identifier, so the invoice tracker has no accepted evidence."
        description="Official area: Marketplace Invoice Tracker. Rows with no invoice identifier are grouped under INVOICE_NOT_SUPPLIED rather than dropped."
        dimension="Invoice"
        items={board.spendByInvoice}
        title="Marketplace invoice tracker"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ Tab 2 */

function SpendDeepDiveTab({ report }: { readonly report: MarketplaceSpgReport }) {
  const board = report.dashboard;

  /**
   * Charge-category composition is aggregated here from the visible CUR2 rows
   * only. It is labelled as such: with a truncated row set it is a view of what
   * is on screen, not of the whole generation.
   */
  const categoryGroups = byCurrency(board.spendRows).map(({ currency, rows }) => {
    const categories = new Map<string, bigint>();
    for (const row of rows) {
      const amount = bigintOf(row.billedAmountMicros);
      if (amount === null) continue;
      categories.set(row.chargeCategory, (categories.get(row.chargeCategory) ?? BigInt(0)) + amount);
    }
    return {
      currency,
      entries: [...categories].sort(([left], [right]) => left.localeCompare(right)),
    };
  });

  const sellerProduct = new Map<string, { seller: string; product: string; currency: string; billed: bigint; rows: number }>();
  for (const row of board.spendRows) {
    const key = `${row.currency}:${row.sellerName}:${row.productName}`;
    const bucket = sellerProduct.get(key)
      ?? { seller: row.sellerName, product: row.productName, currency: row.currency, billed: BigInt(0), rows: 0 };
    bucket.billed += bigintOf(row.billedAmountMicros) ?? BigInt(0);
    bucket.rows += 1;
    sellerProduct.set(key, bucket);
  }

  return (
    <div className={shell.blocks}>
      <SpendRanking
        absent="No filtered CUR2 row carried a product name."
        description="Official area: Spend by Product."
        dimension="Product"
        items={board.spendByProduct}
        title="Spend by product"
      />

      <SpendRanking
        absent="No filtered CUR2 row carried a linked account."
        description="Official area: Spend by AWS Account ID."
        dimension="AWS account"
        items={board.spendByAccount}
        title="Spend by AWS account ID"
      />

      <FinopsSheetBlock
        description="Official area: Spend Mapping by Seller. Seller to product mapping aggregated from the visible CUR2 rows only."
        title="Spend mapping by seller"
      >
        {sellerProduct.size === 0 ? (
          <EvidenceGap
            title="No seller to product mapping"
            reason="No visible CUR2 row carried both a seller and a product name in this filter."
          />
        ) : (
          <div className={shell.tableWrap}>
            <table className={shell.table}>
              <caption>
                Aggregated from the {formatCount(board.spendRows.length)} visible CUR2 rows
                {board.spendRowsTruncated ? ", which are a bounded subset of the filtered set" : ""}.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Seller</th>
                  <th scope="col">Product</th>
                  <th scope="col">Currency</th>
                  <th className={shell.numeric} scope="col">Billed (visible rows)</th>
                  <th className={shell.numeric} scope="col">Rows</th>
                </tr>
              </thead>
              <tbody>
                {[...sellerProduct].sort(([left], [right]) => left.localeCompare(right)).map(([key, bucket]) => (
                  <tr key={key}>
                    <th scope="row">{bucket.seller}</th>
                    <td>{bucket.product}</td>
                    <td>{bucket.currency}</td>
                    <td className={shell.numeric}>{exactMoney(bucket.billed.toString(), bucket.currency)}</td>
                    <td className={shell.numeric}>{formatCount(bucket.rows)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Official area: Spend Details by Invoice. Charge categories keep their sign, so credits and refunds are visible as negative amounts."
        title="Charge category composition of visible rows"
      >
        {categoryGroups.length === 0 ? (
          <EvidenceGap
            title="No charge-category evidence"
            reason="No visible CUR2 row is available to categorize in this filter."
          />
        ) : categoryGroups.map(({ currency, entries }) => (
          <BarChart
            ariaLabel={`Signed billed Marketplace spend by charge category in ${currency}`}
            caption={`${currency}, aggregated from the visible CUR2 rows. A negative bar is a credit or refund, not an error.`}
            categories={entries.map(([category]) => category)}
            formatValue={(value) => formatUnits(value, currency)}
            key={currency}
            series={[{
              id: "billed",
              label: "Billed",
              values: entries.map(([, amount]) => microsToUnits(amount.toString())),
            }]}
          />
        ))}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        actions={
          <button onClick={() => exportSpend(board.spendRows)} type="button">
            Export visible CUR2 rows
          </button>
        }
        description="Official area: Spend Details by Invoice. Period, invoice, account, product, seller and charge-category lineage of each visible CUR2 row."
        title="Invoice, product and charge-category drilldown"
      >
        {board.spendRows.length === 0 ? (
          <EvidenceGap
            title="No CUR2 detail rows"
            reason="The filter matched no Marketplace CUR2 row in the accepted generation."
          />
        ) : (
          <div className={shell.tableWrap} role="region" tabIndex={0} aria-label="Marketplace realized spend drilldown">
            <table className={shell.table}>
              <caption>
                Realized spend from the active reconciled CUR2 generation only. No control-plane
                agreement or license figure appears in this table.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Period / invoice</th>
                  <th scope="col">Account</th>
                  <th scope="col">Product / seller</th>
                  <th scope="col">Category</th>
                  <th className={shell.numeric} scope="col">Billed</th>
                  <th className={shell.numeric} scope="col">Amortized</th>
                </tr>
              </thead>
              <tbody>
                {board.spendRows.map((row, index) => (
                  <tr key={`${row.billingPeriod}:${row.linkedAccountId}:${row.invoiceId ?? index}`}>
                    <th scope="row">
                      {row.billingPeriod}
                      <small>{row.invoiceId ?? "Invoice not supplied"}</small>
                    </th>
                    <td>{row.linkedAccountId}</td>
                    <td>
                      {row.productName}
                      <small>{row.sellerName} · {row.productCode ?? "No product code"}</small>
                    </td>
                    <td>{row.chargeCategory}</td>
                    <td className={shell.numeric}>{exactMoney(row.billedAmountMicros, row.currency)}</td>
                    <td className={shell.numeric}>
                      {exactMoney(row.amortizedAmountMicros, row.currency, "Not supplied by CUR2")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {board.spendRowsTruncated ? (
          <p className={shell.goalMeta}>
            Only the first bounded page of filtered rows is rendered and exported. Refine the
            filters to reach the omitted rows; the omission is disclosed rather than summarized.
          </p>
        ) : null}
      </FinopsSheetBlock>
    </div>
  );
}

/* ------------------------------------------------------------------ Tab 3 */

function BedrockTab({ report }: { readonly report: MarketplaceSpgReport }) {
  const areas = report.officialDefinition.tabs.find((tab) => tab.id === "bedrock-3p-foundational-model-spend")?.areas ?? [];
  return (
    <div className={shell.blocks}>
      <FinopsSheetBlock
        description="Both documented areas of this official tab are audited UNAVAILABLE. Nothing on this tab is estimated, extrapolated or modelled."
        title="Bedrock 3P foundational model spend"
      >
        <UnavailableArea
          consequence="This tab stays visibly unavailable until an approved classification source is bound. Sutra does not simulate the classification, and it does not guess from product or seller names."
          reason="Authoritative classification required: the approved evidence contract carries no Bedrock third-party foundational-model classification, and Bedrock-powered classification is not available in this vertical. The CUR2 projection can prove Marketplace spend, seller, product and row counts, but not whether a row is a Bedrock third-party model."
          title="Bedrock third-party model classification is unavailable"
        />
        <ul className={shell.coverageGaps}>
          {areas.map((area) => (
            <li key={area.name}>
              <b>{area.name}</b> — {area.support}
              {"limitation" in area ? ` · ${area.limitation}` : ""}
            </li>
          ))}
        </ul>
        <p className={shell.goalMeta}>
          The filtered generation holds {formatCount(report.dashboard.counts.spendRows)} Marketplace
          CUR2 rows. None of them is presented here, because presenting them would imply a
          foundational-model classification that no accepted evidence supports.
        </p>
      </FinopsSheetBlock>
    </div>
  );
}

/* ------------------------------------------------------------------ Tab 4 */

function LicensesTab({ report }: { readonly report: MarketplaceSpgReport }) {
  const board = report.dashboard;
  const grantsByLicense = new Map<string, Grant[]>();
  for (const grant of board.grants) {
    const bucket = grantsByLicense.get(grant.licenseArn) ?? [];
    bucket.push(grant);
    grantsByLicense.set(grant.licenseArn, bucket);
  }

  return (
    <div className={shell.blocks}>
      <FinopsSheetBlock
        description="Official area: Upcoming Contract Expirations. License validity windows and agreement expiration are separate control-plane facts and are counted separately."
        title="Upcoming contract expirations"
      >
        {board.licenseExpirationSummary.length === 0 ? (
          <EvidenceGap
            title="No license validity evidence"
            reason="No filtered License Manager license carried a validity window, so no expiration bucket can be counted."
          />
        ) : (
          <CountBars
            ariaLabel="Filtered License Manager licenses by expiration state"
            caption="License Manager validity windows only. Licenses with no end date are counted under NO END DATE rather than treated as expiring."
            categories={board.licenseExpirationSummary.map((item) => item.state)}
            counts={board.licenseExpirationSummary.map((item) => item.count)}
          />
        )}
        <p className={shell.goalMeta}>
          Separately, {formatCount(board.counts.expiringWithin90Days)} of{" "}
          {formatCount(board.counts.agreements)} filtered Marketplace agreements carry an
          expiration state within ninety days. Agreement expiration is not a license validity
          window and the two counts are never added together.
        </p>
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Official area: Org View of Licenses. Received licenses, their status and their entitlement limits across the covered organization."
        title="Received licenses and entitlements"
      >
        {board.licenseStatusSummary.length === 0 ? (
          <EvidenceGap
            title="No license status evidence"
            reason="The filter matched no License Manager license in the accepted generation."
          />
        ) : (
          <DonutChart
            ariaLabel="Filtered License Manager licenses by status"
            caption="Counts of received licenses by status. Statuses absent from this ring were not observed in the filtered evidence."
            centerLabel="licenses"
            centerValue={formatCount(board.counts.licenses)}
            formatValue={formatCount}
            slices={board.licenseStatusSummary.map((item) => ({
              id: item.status, label: token(item.status), value: item.count,
            }))}
          />
        )}
        {board.licenses.length === 0 ? null : (
          <div className={shell.tableWrap}>
            <table className={shell.table}>
              <caption>
                License Manager control-plane evidence. Entitlement limits are shown as supplied;
                an unspecified limit is labelled rather than defaulted.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Product / license</th>
                  <th scope="col">Beneficiary</th>
                  <th scope="col">Status</th>
                  <th scope="col">Validity</th>
                  <th scope="col">Entitlements</th>
                </tr>
              </thead>
              <tbody>
                {board.licenses.map((license) => (
                  <tr key={license.licenseArn}>
                    <th scope="row">{license.productName}<small>{license.licenseName}</small></th>
                    <td>{license.beneficiaryAccountId}</td>
                    <td><StateBadge state={license.status.toLocaleLowerCase()} /></td>
                    <td>
                      {license.validity === null
                        ? "No validity window supplied"
                        : `${license.validity.startAt} → ${license.validity.endAt}`}
                    </td>
                    <td>
                      {license.entitlements.length === 0
                        ? "None supplied"
                        : license.entitlements.map((entitlement) =>
                          `${entitlement.name}: ${entitlement.value ?? entitlement.maxCount ?? "limit not supplied"} ${entitlement.unit}`).join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {board.licensesTruncated ? (
          <p className={shell.goalMeta}>The license list is bounded; omitted rows are disclosed, not summarized.</p>
        ) : null}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Official area: License Summary by Product."
        title="License summary by product"
      >
        {board.licenseProductSummary.length === 0 ? (
          <EvidenceGap
            title="No product-level license evidence"
            reason="No filtered license carried a product name."
          />
        ) : (
          <RankingBars
            ariaLabel="Filtered received licenses by product"
            caption="Counts of received licenses, not spend. Nothing here is a monetary figure."
            formatValue={formatCount}
            items={board.licenseProductSummary.map((item) => ({
              id: item.productName, label: item.productName, value: item.count,
            }))}
            sort
          />
        )}
        {board.projectionTruncation.licenseProducts ? (
          <p className={shell.goalMeta}>The product summary was deterministically bounded; refine the filters to see omitted products.</p>
        ) : null}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Official area: License Grant and Sharing Details. Grants are matched to the filtered licenses; grant names and principal ARNs are deliberately not collected."
        title="License sharing grants"
      >
        <div className={shell.tiles}>
          <Tile label="Matched grants" value={formatCount(board.counts.grants)} />
          <Tile
            detail="Non-active grants keep their own status and are not counted as active."
            label="Active grants"
            value={formatCount(board.counts.activeGrants)}
          />
        </div>
        {board.grants.length === 0 ? (
          <EvidenceGap
            title="No sharing grant evidence"
            reason="No grant in the accepted generation references a license in this filter. Absence of a grant is not proof that sharing is disabled."
          />
        ) : (
          <div className={shell.tableWrap}>
            <table className={shell.table}>
              <caption>License Manager grant evidence for the filtered licenses.</caption>
              <thead>
                <tr>
                  <th scope="col">Grantee</th>
                  <th scope="col">Status</th>
                  <th scope="col">Operations</th>
                  <th scope="col">Grant evidence</th>
                </tr>
              </thead>
              <tbody>
                {board.grants.map((grant) => (
                  <tr key={grant.grantArn}>
                    <th scope="row">{grant.granteeAccountId}</th>
                    <td><StateBadge state={grant.status.toLocaleLowerCase()} /></td>
                    <td>{grant.operations.length === 0 ? "None supplied" : grant.operations.join(", ")}</td>
                    <td>{grant.grantArn}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Official area: Product mapping to License Grants. The mapping is the licence ARN the grant itself names; no product is inferred for a grant whose license is outside the filter."
        title="Product mapping to license grants"
      >
        {board.licenses.length === 0 ? (
          <EvidenceGap
            title="No license to grant mapping"
            reason="No filtered license is available to map to a grant."
          />
        ) : (
          <div className={shell.tableWrap}>
            <table className={shell.table}>
              <caption>Each filtered license with the grants that reference it.</caption>
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">License</th>
                  <th className={shell.numeric} scope="col">Grants</th>
                  <th scope="col">Grantee accounts</th>
                </tr>
              </thead>
              <tbody>
                {board.licenses.map((license) => {
                  const matched = grantsByLicense.get(license.licenseArn) ?? [];
                  return (
                    <tr key={`map-${license.licenseArn}`}>
                      <th scope="row">{license.productName}</th>
                      <td>{license.licenseArn}</td>
                      <td className={shell.numeric}>{formatCount(matched.length)}</td>
                      <td>
                        {matched.length === 0
                          ? "No grant references this license"
                          : matched.map((grant) => `${grant.granteeAccountId} (${token(grant.status)})`).join(" · ")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </FinopsSheetBlock>
    </div>
  );
}

/* ------------------------------------------------------------------ Tab 5 */

function AgreementsTab({ report }: { readonly report: MarketplaceSpgReport }) {
  const board = report.dashboard;
  const chargeGroups = byCurrency(board.agreementChargesByMonth);
  const acceptances = board.agreements.filter((agreement) => agreement.status === "ACTIVE");
  const legal = board.agreements.filter((agreement) =>
    agreement.terms.some((term) => term.type === "LEGAL" || term.legalDocumentTypes.length > 0));
  const chargeDetails = board.agreements.flatMap((agreement) =>
    agreement.charges.map((charge) => ({ agreement, charge })));
  const typed = APPROVED_PRODUCT_TYPES.map((type) => ({
    type,
    count: board.agreements.filter((agreement) => agreement.product?.approvedProductType === type).length,
  }));
  const untyped = board.agreements.filter((agreement) =>
    agreement.product === null
    || agreement.product.approvedProductType === null
    || agreement.product.approvedProductType === undefined).length;

  return (
    <div className={shell.blocks}>
      <FinopsSheetBlock
        description="Official area: Active Agreement Count by Deployment Status. Deployment status is the Marketplace product deployedOnAws fact; resource-level deployment is not inferred."
        title="Active agreement count by deployment status"
      >
        {board.agreementDeployment.length === 0 ? (
          <EvidenceGap
            title="No active agreement in this filter"
            reason="No filtered agreement carries the ACTIVE status, so no deployment status can be counted."
          />
        ) : (
          <CountBars
            ariaLabel="Active Marketplace agreements by product deployment status"
            caption="Agreements whose product metadata is absent are counted under METADATA UNAVAILABLE rather than assumed deployed."
            categories={board.agreementDeployment.map((item) => item.status)}
            counts={board.agreementDeployment.map((item) => item.activeAgreementCount)}
          />
        )}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Official area: Active Agreement Value by Deployment Status — audited PARTIAL. Known lifecycle commitment is a control-plane fact and is never represented as realized spend or added to CUR2."
        title="Active agreement value by deployment status"
      >
        {board.agreementDeployment.every((item) => item.lifecycleCommitments.length === 0) ? (
          <EvidenceGap
            title="No commitment evidence supplied"
            reason="No filtered active agreement carried estimated charges, so no known lifecycle commitment exists to show. This is missing commitment evidence, not a commitment of zero."
          />
        ) : (
          <div className={shell.tableWrap}>
            <table className={shell.table}>
              <caption>
                Known lifecycle commitment by deployment status and currency, kept separate from
                the CUR2 spend planes on the spend tabs.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Deployment status</th>
                  <th scope="col">Currency</th>
                  <th className={shell.numeric} scope="col">Known lifecycle commitment</th>
                  <th scope="col">Meaning</th>
                </tr>
              </thead>
              <tbody>
                {board.agreementDeployment.flatMap((item) => item.lifecycleCommitments.map((commitment) => (
                  <tr key={`${item.status}:${commitment.currency}`}>
                    <th scope="row">{token(item.status)}</th>
                    <td>{commitment.currency}</td>
                    <td className={shell.numeric}>
                      {exactMoney(commitment.amountMicros, commitment.currency)}
                    </td>
                    <td>Known lifecycle commitment, not usage actual and not an invoice</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        )}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Server-approved procurement taxonomy. A product is typed only where the approved taxonomy ledger binds it; the type is never inferred from a product or seller name."
        title="Approved product taxonomy: software, data and professional services"
      >
        <CountBars
          ariaLabel="Filtered Marketplace agreements by approved product type"
          caption={`Counted over the ${formatCount(board.agreements.length)} visible agreements. A count of zero for an approved type is a proven absence in this filter.`}
          categories={[...typed.map((entry) => entry.type), "NOT_BOUND_TO_APPROVED_TAXONOMY"]}
          counts={[...typed.map((entry) => entry.count), untyped]}
        />
        <p className={shell.goalMeta}>
          {untyped === 0
            ? "Every visible agreement product is bound to an approved product type."
            : `${formatCount(untyped)} visible agreement products are not bound to the approved taxonomy and stay explicitly untyped.`}
        </p>
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Official area: Agreement Information. Offer, status, expiration, terms, commitment and entitlement facts as collected from the buyer Agreement APIs."
        title="Agreements, offers, terms and renewal"
      >
        {board.agreements.length === 0 ? (
          <EvidenceGap
            title="No agreement evidence"
            reason="The filter matched no Marketplace agreement in the accepted generation."
          />
        ) : (
          <div className={shell.tableWrap} role="region" tabIndex={0} aria-label="Marketplace agreement drilldown">
            <table className={shell.table}>
              <caption>
                {formatCount(board.counts.agreements)}
                {board.agreementsTruncated ? "+" : ""} filtered agreements.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Product / seller</th>
                  <th scope="col">Account / agreement</th>
                  <th scope="col">Offer</th>
                  <th scope="col">Status / expiration</th>
                  <th scope="col">Terms and commitment</th>
                  <th scope="col">Entitlements / deployment</th>
                </tr>
              </thead>
              <tbody>
                {board.agreements.map((agreement) => (
                  <tr key={agreement.agreementId}>
                    <th scope="row">
                      {agreement.product?.productName ?? agreement.productId ?? "Metadata unavailable"}
                      <small>
                        {agreement.product?.sellerDisplayName ?? "Seller unavailable"} ·{" "}
                        {agreement.product?.approvedProductType === null
                        || agreement.product?.approvedProductType === undefined
                          ? "approved type not bound"
                          : token(agreement.product.approvedProductType)}
                      </small>
                    </th>
                    <td>{agreement.sourceAccountId}<small>{agreement.agreementId}</small></td>
                    <td>
                      {agreement.offerId ?? "Not supplied"}
                      <small>Public/private type not proven</small>
                    </td>
                    <td>
                      {agreement.status}
                      <small>
                        {token(agreement.expirationState)} · {agreement.endAt ?? "No end date"}
                      </small>
                    </td>
                    <td>
                      {agreement.terms.length === 0
                        ? "None supplied"
                        : agreement.terms.map((term) => token(term.type)).join(", ")}
                      <small>
                        {agreement.estimatedCharges === null
                          ? "No known commitment supplied"
                          : `${exactMoney(agreement.estimatedCharges.amountMicros, agreement.estimatedCharges.currency)} known lifecycle commitment, not spend`}
                      </small>
                    </td>
                    <td>
                      {formatCount(agreement.entitlements.length)} agreement entitlements
                      <small>
                        {token(agreement.product?.deployedOnAws, "Deployment metadata unavailable")} ·{" "}
                        {agreement.product === null || agreement.product.fulfillmentTypes.length === 0
                          ? "Fulfillment unavailable"
                          : agreement.product.fulfillmentTypes.join(", ")}
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Official area: Active Agreement Acceptances. Only agreements the buyer APIs report as ACTIVE appear; a missing acceptance timestamp is labelled, not backfilled."
        title="Active agreement acceptances"
      >
        {acceptances.length === 0 ? (
          <EvidenceGap
            title="No active acceptance evidence"
            reason="No filtered agreement carries the ACTIVE status in the accepted generation."
          />
        ) : (
          <div className={shell.tableWrap}>
            <table className={shell.table}>
              <caption>Acceptance, start and end facts for active agreements.</caption>
              <thead>
                <tr>
                  <th scope="col">Agreement</th>
                  <th scope="col">Accepted</th>
                  <th scope="col">Start</th>
                  <th scope="col">End</th>
                  <th scope="col">Expiration state</th>
                </tr>
              </thead>
              <tbody>
                {acceptances.map((agreement) => (
                  <tr key={`acceptance-${agreement.agreementId}`}>
                    <th scope="row">
                      {agreement.product?.productName ?? agreement.agreementId}
                      <small>{agreement.sourceAccountId}</small>
                    </th>
                    <td>{agreement.acceptanceAt ?? "Acceptance timestamp not supplied"}</td>
                    <td>{agreement.startAt ?? "Start not supplied"}</td>
                    <td>{agreement.endAt ?? "No end date"}</td>
                    <td>{token(agreement.expirationState)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Official area: Agreement Charges by Month. Buyer agreement charge evidence from the control plane; it is never added to, netted against or compared with CUR2 realized spend."
        title="Agreement charges by month"
      >
        {chargeGroups.length === 0 ? (
          <EvidenceGap
            title="No dated agreement charge"
            reason="No filtered agreement charge carried a charge date, so no month can be plotted. Undated charges remain visible in the charge details below."
          />
        ) : chargeGroups.map(({ currency, rows }) => (
          <TimeSeriesChart
            ariaLabel={`Marketplace agreement charges by month in ${currency}`}
            caption={`${currency} control-plane agreement charges only. This series is not CUR2 realized spend.`}
            formatValue={(value) => formatUnits(value, currency)}
            key={currency}
            mode="line"
            series={[{
              id: `${currency}-charges`,
              label: `${currency} agreement charges`,
              points: rows.map((row) => ({ label: row.month, value: microsToUnits(row.amountMicros) })),
            }]}
          />
        ))}
        {chargeGroups.length === 0 ? null : (
          <div className={shell.tableWrap}>
            <table className={shell.table}>
              <caption>Exact monthly agreement charge totals in integer micro-units.</caption>
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col">Currency</th>
                  <th className={shell.numeric} scope="col">Agreement charges</th>
                </tr>
              </thead>
              <tbody>
                {board.agreementChargesByMonth.map((row) => (
                  <tr key={`${row.month}:${row.currency}`}>
                    <th scope="row">{row.month}</th>
                    <td>{row.currency}</td>
                    <td className={shell.numeric}>{exactMoney(row.amountMicros, row.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {board.projectionTruncation.agreementCharges ? (
          <p className={shell.goalMeta}>The monthly charge aggregate was deterministically bounded; omitted months are disclosed rather than merged.</p>
        ) : null}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Official area: Agreement Charge Details. Charge amounts are shown exactly as the Agreement API supplied them, as a decimal amount with its currency code; purchase-order references are not collected."
        title="Agreement charge details"
      >
        {chargeDetails.length === 0 ? (
          <EvidenceGap
            title="No agreement charge evidence"
            reason="No filtered agreement carried a charge record in the accepted generation."
          />
        ) : (
          <div className={shell.tableWrap}>
            <table className={shell.table}>
              <caption>
                Control-plane charge records. The amount is the supplied decimal string and is not
                converted, rounded or combined with CUR2 micro-unit amounts.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Agreement</th>
                  <th scope="col">Charge</th>
                  <th scope="col">Charged at</th>
                  <th className={shell.numeric} scope="col">Amount as supplied</th>
                </tr>
              </thead>
              <tbody>
                {chargeDetails.map(({ agreement, charge }) => (
                  <tr key={`${agreement.agreementId}:${charge.chargeId}`}>
                    <th scope="row">
                      {agreement.product?.productName ?? agreement.agreementId}
                      <small>{agreement.agreementId}</small>
                    </th>
                    <td>{charge.chargeId}</td>
                    <td>{charge.chargeAt ?? "Charge date not supplied"}</td>
                    <td className={shell.numeric}>
                      {charge.money.currencyCode} {charge.money.amount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Official area: Agreement Legal Terms — audited PARTIAL. Only the legal document type is retained; document URLs and document contents are deliberately excluded from collection."
        title="Agreement legal terms and renewal"
      >
        {legal.length === 0 ? (
          <EvidenceGap
            title="No legal term evidence"
            reason="No filtered agreement carried a legal term or a legal document type."
          />
        ) : (
          <div className={shell.tableWrap}>
            <table className={shell.table}>
              <caption>Retained legal document types, renewal flags and committed amounts.</caption>
              <thead>
                <tr>
                  <th scope="col">Agreement</th>
                  <th scope="col">Term type</th>
                  <th scope="col">Legal document types</th>
                  <th scope="col">Auto renew</th>
                  <th className={shell.numeric} scope="col">Committed amount</th>
                </tr>
              </thead>
              <tbody>
                {legal.flatMap((agreement) => agreement.terms.map((term, index) => (
                  <tr key={`${agreement.agreementId}:${term.type}:${index}`}>
                    <th scope="row">{agreement.product?.productName ?? agreement.agreementId}</th>
                    <td>{token(term.type)}</td>
                    <td>
                      {term.legalDocumentTypes.length === 0
                        ? "None retained"
                        : term.legalDocumentTypes.join(", ")}
                    </td>
                    <td>
                      {term.autoRenew === null
                        ? "Renewal flag not supplied"
                        : term.autoRenew ? "Yes" : "No"}
                    </td>
                    <td className={shell.numeric}>
                      {exactMoneyUnknownCurrency(
                        term.committedAmountMicros,
                        term.pricingCurrency ?? agreement.estimatedCharges?.currency ?? null,
                      )}
                    </td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        )}
      </FinopsSheetBlock>
    </div>
  );
}

/**
 * The content of one official tab. Exported so every tab can be rendered and
 * asserted directly, without driving the fetch lifecycle.
 */
export function MarketplaceSpgTabPanel({
  report, tab,
}: { readonly report: MarketplaceSpgReport; readonly tab: OfficialTab }) {
  const label: string = tab.label;
  switch (tab.id) {
    case "spend-summary": return <SpendSummaryTab report={report} />;
    case "spend-deep-dive": return <SpendDeepDiveTab report={report} />;
    case "bedrock-3p-foundational-model-spend": return <BedrockTab report={report} />;
    case "granted-entitled-licenses": return <LicensesTab report={report} />;
    case "marketplace-agreements": return <AgreementsTab report={report} />;
    default:
      return (
        <EvidenceGap
          title={`No projection for the official tab "${label}"`}
          reason="The tab is listed because the pinned AWS catalog publishes it; it is not presented as delivered."
        />
      );
  }
}

function EvidenceDisclosure({ report }: { readonly report: MarketplaceSpgReport }) {
  const separation = Object.entries(report.separation);
  return (
    <details className={styles.evidence}>
      <summary>Provenance, history, source gaps and privacy boundary</summary>
      <dl>
        <div>
          <dt>Accepted generation</dt>
          <dd>{report.provenance.activeGenerationId ?? "No complete accepted head"}</dd>
        </div>
        <div><dt>Capture</dt><dd>{report.provenance.captureId}</dd></div>
        <div><dt>Content digest</dt><dd>{report.provenance.contentSha256}</dd></div>
        <div>
          <dt>Data through</dt>
          <dd>
            {report.freshness.dataThroughAt} · {report.freshness.ageHours} hours old · stale
            after {report.freshness.staleAfterHours} hours
          </dd>
        </div>
        <div><dt>Organization coverage</dt><dd>{token(report.source.organizationCoverage)}</dd></div>
        <div>
          <dt>CUR2 generation</dt>
          <dd>
            {report.provenance.cur2GenerationId ?? "Not configured"}
            {report.provenance.cur2Predicate === null
              ? ""
              : ` · ${token(report.provenance.cur2Predicate)}`}
          </dd>
        </div>
        <div>
          <dt>Collector adapter</dt>
          <dd>
            {token(report.collection.state, "State not supplied")} ·{" "}
            {token(report.collection.reason)}
          </dd>
        </div>
      </dl>
      <h4>Channel states</h4>
      <ul>
        {Object.entries(report.source.channelStates).length === 0
          ? <li>No per-channel state was supplied; channel health is unavailable, not healthy.</li>
          : Object.entries(report.source.channelStates).map(([channel, state]) => (
            <li key={channel}>{token(channel)}: {token(state)}</li>
          ))}
      </ul>
      <h4>Evidence-plane separation</h4>
      <ul>
        {separation.length === 0
          ? <li>Separation metadata was not supplied by this response; the two planes remain rendered apart in this view regardless.</li>
          : separation.map(([key, value]) => (
            <li key={key}>{token(key)}: {typeof value === "boolean" ? (value ? "yes" : "no") : token(value)}</li>
          ))}
      </ul>
      <h4>Retained immutable history</h4>
      <ul>
        {report.history.length === 0
          ? <li>No retained history was supplied for this connection.</li>
          : report.history.map((point) => (
            <li key={point.generationId}>
              {point.capturedAt}: {token(point.state)} · {formatCount(point.agreementCount)} agreements ·{" "}
              {formatCount(point.licenseCount)} licenses · {formatCount(point.spendRowCount)} CUR2 rows
            </li>
          ))}
      </ul>
      <h4>Unsupported official dimensions</h4>
      <ul>{report.unsupportedOfficialViews.map((item) => <li key={item}>{item}</li>)}</ul>
      <h4>Evidence limitations</h4>
      <ul>
        {report.source.limitations.length === 0
          ? <li>No limitation was reported with this generation.</li>
          : report.source.limitations.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </details>
  );
}

/**
 * Presentation for a loaded Marketplace report: the five official tabs, each
 * with its audited area coverage and the real evidence behind it. Takes the
 * report envelope directly, so it renders from a test or a server-side snapshot
 * without any fetching.
 */
export function MarketplaceSpgDashboardView({
  report,
}: { readonly report: MarketplaceSpgReport }) {
  return (
    <div className={styles.stack}>
      <div className={styles.notice}>
        <strong>Two evidence planes, never conflated.</strong> Realized spend and usage come only
        from the active reconciled CUR2 generation. Agreements, accepted terms, entitlements,
        licenses, grants and expiration are Marketplace control-plane facts; known agreement
        commitment is not an invoice and is never summed with realized spend.
      </div>
      {report.sourceState === "partial" ? (
        <div className={styles.warning} role="status">
          A newer incomplete collection is disclosed while the previous complete accepted head
          remains visible.
        </div>
      ) : null}
      {report.sourceState === "empty" ? (
        <div className={styles.warning} role="status">
          The accepted generation matched no agreement, license or CUR2 row for this filter. Every
          area below states its own missing evidence rather than showing a zero.
        </div>
      ) : null}
      {Object.values(report.dashboard.projectionTruncation).some(Boolean) ? (
        <div className={styles.warning} role="status">
          High-cardinality summary output was deterministically bounded. Refine the filters to
          inspect omitted aggregate values; nothing omitted is folded into a residual bucket.
        </div>
      ) : null}
      <MarketplaceSpgOfficialDefinitionPanel definition={report.officialDefinition} />
      {report.officialDefinition.tabs.map((tab, index) => (
        <section
          aria-label={`${tab.label} official tab`}
          className={styles.tabSection}
          id={`marketplace-${tab.id}`}
          key={tab.id}
        >
          <header className={styles.sectionTitle}>
            <span>Official tab {index + 1} of {report.officialDefinition.documentedTabCount}</span>
            <h2>{tab.label}</h2>
            <p>{tab.areas.length} documented visual areas · official visual count unavailable</p>
          </header>
          <TabCoverage tab={tab} />
          <MarketplaceSpgTabPanel report={report} tab={tab} />
        </section>
      ))}
      <EvidenceDisclosure report={report} />
    </div>
  );
}

export function MarketplaceSpgReportView({
  report, filters, onFiltersChange,
}: {
  report: MarketplaceSpgReport;
  filters: Filters;
  onFiltersChange(filters: Filters): void;
}) {
  const set = (key: keyof Filters, value: string) => onFiltersChange({ ...filters, [key]: value });
  return (
    <section className={styles.root} aria-label="AWS Marketplace Single Pane of Glass">
      <section className={styles.filters} aria-label="Marketplace procurement filters">
        <Select label="Account" value={filters.accountId} options={report.dashboard.filterOptions.accounts} onChange={(value) => set("accountId", value)} />
        <Select label="Product" value={filters.product} options={report.dashboard.filterOptions.products} onChange={(value) => set("product", value)} />
        <Select label="Seller" value={filters.seller} options={report.dashboard.filterOptions.sellers} onChange={(value) => set("seller", value)} />
        <Select label="Currency" value={filters.currency} options={report.dashboard.filterOptions.currencies} onChange={(value) => set("currency", value)} />
        <Select label="Billing period" value={filters.billingPeriod} options={report.dashboard.filterOptions.periods} onChange={(value) => set("billingPeriod", value)} />
        <Select label="Agreement status" value={filters.agreementStatus} options={["ACTIVE", "ARCHIVED", "CANCELLED", "EXPIRED", "RENEWED", "REPLACED", "TERMINATED"]} onChange={(value) => set("agreementStatus", value)} />
        <Select label="Expiration" value={filters.expirationState} options={["EXPIRING_30_DAYS", "EXPIRING_60_DAYS", "EXPIRING_90_DAYS", "ACTIVE_BEYOND_90_DAYS", "EXPIRED", "NO_END_DATE"]} onChange={(value) => set("expirationState", value)} />
        <Select label="License status" value={filters.licenseStatus} options={["AVAILABLE", "PENDING_AVAILABLE", "DEACTIVATED", "SUSPENDED", "EXPIRED", "PENDING_DELETE", "DELETED"]} onChange={(value) => set("licenseStatus", value)} />
        <button type="button" onClick={() => onFiltersChange(EMPTY)}>Clear filters</button>
      </section>
      <MarketplaceSpgDashboardView report={report} />
    </section>
  );
}

export function FinopsMarketplaceSpgDashboard({
  connectionId, dashboard,
}: { connectionId: string | null; dashboard: FinopsDashboardCatalogEntry }) {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [state, setState] = useState<{
    loading: boolean;
    report: MarketplaceSpgReport | null;
    error: string | null;
    officialDefinition: MarketplaceSpgOfficialDefinition;
  }>({
    loading: true, report: null, error: null,
    officialDefinition: MARKETPLACE_SPG_OFFICIAL_DEFINITION,
  });

  useEffect(() => {
    if (connectionId === null) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ connectionId });
    for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
    const frame = window.requestAnimationFrame(() => {
      setState((current) => ({
        loading: true, report: null, error: null,
        officialDefinition: current.officialDefinition,
      }));
      void fetch(`/api/v1/finops/marketplace-spg?${query}`, {
        signal: controller.signal, credentials: "same-origin",
      }).then(async (response) => {
        if (!response.ok) throw new Error("Marketplace evidence request failed");
        return response.json() as Promise<MarketplaceSpgReport | MarketplaceSpgConfigurationEnvelope>;
      }).then((body) => {
        if (!hasPinnedOfficialDefinition(body.officialDefinition)) {
          throw new Error("Sutra returned an unrecognized Marketplace official definition");
        }
        if ("dashboard" in body && body.dashboard === null) {
          setState({
            loading: false, report: null, error: null,
            officialDefinition: body.officialDefinition,
          });
        } else {
          setState({
            loading: false, report: body as MarketplaceSpgReport, error: null,
            officialDefinition: body.officialDefinition,
          });
        }
      }, (error: unknown) => {
        if (controller.signal.aborted) return;
        setState((current) => ({
          loading: false, report: null,
          error: error instanceof Error ? error.message : "Marketplace evidence request failed",
          officialDefinition: current.officialDefinition,
        }));
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      controller.abort();
    };
  }, [connectionId, filters]);

  const shown = connectionId === null
    ? {
      state: "configuration_required" as const,
      title: "Connect AWS to configure Marketplace intelligence",
      detail: "An active commercial AWS trust-role connection is required.",
    }
    : state.error !== null
      ? {
        state: "failed" as const,
        title: "Marketplace evidence could not be verified",
        detail: state.error,
      }
      : state.loading
        ? {
          state: "loading" as const,
          title: "Loading Marketplace procurement evidence",
          detail: "Reading the immutable tenant-scoped accepted generation.",
        }
        : state.report === null
          ? {
            state: "configuration_required" as const,
            title: "Marketplace collection is not configured",
            detail: "Deploy and bind the signed broker adapter for buyer Agreements, License Manager, organization coverage, and active reconciled CUR2.",
          }
          : {
            state: view(state.report.sourceState),
            title: "AWS Marketplace Single Pane of Glass",
            detail: "Unified procurement and FinOps views with source evidence kept separate.",
          };

  const report = state.report;
  const evidence = report === null ? null : {
    sourceLabel: "Marketplace buyer APIs + License Manager + active reconciled CUR2",
    collectedAt: report.history[0]?.capturedAt ?? report.freshness.dataThroughAt,
    dataThroughAt: report.freshness.dataThroughAt,
    freshnessAgeHours: report.freshness.ageHours,
    freshnessSlaHours: report.freshness.staleAfterHours,
    acceptedRecords: report.dashboard.counts.agreements + report.dashboard.counts.licenses
      + report.dashboard.counts.grants + report.dashboard.counts.spendRows,
    rejectedRecords: null,
    generationId: report.provenance.generationId,
    contentSha256: report.provenance.contentSha256,
    limitations: [...report.source.limitations, ...report.unsupportedOfficialViews],
  };

  return (
    <FinopsCapabilityShell
      dashboard={dashboard}
      state={shown.state}
      stateTitle={shown.title}
      stateDetail={shown.detail}
      evidence={evidence}
    >
      {report === null ? <MarketplaceSpgOfficialDefinitionPanel definition={state.officialDefinition} /> : <MarketplaceSpgReportView report={report} filters={filters} onFiltersChange={setFilters} />}
    </FinopsCapabilityShell>
  );
}

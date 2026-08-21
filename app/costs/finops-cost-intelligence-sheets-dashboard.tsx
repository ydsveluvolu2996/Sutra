"use client";

import { useMemo, useState, type FormEvent } from "react";
import { BarChart, RankingBars, TimeSeriesChart } from "../components/charts";
import {
  EndpointBoundary,
  EvidenceStrip,
  formatBasisPoints,
  formatMicrosExact,
  type FoundationalSourceEvidence,
} from "./finops-foundational-panels";
import {
  DEFAULT_COST_INTELLIGENCE_FILTERS,
  useCostIntelligenceEndpoint,
  type CostIntelligenceEndpointFilters,
} from "./finops-foundational-endpoint";
import {
  FINOPS_COST_INTELLIGENCE_SHEETS,
  type FinopsSheetDescriptor,
} from "./finops-foundational-sheets";
import {
  FinopsSheetBlock,
  FinopsSheetShell,
  foundationalStyles as styles,
} from "./finops-foundational-sheet-shell";
import { formatCount, formatUnits, microsToUnits } from "./finops-foundational-money";
import {
  FINOPS_COST_BASES,
  FINOPS_COST_DIMENSIONS,
  type FinopsCostDimension,
  type FinopsCostIntelligenceReport,
  type FinopsExplorerFilter,
} from "../../lib/finops-cost-intelligence";

/**
 * FND-02 Cost Intelligence, presented as the ten sheets AWS publishes.
 *
 * The report is history-wide rather than single-period: `summaries` covers every
 * period in the canonical export, and comparisons are always between the
 * engine's own baseline and comparison periods rather than periods chosen here.
 * Money stays in integer micro-units; charts convert only for geometry.
 */

type Report = FinopsCostIntelligenceReport;

/** The sentinel the allocation engine uses for cost with no taxonomy value. */
const UNALLOCATED = "__unallocated__";

function Tile({
  label, value, detail,
}: { readonly label: string; readonly value: string; readonly detail?: string }) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      {detail === undefined ? null : <span className={styles.tileDetail}>{detail}</span>}
    </div>
  );
}

function NoEvidence({ reason }: { readonly reason: string }) {
  return (
    <div className={styles.coverage} data-support="PARTIAL" role="status">
      <div className={styles.coverageHead}>
        <strong>Not available from the canonical export</strong>
      </div>
      <ul className={styles.coverageGaps}><li>{reason}</li></ul>
    </div>
  );
}

function currenciesOf(report: Report): readonly string[] {
  return [...new Set(report.summaries.map(({ currency }) => currency))].sort();
}

function label(value: string): string {
  return value === UNALLOCATED ? "Unallocated" : value;
}

function dimensionLabel(value: string): string {
  return value.replace(/_/gu, " ");
}

function formatQuantityMicrosExact(
  quantityMicros: string | null,
  unit: string,
): string {
  if (quantityMicros === null || !/^-?(?:0|[1-9]\d*)$/u.test(quantityMicros)) {
    return "Not observed";
  }
  const amount = BigInt(quantityMicros);
  const negative = amount < BigInt(0);
  const absolute = negative ? -amount : amount;
  const whole = (absolute / BigInt(1_000_000)).toLocaleString("en-US");
  const fraction = (absolute % BigInt(1_000_000)).toString()
    .padStart(6, "0").replace(/0+$/u, "");
  return `${negative ? "−" : ""}${whole}${
    fraction.length === 0 ? "" : `.${fraction}`
  } ${unit}`;
}

/** Billing summary: invoiced scope, what the policy excludes, and why. */
function BillingSummarySheet({ report }: { readonly report: Report }) {
  const currencies = currenciesOf(report);
  if (currencies.length === 0) {
    return <NoEvidence reason="The canonical export history produced no period summary." />;
  }
  return (
    <div className={styles.blocks}>
      <FinopsSheetBlock
        description={report.inclusionPolicy.description}
        title={`Inclusion policy: ${report.inclusionPolicy.id.replace(/_/gu, " ")}`}
      >
        <ul className={styles.formulaList} aria-label="Charge class treatment">
          {Object.entries(report.inclusionPolicy.classes).map(([chargeClass, treatment]) => (
            <li key={chargeClass}>{chargeClass}: {treatment}</li>
          ))}
        </ul>
      </FinopsSheetBlock>

      {currencies.map((currency) => {
        const summaries = report.summaries.filter((summary) => summary.currency === currency);
        const latest = summaries[summaries.length - 1] ?? null;
        if (latest === null) return null;
        return (
          <FinopsSheetBlock
            description={`Most recent period ${latest.period}. Excluded charges are itemized by class rather than netted away.`}
            key={currency}
            title={`${currency} billing summary`}
          >
            <div className={styles.tiles}>
              <Tile label="Source total" value={formatMicrosExact(latest.sourceTotalMicros, currency)} />
              <Tile label="Included" value={formatMicrosExact(latest.includedMicros, currency)} />
              <Tile label="Excluded" value={formatMicrosExact(latest.excludedMicros, currency)} />
              <Tile label="Included lines" value={formatCount(latest.includedLineCount)} />
              <Tile label="Excluded lines" value={formatCount(latest.excludedLineCount)} />
              <Tile
                detail={`over ${formatCount(latest.averageDailyRunRate.observedDays)} observed days`}
                label="Average daily run rate"
                value={formatMicrosExact(latest.averageDailyRunRate.roundedMicrosPerDay, currency)}
              />
            </div>

            {latest.excludedByClass.length === 0 ? null : (
              <BarChart
                ariaLabel={`${currency} excluded cost by charge class in ${latest.period}`}
                categories={latest.excludedByClass.map(({ chargeClass }) => chargeClass)}
                formatValue={(value) => formatUnits(value, currency)}
                series={[{
                  id: "excluded",
                  label: "Excluded amount",
                  values: latest.excludedByClass.map(({ amountMicros }) => microsToUnits(amountMicros)),
                }]}
              />
            )}
          </FinopsSheetBlock>
        );
      })}
    </div>
  );
}

/** Cost summary: the included-cost trend across every collected period. */
function CostSummarySheet({ report }: { readonly report: Report }) {
  const currencies = currenciesOf(report);
  if (currencies.length === 0) {
    return <NoEvidence reason="No period summary exists, so no trend can be plotted." />;
  }
  return (
    <div className={styles.blocks}>
      {currencies.map((currency) => {
        const summaries = report.summaries.filter((summary) => summary.currency === currency);
        return (
          <FinopsSheetBlock
            description={`Included cost per period on the ${report.costBasis} basis, with the source total for comparison.`}
            key={currency}
            title={`${currency} cost trend`}
          >
            <TimeSeriesChart
              ariaLabel={`${currency} included and source cost by period`}
              formatValue={(value) => formatUnits(value, currency)}
              mode="area"
              series={[
                {
                  id: "included",
                  label: "Included",
                  points: summaries.map((summary) => ({
                    label: summary.period,
                    value: microsToUnits(summary.includedMicros),
                  })),
                },
                {
                  id: "source",
                  label: "Source total",
                  points: summaries.map((summary) => ({
                    label: summary.period,
                    value: microsToUnits(summary.sourceTotalMicros),
                  })),
                },
              ]}
            />
          </FinopsSheetBlock>
        );
      })}
    </div>
  );
}

/** Allocation: the taxonomy tree, with unallocated cost shown as its own share. */
function AllocationSheet({ report }: { readonly report: Report }) {
  if (report.allocations.length === 0) {
    return <NoEvidence reason="No allocation is available: the organizational taxonomy produced no allocated cost for the compared periods." />;
  }
  return (
    <div className={styles.blocks}>
      {report.allocations.map((allocation) => (
        <FinopsSheetBlock
          description={`${report.allocationMode} allocation for ${allocation.period}. Cost with no taxonomy value is reported as unallocated rather than distributed.`}
          key={`${allocation.currency}-${allocation.period}`}
          title={`${allocation.currency} allocation`}
        >
          <div className={styles.tiles}>
            <Tile label="Included" value={formatMicrosExact(allocation.includedMicros, allocation.currency)} />
            <Tile label="Excluded" value={formatMicrosExact(allocation.excludedMicros, allocation.currency)} />
            <Tile
              detail={`${formatCount(allocation.rootUnallocatedLineCount)} lines`}
              label="Unallocated at root"
              value={formatMicrosExact(allocation.rootUnallocatedMicros, allocation.currency)}
            />
          </div>

          {allocation.children.length === 0 ? (
            <NoEvidence reason="The taxonomy produced no top-level allocation node for this currency and period." />
          ) : (
            <RankingBars
              ariaLabel={`${allocation.currency} allocated cost by ${allocation.children[0]!.dimension} in ${allocation.period}`}
              formatValue={(value) => formatUnits(value, allocation.currency)}
              items={allocation.children.flatMap((node) => {
                const units = microsToUnits(node.amountMicros);
                return units === null ? [] : [{
                  id: `${node.dimension}-${node.value}`,
                  label: label(node.value),
                  value: units,
                  detail: `${formatCount(node.lineCount)} lines`,
                  tone: node.value === UNALLOCATED ? ("amber" as const) : ("blue" as const),
                }];
              })}
              sort
            />
          )}
        </FinopsSheetBlock>
      ))}
    </div>
  );
}

/** Movers: what changed between the engine's baseline and comparison periods. */
function MoversSheet({ report }: { readonly report: Report }) {
  if (report.movers.length === 0) {
    return <NoEvidence reason="No dimension changed measurably between the compared periods." />;
  }
  const currency = report.movers[0]!.currency;
  return (
    <FinopsSheetBlock
      description={`${report.baselinePeriod} compared with ${report.comparisonPeriod}. A percentage is withheld where the baseline was zero, rather than shown as infinite growth.`}
      title="Largest movers"
    >
      <RankingBars
        ariaLabel={`Cost change by ${report.movers[0]!.dimension} between ${report.baselinePeriod} and ${report.comparisonPeriod} in ${currency}`}
        formatValue={(value) => formatUnits(value, currency)}
        items={report.movers.flatMap((mover) => {
          const units = microsToUnits(mover.absoluteDeltaMicros);
          return units === null ? [] : [{
            id: `${mover.dimension}-${mover.value}`,
            label: label(mover.value),
            value: units,
            detail: mover.percentageState === "available"
              ? formatBasisPoints(mover.deltaPercentBasisPoints)
              : "no baseline",
            tone: units < 0 ? ("teal" as const) : ("red" as const),
          }];
        })}
      />
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption>Exact baseline and comparison amounts for every mover.</caption>
          <thead>
            <tr>
              <th scope="col">Dimension value</th>
              <th className={styles.numeric} scope="col">Baseline</th>
              <th className={styles.numeric} scope="col">Comparison</th>
              <th className={styles.numeric} scope="col">Delta</th>
              <th className={styles.numeric} scope="col">Change</th>
            </tr>
          </thead>
          <tbody>
            {report.movers.map((mover) => (
              <tr key={`${mover.currency}-${mover.dimension}-${mover.value}`}>
                <th scope="row">{label(mover.value)}</th>
                <td className={styles.numeric}>{formatMicrosExact(mover.baselineMicros, mover.currency)}</td>
                <td className={styles.numeric}>{formatMicrosExact(mover.comparisonMicros, mover.currency)}</td>
                <td className={styles.numeric}>{formatMicrosExact(mover.absoluteDeltaMicros, mover.currency)}</td>
                <td className={styles.numeric}>
                  {mover.percentageState === "available"
                    ? formatBasisPoints(mover.deltaPercentBasisPoints)
                    : "No baseline"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </FinopsSheetBlock>
  );
}

/** Commitments: expiring RI/SP with explicit evidence coverage. */
function CommitmentsSheet({ report, expiringOnly }: {
  readonly report: Report;
  readonly expiringOnly: boolean;
}) {
  const items = expiringOnly
    ? [...report.commitments.items].sort((left, right) => left.expiresInDays - right.expiresInDays)
    : report.commitments.items;

  return (
    <div className={styles.blocks}>
      <FinopsSheetBlock
        description={`Commitments expiring within ${report.commitments.expiresWithinDays} days of ${report.commitments.asOfIso}, sourced from period ${report.commitments.sourcePeriod}.`}
        title={expiringOnly ? "Expiring commitments" : "Reserved Instances and Savings Plans"}
      >
        {items.length === 0 ? (
          <NoEvidence reason="No commitment in the source period expires inside the tracked window." />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>
                Savings and utilization are withheld where the required evidence is missing; the
                missing inputs are named per row rather than assumed to be zero.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Commitment</th>
                  <th scope="col">Type</th>
                  <th className={styles.numeric} scope="col">Expires in</th>
                  <th className={styles.numeric} scope="col">Gross</th>
                  <th className={styles.numeric} scope="col">Used</th>
                  <th className={styles.numeric} scope="col">Unused</th>
                  <th scope="col">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.commitmentArnOrId}>
                    <th scope="row">{item.commitmentArnOrId}</th>
                    <td>{item.commitmentType}</td>
                    <td className={styles.numeric}>{formatCount(item.expiresInDays)} days</td>
                    <td className={styles.numeric}>{formatMicrosExact(item.grossMicros, report.summaries[0]?.currency ?? "USD")}</td>
                    <td className={styles.numeric}>{formatMicrosExact(item.usedMicros, report.summaries[0]?.currency ?? "USD")}</td>
                    <td className={styles.numeric}>{formatMicrosExact(item.unusedMicros, report.summaries[0]?.currency ?? "USD")}</td>
                    <td>
                      {item.coverage.complete
                        ? "Complete"
                        : `Missing: ${item.coverage.missing.map((entry) => entry.replace(/_/gu, " ")).join(", ")}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FinopsSheetBlock>

      {report.commitments.untrackable.length === 0 ? null : (
        <FinopsSheetBlock
          description="These billing lines look like commitments but cannot be tracked. They are disclosed rather than dropped."
          title={`Untrackable commitment lines (${formatCount(report.commitments.untrackable.length)})`}
        >
          <ul className={styles.coverageGaps}>
            {report.commitments.untrackable.slice(0, 25).map((row) => (
              <li key={row.lineItemId}>{row.lineItemId}: {row.reason.replace(/_/gu, " ")}</li>
            ))}
          </ul>
        </FinopsSheetBlock>
      )}
    </div>
  );
}

/** Explorer: bounded native grouping over allow-listed dimensions. */
function ExplorerSheet({ report, note }: { readonly report: Report; readonly note?: string }) {
  if (report.explorer === null || report.explorer.groups.length === 0) {
    return <NoEvidence reason="The bounded explorer returned no group for the selected period and dimensions." />;
  }
  const currency = report.explorer.groups[0]!.currency;
  return (
    <FinopsSheetBlock
      description={note ?? `Grouped cost for ${report.explorer.period} across the allow-listed dimensions.`}
      title="Cost explorer groups"
    >
      <RankingBars
        ariaLabel={`Explorer group cost for ${report.explorer.period} in ${currency}`}
        formatValue={(value) => formatUnits(value, currency)}
        items={report.explorer.groups.flatMap((group, index) => {
          const units = microsToUnits(group.amountMicros);
          return units === null ? [] : [{
            id: `${index}`,
            label: group.dimensions.map((entry) => label(entry.value)).join(" · "),
            value: units,
            detail: `${formatCount(group.lineCount)} lines`,
          }];
        })}
        maxItems={20}
        sort
      />
    </FinopsSheetBlock>
  );
}

function UsagePivotSheet({ report }: { readonly report: Report }) {
  const pivot = report.usageMomPivot;
  if (pivot === undefined || pivot.status === "unavailable") {
    return (
      <NoEvidence
        reason={pivot?.reason === "missing_usage_quantity_or_unit"
          ? "Usage rows were observed, but no row carried both a valid integer quantity and an explicit provider unit."
          : "No included usage row was observed for the compared periods, so a usage quantity pivot is unavailable."}
      />
    );
  }
  return (
    <FinopsSheetBlock
      description={`Observed canonical quantities keyed by provider unit. ${pivot.baselinePeriod} is compared with ${pivot.comparisonPeriod}; unlike units are never combined and a missing side is not rendered as zero.`}
      title="Month-over-month usage quantity pivot"
    >
      {pivot.status === "partial" ? (
        <div className={styles.coverage} data-support="PARTIAL" role="status">
          <div className={styles.coverageHead}>
            <strong>Partial usage quantity evidence</strong>
          </div>
          <ul className={styles.coverageGaps}>
            <li>
              {formatCount(pivot.missingEvidenceLineCount)} of {formatCount(pivot.eligibleLineCount)}
              {" "}usage lines lacked a valid quantity or provider unit. Values below are observed
              quantities, not complete totals.
            </li>
          </ul>
        </div>
      ) : null}
      {pivot.cells.length === 0 ? (
        <NoEvidence reason="No unit-compatible quantity cell was observed for the selected dimensions." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>
              {formatCount(pivot.cells.length)} unit-separated cells · {formatCount(pivot.usableLineCount)}
              {" "}usable usage lines.
            </caption>
            <thead>
              <tr>
                <th scope="col">{pivot.dimensions[0]}</th>
                <th scope="col">{pivot.dimensions[1]}</th>
                <th scope="col">Currency scope</th>
                <th scope="col">Provider unit</th>
                <th className={styles.numeric} scope="col">{pivot.baselinePeriod}</th>
                <th className={styles.numeric} scope="col">{pivot.comparisonPeriod}</th>
                <th className={styles.numeric} scope="col">Delta</th>
                <th className={styles.numeric} scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {pivot.cells.map((cell) => (
                <tr key={`${cell.currency}-${cell.usageUnit}-${cell.rowValue}-${cell.columnValue}`}>
                  <th scope="row">{label(cell.rowValue)}</th>
                  <td>{label(cell.columnValue)}</td>
                  <td>{cell.currency}</td>
                  <td>{cell.usageUnit}</td>
                  <td className={styles.numeric}>
                    {formatQuantityMicrosExact(cell.baselineQuantityMicros, cell.usageUnit)}
                  </td>
                  <td className={styles.numeric}>
                    {formatQuantityMicrosExact(cell.comparisonQuantityMicros, cell.usageUnit)}
                  </td>
                  <td className={styles.numeric}>
                    {formatQuantityMicrosExact(cell.deltaQuantityMicros, cell.usageUnit)}
                  </td>
                  <td className={styles.numeric}>
                    {cell.deltaQuantityMicros === null
                      ? "Not available"
                      : formatBasisPoints(cell.deltaPercentBasisPoints)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </FinopsSheetBlock>
  );
}

/** MoM pivot: exact spend and unit-separated quantity views. */
function PivotSheet({ report }: { readonly report: Report }) {
  const { cells, dimensions, baselinePeriod, comparisonPeriod } = report.momPivot;
  if (cells.length === 0) {
    return <NoEvidence reason="The pivot produced no cell for the compared periods and dimensions." />;
  }
  return (
    <div className={styles.blocks}>
      <FinopsSheetBlock
        description={`${dimensions[0]} by ${dimensions[1]}, ${baselinePeriod} against ${comparisonPeriod}. Currency remains part of every spend cell.`}
        title="Month-over-month spend pivot"
      >
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>{formatCount(cells.length)} pivot cells, exact micro-unit amounts.</caption>
            <thead>
              <tr>
                <th scope="col">{dimensions[0]}</th>
                <th scope="col">{dimensions[1]}</th>
                <th className={styles.numeric} scope="col">{baselinePeriod}</th>
                <th className={styles.numeric} scope="col">{comparisonPeriod}</th>
                <th className={styles.numeric} scope="col">Delta</th>
                <th className={styles.numeric} scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {cells.map((cell, index) => (
                <tr key={`${cell.rowValue}-${cell.columnValue}-${index}`}>
                  <th scope="row">{label(cell.rowValue)}</th>
                  <td>{label(cell.columnValue)}</td>
                  <td className={styles.numeric}>{formatMicrosExact(cell.baselineMicros, cell.currency)}</td>
                  <td className={styles.numeric}>{formatMicrosExact(cell.comparisonMicros, cell.currency)}</td>
                  <td className={styles.numeric}>{formatMicrosExact(cell.deltaMicros, cell.currency)}</td>
                  <td className={styles.numeric}>{formatBasisPoints(cell.deltaPercentBasisPoints)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </FinopsSheetBlock>
      <UsagePivotSheet report={report} />
    </div>
  );
}

/** About: forecast method, taxonomy lineage and the policy in force. */
function AboutSheet({ report }: { readonly report: Report }) {
  return (
    <div className={styles.blocks}>
      <FinopsSheetBlock
        description="Deterministic integer trend. The band is a reproducible error band, never a statistical confidence interval."
        title="Forecast"
      >
        {report.forecasts.length === 0 ? (
          <NoEvidence reason="No currency had enough history to attempt a forecast." />
        ) : (
          <div className={styles.tiles}>
            {report.forecasts.map((forecast) => (
              <Tile
                detail={forecast.status === "available"
                  ? `${forecast.forecastPeriod} · ${forecast.model}`
                  : `${forecast.observedPeriods} of ${forecast.minimumPeriods} periods needed`}
                key={forecast.currency}
                label={`${forecast.currency} forecast`}
                value={forecast.status === "available"
                  ? formatMicrosExact(forecast.forecastMicros, forecast.currency)
                  : "Insufficient history"}
              />
            ))}
          </div>
        )}
      </FinopsSheetBlock>

      <FinopsSheetBlock title="Taxonomy and policy lineage">
        <div className={styles.tiles}>
          <Tile label="Taxonomy source" value={report.taxonomyEvidence.source.replace(/_/gu, " ")} />
          <Tile label="Cost basis" value={report.costBasis.replace(/_/gu, " ")} />
          <Tile label="Allocation mode" value={report.allocationMode} />
          <Tile label="Baseline period" value={report.baselinePeriod} />
          <Tile label="Comparison period" value={report.comparisonPeriod} />
        </div>
        <p className={styles.goalMeta}>
          Taxonomy evidence {report.taxonomyEvidence.sourceEvidenceId}, observed{" "}
          {report.taxonomyEvidence.observedAtIso}.
        </p>
      </FinopsSheetBlock>
    </div>
  );
}

/** One sheet's content, exported so any sheet can be rendered and asserted. */
export function FinopsCostIntelligenceSheetContent({
  report, sheet,
}: { readonly report: Report; readonly sheet: FinopsSheetDescriptor }) {
  switch (sheet.key) {
    case "billing-summary": return <BillingSummarySheet report={report} />;
    case "cost-summary":
      // The official Cost Summary sheet is where chargeback and showback
      // reporting lives, so the taxonomy allocation belongs with the trend.
      return (
        <div className={styles.blocks}>
          <CostSummarySheet report={report} />
          <AllocationSheet report={report} />
        </div>
      );
    case "compute-summary":
      return (
        <ExplorerSheet
          note="Grouped cost across the allow-listed dimensions. The official compute sheet also needs EC2-only unit cost and elasticity, which require complete service-specific usage quantity evidence that the canonical export does not carry."
          report={report}
        />
      );
    case "storage-summary":
      return (
        <ExplorerSheet
          note="Grouped cost across the allow-listed dimensions. Bucket, volume and storage-class coverage require unambiguous resource semantics and complete usage evidence, so they are withheld."
          report={report}
        />
      );
    case "ri-sp-summary": return <CommitmentsSheet expiringOnly={false} report={report} />;
    case "expiring-ri-sp-tracker": return <CommitmentsSheet expiringOnly report={report} />;
    case "optics-explorer": return <ExplorerSheet report={report} />;
    case "mom-pivot": return <PivotSheet report={report} />;
    case "summary-of-changes": return <MoversSheet report={report} />;
    case "about": return <AboutSheet report={report} />;
    default:
      return (
        <NoEvidence
          reason={`Sutra has no canonical projection for the official sheet "${sheet.name}". It is listed because AWS publishes it, not because it is delivered.`}
        />
      );
  }
}

/** Presentation for a loaded Cost Intelligence report. */
export function FinopsCostIntelligenceSheets({
  envelope, initialSheetKey,
}: {
  readonly envelope: {
    readonly report: unknown;
    readonly sourceEvidence: FoundationalSourceEvidence | null;
  };
  readonly initialSheetKey?: string;
}) {
  const [sheetKey, setSheetKey] = useState<string>(
    initialSheetKey ?? FINOPS_COST_INTELLIGENCE_SHEETS.sheets[0]!.key,
  );
  const sheet = useMemo(
    () => FINOPS_COST_INTELLIGENCE_SHEETS.sheets.find((entry) => entry.key === sheetKey)
      ?? FINOPS_COST_INTELLIGENCE_SHEETS.sheets[0]!,
    [sheetKey],
  );

  const report = envelope.report;
  if (report === null || typeof report !== "object" || (report as Report).ok !== true) return null;
  const ready = report as Report;

  return (
    <>
      <EvidenceStrip
        basis={ready.costBasis}
        currencies={currenciesOf(ready)}
        evidence={envelope.sourceEvidence}
        title="Cost Intelligence source evidence"
      />
      <FinopsSheetShell
        activeKey={sheet.key}
        idPrefix="cost-intelligence"
        inventory={FINOPS_COST_INTELLIGENCE_SHEETS}
        onSelectSheet={setSheetKey}
      >
        <FinopsCostIntelligenceSheetContent report={ready} sheet={sheet} />
      </FinopsSheetShell>
    </>
  );
}

function replaceExplorerFilter(
  filters: readonly FinopsExplorerFilter[],
  index: number,
  next: FinopsExplorerFilter,
): readonly FinopsExplorerFilter[] {
  return filters.map((filter, current) => current === index ? next : filter);
}

function CostIntelligenceControls({
  applied,
  connectionAvailable,
  onApply,
}: {
  readonly applied: CostIntelligenceEndpointFilters;
  readonly connectionAvailable: boolean;
  readonly onApply: (filters: CostIntelligenceEndpointFilters) => void;
}) {
  const [draft, setDraft] = useState<CostIntelligenceEndpointFilters>(applied);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onApply({
      ...draft,
      explorerFilters: draft.explorerFilters.filter(({ value }) => value.length > 0),
    });
  };
  const reset = () => {
    const next: CostIntelligenceEndpointFilters = {
      ...DEFAULT_COST_INTELLIGENCE_FILTERS,
      explorerFilters: [],
    };
    setDraft(next);
    onApply(next);
  };
  return (
    <section aria-label="Cost Intelligence OPTICS controls">
      <form className={styles.toolbar} onSubmit={submit}>
        <div className={styles.field}>
          <label htmlFor="cid-cost-basis">Cost basis</label>
          <select
            disabled={!connectionAvailable}
            id="cid-cost-basis"
            onChange={(event) => setDraft({
              ...draft,
              costBasis: event.target.value as CostIntelligenceEndpointFilters["costBasis"],
            })}
            value={draft.costBasis}
          >
            {FINOPS_COST_BASES.map((basis) => (
              <option key={basis} value={basis}>{dimensionLabel(basis)}</option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="cid-allocation-mode">Allocation</label>
          <select
            disabled={!connectionAvailable}
            id="cid-allocation-mode"
            onChange={(event) => setDraft({
              ...draft,
              allocationMode: event.target.value as CostIntelligenceEndpointFilters["allocationMode"],
            })}
            value={draft.allocationMode}
          >
            <option value="showback">Showback</option>
            <option value="chargeback">Chargeback</option>
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="cid-group-one">Group by level 1</label>
          <select
            disabled={!connectionAvailable}
            id="cid-group-one"
            onChange={(event) => {
              const pivotRow = event.target.value as FinopsCostDimension;
              const pivotColumn = pivotRow === draft.pivotColumn
                ? FINOPS_COST_DIMENSIONS.find((dimension) => dimension !== pivotRow) ?? "service"
                : draft.pivotColumn;
              setDraft({ ...draft, pivotRow, pivotColumn });
            }}
            value={draft.pivotRow}
          >
            {FINOPS_COST_DIMENSIONS.map((dimension) => (
              <option key={dimension} value={dimension}>{dimensionLabel(dimension)}</option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="cid-group-two">Group by level 2</label>
          <select
            disabled={!connectionAvailable}
            id="cid-group-two"
            onChange={(event) => {
              const pivotColumn = event.target.value as FinopsCostDimension;
              const pivotRow = pivotColumn === draft.pivotRow
                ? FINOPS_COST_DIMENSIONS.find((dimension) => dimension !== pivotColumn) ?? "account"
                : draft.pivotRow;
              setDraft({ ...draft, pivotRow, pivotColumn });
            }}
            value={draft.pivotColumn}
          >
            {FINOPS_COST_DIMENSIONS.map((dimension) => (
              <option key={dimension} value={dimension}>{dimensionLabel(dimension)}</option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="cid-explorer-period">Explorer month</label>
          <input
            disabled={!connectionAvailable}
            id="cid-explorer-period"
            onChange={(event) => setDraft({ ...draft, explorerPeriod: event.target.value })}
            type="month"
            value={draft.explorerPeriod}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="cid-explorer-limit">Result limit</label>
          <select
            disabled={!connectionAvailable}
            id="cid-explorer-limit"
            onChange={(event) => setDraft({ ...draft, explorerLimit: Number(event.target.value) })}
            value={draft.explorerLimit}
          >
            {[25, 50, 100, 200].map((limit) => <option key={limit}>{limit}</option>)}
          </select>
        </div>

        {draft.explorerFilters.map((filter, index) => (
          <div className={styles.toolbar} key={`${index}-${filter.dimension}`}>
            <div className={styles.field}>
              <label htmlFor={`cid-filter-dimension-${index}`}>Filter {index + 1}</label>
              <select
                disabled={!connectionAvailable}
                id={`cid-filter-dimension-${index}`}
                onChange={(event) => setDraft({
                  ...draft,
                  explorerFilters: replaceExplorerFilter(draft.explorerFilters, index, {
                    ...filter,
                    dimension: event.target.value as FinopsCostDimension,
                  }),
                })}
                value={filter.dimension}
              >
                {FINOPS_COST_DIMENSIONS.map((dimension) => (
                  <option key={dimension} value={dimension}>{dimensionLabel(dimension)}</option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor={`cid-filter-value-${index}`}>Exact value</label>
              <input
                disabled={!connectionAvailable}
                id={`cid-filter-value-${index}`}
                maxLength={256}
                onChange={(event) => setDraft({
                  ...draft,
                  explorerFilters: replaceExplorerFilter(draft.explorerFilters, index, {
                    ...filter,
                    value: event.target.value,
                  }),
                })}
                value={filter.value}
              />
            </div>
            <button
              className="button button-secondary"
              disabled={!connectionAvailable}
              onClick={() => setDraft({
                ...draft,
                explorerFilters: draft.explorerFilters.filter((_, current) => current !== index),
              })}
              type="button"
            >
              Remove filter
            </button>
          </div>
        ))}

        <button
          className="button button-secondary"
          disabled={!connectionAvailable || draft.explorerFilters.length >= 8}
          onClick={() => setDraft({
            ...draft,
            explorerFilters: [...draft.explorerFilters, { dimension: "service", value: "" }],
          })}
          type="button"
        >
          Add exact filter
        </button>
        <button className="button button-primary" disabled={!connectionAvailable} type="submit">
          Apply controls
        </button>
        <button className="button button-secondary" disabled={!connectionAvailable} onClick={reset} type="button">
          Reset
        </button>
      </form>
      <p className={styles.goalMeta}>
        Controls are limited to canonical CUR/FOCUS fields and eight exact filters. Database engine,
        instance type family, instance type, and platform stay unavailable when the accepted export
        does not carry an unambiguous first-class value.
      </p>
    </section>
  );
}

export function FinopsCostIntelligenceSheetsDashboard({
  connectionId,
}: { readonly connectionId: string | null }) {
  const [filters, setFilters] = useState<CostIntelligenceEndpointFilters>(
    DEFAULT_COST_INTELLIGENCE_FILTERS,
  );
  const { state, reload } = useCostIntelligenceEndpoint(connectionId, filters);
  const envelope = state.status === "ready" && "envelope" in state ? state.envelope : null;

  return (
    <section aria-label="Cost Intelligence dashboard" className={styles.shell}>
      <CostIntelligenceControls
        applied={filters}
        connectionAvailable={connectionId !== null}
        onApply={setFilters}
      />
      <EndpointBoundary onRetry={reload} state={state} title="the Cost Intelligence dashboard" />
      {envelope === null ? null : <FinopsCostIntelligenceSheets envelope={envelope} />}
    </section>
  );
}

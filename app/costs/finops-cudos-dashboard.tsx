"use client";

import { useMemo, useState } from "react";
import { BarChart, RankingBars, ShareBar, TimeSeriesChart } from "../components/charts";
import {
  EndpointBoundary,
  EvidenceStrip,
  StateBadge,
  costFor,
  formatBasisPoints,
  formatMicrosExact,
  type FoundationalSourceEvidence,
} from "./finops-foundational-panels";
import { useCudosEndpoint } from "./finops-foundational-endpoint";
import { FINOPS_CUDOS_SHEETS, type FinopsSheetDescriptor } from "./finops-foundational-sheets";
import { FinopsSheetBlock, FinopsSheetShell, foundationalStyles as styles } from "./finops-foundational-sheet-shell";
import {
  basisPointsToPercent,
  formatCount,
  formatPercent,
  formatUnits,
  microsToUnits,
} from "./finops-foundational-money";
import type { FinopsCudosModuleId, FinopsCudosResult } from "../../lib/finops-cudos";

/**
 * FND-01 CUDOS, presented as the nineteen sheets AWS publishes rather than as
 * concern-based panels.
 *
 * The sheet set comes from the hash-pinned official definition, so this view
 * cannot invent or omit a sheet. Each sheet renders only fields the canonical
 * `/api/v1/finops/cudos` report actually returns; where the official sheet
 * depends on provider telemetry the CUR does not carry, the sheet says so
 * through its audited gap rather than filling the space.
 *
 * Money is integer micro-units end to end. Exact figures are printed with
 * `formatMicrosExact`, which never converts to a number; charts convert only for
 * geometry and drop any value too large to convert exactly.
 */

/**
 * Which canonical module backs each official service sheet. Sheets without a
 * module entry are not service modules — they are executive, explorer or About
 * sheets and are handled directly.
 */
const SHEET_MODULES: Readonly<Record<string, readonly FinopsCudosModuleId[]>> = Object.freeze({
  compute: ["compute"],
  "storage-backup": ["storage", "ebs"],
  "amazon-s3": ["s3"],
  databases: ["database"],
  "amazon-dynamodb": ["dynamodb"],
  "ai-ml": ["ai_ml"],
  "data-transfer-networking": ["data_transfer_networking"],
  "messaging-and-streaming": ["messaging"],
  "monitoring-observability": ["monitoring"],
  analytics: ["analytics"],
  security: ["security"],
  "end-user-computing": ["end_user_computing"],
  "gametech-media": ["gametech_media"],
});

const MODULE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  compute: "Compute", storage: "Storage", s3: "Amazon S3", ebs: "Amazon EBS",
  database: "Databases", dynamodb: "Amazon DynamoDB", ai_ml: "AI/ML",
  data_transfer_networking: "Data transfer & networking", messaging: "Messaging & streaming",
  monitoring: "Monitoring & observability", analytics: "Analytics", security: "Security",
  end_user_computing: "End user computing", gametech_media: "GameTech & media",
});

/** The successful arm of the canonical CUDOS report. */
type CudosReport = Extract<FinopsCudosResult, { readonly ok: true }>;

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
        <strong>No evidence for this sheet in the active generation</strong>
      </div>
      <ul className={styles.coverageGaps}><li>{reason}</li></ul>
    </div>
  );
}

function formatUsageMicros(value: string | null): string {
  return value === null
    ? "Unavailable"
    : `${BigInt(value).toLocaleString("en-US")} usage micros`;
}

/** Trends: three official cadences, each a real time series. */
function TrendsSheet({ report }: { readonly report: CudosReport }) {
  const basis = report.selectedCostBasis;
  const currencies = [...new Set(report.trends.monthly.map(({ currency }) => currency))].sort();

  const cadences = [
    { key: "monthly", label: "Monthly", buckets: report.trends.monthly },
    { key: "weekly", label: "UTC week", buckets: report.trends.weekly },
    { key: "daily", label: "Daily", buckets: report.trends.daily },
  ] as const;

  if (currencies.length === 0) {
    return <NoEvidence reason="The active generation contains no trend buckets, so no cadence can be plotted." />;
  }

  return (
    <div className={styles.blocks}>
      {cadences.map((cadence) => (
        <FinopsSheetBlock
          description={`Cost on the ${basis} basis. Currencies are never combined; a period with no collected cost is a gap, not a zero.`}
          key={cadence.key}
          title={`${cadence.label} trend`}
        >
          {currencies.map((currency) => {
            const buckets = cadence.buckets.filter((bucket) => bucket.currency === currency);
            return (
              <TimeSeriesChart
                ariaLabel={`${cadence.label} ${basis} cost in ${currency}`}
                formatValue={(value) => formatUnits(value, currency)}
                key={currency}
                mode={cadence.key === "daily" ? "line" : "area"}
                series={[{
                  id: `${cadence.key}-${currency}`,
                  label: `${currency} ${basis}`,
                  points: buckets.map((bucket) => ({
                    label: bucket.period,
                    value: microsToUnits(costFor(bucket.costs, basis)?.totalMicros ?? null),
                  })),
                }]}
              />
            );
          })}
        </FinopsSheetBlock>
      ))}
    </div>
  );
}

/** Billing summary: per-currency totals and the full charge-kind disclosure. */
function BillingSummarySheet({ report }: { readonly report: CudosReport }) {
  const basis = report.selectedCostBasis;
  if (report.executive.length === 0) {
    return <NoEvidence reason="The active generation produced no per-currency executive summary." />;
  }
  return (
    <div className={styles.blocks}>
      {report.executive.map((summary) => {
        const selected = costFor(summary.costs, basis);
        return (
          <FinopsSheetBlock
            description={`Invoiced scope for ${summary.currency}. Coverage states whether every line carried the ${basis} basis.`}
            key={summary.currency}
            title={`${summary.currency} billing summary`}
          >
            <div className={styles.tiles}>
              <Tile
                detail={`Coverage: ${selected?.coverage ?? "unavailable"}`}
                label={`${basis} total`}
                value={formatMicrosExact(selected?.totalMicros ?? null, summary.currency)}
              />
              <Tile label="Billing lines" value={formatCount(summary.lineCount)} />
              <Tile label="Accounts" value={formatCount(summary.accountCount)} />
              <Tile label="Services" value={formatCount(summary.serviceCount)} />
              <Tile label="Regions" value={formatCount(summary.regionCount)} />
              <Tile label="Resources" value={formatCount(summary.resourceCount)} />
            </div>

            {/* Charge kinds include credits and refunds, which are negative. A
                bar chart keeps their sign; a composition ring could not. */}
            <BarChart
              ariaLabel={`${summary.currency} cost by charge kind on the ${basis} basis`}
              categories={summary.chargeKinds.map(({ chargeKind }) => chargeKind)}
              formatValue={(value) => formatUnits(value, summary.currency)}
              series={[{
                id: "charge",
                label: `${basis} cost`,
                values: summary.chargeKinds.map((kind) =>
                  microsToUnits(costFor(kind.costs, basis)?.totalMicros ?? null)),
              }]}
            />

            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>
                  Every official charge kind is listed, including kinds proven absent, so an
                  absent kind is evidence rather than an omission.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Charge kind</th>
                    <th scope="col">Present</th>
                    <th className={styles.numeric} scope="col">Lines</th>
                    <th className={styles.numeric} scope="col">Signed total</th>
                    <th scope="col">Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.chargeKinds.map((kind) => {
                    const cost = costFor(kind.costs, basis);
                    return (
                      <tr key={kind.chargeKind}>
                        <th scope="row">{kind.chargeKind}</th>
                        <td>{kind.present ? "Observed" : "Proven absent"}</td>
                        <td className={styles.numeric}>{formatCount(kind.lineCount)}</td>
                        <td className={styles.numeric}>
                          {formatMicrosExact(cost?.totalMicros ?? null, summary.currency)}
                        </td>
                        <td><StateBadge state={cost?.coverage ?? "unavailable"} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </FinopsSheetBlock>
        );
      })}
    </div>
  );
}

/** RI/SP summary: coverage, utilization and amortization true-up. */
function CommitmentsSheet({ report }: { readonly report: CudosReport }) {
  if (report.commitments.length === 0) {
    return <NoEvidence reason="The active generation carries no commitment evidence, so coverage and utilization are unavailable rather than zero." />;
  }
  return (
    <div className={styles.blocks}>
      {report.commitments.map((commitment) => {
        const coverage = basisPointsToPercent(commitment.coverage.coverageBasisPoints);
        const utilization = basisPointsToPercent(commitment.utilization.utilizationBasisPoints);
        return (
          <FinopsSheetBlock
            description={`Reserved Instance and Savings Plan position for ${commitment.currency} on the ${commitment.costBasis} basis.`}
            key={`${commitment.currency}-${commitment.costBasis}`}
            title={`${commitment.currency} commitments`}
          >
            <div className={styles.tiles}>
              <Tile
                detail={`Status: ${commitment.coverage.status}`}
                label="Commitment coverage"
                value={formatBasisPoints(commitment.coverage.coverageBasisPoints)}
              />
              <Tile
                detail={`Status: ${commitment.utilization.status}`}
                label="Commitment utilization"
                value={formatBasisPoints(commitment.utilization.utilizationBasisPoints)}
              />
              <Tile
                label="Covered cost"
                value={formatMicrosExact(commitment.coverage.coveredCostMicros, commitment.currency)}
              />
              <Tile
                label="Eligible classified cost"
                value={formatMicrosExact(commitment.coverage.classifiedEligibleCostMicros, commitment.currency)}
              />
              <Tile
                label="Explicit unused commitment"
                value={formatMicrosExact(commitment.utilization.explicitUnusedCostMicros, commitment.currency)}
              />
              <Tile
                detail={`Status: ${commitment.trueUp.status}`}
                label="Amortized minus unblended"
                value={formatMicrosExact(commitment.trueUp.amortizedMinusUnblendedMicros, commitment.currency)}
              />
            </div>

            {coverage === null ? null : (
              <ShareBar
                ariaLabel={`Commitment coverage ${formatPercent(coverage)} of classified eligible cost in ${commitment.currency}`}
                formatValue={(value) => formatPercent(value)}
                segments={[
                  { id: "covered", label: "Covered by commitments", value: coverage, tone: "teal" },
                  { id: "ondemand", label: "On demand", value: Math.max(0, 100 - coverage), tone: "amber" },
                ]}
              />
            )}

            <BarChart
              ariaLabel={`Commitment line classification counts for ${commitment.currency}`}
              categories={["Covered", "On demand", "Excluded spot", "Unknown class", "Missing cost"]}
              formatValue={formatCount}
              series={[{
                id: "lines",
                label: "Billing lines",
                values: [
                  commitment.coverage.coveredLineCount,
                  commitment.coverage.onDemandLineCount,
                  commitment.coverage.excludedSpotLineCount,
                  commitment.coverage.unknownClassificationLineCount,
                  commitment.coverage.missingCostLineCount,
                ],
              }]}
            />

            {[...commitment.coverage.incompleteReasons, ...commitment.utilization.incompleteReasons].length === 0
              ? null
              : (
                <ul className={styles.coverageGaps}>
                  {[...commitment.coverage.incompleteReasons, ...commitment.utilization.incompleteReasons]
                    .map((reason) => <li key={reason}>{reason.replace(/_/gu, " ")}</li>)}
                </ul>
              )}
            {utilization === null ? (
              <p className={styles.goalMeta}>
                Utilization is unavailable for this currency: the engine reports a status of
                {" "}{commitment.utilization.status}, and a percentage is withheld rather than estimated.
              </p>
            ) : null}
          </FinopsSheetBlock>
        );
      })}
    </div>
  );
}

/** One service module sheet, shown in the context of every other module. */
function ModuleSheet({
  report, sheet, moduleIds,
}: {
  readonly report: CudosReport;
  readonly sheet: FinopsSheetDescriptor;
  readonly moduleIds: readonly FinopsCudosModuleId[];
}) {
  const basis = report.selectedCostBasis;
  const selected = report.modules.filter((module) => moduleIds.includes(module.moduleId));
  if (selected.length === 0) {
    return (
      <NoEvidence
        reason={`No billing line in the active generation classified into ${moduleIds.map((id) => MODULE_LABEL[id] ?? id).join(" or ")}. This is a proven absence for this period, not a zero cost.`}
      />
    );
  }

  const currencies = [...new Set(report.modules.flatMap((module) =>
    module.currencies.map(({ currency }) => currency)))].sort();
  const currency = currencies[0] ?? null;

  return (
    <div className={styles.blocks}>
      {selected.map((module) => (
        <FinopsSheetBlock
          description={`Canonical ${MODULE_LABEL[module.moduleId] ?? module.moduleId} classification with its exact source-line evidence.`}
          key={module.moduleId}
          title={MODULE_LABEL[module.moduleId] ?? module.moduleId}
        >
          <div className={styles.tiles}>
            <Tile label="Billing lines" value={formatCount(module.lineCount)} />
            <Tile label="Distinct services" value={formatCount(module.services.length)} />
            {module.currencies.map((entry) => (
              <Tile
                detail={`Coverage: ${costFor(entry.costs, basis)?.coverage ?? "unavailable"}`}
                key={entry.currency}
                label={`${entry.currency} ${basis}`}
                value={formatMicrosExact(costFor(entry.costs, basis)?.totalMicros ?? null, entry.currency)}
              />
            ))}
          </div>

          {module.services.length === 0 ? null : (
            <ul className={styles.formulaList} aria-label={`${module.moduleId} services`}>
              {module.services.map((service) => <li key={service}>{service}</li>)}
            </ul>
          )}

          <p className={styles.goalMeta}>
            Source lines: {formatCount(module.sourceLineIdCount)}
            {module.sourceLineIdsTruncated ? " (evidence list truncated)" : ""}
            {module.sourceLineIds.length === 0 ? "" : ` · first ${Math.min(2, module.sourceLineIds.length)}: ${module.sourceLineIds.slice(0, 2).join(", ")}`}
          </p>
        </FinopsSheetBlock>
      ))}

      {currency === null ? null : (
        <FinopsSheetBlock
          description={`Where ${sheet.name} sits against every other classified module, so a single module is never read out of context.`}
          title="Module comparison"
        >
          <RankingBars
            ariaLabel={`Classified module cost in ${currency} on the ${basis} basis`}
            formatValue={(value) => formatUnits(value, currency)}
            items={report.modules.flatMap((module) => {
              const entry = module.currencies.find((value) => value.currency === currency);
              const units = microsToUnits(costFor(entry?.costs ?? [], basis)?.totalMicros ?? null);
              return units === null ? [] : [{
                id: module.moduleId,
                label: MODULE_LABEL[module.moduleId] ?? module.moduleId,
                value: units,
                tone: moduleIds.includes(module.moduleId) ? ("teal" as const) : ("slate" as const),
              }];
            })}
            sort
          />
        </FinopsSheetBlock>
      )}
    </div>
  );
}

/** AWS CUDOS v5.9.1 Bedrock token/cache additions on canonical CUR evidence. */
function BedrockTokensSheet({ report }: { readonly report: CudosReport }) {
  const evidence = report.bedrockTokens;
  if (evidence.buckets.length === 0) {
    return (
      <div className={styles.blocks}>
        <NoEvidence
          reason={evidence.missingUsageEvidenceLineCount > 0
            ? `${formatCount(evidence.missingUsageEvidenceLineCount)} classified Bedrock token lines lack a usage quantity or raw usage unit. Ratios are unavailable rather than zero.`
            : "No canonical Bedrock input, output, cache-read, or cache-write token usage was observed with a quantity and raw usage unit. Ratios are unavailable rather than zero."}
        />
        <FinopsSheetBlock
          description="Sutra does not infer the uncached input-token rate needed by AWS's calculated savings formula."
          title="Bedrock Cache Cost Savings % — withheld"
        >
          <p className={styles.goalMeta}>
            {evidence.cacheCostSavings.reason.replace(/_/gu, " ")}.
          </p>
        </FinopsSheetBlock>
      </div>
    );
  }

  const groups = [...new Set(evidence.buckets.map((bucket) =>
    `${bucket.currency}\0${bucket.usageUnit}`))]
    .sort()
    .map((key) => {
      const [currency, usageUnit] = key.split("\0");
      return {
        currency: currency ?? "",
        usageUnit: usageUnit ?? "",
        buckets: evidence.buckets.filter((bucket) =>
          bucket.currency === currency && bucket.usageUnit === usageUnit),
      };
    });

  return (
    <div className={styles.blocks}>
      {groups.map((group) => (
        <FinopsSheetBlock
          description={`Canonical raw token quantities in ${group.usageUnit} for ${group.currency}. Raw units and currencies are never normalized or combined.`}
          key={`usage-${group.currency}-${group.usageUnit}`}
          title="Amazon Bedrock Tokens Usage per UsageType Group"
        >
          <BarChart
            ariaLabel={`Amazon Bedrock token usage by usage type in ${group.usageUnit} for ${group.currency}`}
            categories={group.buckets.map(({ period }) => period)}
            formatValue={(value) => `${value.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${group.usageUnit}`}
            series={[
              { id: "input", label: "Input Tokens", values: group.buckets.map((bucket) => microsToUnits(bucket.usage.input.quantityMicros)) },
              { id: "output", label: "Output Tokens", values: group.buckets.map((bucket) => microsToUnits(bucket.usage.output.quantityMicros)) },
              { id: "cache-read", label: "Cache Read Input Tokens", values: group.buckets.map((bucket) => microsToUnits(bucket.usage.cache_read.quantityMicros)) },
              { id: "cache-write", label: "Cache Write Input Tokens", values: group.buckets.map((bucket) => microsToUnits(bucket.usage.cache_write.quantityMicros)) },
            ]}
          />
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>
                Exact source quantities. An unobserved token class is unavailable,
                never a fabricated zero.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th className={styles.numeric} scope="col">Input</th>
                  <th className={styles.numeric} scope="col">Output</th>
                  <th className={styles.numeric} scope="col">Cache read</th>
                  <th className={styles.numeric} scope="col">Cache write</th>
                </tr>
              </thead>
              <tbody>
                {group.buckets.map((bucket) => (
                  <tr key={`${bucket.period}-${bucket.currency}-${bucket.usageUnit}`}>
                    <th scope="row">{bucket.period}</th>
                    <td className={styles.numeric}>{formatUsageMicros(bucket.usage.input.quantityMicros)}</td>
                    <td className={styles.numeric}>{formatUsageMicros(bucket.usage.output.quantityMicros)}</td>
                    <td className={styles.numeric}>{formatUsageMicros(bucket.usage.cache_read.quantityMicros)}</td>
                    <td className={styles.numeric}>{formatUsageMicros(bucket.usage.cache_write.quantityMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </FinopsSheetBlock>
      ))}

      {groups.map((group) => (
        <FinopsSheetBlock
          description={`Share of compatible input-token evidence in ${group.usageUnit} for ${group.currency}. A missing class or non-positive quantity withholds the ratio.`}
          key={`ratio-${group.currency}-${group.usageUnit}`}
          title="Amazon Bedrock Tokens Cache Read and Cache Write Ratio"
        >
          <TimeSeriesChart
            ariaLabel={`Amazon Bedrock cache read and cache write ratio for ${group.currency} ${group.usageUnit}`}
            formatValue={formatPercent}
            mode="line"
            series={[
              {
                id: "cache-read-ratio",
                label: "Cache read ratio",
                points: group.buckets.map((bucket) => ({
                  label: bucket.period,
                  value: basisPointsToPercent(bucket.cacheReadRatioBasisPoints),
                })),
              },
              {
                id: "cache-write-ratio",
                label: "Cache write ratio",
                points: group.buckets.map((bucket) => ({
                  label: bucket.period,
                  value: basisPointsToPercent(bucket.cacheWriteRatioBasisPoints),
                })),
              },
            ]}
          />
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col">Evidence status</th>
                  <th className={styles.numeric} scope="col">Read ratio</th>
                  <th className={styles.numeric} scope="col">Write ratio</th>
                </tr>
              </thead>
              <tbody>
                {group.buckets.map((bucket) => (
                  <tr key={`${bucket.period}-${bucket.currency}-${bucket.usageUnit}`}>
                    <th scope="row">{bucket.period}</th>
                    <td>{bucket.ratioUnavailableReason === null
                      ? <StateBadge state={bucket.ratioStatus} />
                      : bucket.ratioUnavailableReason.replace(/_/gu, " ")}</td>
                    <td className={styles.numeric}>{formatBasisPoints(bucket.cacheReadRatioBasisPoints)}</td>
                    <td className={styles.numeric}>{formatBasisPoints(bucket.cacheWriteRatioBasisPoints)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </FinopsSheetBlock>
      ))}

      <FinopsSheetBlock
        description="The canonical rows do not provide an authoritative compatible uncached input-token rate, so this value is not inferred."
        title="Bedrock Cache Cost Savings % — withheld"
      >
        <p className={styles.goalMeta}>
          {evidence.cacheCostSavings.reason.replace(/_/gu, " ")}.
        </p>
      </FinopsSheetBlock>
    </div>
  );
}

/** Taxonomy explorer: the four official ranking dimensions plus drilldown reach. */
function TaxonomySheet({ report }: { readonly report: CudosReport }) {
  const basis = report.selectedCostBasis;
  const dimensions = [
    { key: "accounts", label: "Accounts", entries: report.rankings.accounts },
    { key: "services", label: "Services", entries: report.rankings.services },
    { key: "regions", label: "Regions", entries: report.rankings.regions },
    { key: "serviceCategories", label: "FOCUS service categories", entries: report.rankings.serviceCategories },
  ] as const;

  return (
    <div className={styles.blocks}>
      {dimensions.map((dimension) => {
        const currency = dimension.entries[0]?.currency ?? null;
        return (
          <FinopsSheetBlock key={dimension.key} title={`Top ${dimension.label.toLowerCase()}`}>
            {currency === null ? (
              <NoEvidence reason={`No ${dimension.label.toLowerCase()} ranking is present in the active generation.`} />
            ) : (
              <RankingBars
                ariaLabel={`Top ${dimension.label.toLowerCase()} by ${basis} cost in ${currency}`}
                formatValue={(value) => formatUnits(value, currency)}
                items={dimension.entries.flatMap((entry) => {
                  const units = microsToUnits(entry.selectedTotalMicros);
                  return units === null ? [] : [{
                    id: `${entry.rank}-${entry.value ?? "unknown"}`,
                    label: entry.label ?? entry.value ?? "Dimension not supplied",
                    value: units,
                    detail: `Rank ${entry.rank} · ${formatCount(entry.lineCount)} lines`,
                  }];
                })}
              />
            )}
          </FinopsSheetBlock>
        );
      })}

      <FinopsSheetBlock
        description="How far the active generation can be drilled into. A missing dimension limits the official sheet rather than being treated as absent cost."
        title="Drilldown reach"
      >
        <div className={styles.tiles}>
          <Tile label="Lines in scope" value={formatCount(report.drilldowns.lineCount)} />
          {([
            ["Resource", report.drilldowns.resource],
            ["Hourly", report.drilldowns.hourly],
            ["Resource + hourly", report.drilldowns.resourceHourly],
          ] as const).map(([label, availability]) => (
            <Tile
              detail={`${formatCount(availability.availableLineCount)} available · ${formatCount(availability.missingLineCount)} missing`}
              key={label}
              label={label}
              value={availability.status}
            />
          ))}
        </div>
      </FinopsSheetBlock>
    </div>
  );
}

/** OPTICS explorer: exact unit-cost metrics. */
function UnitCostSheet({ report }: { readonly report: CudosReport }) {
  const { metrics, totalMetrics, truncated, invariant } = report.unitCosts;
  if (metrics.length === 0) {
    return <NoEvidence reason="No unit-cost metric could be formed: a metric needs both a cost on the selected basis and a positive usage quantity." />;
  }
  return (
    <FinopsSheetBlock
      description={`${formatCount(totalMetrics)} metrics formed${truncated ? ", list truncated" : ""}. Invariant: ${invariant.replace(/_/gu, " ")}.`}
      title="Unit cost by service and usage unit"
    >
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption>
            Ratios are exact rationals of cost micro-units per usage unit. Sutra does not round
            them, and a metric with no positive usage quantity states its reason instead.
          </caption>
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col">Usage unit</th>
              <th scope="col">Currency</th>
              <th className={styles.numeric} scope="col">Cost</th>
              <th className={styles.numeric} scope="col">Usage micros</th>
              <th className={styles.numeric} scope="col">Lines</th>
              <th scope="col">Availability</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((metric) => (
              <tr key={`${metric.currency}-${metric.service}-${metric.usageUnit}`}>
                <th scope="row">{metric.service}</th>
                <td>{metric.usageUnit}</td>
                <td>{metric.currency}</td>
                <td className={styles.numeric}>
                  {formatMicrosExact(metric.cost.totalMicros, metric.currency)}
                </td>
                <td className={styles.numeric}>{metric.usageQuantityMicros}</td>
                <td className={styles.numeric}>{formatCount(metric.lineCount)}</td>
                <td>
                  {metric.unavailableReason === null
                    ? <StateBadge state={metric.cost.coverage} />
                    : metric.unavailableReason.replace(/_/gu, " ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </FinopsSheetBlock>
  );
}

/** About: lineage, opportunities and the disclaimer that governs them. */
function AboutSheet({ report }: { readonly report: CudosReport }) {
  const { estimates, totalCandidates, truncated, disclaimer } = report.opportunities;
  return (
    <div className={styles.blocks}>
      <FinopsSheetBlock title="Active generation lineage">
        <div className={styles.tiles}>
          <Tile label="Billing period" value={report.evidence.billingPeriod} />
          <Tile label="Lines in generation" value={formatCount(report.evidence.activeLineCount)} />
          <Tile label="Currencies" value={report.evidence.currencies.join(", ") || "Not available"} />
          <Tile label="Selected cost basis" value={report.selectedCostBasis} />
        </div>
        <p className={styles.goalMeta}>
          Export {report.evidence.exportName} · generation {report.evidence.generationId}
          {report.evidence.sourceFormats.length === 0
            ? ""
            : ` · formats ${report.evidence.sourceFormats.join(", ")}`}
        </p>
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description={disclaimer}
        title={`Review candidates (${formatCount(totalCandidates)})${truncated ? " — truncated" : ""}`}
      >
        {estimates.length === 0 ? (
          <NoEvidence reason="No CUR-derived review candidate was observed in the active generation." />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>
                These are observed billing patterns requiring review, never savings, compatibility
                or remediation claims.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Rule</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Service</th>
                  <th className={styles.numeric} scope="col">Observed exposure</th>
                  <th scope="col">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {estimates.map((estimate, index) => (
                  <tr key={`${estimate.ruleId}-${estimate.subjectId}-${index}`}>
                    <th scope="row">{estimate.ruleId.replace(/_/gu, " ")}</th>
                    <td>{estimate.subjectType}: {estimate.subjectId}</td>
                    <td>{estimate.service}</td>
                    <td className={styles.numeric}>
                      {formatMicrosExact(estimate.estimate.totalMicros, estimate.currency)}
                    </td>
                    <td>{estimate.confidence}</td>
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
 * One sheet's content. Exported so every sheet can be rendered and asserted
 * directly, without driving the fetch lifecycle.
 */
export function FinopsCudosSheetContent({
  report, sheet,
}: { readonly report: CudosReport; readonly sheet: FinopsSheetDescriptor }) {
  const moduleIds = SHEET_MODULES[sheet.key];
  if (sheet.key === "ai-ml" && moduleIds !== undefined) {
    return (
      <div className={styles.blocks}>
        <ModuleSheet moduleIds={moduleIds} report={report} sheet={sheet} />
        <BedrockTokensSheet report={report} />
      </div>
    );
  }
  if (moduleIds !== undefined) {
    return <ModuleSheet moduleIds={moduleIds} report={report} sheet={sheet} />;
  }
  switch (sheet.key) {
    case "executive-billing-summary": return <BillingSummarySheet report={report} />;
    case "executive-ri-sp-summary": return <CommitmentsSheet report={report} />;
    case "executive-trends": return <TrendsSheet report={report} />;
    case "taxonomy-explorer": return <TaxonomySheet report={report} />;
    case "optics-explorer": return <UnitCostSheet report={report} />;
    case "about": return <AboutSheet report={report} />;
    default:
      return (
        <NoEvidence
          reason={`Sutra has no canonical projection for the official sheet "${sheet.name}". The sheet is listed because AWS publishes it; it is not presented as delivered.`}
        />
      );
  }
}

/**
 * Presentation for a loaded CUDOS report: source evidence, the nineteen official
 * sheet tabs and the active sheet. Takes the envelope directly so it can be
 * rendered from a test or a server-side snapshot without any fetching.
 */
export function FinopsCudosSheets({
  envelope, initialSheetKey,
}: {
  readonly envelope: { readonly report: unknown; readonly sourceEvidence: FoundationalSourceEvidence | null };
  readonly initialSheetKey?: string;
}) {
  const [sheetKey, setSheetKey] = useState<string>(
    initialSheetKey ?? FINOPS_CUDOS_SHEETS.sheets[0]!.key,
  );
  const sheet = useMemo(
    () => FINOPS_CUDOS_SHEETS.sheets.find((entry) => entry.key === sheetKey)
      ?? FINOPS_CUDOS_SHEETS.sheets[0]!,
    [sheetKey],
  );

  const report = envelope.report;
  if (report === null || typeof report !== "object" || (report as CudosReport).ok !== true) {
    return null;
  }
  const ready = report as CudosReport;

  return (
    <>
      <EvidenceStrip
        basis={ready.selectedCostBasis}
        currencies={ready.evidence.currencies}
        evidence={envelope.sourceEvidence}
        title="CUDOS source evidence"
      />
      <FinopsSheetShell
        activeKey={sheet.key}
        idPrefix="cudos"
        inventory={FINOPS_CUDOS_SHEETS}
        onSelectSheet={setSheetKey}
      >
        <FinopsCudosSheetContent report={ready} sheet={sheet} />
      </FinopsSheetShell>
    </>
  );
}

export function FinopsCudosDashboard({ connectionId }: { readonly connectionId: string | null }) {
  const { state, reload } = useCudosEndpoint(connectionId);
  const envelope = state.status === "ready" && "envelope" in state ? state.envelope : null;

  return (
    <section aria-label="CUDOS dashboard" className={styles.shell}>
      <EndpointBoundary onRetry={reload} state={state} title="the CUDOS dashboard" />
      {envelope === null ? null : <FinopsCudosSheets envelope={envelope} />}
    </section>
  );
}

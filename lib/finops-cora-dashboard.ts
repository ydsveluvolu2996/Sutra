/** Native, presentation-safe CORA projection over an accepted snapshot. */
import type { CoraSnapshot } from "./finops-cora.ts";

export const CORA_DASHBOARD_BOUNDS = Object.freeze({
  maximumRows: 500,
  maximumHistoryPoints: 30,
  maximumFilterValues: 1_000,
} as const);

export interface CoraDashboardFilters {
  readonly accountId: string | null;
  readonly optimizationClass: CoraSnapshot["recommendations"][number]["optimizationClass"] | null;
  readonly actionType: CoraSnapshot["recommendations"][number]["actionType"] | null;
  readonly region: string | null;
  readonly implementationEffort: CoraSnapshot["recommendations"][number]["implementationEffort"] | null;
  readonly workflowStatus: CoraSnapshot["recommendations"][number]["workflow"]["status"] | null;
  readonly currencyCode: string | null;
  readonly tagKey: string | null;
  readonly tagValue: string | null;
  readonly resourceId: string | null;
  readonly restartNeeded: boolean | null;
  readonly rollbackPossible: boolean | null;
  readonly excludeFinopsExceptions: boolean;
}

export interface CoraDashboardOpportunitySummary {
  readonly optimizationClass: CoraSnapshot["recommendations"][number]["optimizationClass"];
  readonly currencyCode: string;
  readonly rawRecommendationCount: number;
  readonly deduplicatedActionCount: number;
  readonly distinctResourceCount: number;
  readonly recommendationsWithoutResourceId: number;
  readonly estimatedMonthlySavingsBeforeDiscountMicros: string;
  readonly estimatedMonthlySavingsAfterDiscountMicros: string | null;
  readonly aggregationMeaning: "MAX_RECOMMENDATION_PER_RESOURCE_WITHIN_OPTIMIZATION_CLASS_MISSING_RESOURCE_IDS_UNDEDUPLICATED";
}

export interface CoraOfficialSheetCoverage {
  readonly sheet: "Summary" | "Usage Optimization" | "Rate Optimization - Saving Plans"
    | "Rate Optimization - Reserved Instances" | "About";
  readonly status: "IMPLEMENTED" | "PARTIAL";
  readonly localEvidence: string;
  readonly limitation: string | null;
}

export interface CoraDashboardHistoryPoint {
  readonly generationId: string;
  readonly collectedAtIso: string;
  readonly dataThroughAtIso: string | null;
  readonly sourceState: CoraSnapshot["state"];
  readonly recommendationCount: number;
  readonly summaries: CoraSnapshot["summaries"];
}

export interface CoraDashboardRow {
  readonly trackingKey: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly optimizationClass: CoraSnapshot["recommendations"][number]["optimizationClass"];
  readonly actionType: CoraSnapshot["recommendations"][number]["actionType"];
  readonly region: string;
  readonly currencyCode: string;
  readonly implementationEffort: CoraSnapshot["recommendations"][number]["implementationEffort"];
  readonly currentResourceType: string | null;
  readonly recommendedResourceType: string | null;
  readonly currentResourceSummary: string | null;
  readonly recommendedResourceSummary: string | null;
  readonly resourceId: string | null;
  readonly resourceArn: string | null;
  readonly restartNeeded: boolean;
  readonly rollbackPossible: boolean;
  readonly recommendationSource: string;
  readonly recommendationLookbackPeriodInDays: number;
  readonly lastRefreshTimestamp: string;
  readonly estimates: CoraSnapshot["recommendations"][number]["estimates"];
  readonly tags: CoraSnapshot["recommendations"][number]["tags"];
  readonly workflow: {
    readonly status: CoraSnapshot["recommendations"][number]["workflow"]["status"];
    readonly ownerPrincipalId: string | null;
    readonly externalTicketId: string | null;
    readonly updatedAt: string;
  };
  readonly observedCostEvidenceCount: number;
  readonly commitmentDimensions: CoraSnapshot["recommendations"][number]["commitmentDimensions"];
}

export interface CoraCommitmentMatrixRow {
  readonly actionType: "PurchaseSavingsPlans" | "PurchaseReservedInstances";
  readonly currencyCode: string;
  readonly level: "PAYER" | "LINKED" | "UNKNOWN";
  readonly term: "ONE_YEAR" | "THREE_YEARS" | "UNKNOWN";
  readonly upfront: "NO_UPFRONT" | "PARTIAL_UPFRONT" | "ALL_UPFRONT" | "UNKNOWN";
  readonly offeringType: string;
  readonly service: string;
  readonly deduplicatedActionCount: number;
  readonly estimatedMonthlySavingsBeforeDiscountMicros: string;
  readonly estimatedMonthlySavingsAfterDiscountMicros: string | null;
  readonly aggregationMeaning: "RESOURCE_SAFE_MAX_RECOMMENDATION_THEN_OPTION_MATRIX_SUM";
}

export interface CoraDashboardProjection {
  readonly schema: "sutra.finops-cora-dashboard.v1";
  readonly filters: CoraDashboardFilters;
  readonly filterOptions: {
    readonly accounts: readonly { readonly id: string; readonly name: string }[];
    readonly optimizationClasses: readonly string[];
    readonly actionTypes: readonly string[];
    readonly regions: readonly string[];
    readonly implementationEfforts: readonly string[];
    readonly workflowStatuses: readonly string[];
    readonly currencies: readonly string[];
    readonly tagKeys: readonly string[];
  };
  readonly resultCount: number;
  readonly rowsTruncated: boolean;
  readonly rows: readonly CoraDashboardRow[];
  readonly summaries: CoraSnapshot["summaries"];
  readonly opportunitySummaries: readonly CoraDashboardOpportunitySummary[];
  readonly commitmentMatrices: readonly CoraCommitmentMatrixRow[];
  readonly officialSheetCoverage: readonly CoraOfficialSheetCoverage[];
  readonly history: readonly CoraDashboardHistoryPoint[];
}

function distinct(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort().slice(0, CORA_DASHBOARD_BOUNDS.maximumFilterValues);
}

function sum(left: string, right: string): string {
  return (BigInt(left) + BigInt(right)).toString();
}

function summaries(
  rows: readonly CoraSnapshot["recommendations"][number][],
): CoraSnapshot["summaries"] {
  const groups = new Map<string, CoraSnapshot["summaries"][number]>();
  for (const row of rows) {
    const key = `${row.optimizationClass}:${row.estimates.currencyCode}`;
    const current = groups.get(key);
    if (current === undefined) {
      groups.set(key, {
        optimizationClass: row.optimizationClass,
        currencyCode: row.estimates.currencyCode,
        recommendationCount: 1,
        estimatedMonthlyCostBeforeDiscountMicros: row.estimates.monthlyCostBeforeDiscountMicros,
        estimatedMonthlyCostAfterDiscountMicros: row.estimates.monthlyCostAfterDiscountMicros,
        estimatedMonthlySavingsBeforeDiscountMicros: row.estimates.monthlySavingsBeforeDiscountMicros,
        estimatedMonthlySavingsAfterDiscountMicros: row.estimates.monthlySavingsAfterDiscountMicros,
        aggregationMeaning: "NON_DEDUPLICATED_ROW_SUM_NOT_A_PORTFOLIO_SAVINGS_CLAIM",
      });
      continue;
    }
    groups.set(key, {
      ...current,
      recommendationCount: current.recommendationCount + 1,
      estimatedMonthlyCostBeforeDiscountMicros: sum(
        current.estimatedMonthlyCostBeforeDiscountMicros,
        row.estimates.monthlyCostBeforeDiscountMicros,
      ),
      estimatedMonthlyCostAfterDiscountMicros:
        current.estimatedMonthlyCostAfterDiscountMicros === null
        || row.estimates.monthlyCostAfterDiscountMicros === null
          ? null
          : sum(current.estimatedMonthlyCostAfterDiscountMicros, row.estimates.monthlyCostAfterDiscountMicros),
      estimatedMonthlySavingsBeforeDiscountMicros: sum(
        current.estimatedMonthlySavingsBeforeDiscountMicros,
        row.estimates.monthlySavingsBeforeDiscountMicros,
      ),
      estimatedMonthlySavingsAfterDiscountMicros:
        current.estimatedMonthlySavingsAfterDiscountMicros === null
        || row.estimates.monthlySavingsAfterDiscountMicros === null
          ? null
          : sum(current.estimatedMonthlySavingsAfterDiscountMicros, row.estimates.monthlySavingsAfterDiscountMicros),
    });
  }
  return [...groups.values()].sort((left, right) =>
    left.optimizationClass.localeCompare(right.optimizationClass)
    || left.currencyCode.localeCompare(right.currencyCode));
}

function savingsForOrdering(
  row: CoraSnapshot["recommendations"][number],
): bigint {
  return BigInt(row.estimates.monthlySavingsAfterDiscountMicros
    ?? row.estimates.monthlySavingsBeforeDiscountMicros);
}

function deduplicatedRows(
  rows: readonly CoraSnapshot["recommendations"][number][],
): readonly CoraSnapshot["recommendations"][number][] {
  const selected = new Map<string, CoraSnapshot["recommendations"][number]>();
  for (const row of rows) {
    const identity = row.resourceId === null
      ? `missing:${row.trackingKey}`
      : `resource:${row.accountId}:${row.region}:${row.resourceId}`;
    const key = `${row.optimizationClass}:${row.estimates.currencyCode}:${identity}`;
    const current = selected.get(key);
    if (current === undefined
      || savingsForOrdering(row) > savingsForOrdering(current)
      || (savingsForOrdering(row) === savingsForOrdering(current)
        && row.trackingKey.localeCompare(current.trackingKey) < 0)) selected.set(key, row);
  }
  return [...selected.values()];
}

/**
 * AWS CORA removes duplicate recommendations by resource ID independently for
 * Usage and Rate. Account, Region, and currency are included in the key so a
 * provider-local resource identifier cannot collide across scopes. Rows with no
 * resource ID remain separate because collapsing them would invent identity.
 */
function deduplicatedOpportunitySummaries(
  rows: readonly CoraSnapshot["recommendations"][number][],
): readonly CoraDashboardOpportunitySummary[] {
  const selected = deduplicatedRows(rows);

  const grouped = new Map<string, CoraDashboardOpportunitySummary>();
  const rawCounts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.optimizationClass}:${row.estimates.currencyCode}`;
    rawCounts.set(key, (rawCounts.get(key) ?? 0) + 1);
  }
  for (const row of selected) {
    const key = `${row.optimizationClass}:${row.estimates.currencyCode}`;
    const current = grouped.get(key);
    const hasResource = row.resourceId !== null;
    if (current === undefined) {
      grouped.set(key, {
        optimizationClass: row.optimizationClass,
        currencyCode: row.estimates.currencyCode,
        rawRecommendationCount: rawCounts.get(key) ?? 1,
        deduplicatedActionCount: 1,
        distinctResourceCount: hasResource ? 1 : 0,
        recommendationsWithoutResourceId: hasResource ? 0 : 1,
        estimatedMonthlySavingsBeforeDiscountMicros: row.estimates.monthlySavingsBeforeDiscountMicros,
        estimatedMonthlySavingsAfterDiscountMicros: row.estimates.monthlySavingsAfterDiscountMicros,
        aggregationMeaning: "MAX_RECOMMENDATION_PER_RESOURCE_WITHIN_OPTIMIZATION_CLASS_MISSING_RESOURCE_IDS_UNDEDUPLICATED",
      });
      continue;
    }
    grouped.set(key, {
      ...current,
      deduplicatedActionCount: current.deduplicatedActionCount + 1,
      distinctResourceCount: current.distinctResourceCount + (hasResource ? 1 : 0),
      recommendationsWithoutResourceId: current.recommendationsWithoutResourceId + (hasResource ? 0 : 1),
      estimatedMonthlySavingsBeforeDiscountMicros: sum(
        current.estimatedMonthlySavingsBeforeDiscountMicros,
        row.estimates.monthlySavingsBeforeDiscountMicros,
      ),
      estimatedMonthlySavingsAfterDiscountMicros:
        current.estimatedMonthlySavingsAfterDiscountMicros === null
        || row.estimates.monthlySavingsAfterDiscountMicros === null
          ? null
          : sum(current.estimatedMonthlySavingsAfterDiscountMicros, row.estimates.monthlySavingsAfterDiscountMicros),
    });
  }
  return [...grouped.values()].sort((left, right) =>
    left.optimizationClass.localeCompare(right.optimizationClass)
    || left.currencyCode.localeCompare(right.currencyCode));
}

function commitmentMatrices(
  rows: readonly CoraSnapshot["recommendations"][number][],
): readonly CoraCommitmentMatrixRow[] {
  const groups = new Map<string, CoraCommitmentMatrixRow>();
  for (const row of deduplicatedRows(rows)) {
    const dimensions = row.commitmentDimensions;
    if (dimensions == null || (row.actionType !== "PurchaseSavingsPlans"
      && row.actionType !== "PurchaseReservedInstances")) continue;
    const key = [row.actionType, row.estimates.currencyCode, dimensions.level,
      dimensions.term, dimensions.upfront, dimensions.offeringType, dimensions.service].join(":");
    const current = groups.get(key);
    if (current === undefined) {
      groups.set(key, {
        actionType: row.actionType,
        currencyCode: row.estimates.currencyCode,
        level: dimensions.level,
        term: dimensions.term,
        upfront: dimensions.upfront,
        offeringType: dimensions.offeringType,
        service: dimensions.service,
        deduplicatedActionCount: 1,
        estimatedMonthlySavingsBeforeDiscountMicros: row.estimates.monthlySavingsBeforeDiscountMicros,
        estimatedMonthlySavingsAfterDiscountMicros: row.estimates.monthlySavingsAfterDiscountMicros,
        aggregationMeaning: "RESOURCE_SAFE_MAX_RECOMMENDATION_THEN_OPTION_MATRIX_SUM",
      });
      continue;
    }
    groups.set(key, {
      ...current,
      deduplicatedActionCount: current.deduplicatedActionCount + 1,
      estimatedMonthlySavingsBeforeDiscountMicros: sum(
        current.estimatedMonthlySavingsBeforeDiscountMicros,
        row.estimates.monthlySavingsBeforeDiscountMicros,
      ),
      estimatedMonthlySavingsAfterDiscountMicros:
        current.estimatedMonthlySavingsAfterDiscountMicros === null
        || row.estimates.monthlySavingsAfterDiscountMicros === null ? null
          : sum(current.estimatedMonthlySavingsAfterDiscountMicros,
            row.estimates.monthlySavingsAfterDiscountMicros),
    });
  }
  return [...groups.values()].sort((left, right) => left.actionType.localeCompare(right.actionType)
    || left.currencyCode.localeCompare(right.currencyCode)
    || left.service.localeCompare(right.service) || left.offeringType.localeCompare(right.offeringType)
    || left.level.localeCompare(right.level) || left.term.localeCompare(right.term)
    || left.upfront.localeCompare(right.upfront));
}

function hasFinopsException(row: CoraSnapshot["recommendations"][number]): boolean {
  return row.tags.some((tag) => tag.key.toLowerCase() === "finopsexception");
}

const OFFICIAL_SHEET_COVERAGE: readonly CoraOfficialSheetCoverage[] = Object.freeze([
  { sheet: "Summary", status: "PARTIAL", localEvidence: "Resource-deduplicated usage/rate opportunity summaries, raw counts, action details, filters, export and history", limitation: "The official scatter, Sankey, pivot, pie and calculated GroupBy visual geometry is not reproduced one-for-one." },
  { sheet: "Usage Optimization", status: "PARTIAL", localEvidence: "Rightsize, idle/stop, delete, scale-in, upgrade, and migration actions with resource drilldown", limitation: "The official pie, pivot, bar and arbitrary GroupBy interaction tree is not reproduced one-for-one." },
  { sheet: "Rate Optimization - Saving Plans", status: "IMPLEMENTED", localEvidence: "Resource-safe Savings Plans level, term, upfront, type and service matrices derived from the pinned v0.0.11 contract", limitation: null },
  { sheet: "Rate Optimization - Reserved Instances", status: "IMPLEMENTED", localEvidence: "Resource-safe Reserved Instance service, level, term, upfront and offering matrices derived from the pinned v0.0.11 contract", limitation: null },
  { sheet: "About", status: "IMPLEMENTED", localEvidence: "Freshness, coverage, generation lineage, limitations, and estimate disclosures", limitation: null },
]);

export function buildCoraDashboardProjection(
  snapshot: CoraSnapshot,
  history: readonly CoraDashboardHistoryPoint[],
  filters: CoraDashboardFilters,
): CoraDashboardProjection {
  const source = snapshot.recommendations;
  const accounts = new Map<string, string>();
  for (const row of source) accounts.set(row.accountId, row.accountName);
  const matched = source.filter((row) =>
    (filters.accountId === null || row.accountId === filters.accountId)
    && (filters.optimizationClass === null || row.optimizationClass === filters.optimizationClass)
    && (filters.actionType === null || row.actionType === filters.actionType)
    && (filters.region === null || row.region === filters.region)
    && (filters.implementationEffort === null || row.implementationEffort === filters.implementationEffort)
    && (filters.workflowStatus === null || row.workflow.status === filters.workflowStatus)
    && (filters.currencyCode === null || row.currencyCode === filters.currencyCode)
    && (filters.resourceId === null || row.resourceId === filters.resourceId)
    && (filters.restartNeeded === null || row.restartNeeded === filters.restartNeeded)
    && (filters.rollbackPossible === null || row.rollbackPossible === filters.rollbackPossible)
    && (!filters.excludeFinopsExceptions || !hasFinopsException(row))
    && (filters.tagKey === null || row.tags.some((tag) =>
      tag.key === filters.tagKey && (filters.tagValue === null || tag.value === filters.tagValue))));
  const ordered = [...matched].sort((left, right) => {
    const savings = savingsForOrdering(right) - savingsForOrdering(left);
    return savings > BigInt(0) ? 1
      : savings < BigInt(0) ? -1
        : left.trackingKey.localeCompare(right.trackingKey);
  });
  return {
    schema: "sutra.finops-cora-dashboard.v1",
    filters,
    filterOptions: {
      accounts: [...accounts.entries()].sort((left, right) => left[1].localeCompare(right[1]))
        .slice(0, CORA_DASHBOARD_BOUNDS.maximumFilterValues)
        .map(([id, name]) => ({ id, name })),
      optimizationClasses: distinct(source.map((row) => row.optimizationClass)),
      actionTypes: distinct(source.map((row) => row.actionType)),
      regions: distinct(source.map((row) => row.region)),
      implementationEfforts: distinct(source.map((row) => row.implementationEffort)),
      workflowStatuses: distinct(source.map((row) => row.workflow.status)),
      currencies: distinct(source.map((row) => row.currencyCode)),
      tagKeys: distinct(source.flatMap((row) => row.tags.map((tag) => tag.key))),
    },
    resultCount: ordered.length,
    rowsTruncated: ordered.length > CORA_DASHBOARD_BOUNDS.maximumRows,
    rows: ordered.slice(0, CORA_DASHBOARD_BOUNDS.maximumRows).map((row) => ({
      trackingKey: row.trackingKey,
      accountId: row.accountId,
      accountName: row.accountName,
      optimizationClass: row.optimizationClass,
      actionType: row.actionType,
      region: row.region,
      currencyCode: row.currencyCode,
      implementationEffort: row.implementationEffort,
      currentResourceType: row.currentResourceType,
      recommendedResourceType: row.recommendedResourceType,
      currentResourceSummary: row.currentResourceSummary,
      recommendedResourceSummary: row.recommendedResourceSummary,
      resourceId: row.resourceId,
      resourceArn: row.resourceArn,
      restartNeeded: row.restartNeeded,
      rollbackPossible: row.rollbackPossible,
      recommendationSource: row.recommendationSource,
      recommendationLookbackPeriodInDays: row.recommendationLookbackPeriodInDays,
      lastRefreshTimestamp: row.lastRefreshTimestamp,
      estimates: row.estimates,
      tags: row.tags,
      workflow: {
        status: row.workflow.status,
        ownerPrincipalId: row.workflow.ownerPrincipalId,
        externalTicketId: row.workflow.externalTicketId,
        updatedAt: row.workflow.updatedAt,
      },
      observedCostEvidenceCount: row.observedCosts.length,
      commitmentDimensions: row.commitmentDimensions,
    })),
    summaries: summaries(matched),
    opportunitySummaries: deduplicatedOpportunitySummaries(matched),
    commitmentMatrices: commitmentMatrices(matched),
    officialSheetCoverage: OFFICIAL_SHEET_COVERAGE,
    history: history.slice(0, CORA_DASHBOARD_BOUNDS.maximumHistoryPoints),
  };
}

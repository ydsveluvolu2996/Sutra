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
    && (filters.tagKey === null || row.tags.some((tag) =>
      tag.key === filters.tagKey && (filters.tagValue === null || tag.value === filters.tagValue))));
  const ordered = [...matched].sort((left, right) => {
    const savings = BigInt(right.estimates.monthlySavingsAfterDiscountMicros
      ?? right.estimates.monthlySavingsBeforeDiscountMicros)
      - BigInt(left.estimates.monthlySavingsAfterDiscountMicros
        ?? left.estimates.monthlySavingsBeforeDiscountMicros);
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
    })),
    summaries: summaries(matched),
    history: history.slice(0, CORA_DASHBOARD_BOUNDS.maximumHistoryPoints),
  };
}

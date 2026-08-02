import type {
  GravitonInstanceMappingRow,
  GravitonOpportunity,
  GravitonOpportunityState,
  GravitonResourceType,
  GravitonSavingsSnapshot,
} from "./finops-graviton-savings.ts";

export interface GravitonDashboardFilters {
  readonly accountId?: string;
  readonly region?: string;
  readonly resourceType?: GravitonResourceType;
  readonly state?: GravitonOpportunityState;
  readonly currency?: string;
  readonly migrationEffort?: GravitonOpportunity["migrationEffort"];
  readonly recommendationAuthority?: GravitonOpportunity["recommendationAuthority"];
  readonly architecture?: "X86_64" | "ARM64";
  readonly operatingSystem?: string;
  readonly purchaseOption?: "ON_DEMAND";
  readonly priceListVersion?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
function total(values: readonly string[]): string {
  return values.reduce((sum, value) => sum + BigInt(value), BigInt(0)).toString();
}
function matchesResource(item: { readonly accountId: string; readonly region: string; readonly resourceType: GravitonResourceType }, filters: GravitonDashboardFilters): boolean {
  return (filters.accountId === undefined || item.accountId === filters.accountId)
    && (filters.region === undefined || item.region === filters.region)
    && (filters.resourceType === undefined || item.resourceType === filters.resourceType);
}
function matchesMapping(item: GravitonInstanceMappingRow, filters: GravitonDashboardFilters): boolean {
  return (filters.region === undefined || item.region === filters.region)
    && (filters.resourceType === undefined || item.resourceType === filters.resourceType)
    && (filters.currency === undefined || item.currency === filters.currency)
    && (filters.architecture === undefined || item.architecture === filters.architecture)
    && (filters.operatingSystem === undefined || item.operatingSystem === filters.operatingSystem)
    && (filters.purchaseOption === undefined || item.purchaseOption === filters.purchaseOption)
    && (filters.priceListVersion === undefined || item.priceListVersion === filters.priceListVersion);
}
function mappingFiltersSelected(filters: GravitonDashboardFilters): boolean {
  return filters.architecture !== undefined || filters.operatingSystem !== undefined
    || filters.purchaseOption !== undefined || filters.priceListVersion !== undefined;
}
function mappingAppliesToOpportunity(item: GravitonOpportunity, mapping: readonly GravitonInstanceMappingRow[], filters: GravitonDashboardFilters): boolean {
  if (!mappingFiltersSelected(filters)) return true;
  return mapping.some((row) => row.resourceType === item.resourceType && row.region === item.region
    && ((row.role === "CURRENT" && row.configuration === item.currentConfiguration)
      || (row.role === "TARGET" && row.configuration === item.targetConfiguration))
    && matchesMapping(row, filters));
}
function period(items: readonly GravitonOpportunity[], kind: "potential" | "realized") {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    if (kind === "potential") {
      const value = item.potentialSavings; if (value === null) continue;
      const key = `${value.periodStartAt}|${value.periodEndAt}|${value.savings.currency}`;
      groups.set(key, [...(groups.get(key) ?? []), value.savings.amountMicros]);
    } else {
      const value = item.realizedSavings; if (value === null) continue;
      const key = `${value.measurementPeriodStartAt}|${value.measurementPeriodEndAt}|${value.observedSavings.currency}`;
      groups.set(key, [...(groups.get(key) ?? []), value.observedSavings.amountMicros]);
    }
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => {
    const [periodStartAt, periodEndAt, currency] = key.split("|") as [string, string, string];
    return { periodStartAt, periodEndAt, currency, amountMicros: total(values) };
  });
}
export function buildGravitonDashboard(snapshot: GravitonSavingsSnapshot, filters: GravitonDashboardFilters = {}) {
  const limit = filters.limit ?? 100, cursor = filters.cursor ?? "";
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500
    || (cursor !== "" && !/^v1:(?:0|[1-9]\d{0,7})$/u.test(cursor))) throw new Error("INVALID_GRAVITON_QUERY");
  const sourceMapping = snapshot.instanceMapping ?? [];
  const mapping = sourceMapping.filter((item) => matchesMapping(item, filters));
  const all = snapshot.opportunities.filter((item) => matchesResource(item, filters)
    && (filters.state === undefined || item.state === filters.state)
    && (filters.currency === undefined || item.potentialSavings?.savings.currency === filters.currency
      || item.providerEstimate?.savings.currency === filters.currency || item.realizedSavings?.observedSavings.currency === filters.currency)
    && (filters.migrationEffort === undefined || item.migrationEffort === filters.migrationEffort)
    && (filters.recommendationAuthority === undefined || item.recommendationAuthority === filters.recommendationAuthority)
    && mappingAppliesToOpportunity(item, sourceMapping, filters));
  const offset = cursor === "" ? 0 : Number(cursor.slice(3));
  if (!Number.isSafeInteger(offset) || offset > all.length) throw new Error("INVALID_GRAVITON_QUERY");
  const opportunities = all.slice(offset, offset + limit);
  const nextCursor = offset + opportunities.length < all.length ? `v1:${offset + opportunities.length}` : null;
  const usage = snapshot.currentUsage.filter((item) => matchesResource(item, filters)
    && (filters.currency === undefined || item.currency === filters.currency)
    && (filters.architecture === undefined || item.architecture === filters.architecture));
  const currencies = [...new Set([...usage.map((item) => item.currency), ...all.flatMap((item) =>
    [item.potentialSavings?.savings.currency, item.realizedSavings?.observedSavings.currency]
      .filter((value): value is string => value !== undefined))])].sort();
  const types = [...new Set([...usage.map((item) => item.resourceType), ...all.map((item) => item.resourceType)])].sort();
  return {
    schema: "sutra.finops-graviton-dashboard.v1" as const, state: snapshot.state, filters,
    resultCount: all.length, opportunities, nextCursor, instanceMapping: mapping,
    summary: { ...snapshot.summary, resources: all.length,
      ready: all.filter((item) => item.state === "READY").length,
      reviewRequired: all.filter((item) => item.state === "REVIEW_REQUIRED").length,
      blocked: all.filter((item) => item.state === "BLOCKED").length,
      configurationRequired: all.filter((item) => item.state === "CONFIGURATION_REQUIRED").length,
      modeledPotentialByPeriod: period(all, "potential"), measuredRealizedByPeriod: period(all, "realized") },
    existingUsage: { series: usage, arm64ByService: types.map((resourceType) => ({ resourceType,
      periods: usage.filter((item) => item.resourceType === resourceType && item.architecture === "ARM64"),
      resourceCount: Math.max(0, ...usage.filter((item) => item.resourceType === resourceType && item.architecture === "ARM64").map((item) => item.resourceCount)) })) },
    serviceSummaries: types.flatMap((resourceType) => currencies.map((currency) => {
      const items = all.filter((item) => item.resourceType === resourceType);
      return { resourceType, currency, opportunities: items.length, ready: items.filter((item) => item.state === "READY").length,
        providerEstimateMicros: total(items.flatMap((item) => item.providerEstimate?.savings.currency === currency ? [item.providerEstimate.savings.amountMicros] : [])),
        modeledPotentialMicros: total(items.flatMap((item) => item.potentialSavings?.savings.currency === currency ? [item.potentialSavings.savings.amountMicros] : [])),
        realizedMicros: total(items.flatMap((item) => item.realizedSavings?.observedSavings.currency === currency ? [item.realizedSavings.observedSavings.amountMicros] : [])) };
    })),
    disclosures: ["Provider estimates, modeled potential, and measured realized savings are separate evidence classes.",
      "Compatibility is never inferred from a Graviton-looking family name.",
      "Missing recommendation, compatibility, inventory, CUR2, metadata, or pricing evidence blocks a savings claim."],
  };
}

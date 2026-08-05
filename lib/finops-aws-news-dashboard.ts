import type {
  AwsNewsFeedKind,
  AwsNewsFeedSourceId,
  AwsNewsFeedsSnapshot,
  AwsNewsNormalizedItem,
} from "./finops-aws-news-feeds.ts";
import type { AwsNewsFeedsHistoryItem } from "../db/finops-aws-news-feeds-repository.ts";

export interface AwsNewsDashboardFilters {
  readonly sourceId: AwsNewsFeedSourceId | null;
  readonly feedKind: AwsNewsFeedKind | null;
  readonly serviceId: string | null;
  readonly category: string | null;
  readonly relevance: "ALL" | "TENANT_RELEVANT" | null;
  readonly search: string | null;
}

export interface AwsNewsDashboardProjection {
  readonly schema: "sutra.finops-aws-news-dashboard.v1";
  readonly filters: AwsNewsDashboardFilters;
  readonly filterOptions: {
    readonly sources: readonly { readonly id: AwsNewsFeedSourceId; readonly label: string }[];
    readonly feedKinds: readonly AwsNewsFeedKind[];
    readonly services: readonly { readonly id: string; readonly label: string }[];
    readonly categories: readonly string[];
  };
  readonly totalItemCount: number;
  readonly resultCount: number;
  readonly rowsTruncated: boolean;
  readonly items: readonly AwsNewsNormalizedItem[];
  readonly familyCounts: readonly { readonly kind: AwsNewsFeedKind; readonly count: number }[];
  readonly history: readonly AwsNewsFeedsHistoryItem[];
}

const MAX_ROWS = 250;

export function buildAwsNewsDashboardProjection(
  snapshot: AwsNewsFeedsSnapshot,
  history: readonly AwsNewsFeedsHistoryItem[],
  filters: AwsNewsDashboardFilters,
): AwsNewsDashboardProjection {
  const search = filters.search?.toLocaleLowerCase("en-US") ?? null;
  const filtered = snapshot.items.filter((item) =>
    (filters.sourceId === null || item.sourceId === filters.sourceId)
    && (filters.feedKind === null || item.feedKind === filters.feedKind)
    && (filters.serviceId === null || item.matchedServices.some((service) => service.serviceId === filters.serviceId))
    && (filters.category === null || item.categories.includes(filters.category))
    && (filters.relevance !== "TENANT_RELEVANT" || item.tenantRelevant)
    && (search === null || `${item.title} ${item.summary}`.toLocaleLowerCase("en-US").includes(search))
  );
  const services = new Map<string, string>();
  for (const item of snapshot.items) for (const service of item.matchedServices) services.set(service.serviceId, service.displayName);
  const sources = new Map<AwsNewsFeedSourceId, string>();
  for (const item of snapshot.items) sources.set(item.sourceId, item.sourceLabel);
  const kinds = [...new Set(snapshot.items.map((item) => item.feedKind))].sort();
  return {
    schema: "sutra.finops-aws-news-dashboard.v1",
    filters,
    filterOptions: {
      sources: [...sources].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label)),
      feedKinds: kinds,
      services: [...services].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label)),
      categories: [...new Set(snapshot.items.flatMap((item) => item.categories))].sort(),
    },
    totalItemCount: snapshot.items.length,
    resultCount: filtered.length,
    rowsTruncated: filtered.length > MAX_ROWS,
    items: filtered.slice(0, MAX_ROWS),
    familyCounts: kinds.map((kind) => ({ kind, count: snapshot.items.filter((item) => item.feedKind === kind).length })),
    history,
  };
}

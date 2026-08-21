import {
  AWS_CMDB_CATALOG,
  findAwsCatalogCategory,
  findAwsCatalogResourceType,
  findAwsCatalogResourceTypeByNormalizedType,
  findAwsCatalogService,
  type AwsCatalogCategory,
  type AwsCatalogResourceType,
  type AwsCatalogService,
} from "./aws-cmdb-catalog.ts";
import type { PilotCoverageEntry, PilotResource, PilotState, PilotSyncRun } from "./pilot-types.ts";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const SEGMENT = /^[a-z0-9][a-z0-9.-]{0,127}$/u;
const REGION = /^(?:all|global|[a-z]{2}(?:-gov)?-[a-z]+-\d)$/u;
const MAX_SEARCH_RESULTS = 60;
const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
const REVIEW_DUE_AFTER_MS = 24 * 60 * 60 * 1000;

export type AwsNavigatorCoverageState =
  | "complete"
  | "not_configured"
  | "waiting"
  | "not_collected"
  | "permission_required"
  | "partial"
  | "failed"
  | "retained"
  | "stale"
  | "unavailable";

export type AwsNavigatorFreshness = "unavailable" | "current" | "review_due" | "stale";

export interface AwsNavigatorCoverage {
  readonly state: AwsNavigatorCoverageState;
  /** Numeric only when this exact catalog boundary is completely covered. */
  readonly authoritativeCount: number | null;
  /** Retained evidence is labeled separately and never substituted for a current zero. */
  readonly lastKnownCount: number | null;
  readonly retirementPendingCount: number;
  readonly message: string;
}

export interface AwsNavigatorTypeView extends AwsCatalogResourceType {
  readonly coverage: AwsNavigatorCoverage;
}

export interface AwsNavigatorServiceView {
  readonly id: string;
  readonly name: string;
  readonly href: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly catalogTypeCount: number;
  readonly implementedTypeCount: number;
  readonly externallyAcceptedTypeCount: number;
  readonly completeTypeCount: number;
  /** Sum over complete implemented types only; never represented as all-service coverage. */
  readonly observedInCoveredTypes: number | null;
  readonly coverageState: AwsNavigatorCoverageState;
}

export interface AwsNavigatorCategoryView {
  readonly id: string;
  readonly name: string;
  readonly href: string;
  readonly serviceCount: number;
  readonly catalogTypeCount: number;
  readonly implementedTypeCount: number;
  readonly completeTypeCount: number;
  /** Sum over complete implemented types only; never represented as category-total coverage. */
  readonly observedInCoveredTypes: number | null;
  readonly coverageState: AwsNavigatorCoverageState;
}

export interface AwsNavigatorSearchResult {
  readonly kind: "account" | "category" | "service" | "resource_type" | "resource";
  readonly title: string;
  readonly subtitle: string;
  readonly href: string;
  readonly coverageState: AwsNavigatorCoverageState | null;
}

export interface AwsNavigatorBreadcrumb {
  readonly label: string;
  readonly href: string;
}

export interface AwsNavigatorEnvelope {
  readonly schemaVersion: "sutra.aws-navigator.v1";
  readonly catalog: {
    readonly version: string;
    readonly categoryCount: number;
    readonly serviceCount: number;
    readonly referenceTypeCount: number;
    readonly sutraExtensionTypeCount: number;
    readonly taggableTypeCount: number;
    readonly sourceAnomalies: readonly string[];
  };
  readonly scope: {
    readonly connectionId: string | null;
    readonly customerName: string | null;
    readonly accountId: string | null;
    readonly partition: string | null;
    readonly regions: readonly string[];
    readonly selectedRegion: string;
    readonly freshness: AwsNavigatorFreshness;
    readonly activeSnapshot: {
      readonly id: string;
      readonly collectedAt: string;
      readonly snapshotSha256: string;
    } | null;
    readonly latestAttempt: {
      readonly id: string;
      readonly status: PilotSyncRun["status"];
      readonly finishedAt: string | null;
    } | null;
  };
  readonly destination: {
    readonly kind: "root" | "category" | "service" | "resource_type";
    readonly id: string;
    readonly title: string;
    readonly href: string;
  };
  readonly breadcrumbs: readonly AwsNavigatorBreadcrumb[];
  readonly categories: readonly AwsNavigatorCategoryView[];
  readonly services: readonly AwsNavigatorServiceView[];
  readonly resourceTypes: readonly AwsNavigatorTypeView[];
  readonly searchResults: readonly AwsNavigatorSearchResult[];
  readonly query: string;
}

export class AwsNavigatorInputError extends Error {
  public readonly code: "INVALID_INPUT" | "NOT_FOUND";

  public constructor(code: AwsNavigatorInputError["code"]) {
    super("AWS Navigator request rejected");
    this.name = "AwsNavigatorInputError";
    this.code = code;
  }
}

interface BuildNavigatorInput {
  readonly state: PilotState;
  readonly segments?: readonly string[];
  readonly region?: string | null;
  readonly query?: string | null;
  readonly nowMs?: number;
}

export interface AwsNavigatorConnectionBoundary {
  readonly id: string;
  readonly customerId: string;
  readonly awsAccountId: string;
}

interface ResolvedDestination {
  readonly kind: AwsNavigatorEnvelope["destination"]["kind"];
  readonly category: AwsCatalogCategory | null;
  readonly service: AwsCatalogService | null;
  readonly resourceType: AwsCatalogResourceType | null;
}

type CoverageResolver = (type: AwsCatalogResourceType) => AwsNavigatorCoverage;

interface IndexedResourceCounts {
  readonly active: number;
  readonly retained: number;
  readonly regions: ReadonlyMap<string, { readonly active: number; readonly retained: number }>;
}

function invalid(): never {
  throw new AwsNavigatorInputError("INVALID_INPUT");
}

/**
 * Fail closed if a repository/composition bug returns state from any boundary
 * other than the already authorized connection. The API performs this check
 * after its org-scoped connection lookup and customer capability decision.
 */
export function assertAwsNavigatorStateBoundary(
  expected: AwsNavigatorConnectionBoundary,
  state: PilotState,
): void {
  if (state.connection === null
    || state.connection.id !== expected.id
    || state.connection.customerId !== expected.customerId
    || state.connection.awsAccountId !== expected.awsAccountId) {
    throw new AwsNavigatorInputError("NOT_FOUND");
  }
}

function scopedHref(href: string, connectionId: string | null, region: string): string {
  const url = new URL(href, "https://www.sutracmdb.com");
  if (connectionId !== null) url.searchParams.set("connectionId", connectionId);
  if (region !== "all") url.searchParams.set("region", region);
  return `${url.pathname}${url.search}`;
}

function resolveDestination(segments: readonly string[]): ResolvedDestination {
  if (segments.length === 0) return { kind: "root", category: null, service: null, resourceType: null };
  if (segments.length > 2 || segments.some((segment) => !SEGMENT.test(segment))) invalid();
  if (segments.length === 1) {
    const category = findAwsCatalogCategory(segments[0] ?? "");
    if (category !== null) return { kind: "category", category, service: null, resourceType: null };
    const service = findAwsCatalogService(segments[0] ?? "");
    if (service !== null) {
      return {
        kind: "service",
        category: findAwsCatalogCategory(service.categoryId),
        service,
        resourceType: null,
      };
    }
    throw new AwsNavigatorInputError("NOT_FOUND");
  }
  const service = findAwsCatalogService(segments[0] ?? "");
  const resourceType = service === null ? null : findAwsCatalogResourceType(service.id, segments[1] ?? "");
  if (service === null || resourceType === null) throw new AwsNavigatorInputError("NOT_FOUND");
  return {
    kind: "resource_type",
    category: findAwsCatalogCategory(service.categoryId),
    service,
    resourceType,
  };
}

function freshness(state: PilotState, nowMs: number): AwsNavigatorFreshness {
  if (state.activeSnapshot === null) return "unavailable";
  const collectedAt = Date.parse(state.activeSnapshot.collectedAt);
  if (!Number.isFinite(collectedAt)) return "stale";
  const age = Math.max(0, nowMs - collectedAt);
  if (age >= STALE_AFTER_MS) return "stale";
  if (age >= REVIEW_DUE_AFTER_MS) return "review_due";
  return "current";
}

function coverageEntries(
  entries: readonly PilotCoverageEntry[],
  collectorKey: string,
  scope: AwsCatalogResourceType["scope"],
  selectedRegion: string,
): readonly PilotCoverageEntry[] {
  const matching = entries.filter((entry) => entry.collectorKey === collectorKey);
  if (selectedRegion === "all") return matching;
  if (scope === "global") return matching.filter((entry) => entry.region === "global");
  return matching.filter((entry) => entry.region === selectedRegion);
}

function completeCoverageBoundary(
  state: PilotState,
  type: AwsCatalogResourceType,
  selectedRegion: string,
  entries: readonly PilotCoverageEntry[],
): boolean {
  if (type.scope === "global") return entries.some((entry) => entry.region === "global");
  if (selectedRegion !== "all") return entries.some((entry) => entry.region === selectedRegion);
  const explicitRegions = state.connection?.enabledRegions.filter((region) => REGION.test(region) && region !== "all" && region !== "global") ?? [];
  const expectedRegions = explicitRegions.length > 0
    ? explicitRegions
    : [...new Set([
        ...state.coverage.map((entry) => entry.region),
        ...(state.latestRunCoverage?.entries.map((entry) => entry.region) ?? []),
        ...state.resources.map((resource) => resource.region),
      ].filter((region) => region !== "global"))];
  return expectedRegions.length > 0 && expectedRegions.every((region) => entries.some((entry) => entry.region === region));
}

function stateFromFailedCoverage(entries: readonly PilotCoverageEntry[]): AwsNavigatorCoverageState {
  if (entries.some((entry) => entry.errorCode?.toLocaleLowerCase("en-US").includes("accessdenied")
    || entry.errorCode?.toLocaleLowerCase("en-US").includes("unauthorized"))) {
    return "permission_required";
  }
  if (entries.some((entry) => entry.status === "failed")) return "failed";
  if (entries.some((entry) => entry.status === "partial")) return "partial";
  return "retained";
}

function latestAttemptIsNewerThanSnapshot(state: PilotState): boolean {
  const latest = state.syncRuns[0];
  if (latest === undefined || latest.status === "succeeded" || state.activeSnapshot === null) return false;
  const latestAt = Date.parse(latest.finishedAt ?? latest.startedAt ?? latest.createdAt);
  const snapshotAt = Date.parse(state.activeSnapshot.collectedAt);
  return Number.isFinite(latestAt) && Number.isFinite(snapshotAt) && latestAt > snapshotAt;
}

function resourceCounts(
  resources: readonly PilotResource[],
  type: AwsCatalogResourceType,
  selectedRegion: string,
): { active: number; retained: number } {
  let active = 0;
  let retained = 0;
  for (const resource of resources) {
    if (resource.resourceType !== type.normalizedResourceType) continue;
    if (selectedRegion !== "all" && type.scope !== "global" && resource.region !== selectedRegion) continue;
    if (resource.lifecycleState === "retirement_pending") retained += 1;
    else active += 1;
  }
  return { active, retained };
}

function indexResourceCounts(resources: readonly PilotResource[]): ReadonlyMap<string, IndexedResourceCounts> {
  const mutable = new Map<string, { active: number; retained: number; regions: Map<string, { active: number; retained: number }> }>();
  for (const resource of resources) {
    const indexed = mutable.get(resource.resourceType) ?? { active: 0, retained: 0, regions: new Map() };
    const region = indexed.regions.get(resource.region) ?? { active: 0, retained: 0 };
    if (resource.lifecycleState === "retirement_pending") {
      indexed.retained += 1;
      region.retained += 1;
    } else {
      indexed.active += 1;
      region.active += 1;
    }
    indexed.regions.set(resource.region, region);
    mutable.set(resource.resourceType, indexed);
  }
  return mutable;
}

function indexedCounts(
  index: ReadonlyMap<string, IndexedResourceCounts>,
  type: AwsCatalogResourceType,
  selectedRegion: string,
): { active: number; retained: number } {
  if (type.normalizedResourceType === null) return { active: 0, retained: 0 };
  const counts = index.get(type.normalizedResourceType);
  if (counts === undefined) return { active: 0, retained: 0 };
  if (selectedRegion === "all" || type.scope === "global") {
    return { active: counts.active, retained: counts.retained };
  }
  return counts.regions.get(selectedRegion) ?? { active: 0, retained: 0 };
}

function coverageMessage(state: AwsNavigatorCoverageState): string {
  switch (state) {
    case "complete": return "The selected collector boundary succeeded; zero is authoritative when shown.";
    case "not_configured": return "No AWS connection is configured for this workspace.";
    case "waiting": return "The connection has no promoted complete inventory snapshot yet.";
    case "not_collected": return "This catalog type is not collected by the current adapter or selected Region boundary.";
    case "permission_required": return "The latest applicable collector evidence reports a permission denial.";
    case "partial": return "The applicable collector boundary is partial; retained evidence is not a current count.";
    case "failed": return "The applicable collector failed; retained evidence is not a current count.";
    case "retained": return "A newer incomplete collection attempt did not replace the last complete snapshot.";
    case "stale": return "The last complete snapshot is older than the 48-hour freshness boundary.";
    case "unavailable": return "This catalog type is explicitly unavailable in the current implementation.";
  }
}

function coverageForAwsCatalogTypeWithCounts(
  state: PilotState,
  type: AwsCatalogResourceType,
  selectedRegion = "all",
  nowMs = Date.now(),
  counts = resourceCounts(state.resources, type, selectedRegion),
): AwsNavigatorCoverage {
  if (!REGION.test(selectedRegion) || !Number.isFinite(nowMs)) invalid();
  const candidateLastKnownCount = state.activeSnapshot === null || !type.maturity.implemented ? null : counts.active;
  const result = (
    coverageState: AwsNavigatorCoverageState,
    authoritativeCount: number | null,
    exposeLastKnown = false,
  ): AwsNavigatorCoverage => ({
    state: coverageState,
    authoritativeCount,
    lastKnownCount: authoritativeCount === null && exposeLastKnown ? candidateLastKnownCount : null,
    retirementPendingCount: counts.retained,
    message: coverageMessage(coverageState),
  });

  if (state.connection === null) return result("not_configured", null);
  if (type.maturity.unavailable) return result("unavailable", null);
  if (!type.maturity.implemented || type.collectorKey === null || type.normalizedResourceType === null) {
    return result("not_collected", null);
  }
  if (state.activeSnapshot === null) {
    const latestEntries = state.latestRunCoverage === null
      ? []
      : coverageEntries(state.latestRunCoverage.entries, type.collectorKey, type.scope, selectedRegion);
    if (latestEntries.length > 0 && latestEntries.some((entry) => entry.status !== "succeeded")) {
      return result(stateFromFailedCoverage(latestEntries), null);
    }
    return result("waiting", null);
  }
  if (latestAttemptIsNewerThanSnapshot(state)) {
    const latestEntries = state.latestRunCoverage === null
      ? []
      : coverageEntries(state.latestRunCoverage.entries, type.collectorKey, type.scope, selectedRegion);
    return result(latestEntries.length === 0 ? "retained" : stateFromFailedCoverage(latestEntries), null, true);
  }
  const entries = coverageEntries(state.coverage, type.collectorKey, type.scope, selectedRegion);
  if (entries.length === 0) return result("not_collected", null, counts.active > 0);
  if (entries.some((entry) => entry.status !== "succeeded")) {
    return result(stateFromFailedCoverage(entries), null, true);
  }
  if (!completeCoverageBoundary(state, type, selectedRegion, entries)) {
    return result("partial", null, counts.active > 0);
  }
  if (freshness(state, nowMs) === "stale") return result("stale", null, true);
  return result("complete", counts.active);
}

export function coverageForAwsCatalogType(
  state: PilotState,
  type: AwsCatalogResourceType,
  selectedRegion = "all",
  nowMs = Date.now(),
): AwsNavigatorCoverage {
  return coverageForAwsCatalogTypeWithCounts(state, type, selectedRegion, nowMs);
}

function priorityState(states: readonly AwsNavigatorCoverageState[]): AwsNavigatorCoverageState {
  const priority: readonly AwsNavigatorCoverageState[] = [
    "permission_required", "failed", "partial", "stale", "retained", "waiting",
    "not_configured", "not_collected", "unavailable", "complete",
  ];
  return priority.find((candidate) => states.includes(candidate)) ?? "not_collected";
}

function typeView(type: AwsCatalogResourceType, resolveCoverage: CoverageResolver): AwsNavigatorTypeView {
  return { ...type, coverage: resolveCoverage(type) };
}

function serviceView(
  service: AwsCatalogService,
  resolveCoverage: CoverageResolver,
  connectionId: string | null,
  region: string,
): AwsNavigatorServiceView {
  const types = service.resourceTypes.map((type) => typeView(type, resolveCoverage));
  const complete = types.filter((type) => type.coverage.state === "complete");
  return {
    id: service.id,
    name: service.name,
    href: scopedHref(service.href, connectionId, region),
    categoryId: service.categoryId,
    categoryName: service.categoryName,
    catalogTypeCount: types.length,
    implementedTypeCount: types.filter((type) => type.maturity.implemented).length,
    externallyAcceptedTypeCount: types.filter((type) => type.maturity.externallyAccepted).length,
    completeTypeCount: complete.length,
    observedInCoveredTypes: complete.length === 0
      ? null
      : complete.reduce((total, type) => total + (type.coverage.authoritativeCount ?? 0), 0),
    coverageState: complete.length === types.length && types.length > 0
      ? "complete"
      : priorityState(types.map((type) => type.coverage.state)),
  };
}

function categoryView(
  category: AwsCatalogCategory,
  resolveCoverage: CoverageResolver,
  connectionId: string | null,
  region: string,
): AwsNavigatorCategoryView {
  const serviceViews = category.services.map((service) => serviceView(service, resolveCoverage, connectionId, region));
  const catalogTypeCount = serviceViews.reduce((total, service) => total + service.catalogTypeCount, 0);
  const completeTypeCount = serviceViews.reduce((total, service) => total + service.completeTypeCount, 0);
  const observed = serviceViews.filter((service) => service.observedInCoveredTypes !== null);
  return {
    id: category.id,
    name: category.name,
    href: scopedHref(category.href, connectionId, region),
    serviceCount: category.services.length,
    catalogTypeCount,
    implementedTypeCount: serviceViews.reduce((total, service) => total + service.implementedTypeCount, 0),
    completeTypeCount,
    observedInCoveredTypes: observed.length === 0
      ? null
      : observed.reduce((total, service) => total + (service.observedInCoveredTypes ?? 0), 0),
    coverageState: completeTypeCount === catalogTypeCount && catalogTypeCount > 0
      ? "complete"
      : priorityState(serviceViews.map((service) => service.coverageState)),
  };
}

function resourceLabel(resource: PilotResource): string {
  return resource.name?.trim() || resource.tags.Name || resource.nativeId;
}

function searchResults(
  state: PilotState,
  query: string,
  region: string,
  categoryViews: readonly AwsNavigatorCategoryView[],
  serviceViews: readonly AwsNavigatorServiceView[],
  resolveCoverage: CoverageResolver,
  nowMs: number,
): readonly AwsNavigatorSearchResult[] {
  const needle = query.trim().toLocaleLowerCase("en-US");
  if (needle === "") return [];
  const results: AwsNavigatorSearchResult[] = [];
  const push = (value: AwsNavigatorSearchResult): void => {
    if (results.length < MAX_SEARCH_RESULTS) results.push(value);
  };
  const connection = state.connection;
  if (connection !== null && `${connection.customerName} ${connection.awsAccountId}`.toLocaleLowerCase("en-US").includes(needle)) {
    push({
      kind: "account",
      title: connection.customerName,
      subtitle: `${connection.awsAccountId} · ${connection.partition}`,
      href: scopedHref("/cmdb/navigator", connection.id, region),
      coverageState: state.activeSnapshot === null ? "waiting" : null,
    });
  }
  for (const category of categoryViews) {
    if (category.name.toLocaleLowerCase("en-US").includes(needle)) {
      push({ kind: "category", title: category.name, subtitle: `${category.serviceCount} services · ${category.catalogTypeCount} catalog types`, href: category.href, coverageState: category.coverageState });
    }
  }
  for (const service of serviceViews) {
    if (`${service.name} ${service.categoryName}`.toLocaleLowerCase("en-US").includes(needle)) {
      push({ kind: "service", title: service.name, subtitle: `${service.categoryName} · ${service.catalogTypeCount} catalog types`, href: service.href, coverageState: service.coverageState });
    }
  }
  for (const type of AWS_CMDB_CATALOG.resourceTypes) {
    if (results.length >= MAX_SEARCH_RESULTS) break;
    if (`${type.name} ${type.serviceName} ${type.normalizedResourceType ?? ""}`.toLocaleLowerCase("en-US").includes(needle)) {
      const coverage = resolveCoverage(type);
      push({
        kind: "resource_type",
        title: type.name,
        subtitle: `${type.serviceName} · ${type.maturity.implemented ? "implemented adapter" : type.maturity.adapterPlanned ? "adapter planned" : "cataloged"}`,
        href: scopedHref(type.href, connection?.id ?? null, region),
        coverageState: coverage.state,
      });
    }
  }
  for (const resource of state.resources) {
    if (results.length >= MAX_SEARCH_RESULTS) break;
    if (region !== "all" && resource.region !== region) continue;
    const haystack = `${resourceLabel(resource)} ${resource.nativeId} ${resource.arn ?? ""} ${resource.resourceType} ${resource.service} ${resource.region} ${Object.entries(resource.tags).flat().join(" ")}`.toLocaleLowerCase("en-US");
    if (!haystack.includes(needle)) continue;
    const catalogType = findAwsCatalogResourceTypeByNormalizedType(resource.resourceType);
    const resourceCoverage = catalogType === null
      ? freshness(state, nowMs) === "stale"
        ? "stale"
        : latestAttemptIsNewerThanSnapshot(state) ? "retained" : "complete"
      : resolveCoverage(catalogType).state;
    push({
      kind: "resource",
      title: resourceLabel(resource),
      subtitle: `${resource.resourceType} · ${resource.region}${resource.lifecycleState === "retirement_pending" ? " · retirement pending" : ""}`,
      href: scopedHref(`/cmdb/resource?key=${encodeURIComponent(resource.resourceKey)}`, connection?.id ?? null, region),
      coverageState: resource.lifecycleState === "retirement_pending" ? "retained" : resourceCoverage,
    });
  }
  return results;
}

export function buildAwsNavigatorEnvelope(input: BuildNavigatorInput): AwsNavigatorEnvelope {
  const segments = input.segments ?? [];
  const query = input.query?.trim() ?? "";
  const region = input.region ?? "all";
  const nowMs = input.nowMs ?? Date.now();
  if (input.state.connection !== null && !CONNECTION_ID.test(input.state.connection.id)) invalid();
  if (!REGION.test(region) || query.length > 120 || !Number.isFinite(nowMs)) invalid();
  const destination = resolveDestination(segments);
  const connection = input.state.connection;
  const resourceCountIndex = indexResourceCounts(input.state.resources);
  const coverageCache = new Map<string, AwsNavigatorCoverage>();
  const resolveCoverage: CoverageResolver = (type) => {
    const cacheKey = `${type.serviceId}/${type.id}`;
    const existing = coverageCache.get(cacheKey);
    if (existing !== undefined) return existing;
    const value = coverageForAwsCatalogTypeWithCounts(
      input.state,
      type,
      region,
      nowMs,
      indexedCounts(resourceCountIndex, type, region),
    );
    coverageCache.set(cacheKey, value);
    return value;
  };
  const regions = [...new Set([
    ...input.state.coverage.map((entry) => entry.region),
    ...input.state.resources.map((resource) => resource.region),
  ].filter((value) => value !== "global"))].sort();
  if (region !== "all" && region !== "global" && !regions.includes(region)) invalid();

  const categoryViews = AWS_CMDB_CATALOG.categories.map((category) => categoryView(category, resolveCoverage, connection?.id ?? null, region));
  const allServiceViews = AWS_CMDB_CATALOG.services.map((service) => serviceView(service, resolveCoverage, connection?.id ?? null, region));
  const serviceViews = destination.kind === "category"
    ? allServiceViews.filter((service) => service.categoryId === destination.category?.id)
    : destination.kind === "root" ? [] : destination.service === null ? [] : [serviceView(destination.service, resolveCoverage, connection?.id ?? null, region)];
  const typeViews = destination.service === null
    ? []
    : destination.resourceType === null
      ? destination.service.resourceTypes.map((type) => typeView(type, resolveCoverage))
      : [typeView(destination.resourceType, resolveCoverage)];
  const rootHref = scopedHref("/cmdb/navigator", connection?.id ?? null, region);
  const breadcrumbs: AwsNavigatorBreadcrumb[] = [{ label: "AWS Navigator", href: rootHref }];
  if (destination.category !== null) breadcrumbs.push({ label: destination.category.name, href: scopedHref(destination.category.href, connection?.id ?? null, region) });
  if (destination.service !== null) breadcrumbs.push({ label: destination.service.name, href: scopedHref(destination.service.href, connection?.id ?? null, region) });
  if (destination.resourceType !== null) breadcrumbs.push({ label: destination.resourceType.name, href: scopedHref(destination.resourceType.href, connection?.id ?? null, region) });
  const current = destination.resourceType ?? destination.service ?? destination.category;

  return {
    schemaVersion: "sutra.aws-navigator.v1",
    catalog: {
      version: AWS_CMDB_CATALOG.catalogVersion,
      categoryCount: AWS_CMDB_CATALOG.categories.length,
      serviceCount: AWS_CMDB_CATALOG.services.length,
      referenceTypeCount: AWS_CMDB_CATALOG.source.unionResourceTypeCount,
      sutraExtensionTypeCount: AWS_CMDB_CATALOG.resourceTypes.filter((type) => type.origin === "sutra_extension").length,
      taggableTypeCount: AWS_CMDB_CATALOG.resourceTypes.filter((type) => type.taggable).length,
      sourceAnomalies: AWS_CMDB_CATALOG.source.anomalies,
    },
    scope: {
      connectionId: connection?.id ?? null,
      customerName: connection?.customerName ?? null,
      accountId: connection?.awsAccountId ?? null,
      partition: connection?.partition ?? null,
      regions,
      selectedRegion: region,
      freshness: freshness(input.state, nowMs),
      activeSnapshot: input.state.activeSnapshot === null ? null : {
        id: input.state.activeSnapshot.id,
        collectedAt: input.state.activeSnapshot.collectedAt,
        snapshotSha256: input.state.activeSnapshot.snapshotSha256,
      },
      latestAttempt: input.state.syncRuns[0] === undefined ? null : {
        id: input.state.syncRuns[0].id,
        status: input.state.syncRuns[0].status,
        finishedAt: input.state.syncRuns[0].finishedAt,
      },
    },
    destination: {
      kind: destination.kind,
      id: current?.id ?? "aws",
      title: current?.name ?? "AWS Navigator",
      href: current === null || current === undefined ? rootHref : scopedHref(current.href, connection?.id ?? null, region),
    },
    breadcrumbs,
    categories: destination.kind === "root" ? categoryViews : [],
    services: serviceViews,
    resourceTypes: typeViews,
    searchResults: searchResults(input.state, query, region, categoryViews, allServiceViews, resolveCoverage, nowMs),
    query,
  };
}

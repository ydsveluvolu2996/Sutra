import { isCollectableAwsSourceKind } from "../../../../../lib/aws-connection-source";
import { GravitonSavingsRepository } from "../../../../../db/finops-graviton-savings-repository";
import { GravitonRuntimeRepository } from "../../../../../db/finops-graviton-runtime-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import {
  assertSessionCapability,
  requireApiSession,
} from "../../../../../lib/api-auth";
import {
  buildGravitonDashboard,
  type GravitonDashboardFilters,
} from "../../../../../lib/finops-graviton-dashboard";
import { GRAVITON_SAVINGS_OFFICIAL_DEFINITION } from "../../../../../lib/finops-graviton-savings-official-definition";
import type {
  GravitonOpportunityState,
  GravitonResourceType,
} from "../../../../../lib/finops-graviton-savings";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";
export const dynamic = "force-dynamic";
const CONNECTION = /^conn_[a-f0-9]{32}$/u,
  ACCOUNT = /^\d{12}$/u,
  REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u,
  CURRENCY = /^[A-Z]{3}$/u,
  CURSOR = /^v1:(?:0|[1-9]\d{0,7})$/u,
  TYPES = new Set([
    "EC2_INSTANCE",
    "AUTO_SCALING_GROUP",
    "RDS_DB_INSTANCE",
    "AURORA_DB_INSTANCE",
    "OPENSEARCH_DOMAIN",
    "ELASTICACHE_REPLICATION_GROUP",
  ]),
  STATES = new Set([
    "READY",
    "REVIEW_REQUIRED",
    "BLOCKED",
    "CONFIGURATION_REQUIRED",
  ]),
  ALLOWED = new Set([
    "connectionId",
    "accountId",
    "region",
    "resourceType",
    "state",
    "currency",
    "migrationEffort",
    "recommendationAuthority",
    "architecture",
    "operatingSystem",
    "purchaseOption",
    "priceListVersion",
    "limit",
    "cursor",
  ]);
function invalid(): never {
  throw Object.assign(new Error("The Graviton dashboard request is invalid"), {
    code: "INVALID_INPUT",
    status: 400,
  });
}
function parse(request: Request) {
  const values = new URL(request.url).searchParams;
  for (const key of values.keys()) if (!ALLOWED.has(key)) invalid();
  for (const key of ALLOWED) if (values.getAll(key).length > 1) invalid();
  const connectionId = values.get("connectionId") ?? "",
    accountId = values.get("accountId") ?? undefined,
    region = values.get("region") ?? undefined,
    resourceType = values.get("resourceType") ?? undefined,
    state = values.get("state") ?? undefined,
    currency = values.get("currency") ?? undefined,
    migrationEffort = values.get("migrationEffort") ?? undefined,
    recommendationAuthority = values.get("recommendationAuthority") ?? undefined,
    architecture = values.get("architecture") ?? undefined,
    operatingSystem = values.get("operatingSystem") ?? undefined,
    purchaseOption = values.get("purchaseOption") ?? undefined,
    priceListVersion = values.get("priceListVersion") ?? undefined,
    cursor = values.get("cursor") ?? undefined,
    limit = values.get("limit") === null ? 100 : Number(values.get("limit"));
  if (
    !CONNECTION.test(connectionId) ||
    (accountId !== undefined && !ACCOUNT.test(accountId)) ||
    (region !== undefined && !REGION.test(region)) ||
    (resourceType !== undefined && !TYPES.has(resourceType)) ||
    (state !== undefined && !STATES.has(state)) ||
    (currency !== undefined && !CURRENCY.test(currency)) ||
    (migrationEffort !== undefined && !new Set(["VERY_LOW", "LOW", "MEDIUM", "HIGH"]).has(migrationEffort)) ||
    (recommendationAuthority !== undefined && !new Set(["AWS_COMPUTE_OPTIMIZER", "AWS_SERVICE_INVENTORY_PRICING"]).has(recommendationAuthority)) ||
    (architecture !== undefined && architecture !== "X86_64" && architecture !== "ARM64") ||
    (operatingSystem !== undefined && (!/^[A-Za-z0-9 ._+:/()-]{1,128}$/u.test(operatingSystem))) ||
    (purchaseOption !== undefined && purchaseOption !== "ON_DEMAND") ||
    (priceListVersion !== undefined && !/^[A-Za-z0-9._:@+-]{1,128}$/u.test(priceListVersion)) ||
    (cursor !== undefined && !CURSOR.test(cursor)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 500
  )
    invalid();
  return {
    connectionId,
    filters: {
      accountId,
      region,
      resourceType: resourceType as GravitonResourceType | undefined,
      state: state as GravitonOpportunityState | undefined,
      currency,
      migrationEffort: migrationEffort as GravitonDashboardFilters["migrationEffort"],
      recommendationAuthority: recommendationAuthority as GravitonDashboardFilters["recommendationAuthority"],
      architecture: architecture as GravitonDashboardFilters["architecture"],
      operatingSystem,
      purchaseOption: purchaseOption as GravitonDashboardFilters["purchaseOption"],
      priceListVersion,
      limit,
      cursor,
    } satisfies GravitonDashboardFilters,
  };
}
function unique(values: readonly (string | undefined)[]) {
  return [
    ...new Set(values.filter((value): value is string => value !== undefined)),
  ].sort();
}
export async function GET(request: Request): Promise<Response> {
  try {
    const parsed = parse(request),
      authenticated = await requireApiSession(request),
      connection = await getConnectionForOrg(
        authenticated.subject.orgId,
        parsed.connectionId,
      );
    if (
      connection === null ||
      !isCollectableAwsSourceKind(connection.sourceKind) ||
      connection.status !== "active"
    )
      throw Object.assign(new Error("Cloud connection not found"), {
        code: "NOT_FOUND",
        status: 404,
      });
    assertSessionCapability(
      authenticated,
      "connection:read",
      connection.customerId,
    );
    const scope = {
        organizationId: authenticated.subject.orgId,
        customerId: connection.customerId,
        connectionId: connection.id,
      },
      repository = new GravitonSavingsRepository(),
      runtimeRepository = new GravitonRuntimeRepository(),
      [active, latest, history, runtimeStatus] = await Promise.all([
        repository.getActiveSnapshot(scope),
        repository.getLatestSnapshot(scope),
        repository.listHistory(scope, 24),
        runtimeRepository.getRuntimeStatus(scope),
      ]),
      selected = active ?? latest;
    if (selected === null)
      return jsonResponse({
        schema: "sutra.finops-graviton-dashboard.v1",
        connectionId: connection.id,
        sourceState: "configuration_required",
        officialDefinition: GRAVITON_SAVINGS_OFFICIAL_DEFINITION,
        dashboard: null,
        collection: {
          jobContractAvailable: true,
          providerAdapterAvailable: true,
          runtimeStatus,
          reason: runtimeStatus.reason,
        },
      });
    const unfiltered = buildGravitonDashboard(selected.snapshot),
      dashboard = buildGravitonDashboard(selected.snapshot, parsed.filters),
      ageHours =
        Math.round(
          Math.max(
            0,
            (Date.now() - Date.parse(selected.snapshot.generatedAt)) /
              3_600_000,
          ) * 100,
        ) / 100,
      newerIncomplete =
        active !== null &&
        latest !== null &&
        active.generationId !== latest.generationId,
      sourceState = newerIncomplete
        ? "partial"
        : selected.snapshot.state === "CONFIGURATION_REQUIRED"
          ? "configuration_required"
          : selected.snapshot.state === "PARTIAL"
            ? "partial"
            : ageHours > 48
              ? "stale"
              : dashboard.resultCount === 0 &&
                  dashboard.existingUsage.series.length === 0
                ? "empty"
                : "complete";
    return jsonResponse({
      ...dashboard,
      connectionId: connection.id,
      sourceState,
      officialDefinition: GRAVITON_SAVINGS_OFFICIAL_DEFINITION,
      history,
      filterOptions: {
        accounts: unique([
          ...unfiltered.opportunities.map((item) => item.accountId),
          ...unfiltered.existingUsage.series.map((item) => item.accountId),
        ]),
        regions: unique([
          ...unfiltered.opportunities.map((item) => item.region),
          ...unfiltered.existingUsage.series.map((item) => item.region),
        ]),
        resourceTypes: unique([
          ...unfiltered.opportunities.map((item) => item.resourceType),
          ...unfiltered.existingUsage.series.map((item) => item.resourceType),
        ]),
        states: unique(unfiltered.opportunities.map((item) => item.state)),
        currencies: unique([
          ...unfiltered.serviceSummaries.map((item) => item.currency),
          ...unfiltered.existingUsage.series.map((item) => item.currency),
        ]),
        migrationEfforts: unique(unfiltered.opportunities.map((item) => item.migrationEffort)),
        recommendationAuthorities: unique(unfiltered.opportunities.map((item) => item.recommendationAuthority)),
        architectures: unique(unfiltered.instanceMapping.map((item) => item.architecture)),
        operatingSystems: unique(unfiltered.instanceMapping.map((item) => item.operatingSystem)),
        purchaseOptions: unique(unfiltered.instanceMapping.map((item) => item.purchaseOption)),
        priceListVersions: unique(unfiltered.instanceMapping.map((item) => item.priceListVersion)),
      },
      freshness: {
        generatedAt: selected.snapshot.generatedAt,
        ageHours,
        staleAfterHours: 48,
      },
      evidence: {
        generationId: selected.generationId,
        activeGenerationId: active?.generationId ?? null,
        latestGenerationId: latest?.generationId ?? null,
        collectionId: selected.snapshot.collectionId,
        contentSha256: selected.contentSha256,
        newerIncomplete,
      },
      collection: {
        jobContractAvailable: true,
        providerAdapterAvailable: true,
        runtimeStatus,
        reason: runtimeStatus.reason,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

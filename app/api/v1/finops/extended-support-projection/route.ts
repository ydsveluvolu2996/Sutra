import { isCollectableAwsSourceKind } from "../../../../../lib/aws-connection-source";
import { ExtendedSupportRepository } from "../../../../../db/finops-extended-support-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import {
  assertSessionCapability,
  requireApiSession,
} from "../../../../../lib/api-auth";
import {
  buildExtendedSupportDashboard,
  type ExtendedSupportDashboardFilters,
} from "../../../../../lib/finops-extended-support-dashboard";
import { EXTENDED_SUPPORT_OFFICIAL_DEFINITION } from "../../../../../lib/finops-extended-support-official-definition";
import { EXTENDED_SUPPORT_PRODUCTION_COMPOSITION_STATUS } from "../../../../../lib/finops-extended-support-production-composition";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";
export const dynamic = "force-dynamic";
const CONNECTION = /^conn_[a-f0-9]{32}$/u,
  ACCOUNT = /^\d{12}$/u,
  REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u,
  SAFE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u,
  ALLOWED = new Set([
    "connectionId",
    "service",
    "accountId",
    "region",
    "lifecycleState",
    "engine",
    "horizon",
  ]);
function invalid(): never {
  throw Object.assign(
    new Error("The Extended Support projection request is invalid"),
    { code: "INVALID_INPUT", status: 400 },
  );
}
function parse(request: Request): {
  connectionId: string;
  filters: ExtendedSupportDashboardFilters;
} {
  const p = new URL(request.url).searchParams;
  for (const k of p.keys()) if (!ALLOWED.has(k)) invalid();
  for (const k of ALLOWED) if (p.getAll(k).length > 1) invalid();
  const connectionId = p.get("connectionId") ?? "",
    service = p.get("service"),
    accountId = p.get("accountId"),
    region = p.get("region"),
    lifecycleState = p.get("lifecycleState"),
    engine = p.get("engine"),
    horizon = Number(p.get("horizon") ?? "3");
  if (
    !CONNECTION.test(connectionId) ||
    (service !== null &&
      !["EKS", "RDS", "AURORA", "OPENSEARCH", "ELASTICACHE"].includes(
        service,
      )) ||
    (accountId !== null && !ACCOUNT.test(accountId)) ||
    (region !== null && !REGION.test(region)) ||
    (lifecycleState !== null &&
      ![
        "STANDARD_SUPPORT",
        "EXTENDED_SUPPORT",
        "END_OF_SUPPORT",
        "DATES_NOT_ANNOUNCED",
        "CALENDAR_REQUIRED",
        "VERSION_REQUIRED",
      ].includes(lifecycleState)) ||
    (engine !== null && !SAFE.test(engine)) ||
    ![3, 6, 12].includes(horizon)
  )
    invalid();
  return {
    connectionId,
    filters: {
      service: service as ExtendedSupportDashboardFilters["service"],
      accountId,
      region,
      lifecycleState,
      engine,
      horizon: horizon as 3 | 6 | 12,
    },
  };
}
export async function GET(request: Request): Promise<Response> {
  try {
    const q = parse(request),
      auth = await requireApiSession(request),
      connection = await getConnectionForOrg(
        auth.subject.orgId,
        q.connectionId,
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
    assertSessionCapability(auth, "connection:read", connection.customerId);
    const scope = {
        organizationId: auth.subject.orgId,
        customerId: connection.customerId,
        connectionId: connection.id,
      },
      repo = new ExtendedSupportRepository(),
      [active, latest, history] = await Promise.all([
        repo.getActiveSnapshot(scope),
        repo.getLatestSnapshot(scope),
        repo.listHistory(scope, 30),
      ]),
      selected = active ?? latest;
    if (selected === null)
      return jsonResponse({
        schema: "sutra.finops-extended-support-dashboard.v1",
        connectionId: connection.id,
        sourceState: "configuration_required",
        dashboard: null,
        officialDefinition: EXTENDED_SUPPORT_OFFICIAL_DEFINITION,
        collection: {
          jobContractAvailable: true,
          providerAdapterAvailable: true,
          durableReplayAvailable: true,
          signedTransportAvailable: true,
          sharedRuntimeRegistered:
            EXTENDED_SUPPORT_PRODUCTION_COMPOSITION_STATUS.sharedWorkerRegistered,
          reason: EXTENDED_SUPPORT_PRODUCTION_COMPOSITION_STATUS.activationState,
        },
      });
    const dashboard = buildExtendedSupportDashboard(
        selected.snapshot,
        q.filters,
      ),
      age =
        Math.round(
          Math.max(
            0,
            (Date.now() - Date.parse(selected.snapshot.collectedAt)) / 3600000,
          ) * 100,
        ) / 100,
      newerIncomplete =
        active !== null &&
        latest !== null &&
        active.generationId !== latest.generationId,
      sourceState = newerIncomplete
        ? "partial"
        : active === null
          ? selected.snapshot.state.toLowerCase()
          : age > 48
            ? "stale"
            : dashboard.resultCount === 0
              ? "empty"
              : "complete";
    return jsonResponse({
      schema: "sutra.finops-extended-support-dashboard.v1",
      connectionId: connection.id,
      sourceState,
      dashboard,
      officialDefinition: EXTENDED_SUPPORT_OFFICIAL_DEFINITION,
      history,
      freshness: {
        collectedAt: selected.snapshot.collectedAt,
        ageHours: age,
        staleAfterHours: 48,
      },
      coverage: selected.snapshot.services.map((s) => ({
        service: s.service,
        state: s.state,
        status: s.coverage.status,
        readPermissionsValidated: s.coverage.readPermissionsValidated,
        accountCount: s.coverage.accountIds.length,
        regionCount: s.coverage.regions.length,
        recordCount: s.coverage.recordCount,
        errorCode: s.coverage.errorCode,
      })),
      provenance: {
        generationId: selected.generationId,
        activeGenerationId: active?.generationId ?? null,
        latestGenerationId: latest?.generationId ?? null,
        newerIncomplete,
        collectionId: selected.snapshot.collectionId,
        contentSha256: selected.contentSha256,
        managementAccountId: selected.snapshot.managementAccountId,
        partition: selected.snapshot.partition,
        accountCount: selected.snapshot.accountIds.length,
        regionCount: selected.snapshot.regions.length,
        sourceReferences: selected.snapshot.sourceReferences.map((x) => ({
          id: x.id,
          kind: x.kind,
          operation: x.operation,
          retrievedAt: x.retrievedAt,
          effectiveAt: x.effectiveAt,
          sha256: x.sha256,
        })),
      },
      semantics: {
        actualCostLabel: selected.snapshot.observedCostLabel,
        projectionLabel: selected.snapshot.projectionLabel,
        moneyRepresentation:
          "SIGNED_INTEGER_MICROS_AFTER_ENGINE_SIX_DECIMAL_SEAL",
        projectionIsInvoice: false,
        projectionIsSavingsPromise: false,
      },
      collection: {
        jobContractAvailable: true,
        providerAdapterAvailable: true,
        durableReplayAvailable: true,
        signedTransportAvailable: true,
        sharedRuntimeRegistered:
          EXTENDED_SUPPORT_PRODUCTION_COMPOSITION_STATUS.sharedWorkerRegistered,
        reason: EXTENDED_SUPPORT_PRODUCTION_COMPOSITION_STATUS.activationState,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

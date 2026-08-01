import { AwsHealthRepository } from
  "../../../../../db/finops-aws-health-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import {
  assertSessionCapability,
  requireApiSession,
} from "../../../../../lib/api-auth";
import {
  buildAwsHealthPlanningDashboard,
  type AwsHealthDashboardFilters,
} from "../../../../../lib/finops-aws-health-dashboard";
import { FINOPS_AWS_HEALTH_OFFICIAL_DEFINITION } from
  "../../../../../lib/finops-aws-health-official-definition";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const SAFE = /^[^\u0000-\u001f\u007f<>]{1,128}$/u;
const ALLOWED = new Set([
  "connectionId",
  "status",
  "category",
  "service",
  "accountId",
  "region",
  "actionability",
  "search",
]);

function bad(): never {
  throw Object.assign(
    new Error("Health Events request invalid"),
    { code: "INVALID_INPUT", status: 400 },
  );
}

function member<T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | null {
  if (value === null) return null;
  if (!allowed.includes(value as T)) bad();
  return value as T;
}

function safe(value: string | null): string | null {
  if (value !== null && !SAFE.test(value)) bad();
  return value;
}

function parse(request: Request): {
  readonly connectionId: string;
  readonly filters: AwsHealthDashboardFilters;
} {
  const parameters = new URL(request.url).searchParams;
  for (const key of parameters.keys()) {
    if (!ALLOWED.has(key)) bad();
  }
  for (const key of ALLOWED) {
    if (parameters.getAll(key).length > 1) bad();
  }
  const connectionId = parameters.get("connectionId") ?? "";
  const accountId = parameters.get("accountId");
  const region = parameters.get("region");
  if (
    !CONNECTION.test(connectionId)
    || (accountId !== null && !ACCOUNT.test(accountId))
    || (region !== null && !REGION.test(region))
  ) bad();
  return {
    connectionId,
    filters: {
      status: member(parameters.get("status"), ["open", "closed", "upcoming"] as const),
      category: member(parameters.get("category"), [
        "issue",
        "accountNotification",
        "scheduledChange",
        "investigation",
      ] as const),
      service: safe(parameters.get("service")),
      accountId,
      region,
      actionability: member(parameters.get("actionability"), [
        "ACTION_REQUIRED",
        "ACTION_MAY_BE_REQUIRED",
        "INFORMATIONAL",
      ] as const),
      search: safe(parameters.get("search")),
    },
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const query = parse(request);
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(
      authenticated.subject.orgId,
      query.connectionId,
    );
    if (
      connection === null
      || connection.sourceKind !== "aws_trust_role"
      || connection.status !== "active"
    ) {
      throw Object.assign(
        new Error("Cloud connection not found"),
        { code: "NOT_FOUND", status: 404 },
      );
    }
    assertSessionCapability(
      authenticated,
      "connection:read",
      connection.customerId,
    );
    const scope = {
      organizationId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId: connection.id,
    };
    const repository = new AwsHealthRepository();
    const [heads, latest] = await Promise.all([
      repository.listAcceptedHistory(scope, 180),
      repository.getLatestAttempt(scope),
    ]);
    const availability = latest === null ? null : {
      configurationState: latest.snapshot.configurationState,
      collectionState: latest.snapshot.collectionState,
      supportPlan: latest.snapshot.prerequisites.supportPlan,
      eligibleSupport: latest.snapshot.prerequisites.apiEntitlementValidated,
      organizationsAllFeaturesEnabled:
        latest.snapshot.prerequisites.organizationsAllFeaturesEnabled,
      organizationViewStatus:
        latest.snapshot.prerequisites.organizationViewStatus,
      organizationViewStatusEvidence:
        latest.snapshot.prerequisites.organizationViewStatusEvidence,
      collectorAccountType:
        latest.snapshot.prerequisites.collectorAccountType,
      delegatedAdministratorRegistered:
        latest.snapshot.prerequisites.delegatedAdministratorRegistered,
      initialLoadState: latest.snapshot.prerequisites.initialLoadState,
      observedAt: latest.snapshot.observedAtIso,
    };
    if (heads.length === 0) {
      return jsonResponse({
        schema: "sutra.finops-health-events.v1",
        connectionId: connection.id,
        sourceState: latest?.snapshot.configurationState ?? "unavailable",
        dashboard: null,
        availability,
        latestAttempt: latest === null ? null : {
          generationId: latest.generationId,
          contentSha256: latest.contentSha256,
          captureId: latest.snapshot.captureId,
        },
        officialDefinition: FINOPS_AWS_HEALTH_OFFICIAL_DEFINITION,
        collection: {
          available: false,
          reason: "AWS_HEALTH_ORGANIZATION_JOB_HANDLER_NOT_REGISTERED",
        },
        planningSemantics: {
          notRealTime: true,
          minimumDocumentedLagHours: 48,
          warning: "AWS Health organization data can lag by 48 hours or more.",
        },
      });
    }
    const dashboard = buildAwsHealthPlanningDashboard(heads, query.filters);
    const latestIncomplete = latest !== null
      && latest.snapshot.collectionState !== "complete"
      && latest.snapshot.observedAtIso
        >= (dashboard.freshness.latestAcceptedObservedAt ?? "");
    return jsonResponse({
      schema: "sutra.finops-health-events.v1",
      connectionId: connection.id,
      source: "AWS_HEALTH_ORGANIZATIONAL_VIEW",
      sourceState: latestIncomplete
        ? latest.snapshot.configurationState
        : dashboard.freshness.ageHours !== null
          && dashboard.freshness.ageHours > 72
          ? "stale"
          : "ready",
      availability,
      ...dashboard,
      officialDefinition: FINOPS_AWS_HEALTH_OFFICIAL_DEFINITION,
      evidence: {
        acceptedHead: heads.at(-1)?.generationId,
        acceptedHistory: heads.map((head) => ({
          generationId: head.generationId,
          contentSha256: head.contentSha256,
          captureId: head.snapshot.captureId,
        })),
      },
      collection: {
        available: false,
        reason: "AWS_HEALTH_ORGANIZATION_JOB_HANDLER_NOT_REGISTERED",
      },
      limitations: [
        ...dashboard.limitations,
        ...(latestIncomplete
          ? ["A newer incomplete or unavailable attempt did not replace accepted history."]
          : []),
      ],
    });
  } catch (error) {
    return errorResponse(error);
  }
}

import { ResilienceVueRepository } from "../../../../../db/finops-resilience-vue-repository";
import { ResilienceVueRuntimeRepository } from "../../../../../db/finops-resilience-vue-runtime-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { buildResilienceVueDashboard } from "../../../../../lib/finops-resilience-vue";
import { RESILIENCE_VUE_OFFICIAL_DEFINITION } from "../../../../../lib/finops-resilience-vue-official-definition";
import { isResilienceVueRuntimePermissionPack } from
  "../../../../../lib/finops-permission-pack-successors";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>]{1,80}$/u;
const ALLOWED = new Set(["connectionId", "accountId", "region", "application", "compliance", "recommendationKind", "assessmentFrom", "assessmentTo"]);
const FRESH_HOURS = 168;

function bad(): never { throw Object.assign(new Error("The ResilienceVue request is invalid"), { code: "INVALID_INPUT", status: 400 }); }
function isDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}
function missing(): never { throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND", status: 404 }); }
function parse(request: Request) {
  const values = new URL(request.url).searchParams;
  for (const key of values.keys()) if (!ALLOWED.has(key)) bad();
  for (const key of ALLOWED) if (values.getAll(key).length > 1) bad();
  const connectionId = values.get("connectionId") ?? ""; const accountId = values.get("accountId");
  const region = values.get("region"); const application = values.get("application");
  const compliance = values.get("compliance"); const recommendationKind = values.get("recommendationKind");
  const assessmentFrom = values.get("assessmentFrom"); const assessmentTo = values.get("assessmentTo");
  if (!CONNECTION_ID.test(connectionId) || (accountId !== null && !ACCOUNT_ID.test(accountId))
    || (region !== null && !REGION.test(region)) || (application !== null && !SAFE_TEXT.test(application))
    || (compliance !== null && !["PolicyBreached", "PolicyMet", "NotApplicable", "MissingPolicy"].includes(compliance))
    || (recommendationKind !== null && !["CONFIG", "ALARM", "SOP", "TEST"].includes(recommendationKind))
    || (assessmentFrom !== null && !isDate(assessmentFrom))
    || (assessmentTo !== null && !isDate(assessmentTo))
    || (assessmentFrom !== null && assessmentTo !== null && assessmentFrom > assessmentTo)) bad();
  return { connectionId, accountId, region, application, compliance, recommendationKind, assessmentFrom, assessmentTo };
}
function ageHours(value: string): number | null {
  const parsed = Date.parse(value); if (!Number.isFinite(parsed) || parsed > Date.now() + 300_000) return null;
  return Math.round(Math.max(0, (Date.now() - parsed) / 3_600_000) * 100) / 100;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const query = parse(request); const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, query.connectionId);
    if (connection === null || connection.sourceKind !== "aws_trust_role" || connection.status !== "active") missing();
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    if (!isResilienceVueRuntimePermissionPack(connection.permissionPackVersion)) {
      return jsonResponse({
        schema: "sutra.finops-resilience-vue.v1",
        connectionId: connection.id,
        sourceState: "configuration_required",
        officialDefinition: RESILIENCE_VUE_OFFICIAL_DEFINITION,
        dashboard: null,
        latestAttempt: null,
        collection: {
          state: "unavailable",
          reason: "RESILIENCE_VUE_PERMISSION_PACK_UPGRADE_REQUIRED",
          lastAttemptAt: null,
        },
        limitations: [
          "Deploy immutable permission pack standard-2026-08.9 or its explicitly supported .8.10 successor before Resilience Hub collection can start.",
        ],
      });
    }
    const scope = { organizationId: authenticated.subject.orgId, customerId: connection.customerId, connectionId: connection.id };
    const repository = new ResilienceVueRepository();
    const runtime = new ResilienceVueRuntimeRepository();
    const [activeAll, historyAll, runtimeStatus] = await Promise.all([
      repository.listActiveSnapshots(scope), repository.listHistory(scope), runtime.getRuntimeStatus(scope),
    ]);
    const active = activeAll.filter((item) => (query.accountId === null || item.snapshot.scope.accountId === query.accountId)
      && (query.region === null || item.snapshot.scope.region === query.region));
    const history = historyAll.filter((item) => (query.accountId === null || item.accountId === query.accountId)
      && (query.region === null || item.region === query.region));
    if (active.length === 0) {
      const latest = history[0] ?? null;
      return jsonResponse({ schema: "sutra.finops-resilience-vue.v1", connectionId: connection.id,
        sourceState: runtimeStatus.state === "failed" ? "failed"
          : latest === null || latest.state === "configuration_required" ? "configuration_required" : latest.state,
        officialDefinition: RESILIENCE_VUE_OFFICIAL_DEFINITION,
        dashboard: null, latestAttempt: latest,
        collection: runtimeStatus,
        limitations: [
          "No accepted complete AWS Resilience Hub assessment generation is available for this selection.",
          "Estimated cost and the official recommendation dimensions require a versioned provider-schema migration; no values are synthesized from v1 evidence.",
        ] });
    }
    const targets = active.map((stored) => {
      const built = buildResilienceVueDashboard(stored.snapshot);
      const observed = built.observedAwsEvidence;
      const rangeAssessments = observed.assessmentHistory.filter((assessment) =>
        (query.assessmentFrom === null || assessment.startTime >= `${query.assessmentFrom}T00:00:00.000Z`)
        && (query.assessmentTo === null || assessment.startTime <= `${query.assessmentTo}T23:59:59.999Z`));
      const apps = observed.applicationPosture.filter((app) =>
        (query.application === null || app.name.toLocaleLowerCase().includes(query.application.toLocaleLowerCase()))
        && (query.compliance === null || app.complianceStatus === query.compliance)
        && (query.assessmentFrom === null || app.lastAssessmentTime !== null && app.lastAssessmentTime >= `${query.assessmentFrom}T00:00:00.000Z`)
        && (query.assessmentTo === null || app.lastAssessmentTime !== null && app.lastAssessmentTime <= `${query.assessmentTo}T23:59:59.999Z`));
      const appArns = new Set(apps.map((app) => app.appArn));
      const assessmentHistory = rangeAssessments.filter((assessment) => appArns.has(assessment.appArn));
      const assessmentArns = new Set(assessmentHistory.map((item) => item.assessmentArn));
      const recommendations = observed.recommendationBacklog.filter((item) => assessmentArns.has(item.assessmentArn)
        && (query.recommendationKind === null || item.kind === query.recommendationKind));
      const recommendationEvidence = observed.recommendationEvidence.filter((item) => assessmentArns.has(item.assessmentArn)
        && (query.recommendationKind === null || item.kind === query.recommendationKind));
      return {
        accountId: stored.snapshot.scope.accountId, partition: stored.snapshot.scope.partition,
        region: stored.snapshot.scope.region, generationId: stored.generationId,
        contentSha256: stored.contentSha256, captureId: stored.snapshot.captureId,
        completedAtIso: stored.snapshot.completedAtIso, state: stored.snapshot.state,
        applications: apps, assessmentHistory,
        componentPosture: observed.componentPosture.filter((item) => assessmentArns.has(item.assessmentArn)),
        recommendationEvidence, recommendations, resources: observed.resourceInventory.filter((item) => appArns.has(item.appArn)),
        drifts: observed.driftEvidence.filter((item) => assessmentArns.has(item.assessmentArn)),
        inferredPrioritization: built.inferredPrioritization.filter((item) => recommendations.some((rec) => rec.assessmentArn === item.assessmentArn && rec.recommendationId === item.recommendationId)),
        limitations: observed.limitations,
      };
    });
    const completedAt = targets.map((target) => target.completedAtIso).sort().at(0) ?? null;
    const currentAge = completedAt === null ? null : ageHours(completedAt);
    const newestActive = active.map((item) => item.snapshot.completedAtIso).sort().at(-1) ?? "";
    const newerIncomplete = history.some((item) => !item.complete && item.completedAtIso >= newestActive);
    const applicationCount = targets.reduce((sum, target) => sum + target.applications.length, 0);
    const assessedApplicationCount = targets.reduce((sum, target) => sum + target.applications.filter((item) => item.latestAssessmentArn !== null).length, 0);
    const policyMetApplicationCount = targets.reduce((sum, target) => sum + target.applications.filter((item) => item.complianceStatus === "PolicyMet").length, 0);
    const policyBreachedApplicationCount = targets.reduce((sum, target) => sum + target.applications.filter((item) => item.complianceStatus === "PolicyBreached").length, 0);
    const driftedApplicationCount = targets.reduce((sum, target) => sum + target.applications.filter((item) => item.driftStatus === "Detected").length, 0);
    const recommendationCount = targets.reduce((sum, target) => sum + target.recommendations.length, 0);
    const sourceState = newerIncomplete ? "partial" : currentAge === null || currentAge > FRESH_HOURS ? "stale"
      : applicationCount === 0 ? "empty" : "complete";
    return jsonResponse({
      schema: "sutra.finops-resilience-vue.v1", connectionId: connection.id, source: "AWS_RESILIENCE_HUB",
      sourceState, officialDefinition: RESILIENCE_VUE_OFFICIAL_DEFINITION,
      filters: query, freshness: { dataThroughAt: completedAt, ageHours: currentAge, staleAfterHours: FRESH_HOURS },
      summary: { targetCount: targets.length, applicationCount, assessedApplicationCount,
        unassessedApplicationCount: applicationCount - assessedApplicationCount, policyMetApplicationCount,
        policyBreachedApplicationCount, driftedApplicationCount, openRecommendationCount: recommendationCount },
      targets, history: history.slice(0, 180),
      filterOptions: {
        accounts: [...new Set(activeAll.map((item) => item.snapshot.scope.accountId))].sort(),
        regions: [...new Set(activeAll.map((item) => item.snapshot.scope.region))].sort(),
      },
      evidence: { acceptedHeads: active.map((item) => ({ generationId: item.generationId, contentSha256: item.contentSha256, captureId: item.snapshot.captureId })) },
      latestAttempt: history[0] ?? null,
      collection: runtimeStatus,
      limitations: [
        "RTO/RPO and recommendation fields are AWS Resilience Hub assessment evidence; Sutra priority scores are visibly labeled inference.",
        "Runtime state is derived from the durable ResilienceVue attempt ledger; live AWS provider acceptance remains a separate deployment gate.",
        "Estimated cost, availability architecture, optimization type, and App Component controls require a versioned capture-schema migration and are never inferred from v1 evidence.",
        ...(newerIncomplete ? ["A newer incomplete generation did not replace the last accepted complete target head."] : []),
      ],
    });
  } catch (error) { return errorResponse(error); }
}

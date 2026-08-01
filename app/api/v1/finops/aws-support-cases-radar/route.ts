import { AwsSupportCasesRepository } from "../../../../../db/finops-aws-support-cases-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import {
  AWS_SUPPORT_CASES_COLLECTION_BOUNDS,
  buildAwsSupportCasesRadar,
  type AwsSupportCasesDashboardOptions,
  type AwsSupportCasesRadarDashboard,
  type AwsSupportCasesSnapshot,
} from "../../../../../lib/finops-aws-support-cases-radar";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const STATUSES = new Set(["all-open", "customer-action-completed", "opened", "pending-customer-action", "reopened", "resolved", "unassigned", "work-in-progress"]);
const SEVERITIES = new Set(["low", "normal", "high", "urgent", "critical"]);
const ALLOWED = new Set(["connectionId", "accountId", "status", "severity", "serviceCode", "categoryCode"]);

function invalid(): never {
  throw Object.assign(new Error("The AWS Support Cases Radar request is invalid"), { code: "INVALID_INPUT", status: 400 });
}

function parse(request: Request): { readonly connectionId: string; readonly options: AwsSupportCasesDashboardOptions } {
  const parameters = new URL(request.url).searchParams;
  for (const key of parameters.keys()) if (!ALLOWED.has(key)) invalid();
  for (const key of ALLOWED) if (parameters.getAll(key).length > 1) invalid();
  const connectionId = parameters.get("connectionId") ?? "";
  const accountId = parameters.get("accountId"); const status = parameters.get("status");
  const severity = parameters.get("severity"); const serviceCode = parameters.get("serviceCode");
  const categoryCode = parameters.get("categoryCode");
  if (!CONNECTION_ID.test(connectionId) || (accountId !== null && !ACCOUNT_ID.test(accountId))
    || (status !== null && !STATUSES.has(status)) || (severity !== null && !SEVERITIES.has(severity))
    || (serviceCode !== null && !SAFE_CODE.test(serviceCode)) || (categoryCode !== null && !SAFE_CODE.test(categoryCode))) invalid();
  return { connectionId, options: {
    ...(accountId === null ? {} : { accountId }),
    ...(status === null ? {} : { status: status as AwsSupportCasesDashboardOptions["status"] }),
    ...(severity === null ? {} : { severity: severity as AwsSupportCasesDashboardOptions["severity"] }),
    ...(serviceCode === null ? {} : { serviceCode }), ...(categoryCode === null ? {} : { categoryCode }),
    includeSafeSummaries: false, caseLimit: AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumDashboardCases,
  } };
}

function publicCases(dashboard: AwsSupportCasesRadarDashboard) {
  return dashboard.cases.map((supportCase) => ({
    accountId: supportCase.accountId,
    caseReference: `case-…${supportCase.displayId.slice(-4)}`,
    categoryCode: supportCase.categoryCode, language: supportCase.language,
    serviceCode: supportCase.serviceCode, severity: supportCase.severity, status: supportCase.status,
    createdAt: supportCase.createdAt, updatedAt: supportCase.updatedAt,
    resolvedObservedAt: supportCase.resolvedObservedAt, submittedByKind: supportCase.submittedByKind,
    communicationCount: supportCase.communicationCount, attachmentCount: supportCase.attachmentCount,
    communicationsComplete: supportCase.communicationsComplete,
    firstObservedAt: supportCase.firstObservedAt, observationCount: supportCase.observationCount,
  }));
}

function historyPoint(snapshot: AwsSupportCasesSnapshot, generationId: string) {
  return { generationId, captureId: snapshot.captureId, observedAt: snapshot.observedAt,
    dataThroughAt: snapshot.window.nextWatermark, configurationState: snapshot.configurationState,
    collectionState: snapshot.collectionState, intendedAccountCount: snapshot.intendedAccounts.length,
    completeAccountCount: snapshot.accountCoverage.filter((entry) => entry.status === "complete").length,
    caseCount: snapshot.cases.length, openCount: snapshot.cases.filter((entry) => entry.status !== "resolved").length,
    highUrgentCriticalCount: snapshot.cases.filter((entry) => ["high", "urgent", "critical"].includes(entry.severity)).length };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const query = parse(request);
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, query.connectionId);
    if (connection === null || connection.sourceKind !== "aws_trust_role" || connection.status !== "active" || connection.partition === "aws-cn") {
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND", status: 404 });
    }
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = { organizationId: authenticated.subject.orgId, customerId: connection.customerId, connectionId: connection.id };
    const repository = new AwsSupportCasesRepository();
    const [active, latest, persisted] = await Promise.all([
      repository.getActiveSnapshot(scope), repository.getLatestSnapshot(scope), repository.listHistory(scope, 36),
    ]);
    const selected = active ?? latest;
    if (selected === null) return jsonResponse({
      schema: "sutra.finops-aws-support-cases-radar.v1", connectionId: connection.id,
      sourceState: "configuration_required", dashboard: null,
      collection: { available: false, reason: "AWS_SUPPORT_CASES_COLLECTOR_NOT_BOUND" },
      supportPlanState: "UNKNOWN",
    });
    const cohortKey = JSON.stringify((active?.snapshot ?? selected.snapshot).intendedAccounts);
    const acceptedHistory = active === null ? [selected] : persisted
      .filter((entry) => entry.snapshot.configurationState === "ready" && entry.snapshot.collectionState === "complete"
        && entry.snapshot.observedAt <= active.snapshot.observedAt
        && JSON.stringify(entry.snapshot.intendedAccounts) === cohortKey).reverse();
    const accepted = active !== null && !acceptedHistory.some((entry) => entry.generationId === active.generationId)
      ? [...acceptedHistory, active].slice(-AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumHistorySnapshots)
      : acceptedHistory;
    const boundarySnapshot = active?.snapshot ?? selected.snapshot;
    const dashboard = buildAwsSupportCasesRadar({ snapshots: accepted.map((entry) => entry.snapshot), boundary: {
      scope: boundarySnapshot.scope, binding: "SERVER_RESOLVED_CONNECTIONS", intendedAccounts: boundarySnapshot.intendedAccounts,
    }, options: query.options });
    const newerIncomplete = active !== null && latest !== null && latest.generationId !== active.generationId;
    const mappedState = newerIncomplete ? "partial" : dashboard.source.configurationState !== "ready"
      ? dashboard.source.configurationState : dashboard.source.collectionState !== "complete"
        ? dashboard.source.collectionState : dashboard.source.freshness === "stale" ? "stale"
          : dashboard.summary.caseCount === 0 ? "empty" : "complete";
    return jsonResponse({
      schema: "sutra.finops-aws-support-cases-radar.v1", connectionId: connection.id,
      sourceState: mappedState, generatedAt: dashboard.generatedAt,
      source: { ...dashboard.source, accountCoverage: dashboard.source.accountCoverage.map((entry) => ({
        accountId: entry.accountId, supportPlan: entry.supportPlan, entitlementState: entry.entitlementState,
        readPermissionsValidated: entry.readPermissionsValidated, status: entry.status,
        casesExhausted: entry.casesExhausted, communicationsExhausted: entry.communicationsExhausted,
        caseCount: entry.caseCount, communicationCount: entry.communicationCount, failureCode: entry.failureCode,
      })) }, summary: dashboard.summary, cases: publicCases(dashboard),
      casesTruncated: dashboard.casesTruncated, disclosure: dashboard.disclosure,
      history: persisted.map((entry) => historyPoint(entry.snapshot, entry.generationId)),
      provenance: { activeGenerationId: active?.generationId ?? null, latestGenerationId: latest?.generationId ?? null,
        newerIncomplete, contentSha256: (active ?? selected).contentSha256,
        latestAttemptContentSha256: latest?.contentSha256 ?? null,
        captureId: (active ?? selected).snapshot.captureId,
        observedAt: (active ?? selected).snapshot.observedAt,
        dataThroughAt: (active ?? selected).snapshot.window.nextWatermark,
        historyCoverage: dashboard.source.historyCoverage, watermarkCoverage: dashboard.source.watermarkCoverage,
        organizationCoverageClaimed: false },
      collection: { available: false, reason: "AWS_SUPPORT_CASES_COLLECTOR_NOT_BOUND" },
      summarization: { available: false, provider: null, reason: "OPTIONAL_BEDROCK_SUMMARIZATION_NOT_CONFIGURED" },
    });
  } catch (error) { return errorResponse(error); }
}

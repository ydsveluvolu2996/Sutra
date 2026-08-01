import { AwsConfigComplianceRepository } from "../../../../../db/finops-aws-config-compliance-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const SAFE_NAME = /^[^\u0000-\u001f\u007f<>]{1,256}$/u;
const RESOURCE_TYPE = /^AWS::[A-Za-z0-9]+(?:::[A-Za-z0-9]+)+$/u;
const ALLOWED = new Set(["connectionId", "accountId", "region", "ruleName", "complianceType", "resourceType"]);
const RESULT_BOUND = 500;
const FRESHNESS_SLA_HOURS = 48;

function invalidRequest(): never {
  throw Object.assign(new Error("The AWS Config compliance request is invalid"), { code: "INVALID_INPUT", status: 400 });
}

function notFound(): never {
  throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND", status: 404 });
}

function parseQuery(request: Request) {
  const values = new URL(request.url).searchParams;
  for (const key of values.keys()) if (!ALLOWED.has(key)) invalidRequest();
  for (const key of ALLOWED) if (values.getAll(key).length > 1) invalidRequest();
  const connectionId = values.get("connectionId") ?? "";
  const accountId = values.get("accountId");
  const region = values.get("region");
  const ruleName = values.get("ruleName");
  const complianceType = values.get("complianceType");
  const resourceType = values.get("resourceType");
  if (!CONNECTION_ID.test(connectionId)
    || (accountId !== null && !ACCOUNT_ID.test(accountId))
    || (region !== null && !REGION.test(region))
    || (ruleName !== null && !SAFE_NAME.test(ruleName))
    || (complianceType !== null && !["COMPLIANT", "NON_COMPLIANT", "NO_RESULTS"].includes(complianceType))
    || (resourceType !== null && !RESOURCE_TYPE.test(resourceType))) invalidRequest();
  return { connectionId, accountId, region, ruleName, complianceType, resourceType };
}

function ageHours(value: string): number | null {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > Date.now() + 300_000) return null;
  return Math.round(Math.max(0, (Date.now() - time) / 3_600_000) * 100) / 100;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const query = parseQuery(request);
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, query.connectionId);
    if (connection === null || connection.sourceKind !== "aws_trust_role" || connection.status !== "active") notFound();
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = {
      organizationId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId: connection.id,
    };
    const repository = new AwsConfigComplianceRepository();
    const [active, history] = await Promise.all([
      repository.getActiveSnapshot(scope),
      repository.getHistory(scope),
    ]);
    const latest = history[0] ?? null;
    if (active === null) {
      const sourceState = latest === null || latest.state === "CONFIGURATION_REQUIRED"
        ? "configuration_required" : latest.state === "FAILED" ? "failed"
          : latest.state === "STALE" ? "stale" : "partial";
      return jsonResponse({
        schema: "sutra.finops-aws-config-resource-compliance.v1",
        connectionId: connection.id,
        source: "AWS_CONFIG_ORGANIZATION_AGGREGATOR",
        sourceState,
        dashboard: null,
        latestAttempt: latest === null ? null : {
          snapshotId: latest.snapshotId, state: latest.state, capturedAt: latest.capturedAt,
          contentSha256: latest.contentSha256,
        },
        activation: { available: false, reason: "AWS_CONFIG_COLLECTOR_ADAPTER_NOT_IMPLEMENTED" },
      });
    }

    const snapshot = active.snapshot;
    const currentAgeHours = ageHours(snapshot.capturedAt);
    const newerIncomplete = latest !== null && latest.snapshotId !== active.snapshotId
      && latest.capturedAt >= active.capturedAt;
    const rules = snapshot.rules.filter((rule) =>
      (query.accountId === null || rule.accountId === query.accountId)
      && (query.region === null || rule.region === query.region)
      && (query.ruleName === null || rule.ruleName === query.ruleName)
      && (query.complianceType === null || rule.complianceType === query.complianceType)
      && (query.resourceType === null || rule.resourceTypes.includes(query.resourceType)));
    const evaluations = snapshot.evaluations.filter((evaluation) =>
      (query.accountId === null || evaluation.accountId === query.accountId)
      && (query.region === null || evaluation.region === query.region)
      && (query.ruleName === null || evaluation.ruleName === query.ruleName)
      && (query.complianceType === null || query.complianceType === "NO_RESULTS" ? query.complianceType === null : evaluation.complianceType === query.complianceType)
      && (query.resourceType === null || evaluation.resourceType === query.resourceType));
    const inventory = snapshot.resourceInventory.filter((resource) =>
      (query.accountId === null || resource.accountId === query.accountId)
      && (query.region === null || resource.region === query.region)
      && (query.resourceType === null || resource.resourceType === query.resourceType));
    const aFilterIsActive = query.accountId !== null || query.region !== null || query.ruleName !== null
      || query.complianceType !== null || query.resourceType !== null;
    const sourceState = newerIncomplete ? latest?.state === "FAILED" ? "failed" : "partial"
      : currentAgeHours === null || currentAgeHours > FRESHNESS_SLA_HOURS ? "stale"
        : aFilterIsActive && rules.length === 0 && evaluations.length === 0 && inventory.length === 0 ? "empty"
          : snapshot.state === "EMPTY" ? "empty" : "complete";
    return jsonResponse({
      schema: "sutra.finops-aws-config-resource-compliance.v1",
      connectionId: connection.id,
      source: "AWS_CONFIG_ORGANIZATION_AGGREGATOR",
      sourceState,
      freshness: { capturedAt: snapshot.capturedAt, ageHours: currentAgeHours, staleAfterHours: FRESHNESS_SLA_HOURS },
      coverage: snapshot.organizationCoverage,
      channelStates: snapshot.channelStates,
      counts: snapshot.counts,
      filters: {
        accountId: query.accountId, region: query.region, ruleName: query.ruleName,
        complianceType: query.complianceType, resourceType: query.resourceType,
      },
      rules: rules.slice(0, RESULT_BOUND),
      rulesTruncated: rules.length > RESULT_BOUND,
      evaluations: evaluations.slice(0, RESULT_BOUND),
      evaluationsTruncated: evaluations.length > RESULT_BOUND,
      conformancePacks: snapshot.conformancePacks.slice(0, RESULT_BOUND),
      conformancePacksTruncated: snapshot.conformancePacks.length > RESULT_BOUND,
      resourceCounts: snapshot.resourceCounts.slice(0, RESULT_BOUND),
      resourceCountsTruncated: snapshot.resourceCounts.length > RESULT_BOUND,
      inventory: inventory.slice(0, RESULT_BOUND),
      inventoryTruncated: inventory.length > RESULT_BOUND,
      activity: snapshot.activity,
      actualCosts: snapshot.actualCosts,
      evidence: { snapshotId: active.snapshotId, captureId: snapshot.captureId, contentSha256: active.contentSha256 },
      history: history.slice(0, 12).map((item) => ({
        snapshotId: item.snapshotId, state: item.state, capturedAt: item.capturedAt,
        rules: item.snapshot.counts.rules, nonCompliantResources: item.snapshot.counts.nonCompliantResources,
      })),
      latestAttempt: latest === null ? null : {
        snapshotId: latest.snapshotId, state: latest.state, capturedAt: latest.capturedAt,
        contentSha256: latest.contentSha256,
      },
      activation: { available: false, reason: "AWS_CONFIG_COLLECTOR_ADAPTER_NOT_IMPLEMENTED" },
      limitations: [
        ...snapshot.limitations,
        "Collection activation remains unavailable until the permanent bounded AWS Config collector adapter is implemented and provider-validated.",
        "Tag-compliance fields and resource-specific configuration attributes are not collected by the minimized v1 inventory projection.",
      ],
    });
  } catch (error) {
    return errorResponse(error);
  }
}

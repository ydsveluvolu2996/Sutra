import { AwsBudgetsOrganizationRepository } from "../../../../../db/finops-aws-budgets-organization-repository";
import { FinopsFoundationalConfigRepository } from "../../../../../db/finops-foundational-config-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import {
  buildAwsBudgetsOrganizationDashboard,
  type AwsBudgetType,
  type AwsBudgetsDashboardQuery,
  type AwsBudgetsSnapshot,
} from "../../../../../lib/finops-aws-budgets-organization";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>]{1,128}$/u;
const CURSOR = /^v1:(?:0|[1-9]\d{0,8})$/u;
const BUDGET_TYPES = new Set<AwsBudgetType>([
  "COST", "USAGE", "RI_UTILIZATION", "RI_COVERAGE",
  "SAVINGS_PLANS_UTILIZATION", "SAVINGS_PLANS_COVERAGE",
]);
const ALLOWED = new Set([
  "connectionId", "currency", "budgetType", "accountId", "budgetLevel",
  "namePrefix", "effectiveAt", "cursor", "limit",
]);
const FRESHNESS_SLA_HOURS = 24;

function invalid(): never {
  throw Object.assign(new Error("The AWS Budgets dashboard request is invalid"), { code: "INVALID_INPUT", status: 400 });
}

function parse(request: Request): { readonly connectionId: string; readonly query: AwsBudgetsDashboardQuery } {
  const values = new URL(request.url).searchParams;
  for (const key of values.keys()) if (!ALLOWED.has(key)) invalid();
  for (const key of ALLOWED) if (values.getAll(key).length > 1) invalid();
  const connectionId = values.get("connectionId") ?? "";
  const currency = values.get("currency");
  const budgetType = values.get("budgetType");
  const accountId = values.get("accountId");
  const budgetLevel = values.get("budgetLevel");
  const namePrefix = values.get("namePrefix");
  const effectiveAt = values.get("effectiveAt");
  const cursor = values.get("cursor");
  const limitText = values.get("limit");
  const limit = limitText === null ? 100 : Number(limitText);
  if (!CONNECTION_ID.test(connectionId)
    || (currency !== null && !CURRENCY.test(currency))
    || (budgetType !== null && !BUDGET_TYPES.has(budgetType as AwsBudgetType))
    || (accountId !== null && !ACCOUNT_ID.test(accountId))
    || (budgetLevel !== null && !SAFE_TEXT.test(budgetLevel))
    || (namePrefix !== null && (!SAFE_TEXT.test(namePrefix) || namePrefix.length > 100))
    || (effectiveAt !== null && (!Number.isFinite(Date.parse(effectiveAt))
      || new Date(Date.parse(effectiveAt)).toISOString() !== effectiveAt))
    || (cursor !== null && !CURSOR.test(cursor))
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid();
  return {
    connectionId,
    query: {
      currencies: currency === null ? [] : [currency],
      budgetTypes: budgetType === null ? [] : [budgetType as AwsBudgetType],
      accountIds: accountId === null ? [] : [accountId],
      budgetLevels: budgetLevel === null ? [] : [budgetLevel],
      ...(namePrefix === null ? {} : { namePrefix }),
      ...(effectiveAt === null ? {} : { effectiveAtIso: effectiveAt }),
      page: { limit, ...(cursor === null ? {} : { cursor }) },
    },
  };
}

function currentFreshness(snapshot: AwsBudgetsSnapshot) {
  const epoch = snapshot.dataThroughAt === null ? null : Date.parse(snapshot.dataThroughAt);
  const ageHours = epoch === null || !Number.isFinite(epoch) || epoch > Date.now() + 300_000
    ? null : Math.round(Math.max(0, (Date.now() - epoch) / 3_600_000) * 100) / 100;
  return {
    status: ageHours === null ? "unknown" as const
      : ageHours > FRESHNESS_SLA_HOURS ? "stale" as const : "fresh" as const,
    ageHours,
    staleAfterHours: FRESHNESS_SLA_HOURS,
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const parsed = parse(request);
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, parsed.connectionId);
    if (connection === null || connection.sourceKind !== "aws_trust_role" || connection.status !== "active") {
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND", status: 404 });
    }
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = {
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId: connection.id,
      accountId: connection.awsAccountId,
      partition: connection.partition,
    };
    const repository = new AwsBudgetsOrganizationRepository();
    const taxonomyRepository = new FinopsFoundationalConfigRepository();
    const foundationalScope = {
      organizationId: scope.orgId, customerId: scope.customerId, connectionId: scope.connectionId,
    };
    const [active, latest, history, taxonomy] = await Promise.all([
      repository.getActiveGeneration(scope),
      repository.getLatestGeneration(scope),
      repository.listHistory(scope, 36),
      taxonomyRepository.activeTaxonomy(foundationalScope),
    ]);
    const selected = active ?? latest;
    if (selected === null) return jsonResponse({
      schema: "sutra.finops-aws-budgets-dashboard.v1",
      connectionId: connection.id,
      source: "AWS_BUDGETS_PROVIDER",
      sourceState: "configuration_required",
      dashboard: null,
      separation: {
        providerSource: "AWS_BUDGETS",
        sutraInternalBudgetsIncluded: false,
        reason: "Sutra-authored budgets are a separate product source and are never merged with AWS Budgets.",
      },
      collection: { jobContractAvailable: true, providerAdapterAvailable: false, reason: "AWS_BUDGETS_SIGNED_BROKER_ADAPTER_NOT_DEPLOYED" },
    });
    const freshness = currentFreshness(selected.snapshot);
    const snapshot = {
      ...selected.snapshot,
      freshness: {
        status: freshness.status,
        ageSeconds: freshness.ageHours === null ? null : Math.floor(freshness.ageHours * 3_600),
        staleAfterSeconds: FRESHNESS_SLA_HOURS * 3_600,
      },
    };
    const dashboard = buildAwsBudgetsOrganizationDashboard({
      snapshot,
      hierarchy: selected.hierarchy,
      taxonomy: taxonomy?.taxonomy ?? null,
      query: parsed.query,
    });
    const newerIncomplete = active !== null && latest !== null && latest.generationId !== active.generationId;
    const sourceState = newerIncomplete ? "partial"
      : dashboard.state === "unavailable" ? "failed"
        : dashboard.state === "configuration_required" ? "configuration_required"
          : dashboard.state === "partial" ? "partial"
            : freshness.status === "stale" || (freshness.status === "unknown" && dashboard.budgets.length > 0) ? "stale"
              : dashboard.coverage.totalAwsBudgets === 0 || dashboard.budgets.length === 0 ? "empty" : "complete";
    return jsonResponse({
      schema: "sutra.finops-aws-budgets-dashboard.v1",
      connectionId: connection.id,
      source: "AWS_BUDGETS_PROVIDER",
      sourceState,
      freshness: { dataThroughAt: snapshot.dataThroughAt, ...freshness },
      filters: parsed.query,
      dashboard,
      history,
      evidence: {
        generationId: selected.generationId,
        activeGenerationId: active?.generationId ?? null,
        latestGenerationId: latest?.generationId ?? null,
        sourceCaptureId: selected.snapshot.captureId,
        contentSha256: selected.contentSha256,
        hierarchyEvidenceId: selected.hierarchy?.sourceEvidenceId ?? null,
        taxonomyEvidenceId: taxonomy?.taxonomy.evidence.sourceEvidenceId ?? null,
        newerIncomplete,
      },
      separation: {
        providerSource: dashboard.source,
        sutraInternalBudgetsIncluded: dashboard.internalSutraBudgets.included,
        reason: dashboard.internalSutraBudgets.reason,
      },
      collection: { jobContractAvailable: true, providerAdapterAvailable: false, reason: "AWS_BUDGETS_SIGNED_BROKER_ADAPTER_NOT_DEPLOYED" },
      prerequisites: [
        "AWS Budgets definitions and calculated spend in the connected payer or member account.",
        "AWS Organizations hierarchy reads from the management account or an authorized delegated administrator.",
        "The cid:budget-level provider tag on each AWS Budget for dashboard hierarchy grouping.",
      ],
    });
  } catch (error) {
    return errorResponse(error);
  }
}

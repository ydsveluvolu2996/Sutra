import { isCollectableAwsSourceKind } from "../../../../../lib/aws-connection-source";
import {
  FinopsActiveBillingQueryRepository,
  type FinopsActiveBillingPartition,
} from "../../../../../db/finops-active-billing-query-repository";
import { FinopsFoundationalConfigRepository } from "../../../../../db/finops-foundational-config-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import {
  assertSessionCapability,
  requireApiSession,
} from "../../../../../lib/api-auth";
import { evaluateFinopsKpis } from "../../../../../lib/finops-kpi";
import { FINOPS_KPI_OFFICIAL_DEFINITION } from "../../../../../lib/finops-kpi-official-definition";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const ALLOWED_QUERY_PARAMETERS = new Set([
  "connectionId", "period", "accountId", "payerAccountId",
]);

function invalidRequest(): never {
  throw Object.assign(
    new Error("The Foundational KPI request is invalid"),
    { code: "INVALID_INPUT", status: 400 },
  );
}

function queryFrom(request: Request): {
  readonly connectionId: string;
  readonly period: string | null;
  readonly accountId: string | null;
  readonly payerAccountId: string | null;
} {
  const parameters = new URL(request.url).searchParams;
  for (const key of parameters.keys()) {
    if (!ALLOWED_QUERY_PARAMETERS.has(key)) invalidRequest();
  }
  for (const key of ALLOWED_QUERY_PARAMETERS) {
    if (parameters.getAll(key).length > 1) invalidRequest();
  }
  const connectionId = parameters.get("connectionId") ?? "";
  const period = parameters.get("period");
  const accountId = parameters.get("accountId");
  const payerAccountId = parameters.get("payerAccountId");
  if (
    !CONNECTION_ID.test(connectionId)
    || (period !== null && !PERIOD.test(period))
    || (accountId !== null && !ACCOUNT_ID.test(accountId))
    || (payerAccountId !== null && !ACCOUNT_ID.test(payerAccountId))
  ) invalidRequest();
  return { connectionId, period, accountId, payerAccountId };
}

function sortedUnique(values: readonly (string | null)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string =>
    value !== null && ACCOUNT_ID.test(value)))].sort();
}

function availablePeriods(
  partitions: readonly FinopsActiveBillingPartition[],
): readonly {
  readonly period: string;
  readonly generationId: string;
  readonly committedAtIso: string;
}[] {
  const seen = new Set<string>();
  return partitions.flatMap((partition) => {
    if (seen.has(partition.scope.billingPeriod)) return [];
    seen.add(partition.scope.billingPeriod);
    return [{
      period: partition.scope.billingPeriod,
      generationId: partition.scope.generationId,
      committedAtIso: partition.evidence.activeCommittedAtIso,
    }];
  });
}

function periodWindow(
  period: string,
  evaluatedAt: Date,
): { readonly startIso: string; readonly endIso: string } | null {
  const [yearText, monthText] = period.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const start = Date.UTC(year, month - 1, 1);
  const end = Date.UTC(year, month, 1);
  const boundedEnd = Math.min(end, evaluatedAt.getTime());
  if (
    !Number.isFinite(start)
    || !Number.isFinite(end)
    || boundedEnd <= start
  ) return null;
  return {
    startIso: new Date(start).toISOString(),
    endIso: new Date(boundedEnd).toISOString(),
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const query = queryFrom(request);
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(
      authenticated.subject.orgId,
      query.connectionId,
    );
    if (
      connection === null
      || !isCollectableAwsSourceKind(connection.sourceKind)
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

    const owner = {
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId: query.connectionId,
    };
    const billing = new FinopsActiveBillingQueryRepository();
    const partitions = await billing.listActivePartitions(owner);
    const periods = availablePeriods(partitions);
    const selected = query.period === null
      ? partitions[0] ?? null
      : partitions.find((partition) =>
        partition.scope.billingPeriod === query.period) ?? null;
    const evaluatedAt = new Date();
    const window = selected === null
      ? null
      : periodWindow(selected.scope.billingPeriod, evaluatedAt);
    if (selected === null || window === null) {
      return jsonResponse({
        connectionId: query.connectionId,
        selectedPeriod: query.period,
        availablePeriods: periods,
        report: null,
        goalsConfigured: 0,
        sourceState: "waiting",
        sourceEvidence: null,
        filters: { accountId: query.accountId, payerAccountId: query.payerAccountId },
        filterOptions: { accountIds: [], payerAccountIds: [] },
        officialDefinition: FINOPS_KPI_OFFICIAL_DEFINITION,
      });
    }

    const active = await billing.loadActivePartition(owner, selected);
    const configuration = new FinopsFoundationalConfigRepository();
    const goals = await configuration.goalsForEvaluation(active.scope);
    const rows = active.rows.filter((row) =>
      (query.accountId === null || row.line.usageAccountId === query.accountId)
      && (query.payerAccountId === null
        || row.line.payerAccountId === query.payerAccountId));
    const report = evaluateFinopsKpis({
      scope: active.scope,
      rows,
      evidenceWindow: {
        startIso: window.startIso,
        endIso: window.endIso,
        evaluatedAtIso: evaluatedAt.toISOString(),
        sourceEvidenceId:
          `aws-data-export:${active.evidence.activeManifestSha256}`,
        manifestSha256: active.evidence.activeManifestSha256,
      },
      goals,
      resourceAgeEvidence: [],
      savingsAssumptions: [],
    });
    return jsonResponse({
      connectionId: query.connectionId,
      selectedPeriod: active.scope.billingPeriod,
      availablePeriods: periods,
      report,
      goalsConfigured: goals.length,
      sourceState: "complete",
      filters: { accountId: query.accountId, payerAccountId: query.payerAccountId },
      filterOptions: {
        accountIds: sortedUnique(active.rows.map((row) => row.line.usageAccountId)),
        payerAccountIds: sortedUnique(active.rows.map((row) => row.line.payerAccountId)),
      },
      officialDefinition: FINOPS_KPI_OFFICIAL_DEFINITION,
      sourceEvidence: {
        activeGeneration: {
          manifestSha256: active.evidence.activeManifestSha256,
          generationId: active.scope.generationId,
          sourceUpdatedAtIso: active.evidence.activeSourceUpdatedAtIso,
          observedAtIso: active.evidence.activeObservedAtIso,
          committedAtIso: active.evidence.activeCommittedAtIso,
          acceptedRows: active.evidence.acceptedRows,
          rejectedRows: active.evidence.rejectedRows,
        },
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

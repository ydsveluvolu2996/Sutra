import {
  FinopsActiveBillingQueryRepository,
  type FinopsActiveBillingPartition,
} from "../../../../../db/finops-active-billing-query-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import {
  assertSessionCapability,
  requireApiSession,
} from "../../../../../lib/api-auth";
import {
  DATA_TRANSFER_ANALYSIS_BOUNDS,
  buildDataTransferAnalysis,
} from "../../../../../lib/finops-data-transfer";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const GROUP_LIMIT = /^(?:[1-9]|[1-9]\d|[1-9]\d{2}|[1-4]\d{3}|5000)$/u;
const ALLOWED_QUERY_PARAMETERS = new Set([
  "connectionId",
  "period",
  "groupLimit",
]);

function invalidRequest(): never {
  throw Object.assign(new Error("The Data Transfer request is invalid"), {
    code: "INVALID_INPUT",
    status: 400,
  });
}

function parseQuery(request: Request): {
  readonly connectionId: string;
  readonly period: string | null;
  readonly groupLimit: number;
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
  const groupLimit = parameters.get("groupLimit") ?? "250";
  if (
    !CONNECTION_ID.test(connectionId)
    || (period !== null && !PERIOD.test(period))
    || !GROUP_LIMIT.test(groupLimit)
  ) invalidRequest();
  return { connectionId, period, groupLimit: Number(groupLimit) };
}

function canonicalCur2History(
  partitions: readonly FinopsActiveBillingPartition[],
): readonly FinopsActiveBillingPartition[] {
  const eligible = partitions.filter((partition) =>
    partition.evidence.activeSourceFormat === "aws-cur"
    && partition.evidence.activeSourceVersion === "2.0");
  const exportName = eligible[0]?.scope.exportName;
  if (exportName === undefined) return [];
  const periods = new Set<string>();
  return eligible.flatMap((partition) => {
    if (
      partition.scope.exportName !== exportName
      || periods.has(partition.scope.billingPeriod)
    ) return [];
    periods.add(partition.scope.billingPeriod);
    return [partition];
  });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const query = parseQuery(request);
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
      throw Object.assign(new Error("Cloud connection not found"), {
        code: "NOT_FOUND",
        status: 404,
      });
    }
    assertSessionCapability(
      authenticated,
      "connection:read",
      connection.customerId,
    );

    const owner = {
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId: connection.id,
    };
    const repository = new FinopsActiveBillingQueryRepository();
    const history = canonicalCur2History(
      await repository.listActivePartitions(owner),
    );
    const availablePeriods = history.map((partition) => ({
      period: partition.scope.billingPeriod,
      generationId: partition.scope.generationId,
      committedAtIso: partition.evidence.activeCommittedAtIso,
    }));
    const selected = query.period === null
      ? history[0] ?? null
      : history.find((partition) =>
        partition.scope.billingPeriod === query.period) ?? null;
    if (selected === null) {
      return jsonResponse({
        connectionId: query.connectionId,
        selectedPeriod: query.period,
        availablePeriods,
        report: null,
        sourceState: "waiting",
      });
    }
    if (
      selected.evidence.acceptedRows
        > DATA_TRANSFER_ANALYSIS_BOUNDS.maximumRows
    ) invalidRequest();
    const dataset = await repository.loadActivePartition(owner, selected);
    const payerAccountIds = [...new Set(dataset.rows.flatMap((row) =>
      row.line.payerAccountId === null ? [] : [row.line.payerAccountId]))]
      .sort();
    const usageAccountIds = [...new Set(dataset.rows.map((row) =>
      row.line.usageAccountId))].sort();
    if (dataset.rows.length === 0) {
      return jsonResponse({
        connectionId: query.connectionId,
        selectedPeriod: selected.scope.billingPeriod,
        availablePeriods,
        report: null,
        sourceState: "empty",
      });
    }
    if (
      (
        payerAccountIds.length === 0
        || dataset.rows.some((row) => row.line.payerAccountId === null)
      )
    ) {
      return jsonResponse({
        connectionId: query.connectionId,
        selectedPeriod: selected.scope.billingPeriod,
        availablePeriods,
        report: null,
        sourceState: "source_incomplete",
      });
    }
    const sourceUpdatedAtIso = dataset.evidence.activeSourceUpdatedAtIso;
    const activeFileCount = dataset.evidence.activeFileCount;
    const evidenceErrorCode = activeFileCount === null
      ? "MANIFEST_OBJECT_COVERAGE_UNAVAILABLE"
      : sourceUpdatedAtIso === null
        ? "SOURCE_TIMESTAMPS_UNAVAILABLE"
        : dataset.evidence.rejectedRows > 0
          ? "SOURCE_ROWS_REJECTED"
          : null;
    const report = buildDataTransferAnalysis(
      { scope: dataset.scope, payerAccountIds, usageAccountIds },
      {
        schemaVersion: "sutra.finops-data-transfer-capture.v1",
        scope: dataset.scope,
        evidence: {
          source: "AWS_CUR2_ACTIVE_GENERATION",
          sourceFormat: "aws-cur",
          sourceVersion: "2.0",
          sourceEvidenceId:
            `active-cur2:${dataset.evidence.activeManifestSha256}`,
          manifestSha256: dataset.evidence.activeManifestSha256,
          generationId: dataset.scope.generationId,
          generationState: "ACTIVE",
          generatedAtIso: sourceUpdatedAtIso,
          dataThroughAtIso: sourceUpdatedAtIso,
          observedAtIso: dataset.evidence.activeObservedAtIso,
          payerAccountIds,
          usageAccountIds,
          status: evidenceErrorCode === null ? "SUCCEEDED" : "PARTIAL",
          manifestObjectCount: activeFileCount,
          processedObjectCount: activeFileCount,
          sourceRowCount:
            dataset.evidence.acceptedRows + dataset.evidence.rejectedRows,
          acceptedRowCount: dataset.evidence.acceptedRows,
          rejectedRowCount: dataset.evidence.rejectedRows,
          rowsExhausted: true,
          errorCode: evidenceErrorCode,
        },
        rows: dataset.rows,
        groupLimit: query.groupLimit,
      },
    );
    return jsonResponse({
      connectionId: query.connectionId,
      selectedPeriod: selected.scope.billingPeriod,
      availablePeriods,
      report,
      sourceState: report.state.toLowerCase(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

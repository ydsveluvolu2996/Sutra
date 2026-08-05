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
  buildFinopsCudosDashboard,
  FINOPS_CUDOS_COST_BASES,
  type FinopsCudosCostBasis,
  type FinopsCudosOptions,
} from "../../../../../lib/finops-cudos";
import { FINOPS_CUDOS_OFFICIAL_DEFINITION } from
  "../../../../../lib/finops-cudos-official-definition";
import {
  errorResponse,
  jsonResponse,
} from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const RANKING_LIMIT = /^(?:[1-9]|[1-9]\d|100)$/u;
const ALLOWED_QUERY_PARAMETERS = new Set([
  "connectionId",
  "period",
  "costBasis",
  "rankingLimit",
]);

function invalidRequest(): never {
  throw Object.assign(
    new Error("The CUDOS dashboard request is invalid"),
    { code: "INVALID_INPUT", status: 400 },
  );
}

function parseQuery(request: Request): {
  readonly connectionId: string;
  readonly period: string | null;
  readonly options: FinopsCudosOptions;
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
  const requestedCostBasis = parameters.get("costBasis");
  const requestedRankingLimit = parameters.get("rankingLimit");
  if (
    !CONNECTION_ID.test(connectionId)
    || (period !== null && !PERIOD.test(period))
    || (
      requestedCostBasis !== null
      && !FINOPS_CUDOS_COST_BASES.includes(
        requestedCostBasis as FinopsCudosCostBasis,
      )
    )
    || (
      requestedRankingLimit !== null
      && !RANKING_LIMIT.test(requestedRankingLimit)
    )
  ) invalidRequest();

  return {
    connectionId,
    period,
    options: {
      ...(requestedCostBasis === null
        ? {}
        : { costBasis: requestedCostBasis as FinopsCudosCostBasis }),
      ...(requestedRankingLimit === null
        ? {}
        : { rankingLimit: Number.parseInt(requestedRankingLimit, 10) }),
    },
  };
}

function distinctPeriods(
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
    const repository = new FinopsActiveBillingQueryRepository();
    const partitions = await repository.listActivePartitions(owner);
    const availablePeriods = distinctPeriods(partitions);
    const selected = query.period === null
      ? partitions[0] ?? null
      : partitions.find((partition) =>
        partition.scope.billingPeriod === query.period) ?? null;
    if (selected === null) {
      return jsonResponse({
        connectionId: query.connectionId,
        selectedPeriod: query.period,
        availablePeriods,
        report: null,
        sourceState: "waiting",
        sourceEvidence: null,
        officialDefinition: FINOPS_CUDOS_OFFICIAL_DEFINITION,
      });
    }

    const active = await repository.loadActivePartition(owner, selected);
    const report = buildFinopsCudosDashboard({
      scope: active.scope,
      rows: active.rows,
      options: query.options,
    });
    const sourceIncompleteReasons = [
      ...(active.evidence.rejectedRows > 0
        ? ["SOURCE_ROWS_REJECTED"]
        : []),
      ...(active.evidence.activeFileCount === null
        ? ["MANIFEST_OBJECT_COVERAGE_UNAVAILABLE"]
        : []),
      ...(active.evidence.activeSourceUpdatedAtIso === null
        ? ["SOURCE_FRESHNESS_UNAVAILABLE"]
        : []),
    ];
    return jsonResponse({
      connectionId: query.connectionId,
      selectedPeriod: active.scope.billingPeriod,
      availablePeriods,
      report,
      sourceState: sourceIncompleteReasons.length === 0
        ? "complete"
        : "partial",
      sourceEvidence: {
        activeGeneration: {
          manifestSha256: active.evidence.activeManifestSha256,
          generationId: active.scope.generationId,
          sourceUpdatedAtIso: active.evidence.activeSourceUpdatedAtIso,
          observedAtIso: active.evidence.activeObservedAtIso,
          committedAtIso: active.evidence.activeCommittedAtIso,
          acceptedRows: active.evidence.acceptedRows,
          rejectedRows: active.evidence.rejectedRows,
          activeFileCount: active.evidence.activeFileCount,
          incompleteReasons: sourceIncompleteReasons,
        },
      },
      officialDefinition: FINOPS_CUDOS_OFFICIAL_DEFINITION,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

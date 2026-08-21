import { isCollectableAwsSourceKind } from "../../../../../lib/aws-connection-source";
import {
  FinopsActiveBillingQueryRepository,
  type FinopsActiveBillingPartition,
} from "../../../../../db/finops-active-billing-query-repository";
import {
  FinopsFoundationalConfigRepository,
  type FinopsFoundationalTenantScope,
} from "../../../../../db/finops-foundational-config-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import {
  assertSessionCapability,
  requireApiSession,
} from "../../../../../lib/api-auth";
import {
  buildFinopsCostIntelligence,
  FINOPS_COST_BASES,
  FINOPS_COST_DIMENSIONS,
  type FinopsAllocationMode,
  type FinopsCostBasis,
  type FinopsCostDimension,
  type FinopsExplorerFilter,
} from "../../../../../lib/finops-cost-intelligence";
import { FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION } from
  "../../../../../lib/finops-cost-intelligence-official-definition";
import {
  errorResponse,
  jsonResponse,
} from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const MAX_PERIODS = 36;
const MAX_TOTAL_ROWS = 250_000;
const MAX_EXPLORER_FILTERS = 8;
const MAX_EXPLORER_LIMIT = 200;
const MAX_FILTER_VALUE_LENGTH = 256;
const ALLOCATION_MODES = new Set<FinopsAllocationMode>([
  "showback",
  "chargeback",
]);
const ALLOWED_QUERY_PARAMETERS = new Set([
  "connectionId",
  "baselinePeriod",
  "comparisonPeriod",
  "costBasis",
  "allocationMode",
  "moverDimension",
  "pivotRow",
  "pivotColumn",
  "explorerPeriod",
  "explorerLimit",
  "explorerFilter",
]);
const MULTI_VALUE_QUERY_PARAMETERS = new Set(["explorerFilter"]);

interface CostIntelligenceQuery {
  readonly connectionId: string;
  readonly baselinePeriod: string | null;
  readonly comparisonPeriod: string | null;
  readonly costBasis: FinopsCostBasis;
  readonly allocationMode: FinopsAllocationMode;
  readonly moverDimension: FinopsCostDimension;
  readonly pivotDimensions: readonly [FinopsCostDimension, FinopsCostDimension];
  readonly explorerPeriod: string | null;
  readonly explorerLimit: number;
  readonly explorerFilters: readonly FinopsExplorerFilter[];
}

function invalidRequest(): never {
  throw Object.assign(
    new Error("The Cost Intelligence request is invalid"),
    { code: "INVALID_INPUT", status: 400 },
  );
}

function parseExplorerFilter(encoded: string): FinopsExplorerFilter {
  const separator = encoded.indexOf(":");
  const dimension = encoded.slice(0, separator);
  const value = encoded.slice(separator + 1);
  if (
    separator < 1
    || !FINOPS_COST_DIMENSIONS.includes(dimension as FinopsCostDimension)
    || value.length < 1
    || value.length > MAX_FILTER_VALUE_LENGTH
    || value.includes("\0")
  ) invalidRequest();
  return { dimension: dimension as FinopsCostDimension, value };
}

function parseQuery(request: Request): CostIntelligenceQuery {
  const parameters = new URL(request.url).searchParams;
  for (const key of parameters.keys()) {
    if (!ALLOWED_QUERY_PARAMETERS.has(key)) invalidRequest();
  }
  for (const key of ALLOWED_QUERY_PARAMETERS) {
    if (
      !MULTI_VALUE_QUERY_PARAMETERS.has(key)
      && parameters.getAll(key).length > 1
    ) invalidRequest();
  }

  const connectionId = parameters.get("connectionId") ?? "";
  const baselinePeriod = parameters.get("baselinePeriod");
  const comparisonPeriod = parameters.get("comparisonPeriod");
  const requestedCostBasis = parameters.get("costBasis") ?? "billed";
  const requestedAllocationMode =
    parameters.get("allocationMode") ?? "showback";
  const requestedMoverDimension =
    parameters.get("moverDimension") ?? "service";
  const requestedPivotRow = parameters.get("pivotRow") ?? "account";
  const requestedPivotColumn = parameters.get("pivotColumn") ?? "service";
  const explorerPeriod = parameters.get("explorerPeriod");
  const requestedExplorerLimit = parameters.get("explorerLimit") ?? "50";
  const encodedExplorerFilters = parameters.getAll("explorerFilter");
  if (
    !CONNECTION_ID.test(connectionId)
    || (baselinePeriod !== null && !PERIOD.test(baselinePeriod))
    || (comparisonPeriod !== null && !PERIOD.test(comparisonPeriod))
    || !FINOPS_COST_BASES.includes(requestedCostBasis as FinopsCostBasis)
    || !ALLOCATION_MODES.has(
      requestedAllocationMode as FinopsAllocationMode,
    )
    || !FINOPS_COST_DIMENSIONS.includes(
      requestedMoverDimension as FinopsCostDimension,
    )
    || !FINOPS_COST_DIMENSIONS.includes(
      requestedPivotRow as FinopsCostDimension,
    )
    || !FINOPS_COST_DIMENSIONS.includes(
      requestedPivotColumn as FinopsCostDimension,
    )
    || requestedPivotRow === requestedPivotColumn
    || (explorerPeriod !== null && !PERIOD.test(explorerPeriod))
    || !/^[1-9]\d{0,2}$/u.test(requestedExplorerLimit)
    || Number(requestedExplorerLimit) > MAX_EXPLORER_LIMIT
    || encodedExplorerFilters.length > MAX_EXPLORER_FILTERS
    || (
      baselinePeriod !== null
      && comparisonPeriod !== null
      && baselinePeriod === comparisonPeriod
    )
  ) invalidRequest();

  return {
    connectionId,
    baselinePeriod,
    comparisonPeriod,
    costBasis: requestedCostBasis as FinopsCostBasis,
    allocationMode: requestedAllocationMode as FinopsAllocationMode,
    moverDimension: requestedMoverDimension as FinopsCostDimension,
    pivotDimensions: [
      requestedPivotRow as FinopsCostDimension,
      requestedPivotColumn as FinopsCostDimension,
    ],
    explorerPeriod,
    explorerLimit: Number(requestedExplorerLimit),
    explorerFilters: encodedExplorerFilters.map(parseExplorerFilter),
  };
}

function newestFirst(
  left: FinopsActiveBillingPartition,
  right: FinopsActiveBillingPartition,
): number {
  return right.scope.billingPeriod.localeCompare(left.scope.billingPeriod)
    || right.evidence.activeCommittedAtIso.localeCompare(
      left.evidence.activeCommittedAtIso,
    )
    || left.scope.exportName.localeCompare(right.scope.exportName)
    || left.scope.generationId.localeCompare(right.scope.generationId);
}

/**
 * A connection may retain earlier export definitions. Foundational reports
 * never merge them: the export attached to the newest active period is the
 * sole canonical history for this request.
 */
function canonicalExportHistory(
  partitions: readonly FinopsActiveBillingPartition[],
): readonly FinopsActiveBillingPartition[] {
  const sorted = [...partitions].sort(newestFirst);
  const canonicalExportName = sorted[0]?.scope.exportName;
  if (canonicalExportName === undefined) return [];
  const periods = new Set<string>();
  return sorted.flatMap((partition) => {
    if (
      partition.scope.exportName !== canonicalExportName
      || periods.has(partition.scope.billingPeriod)
      || periods.size >= MAX_PERIODS
    ) return [];
    periods.add(partition.scope.billingPeriod);
    return [partition];
  });
}

function availablePeriods(
  history: readonly FinopsActiveBillingPartition[],
): readonly {
  readonly period: string;
  readonly generationId: string;
  readonly committedAtIso: string;
}[] {
  return history.map((partition) => ({
    period: partition.scope.billingPeriod,
    generationId: partition.scope.generationId,
    committedAtIso: partition.evidence.activeCommittedAtIso,
  }));
}

function activeEvidence(
  history: readonly FinopsActiveBillingPartition[],
): {
  readonly periods: readonly {
    readonly period: string;
    readonly generationId: string;
    readonly manifestSha256: string;
    readonly sourceUpdatedAtIso: string | null;
    readonly observedAtIso: string;
    readonly committedAtIso: string;
    readonly acceptedRows: number;
    readonly rejectedRows: number;
  }[];
} | null {
  if (history.length === 0) return null;
  return {
    periods: history.map((partition) => ({
      period: partition.scope.billingPeriod,
      generationId: partition.scope.generationId,
      manifestSha256: partition.evidence.activeManifestSha256,
      sourceUpdatedAtIso:
        partition.evidence.activeSourceUpdatedAtIso,
      observedAtIso: partition.evidence.activeObservedAtIso,
      committedAtIso: partition.evidence.activeCommittedAtIso,
      acceptedRows: partition.evidence.acceptedRows,
      rejectedRows: partition.evidence.rejectedRows,
    })),
  };
}

function selectedComparisonPeriods(
  query: CostIntelligenceQuery,
  history: readonly FinopsActiveBillingPartition[],
): {
  readonly baselinePeriod: string;
  readonly comparisonPeriod: string;
} {
  const known = new Set(
    history.map((partition) => partition.scope.billingPeriod),
  );
  const comparisonPeriod =
    query.comparisonPeriod ?? history[0]?.scope.billingPeriod ?? "";
  const baselinePeriod =
    query.baselinePeriod ?? history[1]?.scope.billingPeriod ?? "";
  if (
    !known.has(baselinePeriod)
    || !known.has(comparisonPeriod)
    || baselinePeriod === comparisonPeriod
  ) invalidRequest();
  return { baselinePeriod, comparisonPeriod };
}

function sourceStateEnvelope(
  connectionId: string,
  history: readonly FinopsActiveBillingPartition[],
  taxonomyConfigured: boolean,
  sourceState: "waiting" | "configuration_required",
): Record<string, unknown> {
  return {
    connectionId,
    selectedPeriods: history.map(
      (partition) => partition.scope.billingPeriod,
    ),
    availablePeriods: availablePeriods(history),
    report: null,
    taxonomyConfigured,
    sourceState,
    sourceEvidence: activeEvidence(history),
    officialDefinition: FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION,
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const query = parseQuery(request);
    // Capture request time once. It is used only as the commitment observation
    // boundary and is never substituted for source delivery/freshness evidence.
    const commitmentAsOfIso = new Date().toISOString();
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

    const billingOwner = {
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId: connection.id,
    };
    const foundationalScope: FinopsFoundationalTenantScope = {
      organizationId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId: connection.id,
    };
    const billingRepository = new FinopsActiveBillingQueryRepository();
    const configRepository = new FinopsFoundationalConfigRepository();
    const [partitions, publishedTaxonomy] = await Promise.all([
      billingRepository.listActivePartitions(billingOwner),
      configRepository.activeTaxonomy(foundationalScope),
    ]);
    const history = canonicalExportHistory(partitions);
    if (publishedTaxonomy === null) {
      return jsonResponse(sourceStateEnvelope(
        query.connectionId,
        history,
        false,
        "configuration_required",
      ));
    }
    if (history.length < 2) {
      return jsonResponse(sourceStateEnvelope(
        query.connectionId,
        history,
        true,
        "waiting",
      ));
    }

    const selected = selectedComparisonPeriods(query, history);
    const acceptedRows = history.reduce(
      (total, partition) => total + partition.evidence.acceptedRows,
      0,
    );
    if (!Number.isSafeInteger(acceptedRows) || acceptedRows > MAX_TOTAL_ROWS) {
      invalidRequest();
    }
    const datasets = await Promise.all(
      history.map((partition) =>
        billingRepository.loadActivePartition(billingOwner, partition)),
    );
    const report = buildFinopsCostIntelligence({
      periods: datasets.map((dataset) => ({
        scope: dataset.scope,
        rows: dataset.rows,
        ...(() => {
          const observedThrough =
            dataset.evidence.activeSourceUpdatedAtIso
            ?? dataset.evidence.activeObservedAtIso;
          return observedThrough.slice(0, 7) === dataset.scope.billingPeriod
            ? { observedThroughIso: observedThrough }
            : {};
        })(),
      })),
      costBasis: query.costBasis,
      allocationMode: query.allocationMode,
      taxonomy: publishedTaxonomy.taxonomy,
      baselinePeriod: selected.baselinePeriod,
      comparisonPeriod: selected.comparisonPeriod,
      moverDimension: query.moverDimension,
      pivotDimensions: query.pivotDimensions,
      explorer: {
        period: query.explorerPeriod ?? selected.comparisonPeriod,
        dimensions: query.pivotDimensions,
        filters: query.explorerFilters,
        limit: query.explorerLimit,
        maximumCardinality: 1_000,
      },
      forecast: { minimumPeriods: 3, trainingPeriods: 6 },
      commitments: {
        asOfIso: commitmentAsOfIso,
        expiresWithinDays: 90,
        coverage: {
          evidenceLabel:
            "Canonical billing rows do not prove commitment field completeness.",
          unusedChargesComplete: false,
          publicOnDemandCostComplete: false,
          usageQuantityComplete: false,
        },
      },
    });
    return jsonResponse({
      connectionId: query.connectionId,
      selectedPeriods: history.map(
        (partition) => partition.scope.billingPeriod,
      ),
      availablePeriods: availablePeriods(history),
      report,
      taxonomyConfigured: true,
      sourceState: "complete",
      sourceEvidence: activeEvidence(history),
      officialDefinition: FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

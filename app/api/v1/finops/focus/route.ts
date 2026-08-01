import {
  FinopsActiveBillingQueryRepository,
  type FinopsActiveBillingDataset,
  type FinopsActiveBillingPartition,
} from "../../../../../db/finops-active-billing-query-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import {
  assertSessionCapability,
  requireApiSession,
} from "../../../../../lib/api-auth";
import {
  buildFinopsFocusDashboard,
  FINOPS_FOCUS_DASHBOARD_BOUNDS,
} from "../../../../../lib/finops-focus-dashboard";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const FRESHNESS_SLA_HOURS = 48;
const ALLOWED_QUERY_PARAMETERS = new Set([
  "connectionId",
  "fromPeriod",
  "toPeriod",
]);

interface FocusQuery {
  readonly connectionId: string;
  readonly fromPeriod: string | null;
  readonly toPeriod: string | null;
}

function invalidRequest(): never {
  throw Object.assign(new Error("The FOCUS dashboard request is invalid"), {
    code: "INVALID_INPUT",
    status: 400,
  });
}

function parseQuery(request: Request): FocusQuery {
  const parameters = new URL(request.url).searchParams;
  for (const key of parameters.keys()) {
    if (!ALLOWED_QUERY_PARAMETERS.has(key)) invalidRequest();
  }
  for (const key of ALLOWED_QUERY_PARAMETERS) {
    if (parameters.getAll(key).length > 1) invalidRequest();
  }
  const connectionId = parameters.get("connectionId") ?? "";
  const fromPeriod = parameters.get("fromPeriod");
  const toPeriod = parameters.get("toPeriod");
  if (
    !CONNECTION_ID.test(connectionId)
    || (fromPeriod === null) !== (toPeriod === null)
    || (fromPeriod !== null && !PERIOD.test(fromPeriod))
    || (toPeriod !== null && !PERIOD.test(toPeriod))
    || (
      fromPeriod !== null
      && toPeriod !== null
      && fromPeriod > toPeriod
    )
  ) invalidRequest();
  return { connectionId, fromPeriod, toPeriod };
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
 * Select one immutable active generation per period from one canonical FOCUS
 * 1.2 export. CUR and FOCUS 1.0 partitions are intentionally not fallbacks.
 */
function canonicalFocus12History(
  partitions: readonly FinopsActiveBillingPartition[],
): readonly FinopsActiveBillingPartition[] {
  const eligible = partitions.filter((partition) =>
    partition.evidence.activeSourceFormat === "focus"
    && partition.evidence.activeSourceVersion === "1.2").sort(newestFirst);
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

function selectedWindow(
  query: FocusQuery,
  history: readonly FinopsActiveBillingPartition[],
): { readonly fromPeriod: string; readonly toPeriod: string } | null {
  if (query.fromPeriod !== null && query.toPeriod !== null) {
    return { fromPeriod: query.fromPeriod, toPeriod: query.toPeriod };
  }
  const newest = history[0]?.scope.billingPeriod;
  const oldest = history[history.length - 1]?.scope.billingPeriod;
  return newest === undefined || oldest === undefined
    ? null
    : { fromPeriod: oldest, toPeriod: newest };
}

function freshnessFor(
  partition: FinopsActiveBillingPartition,
  nowMs = Date.now(),
): {
  readonly dataThroughAt: string;
  readonly ageHours: number | null;
  readonly slaHours: number;
  readonly state: "complete" | "stale" | "partial";
} {
  const dataThroughAt = partition.evidence.activeSourceUpdatedAtIso
    ?? partition.evidence.activeObservedAtIso;
  const dataThroughMs = Date.parse(dataThroughAt);
  const future = dataThroughMs > nowMs + 5 * 60_000;
  const ageHours = future
    ? null
    : Math.max(0, Math.round(((nowMs - dataThroughMs) / 3_600_000) * 100) / 100);
  return {
    dataThroughAt,
    ageHours,
    slaHours: FRESHNESS_SLA_HOURS,
    state: future
      ? "partial"
      : ageHours !== null && ageHours > FRESHNESS_SLA_HOURS
        ? "stale"
        : "complete",
  };
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
    const allActivePartitions = await repository.listActivePartitions(owner);
    const history = canonicalFocus12History(allActivePartitions);
    const availablePeriods = history.map((partition) => ({
      period: partition.scope.billingPeriod,
      generationId: partition.scope.generationId,
      committedAtIso: partition.evidence.activeCommittedAtIso,
    }));
    const window = selectedWindow(query, history);
    if (window === null) {
      return jsonResponse({
        connectionId: query.connectionId,
        selectedWindow: null,
        availablePeriods,
        report: null,
        sourceState: allActivePartitions.length === 0
          ? "waiting"
          : "configuration_required",
        requiredSource: {
          format: "focus",
          version: "1.2",
          substitutionAllowed: false,
        },
      });
    }

    const selectedPartitions = history.filter((partition) => {
      const period = partition.scope.billingPeriod;
      return period >= window.fromPeriod && period <= window.toPeriod;
    });
    if (selectedPartitions.length === 0) {
      return jsonResponse({
        connectionId: query.connectionId,
        selectedWindow: window,
        availablePeriods,
        report: null,
        sourceState: "waiting",
      });
    }
    if (selectedPartitions.length > FINOPS_FOCUS_DASHBOARD_BOUNDS.maximumPeriods) {
      invalidRequest();
    }
    const acceptedRows = selectedPartitions.reduce(
      (total, partition) => total + partition.evidence.acceptedRows,
      0,
    );
    if (
      !Number.isSafeInteger(acceptedRows)
      || acceptedRows > FINOPS_FOCUS_DASHBOARD_BOUNDS.maximumTotalRows
    ) invalidRequest();

    const datasets: FinopsActiveBillingDataset[] = [];
    for (const partition of selectedPartitions) {
      datasets.push(await repository.loadActivePartition(owner, partition));
    }
    const report = buildFinopsFocusDashboard({ scope: owner, datasets });
    if (!report.ok) {
      return jsonResponse({
        connectionId: query.connectionId,
        selectedWindow: window,
        availablePeriods,
        report: null,
        sourceState: "partial",
        qualityFailures: report.failures,
      });
    }
    const freshness = freshnessFor(selectedPartitions[0]!);
    const sourceState = report.quality.ingestionCoverage !== "complete"
      ? "partial"
      : freshness.state !== "complete"
        ? freshness.state
        : report.quality.acceptedLineCount === 0
          ? "empty"
          : "complete";
    return jsonResponse({
      connectionId: query.connectionId,
      selectedWindow: window,
      availablePeriods,
      report,
      sourceState,
      sourceFreshness: freshness,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

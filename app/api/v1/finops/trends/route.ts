import {
  FinopsActiveBillingQueryRepository,
  type FinopsActiveBillingDataset,
  type FinopsActiveBillingPartition,
} from "../../../../../db/finops-active-billing-query-repository";
import { AlertRuleRepository } from "../../../../../db/alert-rule-repository";
import { FinopsScheduledReportRepository } from "../../../../../db/finops-scheduled-report-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import {
  assertSessionCapability,
  requireApiSession,
} from "../../../../../lib/api-auth";
import {
  FINOPS_COST_BASES,
  type FinopsCostBasis,
} from "../../../../../lib/finops-billing-projections";
import {
  FINOPS_TRENDS_INTELLIGENCE_BOUNDS,
  buildFinopsTrendsIntelligence,
} from "../../../../../lib/finops-trends-intelligence";
import {
  buildFinopsTrendsCapabilityClosure,
  type FinopsTrendsAutomationStatus,
} from "../../../../../lib/finops-trends-capability-closure";
import { FINOPS_TRENDS_OFFICIAL_DEFINITION } from
  "../../../../../lib/finops-trends-official-definition";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const POSITIVE_INTEGER = /^(?:[1-9]|[1-4]\d|50)$/u;
const ROLLING_WINDOW = /^(?:[1-9]|1[0-2])$/u;
// Three years keeps month, quarter and rolling-year comparisons useful while
// the engine's 500k-row cap still fails closed before partition bodies load.
const MAX_WINDOW_PERIODS = 36;
const ALLOWED_QUERY_PARAMETERS = new Set([
  "connectionId",
  "fromPeriod",
  "toPeriod",
  "costBases",
  "rollingWindowMonths",
  "contributorLimit",
]);

interface TrendsQuery {
  readonly connectionId: string;
  readonly fromPeriod: string | null;
  readonly toPeriod: string | null;
  readonly costBases: readonly FinopsCostBasis[];
  readonly rollingWindowMonths: number;
  readonly contributorLimit: number;
}

function invalidRequest(): never {
  throw Object.assign(new Error("The Trends request is invalid"), {
    code: "INVALID_INPUT",
    status: 400,
  });
}

function periodIndex(period: string): number {
  const [year, month] = period.split("-");
  return Number(year) * 12 + Number(month) - 1;
}

function parseCostBases(value: string | null): readonly FinopsCostBasis[] {
  const tokens = (value ?? "unblended,amortized").split(",");
  const unique = new Set(tokens);
  if (
    tokens.length === 0
    || unique.size !== tokens.length
    || tokens.some((basis) =>
      !FINOPS_COST_BASES.includes(basis as FinopsCostBasis))
  ) invalidRequest();
  return FINOPS_COST_BASES.filter((basis) => unique.has(basis));
}

function parseQuery(request: Request): TrendsQuery {
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
  const rolling = parameters.get("rollingWindowMonths") ?? "3";
  const contributors = parameters.get("contributorLimit") ?? "8";
  if (
    !CONNECTION_ID.test(connectionId)
    || (fromPeriod === null) !== (toPeriod === null)
    || (fromPeriod !== null && !PERIOD.test(fromPeriod))
    || (toPeriod !== null && !PERIOD.test(toPeriod))
    || !ROLLING_WINDOW.test(rolling)
    || !POSITIVE_INTEGER.test(contributors)
  ) invalidRequest();
  if (
    fromPeriod !== null
    && toPeriod !== null
    && (
      periodIndex(fromPeriod) > periodIndex(toPeriod)
      || periodIndex(toPeriod) - periodIndex(fromPeriod) + 1
        > MAX_WINDOW_PERIODS
    )
  ) invalidRequest();
  return {
    connectionId,
    fromPeriod,
    toPeriod,
    costBases: parseCostBases(parameters.get("costBases")),
    rollingWindowMonths: Number(rolling),
    contributorLimit: Number(contributors),
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

function canonicalCur2History(
  partitions: readonly FinopsActiveBillingPartition[],
): readonly FinopsActiveBillingPartition[] {
  const eligible = partitions.filter((partition) =>
    partition.evidence.activeSourceFormat === "aws-cur"
    && partition.evidence.activeSourceVersion === "2.0").sort(newestFirst);
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

function periodFromIndex(index: number): string {
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function selectedWindow(
  query: TrendsQuery,
  history: readonly FinopsActiveBillingPartition[],
): { readonly fromPeriod: string; readonly toPeriod: string } | null {
  if (query.fromPeriod !== null && query.toPeriod !== null) {
    return { fromPeriod: query.fromPeriod, toPeriod: query.toPeriod };
  }
  const newest = history[0]?.scope.billingPeriod;
  if (newest === undefined) return null;
  return {
    fromPeriod: periodFromIndex(periodIndex(newest) - (MAX_WINDOW_PERIODS - 1)),
    toPeriod: newest,
  };
}

function availableCostBases(dataset: FinopsActiveBillingDataset): FinopsCostBasis[] {
  const valueFor = (basis: FinopsCostBasis, row: FinopsActiveBillingDataset["rows"][number]): string | null => {
    switch (basis) {
      case "unblended": return row.line.amountMicros;
      case "net": return row.line.netUnblendedCostMicros;
      case "amortized": return row.line.amortizedMicros;
      case "list": return row.line.listCostMicros;
      case "contracted": return row.line.contractedCostMicros;
      case "public": return row.line.publicOnDemandCostMicros;
    }
  };
  return FINOPS_COST_BASES.filter((basis) =>
    dataset.rows.every((row) => valueFor(basis, row) !== null));
}

async function trendsAutomationStatus(scope: {
  readonly orgId: string;
  readonly customerId: string;
}, connectionId: string): Promise<{
  readonly alertRules: FinopsTrendsAutomationStatus;
  readonly scheduledReports: FinopsTrendsAutomationStatus;
}> {
  const [rules, reports] = await Promise.allSettled([
    new AlertRuleRepository().list(scope),
    new FinopsScheduledReportRepository().list(scope),
  ]);
  const unavailable: FinopsTrendsAutomationStatus = {
    available: false,
    configuredCount: null,
    enabledCount: null,
    reason: "RUNTIME_STATUS_UNAVAILABLE",
  };
  const connectionReports = reports.status === "fulfilled"
    ? reports.value.filter((report) => report.connectionId === connectionId)
    : [];
  return {
    alertRules: rules.status === "fulfilled" ? {
      available: true,
      configuredCount: rules.value.length,
      enabledCount: rules.value.filter((rule) => rule.enabled).length,
      reason: "SUTRA_TENANT_SCOPED_RUNTIME",
    } : unavailable,
    scheduledReports: reports.status === "fulfilled" ? {
      available: true,
      configuredCount: connectionReports.length,
      enabledCount: connectionReports.filter((report) => report.enabled).length,
      reason: "SUTRA_TENANT_SCOPED_RUNTIME",
    } : unavailable,
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
    const history = canonicalCur2History(
      await repository.listActivePartitions(owner),
    ).slice(0, FINOPS_TRENDS_INTELLIGENCE_BOUNDS.maximumPeriods);
    const availablePeriods = history.map((partition) => ({
      period: partition.scope.billingPeriod,
      generationId: partition.scope.generationId,
      committedAtIso: partition.evidence.activeCommittedAtIso,
    }));
    const window = selectedWindow(query, history);
    if (window === null) {
      return jsonResponse({
        connectionId: query.connectionId,
        officialDefinition: FINOPS_TRENDS_OFFICIAL_DEFINITION,
        selectedWindow: null,
        availablePeriods,
        report: null,
        sourceState: "waiting",
      });
    }
    const selectedPartitions = history.filter((partition) => {
      const period = partition.scope.billingPeriod;
      return period >= window.fromPeriod && period <= window.toPeriod;
    });
    if (selectedPartitions.length === 0) {
      return jsonResponse({
        connectionId: query.connectionId,
        officialDefinition: FINOPS_TRENDS_OFFICIAL_DEFINITION,
        selectedWindow: window,
        availablePeriods,
        report: null,
        sourceState: "waiting",
      });
    }
    const acceptedRows = selectedPartitions.reduce(
      (total, partition) => total + partition.evidence.acceptedRows,
      0,
    );
    if (
      !Number.isSafeInteger(acceptedRows)
      || acceptedRows > FINOPS_TRENDS_INTELLIGENCE_BOUNDS.maximumTotalRows
    ) invalidRequest();
    const datasets = await Promise.all(selectedPartitions.map((partition) =>
      repository.loadActivePartition(owner, partition)));
    const currencies = [...new Set(datasets.flatMap((dataset) =>
      dataset.rows.map((row) => row.line.currency)))].sort();
    if (currencies.length === 0) {
      return jsonResponse({
        connectionId: query.connectionId,
        officialDefinition: FINOPS_TRENDS_OFFICIAL_DEFINITION,
        selectedWindow: window,
        availablePeriods,
        report: null,
        sourceState: "empty",
      });
    }
    const unblendedComplete = datasets.every((dataset) =>
      availableCostBases(dataset).includes("unblended"));
    if (!unblendedComplete) {
      return jsonResponse({
        connectionId: query.connectionId,
        officialDefinition: FINOPS_TRENDS_OFFICIAL_DEFINITION,
        selectedWindow: window,
        availablePeriods,
        report: null,
        sourceState: "source_incomplete",
      });
    }
    const evaluatedAtIso = new Date().toISOString();
    const coreReport = buildFinopsTrendsIntelligence({
      tenant: {
        organizationId: authenticated.subject.orgId,
        customerId: connection.customerId,
        connectionId: connection.id,
        exportName: selectedPartitions[0]?.scope.exportName
          ?? history[0]!.scope.exportName,
      },
      window,
      expectedCurrencies: currencies,
      source: { state: "READY", evaluatedAtIso, errorCode: null },
      periods: datasets.map((dataset) => ({
        scope: dataset.scope,
        evidence: {
          sourceEvidenceId:
            `active-cur2:${dataset.evidence.activeManifestSha256}`,
          manifestSha256: dataset.evidence.activeManifestSha256,
          sourceUpdatedAtIso: dataset.evidence.activeSourceUpdatedAtIso,
          observedAtIso: dataset.evidence.activeObservedAtIso,
          committedAtIso: dataset.evidence.activeCommittedAtIso,
          activatedAtIso: dataset.evidence.activeCommittedAtIso,
          active: true,
          immutable: true,
          reconciliationState: "RECONCILED",
          collectionState: dataset.evidence.rejectedRows === 0
            ? "COMPLETE"
            : "PARTIAL",
          rowsExhausted: true,
          reconciledRowCount: dataset.evidence.acceptedRows,
          rejectedRowCount: dataset.evidence.rejectedRows,
          availableCostBases: availableCostBases(dataset),
          loadKind: "UNCLASSIFIED",
          supersededGenerationId: null,
        },
        rows: dataset.rows,
      })),
      options: {
        costBases: query.costBases,
        rollingWindowMonths: query.rollingWindowMonths,
        contributorLimit: query.contributorLimit,
      },
    });
    const report = coreReport.ok ? {
      ...coreReport,
      capabilities: buildFinopsTrendsCapabilityClosure({
        report: coreReport,
        periods: datasets.map((dataset) => ({
          scope: dataset.scope,
          evidence: {
            sourceEvidenceId: `active-cur2:${dataset.evidence.activeManifestSha256}`,
            manifestSha256: dataset.evidence.activeManifestSha256,
            sourceUpdatedAtIso: dataset.evidence.activeSourceUpdatedAtIso,
            observedAtIso: dataset.evidence.activeObservedAtIso,
            committedAtIso: dataset.evidence.activeCommittedAtIso,
            activatedAtIso: dataset.evidence.activeCommittedAtIso,
            active: true,
            immutable: true,
            reconciliationState: "RECONCILED",
            collectionState: dataset.evidence.rejectedRows === 0 ? "COMPLETE" : "PARTIAL",
            rowsExhausted: true,
            reconciledRowCount: dataset.evidence.acceptedRows,
            rejectedRowCount: dataset.evidence.rejectedRows,
            availableCostBases: availableCostBases(dataset),
            loadKind: "UNCLASSIFIED",
            supersededGenerationId: null,
          },
          rows: dataset.rows,
        })),
        automation: await trendsAutomationStatus({
          orgId: authenticated.subject.orgId,
          customerId: connection.customerId,
        }, connection.id),
      }),
    } : coreReport;
    return jsonResponse({
      connectionId: query.connectionId,
      officialDefinition: FINOPS_TRENDS_OFFICIAL_DEFINITION,
      selectedWindow: window,
      availablePeriods,
      report,
      sourceState: report.ok ? report.state.toLowerCase() : "error",
    });
  } catch (error) {
    return errorResponse(error);
  }
}

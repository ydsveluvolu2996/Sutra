import {
  FinopsActiveBillingQueryRepository,
  type FinopsActiveBillingDataset,
  type FinopsActiveBillingPartition,
} from "../../../../../db/finops-active-billing-query-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { AzureCidRepository } from "../../../../../db/finops-azure-cid-repository";
import { GcpCloudIntelligenceRepository } from "../../../../../db/finops-gcp-cloud-intelligence-repository";
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
const FILTER_VALUE = /^[^\u0000-\u001f\u007f<>]{1,256}$/u;
const FRESHNESS_SLA_HOURS = 48;
const ALLOWED_QUERY_PARAMETERS = new Set([
  "connectionId",
  "providerSourceId",
  "fromPeriod",
  "toPeriod",
  "billingAccount",
  "subAccount",
  "provider",
  "publisher",
  "chargeCategory",
]);

interface FocusQuery {
  readonly connectionId: string;
  readonly providerSourceId: string | null;
  readonly fromPeriod: string | null;
  readonly toPeriod: string | null;
  readonly billingAccount: string | null;
  readonly subAccount: string | null;
  readonly provider: string | null;
  readonly publisher: string | null;
  readonly chargeCategory: string | null;
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
  const providerSourceId = parameters.get("providerSourceId");
  const fromPeriod = parameters.get("fromPeriod");
  const toPeriod = parameters.get("toPeriod");
  const billingAccount = parameters.get("billingAccount");
  const subAccount = parameters.get("subAccount");
  const provider = parameters.get("provider");
  const publisher = parameters.get("publisher");
  const chargeCategory = parameters.get("chargeCategory");
  const filterValues = [billingAccount, subAccount, provider, publisher, chargeCategory];
  if (
    !CONNECTION_ID.test(connectionId)
    || (providerSourceId !== null && !/^(?:conn_|azsrc_|gcpconn_)[a-f0-9]{32}$/u.test(providerSourceId))
    || (fromPeriod === null) !== (toPeriod === null)
    || (fromPeriod !== null && !PERIOD.test(fromPeriod))
    || (toPeriod !== null && !PERIOD.test(toPeriod))
    || filterValues.some((value) => value !== null && !FILTER_VALUE.test(value))
    || (
      fromPeriod !== null
      && toPeriod !== null
      && fromPeriod > toPeriod
    )
  ) invalidRequest();
  return { connectionId, providerSourceId, fromPeriod, toPeriod,
    billingAccount, subAccount, provider, publisher, chargeCategory };
}

const GOVERNED_TAG_TAXONOMY = Object.freeze({ policyId: "sutra-focus-baseline-v1", governedKeys: Object.freeze([{ key: "team", label: "Team" }, { key: "environment", label: "Environment" }, { key: "cost-center", label: "Cost center" }, { key: "business-unit", label: "Business unit" }, { key: "owner", label: "Owner" }, { key: "application", label: "Application" }]), providerTagPrefixes: Object.freeze({ AWS: Object.freeze(["aws:"]), AZURE: Object.freeze(["microsoft:"]), GCP: Object.freeze(["goog-"]) }) });

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
    const azureRepository = new AzureCidRepository();
    const gcpRepository = new GcpCloudIntelligenceRepository();
    const [azureDiscovery, gcpDiscovery] = await Promise.allSettled([
      azureRepository.listSourcesForOrganization(authenticated.subject.orgId),
      gcpRepository.listConnectionsForOrg(authenticated.subject.orgId),
    ]);
    const azureCandidates = azureDiscovery.status === "fulfilled" ? azureDiscovery.value : [];
    const gcpCandidates = gcpDiscovery.status === "fulfilled" ? gcpDiscovery.value : [];
    const readableAzure = azureCandidates.filter((source) => {
      if (source.scope.customerId !== connection.customerId) return false;
      try {
        assertSessionCapability(authenticated, "connection:read", source.scope.customerId);
        return true;
      } catch {
        return false;
      }
    });
    const readableGcp = gcpCandidates.filter((source) => {
      if (source.customerId !== connection.customerId) return false;
      try {
        assertSessionCapability(authenticated, "connection:read", source.customerId);
        return true;
      } catch {
        return false;
      }
    });
    const azureSources = await Promise.all(readableAzure.map(async (source) => {
      const scope = {
        organizationId: authenticated.subject.orgId,
        customerId: source.scope.customerId,
        sourceId: source.scope.sourceId,
      };
      const active = source.activationReason === "READY"
        ? await azureRepository.getActiveSnapshot(scope)
        : null;
      return {
        provider: "AZURE",
        sourceId: source.scope.sourceId,
        focusVersion: active?.snapshot.datasetKind === "FOCUS_1_0" ? "1.0" : null,
        state: source.activationReason !== "READY"
          ? source.activationReason
          : active === null ? "AZURE_EXPORT_DELIVERY_NOT_OBSERVED"
            : active.snapshot.datasetKind !== "FOCUS_1_0" ? "AZURE_SOURCE_IS_NOT_FOCUS"
              : "AZURE_FOCUS_1_0_NORMALIZED_BINDING_NOT_DEPLOYED",
        selectable: true,
      };
    }));
    const providerSources = [
      {
        provider: "AWS",
        sourceId: connection.id,
        focusVersion: "1.2",
        state: "AWS_FOCUS_1_2",
        selectable: true,
      },
      ...azureSources,
      ...readableGcp.map((source) => ({
        provider: "GCP",
        sourceId: source.id,
        focusVersion: null,
        state: "GCP_FOCUS_EXPORT_ADAPTER_NOT_DEPLOYED",
        selectable: true,
      })),
    ];
    if (query.providerSourceId !== null && query.providerSourceId !== connection.id) {
      const selected = providerSources.find((source) => source.sourceId === query.providerSourceId);
      return jsonResponse({ connectionId: query.connectionId, selectedWindow: null, availablePeriods: [], report: null, sourceState: "configuration_required", providerSources, activation: { ready: false, reason: selected?.state ?? "FOCUS_PROVIDER_SOURCE_NOT_FOUND", substitutionAllowed: false } });
    }

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
        providerSources,
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
        providerSources,
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
    const report = buildFinopsFocusDashboard({ scope: owner, datasets, tagTaxonomy: GOVERNED_TAG_TAXONOMY,
      filters: { billingAccount: query.billingAccount, subAccount: query.subAccount, provider: query.provider,
        publisher: query.publisher, chargeCategory: query.chargeCategory } });
    if (!report.ok) {
      return jsonResponse({
        connectionId: query.connectionId,
        selectedWindow: window,
        availablePeriods,
        report: null,
        sourceState: "partial",
        qualityFailures: report.failures,
        providerSources,
      });
    }
    const freshness = freshnessFor(selectedPartitions[0]!);
    const sourceState = report.quality.ingestionCoverage !== "complete"
      ? "partial"
      : freshness.state !== "complete"
        ? freshness.state
        : report.quality.selectedLineCount === 0
          ? "empty"
          : "complete";
    return jsonResponse({
      connectionId: query.connectionId,
      selectedWindow: window,
      availablePeriods,
      report,
      sourceState,
      sourceFreshness: freshness,
      providerSources,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

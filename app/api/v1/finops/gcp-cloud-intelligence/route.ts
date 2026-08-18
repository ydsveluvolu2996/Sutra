import { GcpCloudIntelligenceRepository } from "../../../../../db/finops-gcp-cloud-intelligence-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import {
  buildGcpCloudIntelligenceDashboard,
  type GcpDashboardFilters,
} from "../../../../../lib/finops-gcp-cloud-intelligence";
import { GCP_CLOUD_INTELLIGENCE_OFFICIAL_DEFINITION } from "../../../../../lib/finops-gcp-cloud-intelligence-official-definition";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION = /^gcpconn_[a-f0-9]{32}$/u;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const MONTH = /^\d{4}-\d{2}$/u;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9 ._:@+()\/-]{0,255}$/u;
const LABEL = /^[A-Za-z0-9_.:/-]{1,128}$/u;
const ALLOWED = new Set([
  "sourceId",
  "invoiceMonth",
  "projectId",
  "service",
  "sku",
  "region",
  "currency",
  "labelKey",
  "labelValue",
]);

function invalid(status = 400): never {
  throw Object.assign(
    new Error(status === 404 ? "GCP billing connection not found" : "The GCP Cloud Intelligence request is invalid"),
    { code: status === 404 ? "NOT_FOUND" : "INVALID_INPUT", status },
  );
}

function parse(request: Request): { sourceId: string | null; filters: GcpDashboardFilters } {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) if (!ALLOWED.has(key)) invalid();
  for (const key of ALLOWED) if (params.getAll(key).length > 1) invalid();
  const sourceId = params.get("sourceId");
  const invoiceMonth = params.get("invoiceMonth");
  const projectId = params.get("projectId");
  const service = params.get("service");
  const sku = params.get("sku");
  const region = params.get("region");
  const currency = params.get("currency");
  const labelKey = params.get("labelKey");
  const labelValue = params.get("labelValue");
  if (
    (sourceId !== null && !CONNECTION.test(sourceId))
    || (invoiceMonth !== null && !MONTH.test(invoiceMonth))
    || (projectId !== null && !PROJECT.test(projectId))
    || (service !== null && !SAFE.test(service))
    || (sku !== null && !SAFE.test(sku))
    || (region !== null && !SAFE.test(region))
    || (currency !== null && !CURRENCY.test(currency))
    || (labelKey !== null && !LABEL.test(labelKey))
    || (labelValue !== null && !SAFE.test(labelValue))
    || (labelValue !== null && labelKey === null)
  ) invalid();
  return {
    sourceId,
    filters: { invoiceMonth, projectId, service, sku, region, currency, labelKey, labelValue },
  };
}

function unique(values: readonly (string | null)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => value !== null))].sort();
}

type GcpSource = Awaited<ReturnType<GcpCloudIntelligenceRepository["listConnectionsForOrg"]>>[number];

function sourceOption(source: GcpSource) {
  return {
    sourceId: source.id,
    billingAccountId: source.billingAccountId,
    exportProjectId: source.exportProjectId,
    location: source.location,
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const query = parse(request);
    const authenticated = await requireApiSession(request);
    const repository = new GcpCloudIntelligenceRepository();
    const organizationSources = await repository.listConnectionsForOrg(authenticated.subject.orgId);
    const sources = organizationSources.filter((source) => {
      try {
        assertSessionCapability(authenticated, "connection:read", source.customerId);
        return true;
      } catch {
        return false;
      }
    });
    const sourceOptions = sources.map(sourceOption);

    if (sources.length === 0) {
      return jsonResponse({
        schema: "sutra.finops-gcp-cloud-intelligence-dashboard.v1",
        sourceState: "CONFIGURATION_REQUIRED",
        dashboard: null,
        selectionRequired: false,
        sources: [],
        officialDefinition: GCP_CLOUD_INTELLIGENCE_OFFICIAL_DEFINITION,
        activation: { provider: "GCP", reason: "NO_ACTIVE_GCP_BILLING_SOURCE" },
      });
    }
    if (query.sourceId === null && sources.length > 1) {
      return jsonResponse({
        schema: "sutra.finops-gcp-cloud-intelligence-dashboard.v1",
        sourceState: "CONFIGURATION_REQUIRED",
        dashboard: null,
        selectionRequired: true,
        sources: sourceOptions,
        officialDefinition: GCP_CLOUD_INTELLIGENCE_OFFICIAL_DEFINITION,
      });
    }

    const connection = query.sourceId === null
      ? sources[0]!
      : sources.find((source) => source.id === query.sourceId) ?? null;
    if (connection === null || connection.status !== "active") invalid(404);
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = {
      organizationId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId: connection.id,
    };
    const [active, latest, history] = await Promise.all([
      repository.getActiveSnapshot(scope),
      repository.getLatestSnapshot(scope),
      repository.listHistory(scope, 36),
    ]);
    const selected = active ?? latest;
    if (selected === null) {
      return jsonResponse({
        schema: "sutra.finops-gcp-cloud-intelligence-dashboard.v1",
        sourceId: connection.id,
        sourceState: "PARTIAL_PIPELINE",
        dashboard: null,
        selectionRequired: false,
        sources: sourceOptions,
        officialDefinition: GCP_CLOUD_INTELLIGENCE_OFFICIAL_DEFINITION,
        activation: {
          provider: "GCP",
          billingAccountId: connection.billingAccountId,
          export: `${connection.exportProjectId}.${connection.datasetId}.${connection.billingTableId}`,
          pricing: `${connection.pricingProjectId}.${connection.pricingDatasetId}.${connection.pricingTableId}`,
          identity: "WORKLOAD_IDENTITY_REFERENCE_ONLY",
          reason: "GCP_BIGQUERY_BILLING_EXPORT_ADAPTER_NOT_DEPLOYED",
        },
      });
    }

    const unfiltered = buildGcpCloudIntelligenceDashboard(selected.snapshot);
    const dashboard = buildGcpCloudIntelligenceDashboard(selected.snapshot, query.filters);
    const ageHours = selected.snapshot.dataThroughAt === null
      ? null
      : Math.round(Math.max(0, (Date.now() - Date.parse(selected.snapshot.dataThroughAt)) / 3_600_000) * 100) / 100;
    const newerIncomplete = active !== null && latest !== null && active.generationId !== latest.generationId;
    const sourceState = newerIncomplete
      ? "PARTIAL_PIPELINE"
      : selected.snapshot.sourceState === "READY" && ageHours !== null && ageHours > 48
        ? "STALE"
        : selected.snapshot.sourceState;
    return jsonResponse({
      ...dashboard,
      sourceId: connection.id,
      sourceState,
      sources: sourceOptions,
      officialDefinition: GCP_CLOUD_INTELLIGENCE_OFFICIAL_DEFINITION,
      history,
      filterOptions: {
        invoiceMonths: unique(unfiltered.costTrendByInvoiceMonth.map((row) =>
          row.name.split("|")[1]?.replace(/^(\d{4})(\d{2})$/u, "$1-$2") ?? null)),
        projects: unique(selected.snapshot.rows.map((row) => row.projectId)),
        services: unique(selected.snapshot.rows.map((row) => row.serviceDescription)),
        skus: unique(selected.snapshot.rows.map((row) => row.skuDescription)),
        regions: unique(selected.snapshot.rows.map((row) => row.locationRegion ?? "Unallocated")),
        currencies: unique(selected.snapshot.rows.map((row) => row.currency)),
        labelKeys: unique(selected.snapshot.rows.flatMap((row) => row.labels.map((label) => label.key))),
      },
      freshness: { dataThroughAt: selected.snapshot.dataThroughAt, ageHours, staleAfterHours: 48 },
      evidence: {
        generationId: selected.generationId,
        activeGenerationId: active?.generationId ?? null,
        latestGenerationId: latest?.generationId ?? null,
        newerIncomplete,
        captureId: selected.snapshot.captureId,
        contentSha256: selected.contentSha256,
        bigQueryJobId: selected.snapshot.lineage.bigQueryJobId,
        querySha256: selected.snapshot.lineage.querySha256,
        billingTableSchemaSha256: selected.snapshot.lineage.billingTableSchemaSha256,
        pricingTableSchemaSha256: selected.snapshot.lineage.pricingTableSchemaSha256,
      },
      activation: {
        ...selected.snapshot.activation,
        identityBindingIdReturned: false,
        serviceAccountKeyAccepted: false,
      },
      semantics: {
        moneyRepresentation: "SIGNED_INTEGER_NANOS_EXACT_BIGQUERY_NUMERIC_SCALE",
        billedCost: "PROVIDER_EXPORT_FACT",
        credits: "PROVIDER_EXPORT_FACT",
        pricingVariance: "CALCULATED_NOT_BILLED",
        recommendationSavings: "CALCULATED_NOT_BILLED",
      },
      collection: {
        jobContractAvailable: true,
        providerAdapterAvailable: false,
        reason: "GCP_BIGQUERY_BILLING_EXPORT_ADAPTER_NOT_DEPLOYED",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

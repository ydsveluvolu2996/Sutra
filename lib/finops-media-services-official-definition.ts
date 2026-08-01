export type MediaServicesOfficialCoverage =
  | "SUPPORTED"
  | "PARTIAL"
  | "SERVER_PINNED"
  | "UNAVAILABLE"
  | "ABOUT_EVIDENCE";

export interface MediaServicesOfficialPurpose {
  readonly purpose: string;
  readonly coverage: MediaServicesOfficialCoverage;
  readonly nativeEvidence: string;
  readonly remainingGap: string | null;
}

export interface MediaServicesOfficialControl {
  readonly placement: "parameter" | "filter";
  readonly type: "DateTimePicker" | "List" | "Dropdown" | "Slider";
  readonly title: string;
  readonly coverage: Exclude<MediaServicesOfficialCoverage, "ABOUT_EVIDENCE">;
}

export interface MediaServicesOfficialSheet {
  readonly id: string;
  readonly name: string;
  readonly visualCount: number;
  readonly visualTypes: Readonly<Record<string, number>>;
  readonly controls: readonly MediaServicesOfficialControl[];
  readonly documentedPurposes: readonly MediaServicesOfficialPurpose[];
}

const purpose = (
  name: string,
  coverage: MediaServicesOfficialCoverage,
  nativeEvidence: string,
  remainingGap: string | null,
): MediaServicesOfficialPurpose => Object.freeze({
  purpose: name, coverage, nativeEvidence, remainingGap,
});

const control = (
  placement: MediaServicesOfficialControl["placement"],
  type: MediaServicesOfficialControl["type"],
  title: string,
  coverage: MediaServicesOfficialControl["coverage"],
): MediaServicesOfficialControl => Object.freeze({
  placement, type, title, coverage,
});

const commonControls = (): readonly MediaServicesOfficialControl[] => Object.freeze([
  control("parameter", "Dropdown", "Linked Account", "PARTIAL"),
  control("parameter", "Dropdown", "Payer Account", "SERVER_PINNED"),
  control("parameter", "Dropdown", "Cost Model", "SERVER_PINNED"),
  control("parameter", "Dropdown", "Include Pricing Adjustments", "SERVER_PINNED"),
  control("parameter", "Slider", "Months for Lookback", "SERVER_PINNED"),
  control("parameter", "Slider", "Top N", "UNAVAILABLE"),
]);

/**
 * Frozen audit of the complete public Media Services Insights Hub v2.2.1
 * definition. Counts are parsed from YAML; purposes are limited to AWS
 * Guidance text and the two public source artifacts mirrored at the same SHA.
 */
export const MEDIA_SERVICES_OFFICIAL_DEFINITION = Object.freeze({
  schema: "sutra.finops-media-services-official-definition.v1",
  reviewedAt: "2026-08-01",
  documentationUrl:
    "https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/media-services-insights.html",
  repositories: Object.freeze([
    Object.freeze({
      role: "PRIMARY",
      url: "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
      commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
      byteIdenticalMediaServicesArtifacts: null,
    }),
    Object.freeze({
      role: "DEFINITION_LINKED_MIRROR",
      url: "https://github.com/aws-samples/aws-cudos-framework-deployment",
      commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
      byteIdenticalMediaServicesArtifacts: true,
    }),
  ]),
  source: Object.freeze({
    dashboardId: "media-services-insights",
    name: "Media Services Insights",
    version: "v2.2.1",
    category: "Advanced",
    theme: "MIDNIGHT",
    manifestPath: "dashboards/media-services-insights/msih.yaml",
    definitionPath: "dashboards/media-services-insights/msih-definition.yaml",
    changelogPath: "changes/CHANGELOG-media-services-insights.md",
    datasetIdentifiers: Object.freeze([
      "msih_reservation_optimize", "msih_reservations", "msih_view",
    ]),
  }),
  publication: Object.freeze({
    completeQuickSightDefinitionPublished: true,
    dashboardSpecificDeploymentTemplatePublished: false,
    sharedCidPluginDeploymentTemplatePublished: true,
    pixelOrRuntimeParityClaimed: false,
  }),
  artifacts: Object.freeze([
    Object.freeze({ kind: "DASHBOARD_CATALOG", path: "dashboards/catalog.yaml", sha256: "169a37fb7be4660e96a1fa258d0f95d4cef597f4294c0c27cfda101dfbdb197d", hashBasis: "raw file bytes" }),
    Object.freeze({ kind: "MANIFEST", path: "dashboards/media-services-insights/msih.yaml", sha256: "ab485a191da780a262b09d133731095c19720de4d3827a74dd42b454d974867a", hashBasis: "raw file bytes" }),
    Object.freeze({ kind: "QUICKSIGHT_DEFINITION", path: "dashboards/media-services-insights/msih-definition.yaml", sha256: "a29384174b7eafb599c3ca3734a8a7f4954b8e057f716e6d79e8750cee88fe4d", hashBasis: "raw file bytes" }),
    Object.freeze({ kind: "CHANGELOG", path: "changes/CHANGELOG-media-services-insights.md", sha256: "c489667883cbf69a92144f592d3b4d50ad8fae59420833e8dd1a7ad24e043a53", hashBasis: "raw file bytes" }),
    Object.freeze({ kind: "SHARED_DEPLOYMENT_TEMPLATE", path: "cfn-templates/cid-plugin.yml", sha256: "b96a47e6b53418293ec7127d0a95f96f2ffdae2781cde2b2dffcabad926a713d", hashBasis: "raw file bytes" }),
    Object.freeze({ kind: "DATASET_TEMPLATE", path: "datasets.msih_reservation_optimize.data", sha256: "86dbd25fc53dd7db2c121465371bc2e33621bbbb761f3391bac1a5e09beb00a4", hashBasis: "UTF-8 canonical JSON with recursively sorted object keys" }),
    Object.freeze({ kind: "DATASET_TEMPLATE", path: "datasets.msih_reservations.data", sha256: "7332380211b604b6727c9cbab7292ba61539ac8402a88668a41e8be939fb6ab0", hashBasis: "UTF-8 canonical JSON with recursively sorted object keys" }),
    Object.freeze({ kind: "DATASET_TEMPLATE", path: "datasets.msih_view.data", sha256: "690b21cc539aad83ceffe7f1fc933c6bc59eaed40a5619bd09a911ecaf99e8e5", hashBasis: "UTF-8 canonical JSON with recursively sorted object keys" }),
    Object.freeze({ kind: "ATHENA_VIEW", path: "views.msih_reservation_optimize.data", sha256: "e35911d887dcccca397693a7bc390c6f9539e0aa2c0e2d2e5e1e0c9944517a45", hashBasis: "exact UTF-8 bytes of the decoded YAML block scalar" }),
    Object.freeze({ kind: "ATHENA_VIEW", path: "views.msih_reservations.data", sha256: "9a8ba7f427db59e695b4f83b61ebed672280f5c7e51d371493e91d1196ccb0f2", hashBasis: "exact UTF-8 bytes of the decoded YAML block scalar" }),
    Object.freeze({ kind: "ATHENA_VIEW", path: "views.msih_view.data", sha256: "c53c3ae61c5cc47181c29c2c6ca6cd393796d3c4f5e8f6f6805d5dfd5bee616a", hashBasis: "exact UTF-8 bytes of the decoded YAML block scalar" }),
  ]),
  totals: Object.freeze({
    sheets: 9,
    visuals: 144,
    parameterControls: 59,
    filterControls: 33,
    controlPlacements: 92,
    parameterDeclarations: 44,
    calculatedFields: 175,
    filterGroups: 241,
    columnConfigurations: 2,
    datasets: 3,
  }),
  visualTypes: Object.freeze({
    BarChartVisual: 48,
    KPIVisual: 29,
    InsightVisual: 14,
    LineChartVisual: 25,
    TableVisual: 6,
    HeatMapVisual: 1,
    ScatterPlotVisual: 1,
    ComboChartVisual: 7,
    PivotTableVisual: 7,
    SankeyDiagramVisual: 6,
  }),
  datasets: Object.freeze([
    Object.freeze({ id: "msih_reservation_optimize", importMode: "SPICE", physicalTables: 3, inputColumnCounts: Object.freeze([2, 2, 36]), queryLineCount: 151 }),
    Object.freeze({ id: "msih_reservations", importMode: "SPICE", physicalTables: 3, inputColumnCounts: Object.freeze([31, 2, 2]), queryLineCount: 123 }),
    Object.freeze({ id: "msih_view", importMode: "SPICE", physicalTables: 3, inputColumnCounts: Object.freeze([51, 2, 2]), queryLineCount: 128 }),
  ]),
  sheets: Object.freeze<readonly MediaServicesOfficialSheet[]>([
    Object.freeze({
      id: "cb405782-cc31-48c5-920d-8a2a35b9481e",
      name: "Executive Summary",
      visualCount: 20,
      visualTypes: Object.freeze({ BarChartVisual: 3, KPIVisual: 11, InsightVisual: 2, LineChartVisual: 2, TableVisual: 1, HeatMapVisual: 1 }),
      controls: Object.freeze([
        control("parameter", "Dropdown", "Linked Account", "PARTIAL"),
        control("parameter", "Dropdown", "Payer Account", "SERVER_PINNED"),
        control("parameter", "Dropdown", "Account Display Format", "UNAVAILABLE"),
        control("parameter", "Dropdown", "Cost Model", "SERVER_PINNED"),
        control("parameter", "Dropdown", "Include Pricing Adjustments", "SERVER_PINNED"),
        control("parameter", "Slider", "Top N", "UNAVAILABLE"),
        control("parameter", "Slider", "Months for Lookback", "SERVER_PINNED"),
      ]),
      documentedPurposes: Object.freeze([
        purpose("Total media-services costs and month-over-month trends", "SUPPORTED", "Currency- and cost-basis-separated CUR2 totals and monthly trend points.", null),
        purpose("Service-wise cost breakdown and utilization metrics", "PARTIAL", "Exact service costs and metered usage dimensions are available.", "CloudWatch utilization metrics are not ingested."),
        purpose("Top spending accounts and Regions", "PARTIAL", "Account/Region accepted heads and exact cost groups are filterable.", "The exact Top-N ranking control and upstream chart geometry are unavailable."),
        purpose("Cost per service comparison and growth trends", "PARTIAL", "Service costs and monthly historical trends are available.", "Unlike currencies and cost bases never merge; growth is not synthesized across incomplete periods."),
        purpose("Key performance indicators and cost-optimization opportunities", "PARTIAL", "Bounded resource, row, cost and workflow counts are native.", "No recommendation is inferred without provider or pricing evidence."),
        purpose("Regional distribution of media-services usage", "PARTIAL", "Region-scoped captures and unit-isolated usage rows are native.", "No unpublished heat-map geometry or mixed-unit aggregation is claimed."),
        purpose("Monthly cost forecasting and budget tracking", "PARTIAL", "A labeled trailing-period Sutra projection is available when sufficient periods exist.", "It is not the QuickSight forecast; AWS Budgets evidence remains unavailable."),
      ]),
    }),
    Object.freeze({
      id: "984dc7d1-4f86-4d7b-91a8-bf5cadf5b15b",
      name: "MediaLive Reservation & Savings",
      visualCount: 27,
      visualTypes: Object.freeze({ TableVisual: 4, InsightVisual: 1, ScatterPlotVisual: 1, BarChartVisual: 8, LineChartVisual: 7, KPIVisual: 4, ComboChartVisual: 2 }),
      controls: Object.freeze([
        control("parameter", "DateTimePicker", "Lookback Start", "SERVER_PINNED"),
        control("parameter", "DateTimePicker", "Lookback End", "SERVER_PINNED"),
        control("parameter", "List", "Status", "PARTIAL"),
        control("parameter", "Dropdown", "Linked Account", "PARTIAL"),
        control("parameter", "Dropdown", "Payer Account", "SERVER_PINNED"),
        control("parameter", "Dropdown", "Cost Model", "SERVER_PINNED"),
        control("parameter", "Dropdown", "Include Pricing Adjustments", "SERVER_PINNED"),
        control("parameter", "Slider", "Potential Reservation Savings Rate", "UNAVAILABLE"),
        control("parameter", "Slider", "Total Reservations Scenrio Target (including existing)", "UNAVAILABLE"),
        control("filter", "List", "Type", "PARTIAL"),
        control("filter", "List", "Region", "SUPPORTED"),
        control("filter", "List", "Resolution", "PARTIAL"),
        control("filter", "List", "Bit Rate", "PARTIAL"),
        control("filter", "List", "Frame Rate", "PARTIAL"),
        control("filter", "Dropdown", "Codec", "PARTIAL"),
        control("filter", "Dropdown", "DO NOT CHANGE OR DELETE", "UNAVAILABLE"),
      ]),
      documentedPurposes: Object.freeze([
        purpose("Current and potential MediaLive reservation savings", "UNAVAILABLE", "Reservation, offering and channel inventory counts are shown separately.", "Versioned on-demand comparison rates, reservation allocation and independently reconciled savings are not accepted evidence."),
        purpose("Reserved instances for predictable MediaLive workloads", "UNAVAILABLE", "No purchase recommendation is emitted.", "Workload predictability and the documented up-to-75-percent statement are guidance, not tenant savings evidence."),
        purpose("Optimal one-year versus three-year reservation terms", "UNAVAILABLE", "No term recommendation is emitted.", "Governed term pricing and future usage evidence are absent."),
        purpose("Reservation utilization and capacity adjustment", "PARTIAL", "Reservation/offering/channel inventory and accepted configuration state are native.", "CloudWatch utilization and workload concurrency reconciliation are absent."),
      ]),
    }),
    Object.freeze({
      id: "6d541657-b7f2-4ace-bb22-6f01dc6ff7ef",
      name: "MediaConvert",
      visualCount: 17,
      visualTypes: Object.freeze({ ComboChartVisual: 1, LineChartVisual: 4, PivotTableVisual: 1, InsightVisual: 2, BarChartVisual: 6, KPIVisual: 3 }),
      controls: Object.freeze([
        control("parameter", "List", "Usage Category (Usage)", "PARTIAL"),
        control("parameter", "List", "Usage Category (Cost)", "PARTIAL"),
        control("parameter", "List", "Format", "PARTIAL"),
        ...commonControls(),
        control("filter", "List", "Tier", "PARTIAL"),
        control("filter", "List", "Region", "SUPPORTED"),
        control("filter", "Dropdown", "REGION-DO NOT ADJUST", "UNAVAILABLE"),
      ]),
      documentedPurposes: Object.freeze([
        purpose("Job processing costs by queue and priority", "PARTIAL", "Queue/job inventory, attributes and exact CUR2 service cost are native.", "Exact per-job cost attribution requires resource ARN coverage."),
        purpose("Queue utilization and processing-time analysis", "PARTIAL", "Accepted queue/job state and bounded time attributes can be inspected.", "CloudWatch queue utilization and complete processing telemetry are absent."),
        purpose("Input/output format cost comparison", "PARTIAL", "Format-like provider attributes and cost rows remain inspectable.", "No exact dedicated format selector or complete per-format attribution is claimed."),
        purpose("Reserved-capacity utilization and recommendations", "UNAVAILABLE", "No recommendation or savings amount is emitted.", "Governed capacity pricing, utilization and future demand evidence are absent."),
        purpose("Job failure rates and retry costs", "PARTIAL", "Accepted job state and retry-like attributes may be inspected.", "Complete event history and exact retry-cost attribution are absent."),
        purpose("Processing-time trends and optimization opportunities", "PARTIAL", "Accepted processing attributes and monthly CUR2 costs are native.", "No performance recommendation is inferred."),
        purpose("Cost per minute of processed content", "PARTIAL", "Cost and unit-isolated usage evidence remain separate and visible.", "A ratio is not produced when processed-minute coverage is incomplete."),
        purpose("Peak usage periods and capacity planning", "UNAVAILABLE", "Historical monthly cost and usage rows are retained.", "No complete hourly workload telemetry or capacity model is accepted."),
      ]),
    }),
    Object.freeze({
      id: "2ff1654d-2387-4449-88c0-3230f227f912",
      name: "MediaConnect",
      visualCount: 14,
      visualTypes: Object.freeze({ ComboChartVisual: 1, SankeyDiagramVisual: 2, LineChartVisual: 2, InsightVisual: 2, PivotTableVisual: 1, BarChartVisual: 4, KPIVisual: 2 }),
      controls: Object.freeze([
        control("parameter", "List", "Usage Category (Usage)", "PARTIAL"),
        control("parameter", "List", "Usage Category (Cost)", "PARTIAL"),
        ...commonControls(),
      ]),
      documentedPurposes: Object.freeze([
        purpose("Connection usage patterns and data-transfer volumes", "PARTIAL", "Flow inventory and unit-isolated CUR2 usage rows are native.", "Complete connection telemetry is absent."),
        purpose("Cost breakdown by connection type and Region", "PARTIAL", "Flow attributes, Region scope and exact cost groups are native.", "Per-flow attribution depends on exact ARN coverage."),
        purpose("Bandwidth utilization and peak usage", "UNAVAILABLE", "No utilization percentage is synthesized.", "CloudWatch bandwidth and peak telemetry are not ingested."),
        purpose("Source and destination flow analysis", "PARTIAL", "Accepted flow source/output attributes and operations are inspectable.", "The upstream Sankey interaction and complete endpoint telemetry are not reproduced."),
        purpose("Data-transfer cost-optimization opportunities", "UNAVAILABLE", "Historical transfer costs remain visible.", "No recommendation is emitted without pricing and topology reconciliation."),
        purpose("Connection uptime and reliability", "UNAVAILABLE", "Inventory state is not represented as reliability evidence.", "CloudWatch uptime and failure telemetry are absent."),
        purpose("Regional cost comparison for placement", "PARTIAL", "Region-separated cost evidence is native.", "No future-placement price or performance model is accepted."),
      ]),
    }),
    Object.freeze({
      id: "76636fd2-d689-40c6-8d8e-f808e0e37590",
      name: "MediaLive",
      visualCount: 35,
      visualTypes: Object.freeze({ BarChartVisual: 18, ComboChartVisual: 3, LineChartVisual: 6, PivotTableVisual: 2, InsightVisual: 3, KPIVisual: 3 }),
      controls: Object.freeze([
        control("parameter", "List", "Parameter Type", "PARTIAL"),
        control("parameter", "List", "Usage Category (Usage)", "PARTIAL"),
        control("parameter", "List", "Usage Category (Cost)", "PARTIAL"),
        control("parameter", "List", "Resource Type", "SUPPORTED"),
        ...commonControls(),
        control("filter", "List", "Flow", "PARTIAL"),
        control("filter", "List", "Pipeline", "PARTIAL"),
        control("filter", "List", "Codec", "PARTIAL"),
        control("filter", "List", "Resolution", "PARTIAL"),
        control("filter", "List", "Bit Rate", "PARTIAL"),
        control("filter", "List", "Frame Rate", "PARTIAL"),
        control("filter", "List", "Quality", "PARTIAL"),
        control("filter", "List", "Region", "SUPPORTED"),
        control("filter", "List", "Transcoding Profile", "PARTIAL"),
        control("filter", "Dropdown", "FILTER_HELPER_DO_NOT_EDIT", "UNAVAILABLE"),
      ]),
      documentedPurposes: Object.freeze([
        purpose("Channel costs by type and configuration", "PARTIAL", "Channel/multiplex inventory, attributes and exact service costs are native.", "Exact channel attribution depends on CUR2 resource ARN coverage."),
        purpose("Input/output bandwidth utilization", "UNAVAILABLE", "No bandwidth percentage is synthesized.", "CloudWatch input/output bandwidth telemetry is absent."),
        purpose("Reserved-instance versus on-demand cost analysis", "UNAVAILABLE", "Reservation inventory is separate and savings remains explicitly unavailable.", "Versioned comparison rates and reservation allocation are absent."),
        purpose("Channel uptime and availability", "UNAVAILABLE", "Configuration state is not represented as uptime evidence.", "CloudWatch availability evidence is absent."),
        purpose("Regional deployment cost comparison", "PARTIAL", "Region-separated historical cost is native.", "No future deployment price/performance model is accepted."),
        purpose("Encoding-profile cost optimization", "PARTIAL", "Encoding attributes and historical costs are inspectable.", "No optimization recommendation is inferred."),
        purpose("Redundancy-configuration cost impact", "PARTIAL", "Configuration attributes and cost evidence remain visible.", "Causal before/after evidence is absent."),
        purpose("Peak concurrent channel usage", "UNAVAILABLE", "Channel inventory counts are native.", "Complete hourly concurrency telemetry is absent."),
      ]),
    }),
    Object.freeze({
      id: "2706b2c8-d893-48e0-9d57-7c36255fe61a",
      name: "MediaTailor",
      visualCount: 16,
      visualTypes: Object.freeze({ PivotTableVisual: 2, SankeyDiagramVisual: 2, KPIVisual: 3, BarChartVisual: 5, InsightVisual: 2, LineChartVisual: 2 }),
      controls: Object.freeze([
        control("parameter", "List", "Usage Category (Usage)", "PARTIAL"),
        control("parameter", "List", "Usage Category (Cost)", "PARTIAL"),
        ...commonControls(),
      ]),
      documentedPurposes: Object.freeze([
        purpose("Session volume and ad-request patterns", "PARTIAL", "Playback/channel/source inventory and CUR2 usage dimensions are native.", "Complete session and ad-request telemetry are absent."),
        purpose("Personalization costs and revenue impact", "PARTIAL", "Historical service costs are native.", "Revenue and causal impact evidence are absent."),
        purpose("Configuration usage and optimization", "PARTIAL", "Configuration inventory and accepted attributes are inspectable.", "No optimization recommendation is inferred."),
        purpose("Ad-decision-server integration costs", "PARTIAL", "Operation/usage dimensions and service costs are visible when provided by CUR2.", "External decision-server billing is not ingested."),
        purpose("Content-delivery-network costs", "PARTIAL", "MediaTailor CUR2 cost and transfer-like dimensions remain visible.", "CDN telemetry and cross-service allocation are absent."),
        purpose("Session duration and engagement", "UNAVAILABLE", "No engagement metric is synthesized.", "Viewer/session analytics are absent."),
        purpose("Revenue per session", "UNAVAILABLE", "No revenue ratio is synthesized.", "Revenue and complete session evidence are absent."),
        purpose("Peak traffic handling and scaling", "UNAVAILABLE", "Inventory counts are native.", "Complete traffic and autoscaling telemetry are absent."),
      ]),
    }),
    Object.freeze({
      id: "07a36a13-fc6a-421b-9128-aff6ef568aa7",
      name: "MediaPackage",
      visualCount: 14,
      visualTypes: Object.freeze({ PivotTableVisual: 1, KPIVisual: 3, SankeyDiagramVisual: 2, InsightVisual: 2, BarChartVisual: 4, LineChartVisual: 2 }),
      controls: Object.freeze([
        control("parameter", "List", "Usage Category", "PARTIAL"),
        control("parameter", "List", "Usage Category (Cost)", "PARTIAL"),
        ...commonControls(),
      ]),
      documentedPurposes: Object.freeze([
        purpose("Endpoint usage and request-volume analysis", "PARTIAL", "Channel/group/endpoint inventory and unit-isolated usage are native.", "Complete request telemetry is absent."),
        purpose("Content-delivery cost breakdown", "PARTIAL", "Exact MediaPackage CUR2 costs and usage dimensions are native.", "Cross-service delivery allocation is absent."),
        purpose("Origin-request patterns and caching efficiency", "UNAVAILABLE", "No cache-efficiency value is synthesized.", "Request/cache telemetry is absent."),
        purpose("Packaging-format cost comparison", "PARTIAL", "Packaging attributes and historical costs are inspectable.", "Complete per-format attribution is not guaranteed."),
        purpose("Regional endpoint performance and costs", "PARTIAL", "Region-separated historical costs are native.", "Endpoint performance telemetry is absent."),
        purpose("Content-protection and DRM costs", "PARTIAL", "Configuration attributes and CUR2 cost rows remain inspectable.", "External DRM billing and allocation are absent."),
        purpose("Harvest-job costs and optimization", "PARTIAL", "Harvest-job inventory and exact-ARN cost exist when CUR2 provides attribution.", "No optimization recommendation is inferred."),
        purpose("CDN integration cost analysis", "PARTIAL", "Transfer-like CUR2 dimensions remain visible.", "CDN telemetry and cross-service cost allocation are absent."),
      ]),
    }),
    Object.freeze({
      id: "d2141ba5-1ea4-43db-9f94-64dc4b417f79",
      name: "Raw Data",
      visualCount: 1,
      visualTypes: Object.freeze({ TableVisual: 1 }),
      controls: Object.freeze([
        control("filter", "Dropdown", "Product Code", "SUPPORTED"),
        control("filter", "Dropdown", "Operation", "PARTIAL"),
        control("filter", "Dropdown", "Usage Category", "PARTIAL"),
        control("filter", "Dropdown", "Charge Type", "PARTIAL"),
        control("filter", "Dropdown", "Resource ID", "SUPPORTED"),
        control("filter", "Dropdown", "Video Codec", "PARTIAL"),
        control("filter", "Dropdown", "Usage Type", "PARTIAL"),
        control("filter", "Dropdown", "Video Bit Rate", "PARTIAL"),
        control("filter", "Dropdown", "Video Resolution", "PARTIAL"),
        control("filter", "Dropdown", "Video Frame Rate", "PARTIAL"),
        control("filter", "Dropdown", "Product Family", "PARTIAL"),
        control("filter", "Dropdown", "Video Quality", "PARTIAL"),
        control("filter", "Dropdown", "Video Tier", "PARTIAL"),
      ]),
      documentedPurposes: Object.freeze([
        purpose("Raw data view", "PARTIAL", "Tenant-bound resource, usage, cost and lineage rows can be drilled into and exported.", "The exact upstream 51-column SPICE row shape and every dedicated selector are not reproduced."),
      ]),
    }),
    Object.freeze({
      id: "2b62f5db-9662-4f80-9864-2d15a5f21886",
      name: "About",
      visualCount: 0,
      visualTypes: Object.freeze({}),
      controls: Object.freeze([]),
      documentedPurposes: Object.freeze([
        purpose("Official notices, deployment guidance and provenance", "ABOUT_EVIDENCE", "Pinned repositories, hashes, lineage, source states, limitations and activation gaps remain visible.", "The upstream About sheet contains no QuickSight visual objects."),
      ]),
    }),
  ]),
  disclosures: Object.freeze([
    "The complete public definition proves object inventory, not pixel, geometry, interaction-tree, forecast-engine or QuickSight runtime parity.",
    "The linked legacy aws-cudos-framework-deployment URL and the primary CID framework URL resolve to byte-identical MSIH manifest, definition and changelog artifacts at the same commit.",
    "AWS Guidance recommendation language, including up-to-75-percent reservation savings, is not tenant savings evidence.",
    "Sutra reservation savings and AWS Budgets remain unavailable until versioned pricing, allocation, usage and budget evidence are independently reconciled.",
    "Credential broker, provider adapter, durable handler registration, complete reconciliation, two-tenant proof, release review, deployment and live acceptance remain open.",
  ]),
} as const);

export type MediaServicesOfficialDefinition =
  typeof MEDIA_SERVICES_OFFICIAL_DEFINITION;

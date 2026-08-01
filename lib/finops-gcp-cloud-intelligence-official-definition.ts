export type GcpCidNativeCoverage = "PARTIAL" | "ABOUT";

export interface GcpCidOfficialSheet {
  readonly id: string;
  readonly name:
    | "Summary"
    | "Compute Engine"
    | "Cloud SQL"
    | "Big Query"
    | "Network"
    | "Kubernetes"
    | "About";
  readonly visualCount: number;
  readonly parameterControls: readonly string[];
  readonly filterControls: readonly string[];
  readonly visualTypes: Readonly<Record<string, number>>;
  readonly nativeCoverage: GcpCidNativeCoverage;
  readonly nativeEvidence: string;
  readonly remainingGap: string;
}

const sheet = (
  value: GcpCidOfficialSheet,
): Readonly<GcpCidOfficialSheet> => Object.freeze({
  ...value,
  parameterControls: Object.freeze(value.parameterControls),
  filterControls: Object.freeze(value.filterControls),
  visualTypes: Object.freeze(value.visualTypes),
});

const COMMON_PROJECT_CONTROLS = Object.freeze([
  "Billing Account Id",
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
  "L6",
]);

/**
 * Frozen audit of the complete public CID GCP manifest at one immutable
 * awslabs commit. Counts describe source objects, not rendered pixel parity.
 */
export const GCP_CLOUD_INTELLIGENCE_OFFICIAL_DEFINITION = Object.freeze({
  schema: "sutra.finops-gcp-cloud-intelligence-official-definition.v1",
  guidance: Object.freeze({
    catalogUrl:
      "https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/dashboards.html",
    workshopUrl: "https://catalog.workshops.aws/cid-gcp-cost-dashboard/",
    reviewedOn: "2026-08-01",
    documentedPurpose:
      "Export Google Cloud billing data for visualization and reporting by executive, finance, procurement, FinOps, and product-owner audiences.",
  }),
  cidFrameworkAudit: Object.freeze({
    repository:
      "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
    gcpDashboardSpecificArtifactCount: 0,
    disclosure:
      "The common CID framework has no GCP dashboard artifact at the pinned commit; the linked awslabs repository is the dashboard source.",
  }),
  source: Object.freeze({
    repository: "https://github.com/awslabs/cid-gcp-cost-dashboard",
    commit: "d0b5983db3a0931a63fcc21a9f7e2764483cfcaf",
    defaultBranch: "mainline",
    manifestPath: "GCP-Cost-Dashboard.yaml",
    manifestSha256:
      "78ed3d8245be60aea8f212e38f1458d6ea5be8b9f0fe660deee71f494ec7087c",
    embeddedDefinitionSha256:
      "f0c8192efe855309d5cd63189b9a7c10e0819b2ee7eb64e124fae47588347b07",
    deploymentTemplatePath: "GCP-Cost-Dashboard-Stack.yaml",
    deploymentTemplateSha256:
      "d6d4b02fd0ca40270e212600e88bf021e431db924875fb0d3670b5ec6cdea8a4",
    readmePath: "README.md",
    readmeSha256:
      "3e8baa8574a604fe4d061beebbe1a84cb4ea28afb0fc8e36a35b5c3b5bcd9059",
    dashboardId: "gcp-cost-dashboard",
    dashboardName: "GCP Cost Dashboard",
    category: "Custom",
    publishedVersion: null,
  }),
  publication: Object.freeze({
    completeQuickSightDefinitionEmbedded: true,
    standaloneQuickSightDefinitionPath: null,
    standaloneTemplateBodyPath: null,
    externalTemplateId: null,
    changelogPath: null,
    releaseVersion: null,
    embeddedDatasetCount: 2,
    embeddedViewQueryCount: 3,
  }),
  artifacts: Object.freeze([
    Object.freeze({
      kind: "README",
      path: "README.md",
      sha256:
        "3e8baa8574a604fe4d061beebbe1a84cb4ea28afb0fc8e36a35b5c3b5bcd9059",
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "MANIFEST_CONTAINER",
      path: "GCP-Cost-Dashboard.yaml",
      sha256:
        "78ed3d8245be60aea8f212e38f1458d6ea5be8b9f0fe660deee71f494ec7087c",
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "EMBEDDED_QUICKSIGHT_DEFINITION",
      path: "GCP-Cost-Dashboard.yaml#dashboards.GCP COST DASHBOARD.data",
      sha256:
        "f0c8192efe855309d5cd63189b9a7c10e0819b2ee7eb64e124fae47588347b07",
      hashBasis: "decoded YAML scalar UTF-8 bytes",
    }),
    Object.freeze({
      kind: "DEPLOYMENT_TEMPLATE",
      path: "GCP-Cost-Dashboard-Stack.yaml",
      sha256:
        "d6d4b02fd0ca40270e212600e88bf021e431db924875fb0d3670b5ec6cdea8a4",
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "EMBEDDED_DATASET",
      path: "GCP-Cost-Dashboard.yaml#datasets.gcp_currency",
      sha256:
        "a20a78ce6cc2150640e7f0aa39671c0c2ec5e5964b5fc48141ee6f1d2a6920e8",
      hashBasis: "UTF-8 canonical JSON with recursively sorted object keys",
    }),
    Object.freeze({
      kind: "EMBEDDED_DATASET",
      path: "GCP-Cost-Dashboard.yaml#datasets.gcp_summary_with_pricing",
      sha256:
        "171af7d3e269bd51871a3bc860cda8354bf37fd3b942ddbd6b63d15a22016624",
      hashBasis: "UTF-8 canonical JSON with recursively sorted object keys",
    }),
    Object.freeze({
      kind: "EMBEDDED_VIEW_QUERY",
      path: "GCP-Cost-Dashboard.yaml#views.gcp_currency.data",
      sha256:
        "0cc292a475e92c5b47eef7308f367dad25f71ef382f8f0d70214a4cf7de449f7",
      hashBasis: "decoded YAML scalar UTF-8 bytes",
    }),
    Object.freeze({
      kind: "EMBEDDED_VIEW_QUERY",
      path: "GCP-Cost-Dashboard.yaml#views.gcp_current_pricing.data",
      sha256:
        "0edd777957dccca9dcc7d92d8868aaf93dc1b23a22496f3b981e8bf5cac8206b",
      hashBasis: "decoded YAML scalar UTF-8 bytes",
    }),
    Object.freeze({
      kind: "EMBEDDED_VIEW_QUERY",
      path: "GCP-Cost-Dashboard.yaml#views.gcp_summary.data",
      sha256:
        "d0fe4d58905b1a95a2da2ea24f0c22fce196854112559430352fc26abac5c221",
      hashBasis: "decoded YAML scalar UTF-8 bytes",
    }),
  ]),
  totals: Object.freeze({
    sheets: 7,
    visuals: 60,
    parameterControls: 47,
    filterControls: 7,
    parameterDeclarations: 14,
    calculatedFields: 53,
    filterGroups: 172,
    columnConfigurations: 23,
    datasets: 2,
    views: 3,
  }),
  visualTypes: Object.freeze({
    SankeyDiagramVisual: 8,
    PivotTableVisual: 16,
    LineChartVisual: 4,
    TableVisual: 1,
    BarChartVisual: 26,
    WaterfallVisual: 1,
    ComboChartVisual: 3,
    HeatMapVisual: 1,
  }),
  datasets: Object.freeze([
    Object.freeze({
      identifier: "gcp_currency",
      inputColumnCount: 2,
      uniqueInputColumnCount: 2,
      physicalTableCount: 1,
      logicalTableCount: 1,
    }),
    Object.freeze({
      identifier: "gcp_summary_with_pricing",
      inputColumnCount: 72,
      uniqueInputColumnCount: 66,
      physicalTableCount: 2,
      logicalTableCount: 3,
    }),
  ]),
  views: Object.freeze(["gcp_currency", "gcp_current_pricing", "gcp_summary"]),
  sheets: Object.freeze<readonly Readonly<GcpCidOfficialSheet>[]>([
    sheet({
      id: "a236bbda-44eb-4d26-bfea-7ce8f049fe91",
      name: "Summary",
      visualCount: 27,
      parameterControls: [
        "Default Cost",
        "Currency",
        "Project",
        "Product",
        "Group By",
        ...COMMON_PROJECT_CONTROLS,
      ],
      filterControls: ["Cost Type"],
      visualTypes: { SankeyDiagramVisual: 6, PivotTableVisual: 10, LineChartVisual: 3, TableVisual: 1, BarChartVisual: 5, WaterfallVisual: 1, ComboChartVisual: 1 },
      nativeCoverage: "PARTIAL",
      nativeEvidence:
        "Exact invoice totals, realized credits, project/service/SKU/region/resource groups, invoice-month trend, pricing variance and bounded filters are native.",
      remainingGap:
        "The 27 upstream objects, six-level hierarchy controls, Sankey/waterfall geometry and cross-visual actions are not reproduced one-for-one.",
    }),
    sheet({
      id: "85053360-d1d4-43b5-ac2a-cb5e0c12c2d5",
      name: "Compute Engine",
      visualCount: 19,
      parameterControls: [...COMMON_PROJECT_CONTROLS],
      filterControls: ["Cost Type"],
      visualTypes: { BarChartVisual: 11, ComboChartVisual: 2, PivotTableVisual: 3, HeatMapVisual: 1, SankeyDiagramVisual: 1, LineChartVisual: 1 },
      nativeCoverage: "PARTIAL",
      nativeEvidence:
        "Detailed usage rows preserve Compute Engine service, SKU, project, resource, zone/region, usage and exact billed cost when supplied.",
      remainingGap:
        "The 19 upstream objects, hierarchy controls, heat map, Sankey and interaction tree are not reproduced one-for-one.",
    }),
    sheet({
      id: "ca192852-69e5-470c-9f2e-c389acd1ec69",
      name: "Cloud SQL",
      visualCount: 7,
      parameterControls: [...COMMON_PROJECT_CONTROLS],
      filterControls: ["Cost Type"],
      visualTypes: { PivotTableVisual: 1, BarChartVisual: 5, SankeyDiagramVisual: 1 },
      nativeCoverage: "PARTIAL",
      nativeEvidence:
        "Detailed rows preserve Cloud SQL service, SKU, project, region, resource and exact billed cost when supplied.",
      remainingGap:
        "Engine-specific interpretation and the seven upstream visual objects are not inferred from incomplete SKU or label evidence.",
    }),
    sheet({
      id: "d3fb819d-a5d6-4a40-abd9-e9485e530b83",
      name: "Big Query",
      visualCount: 3,
      parameterControls: [...COMMON_PROJECT_CONTROLS],
      filterControls: ["Cost Type"],
      visualTypes: { PivotTableVisual: 1, BarChartVisual: 2 },
      nativeCoverage: "PARTIAL",
      nativeEvidence:
        "BigQuery service/SKU/project/region, usage, pricing quantity, labels and exact billed cost remain inspectable when supplied.",
      remainingGap:
        "Sutra uses the provider product spelling BigQuery and does not claim the three upstream layouts or interactions.",
    }),
    sheet({
      id: "8a8c759d-8682-4f0d-8eb1-4f32a131439b",
      name: "Network",
      visualCount: 3,
      parameterControls: [...COMMON_PROJECT_CONTROLS],
      filterControls: ["Cost Type"],
      visualTypes: { PivotTableVisual: 1, BarChartVisual: 2 },
      nativeCoverage: "PARTIAL",
      nativeEvidence:
        "Network service/SKU/project/region, usage unit and exact billed cost remain inspectable when supplied.",
      remainingGap:
        "The three upstream layouts, hierarchy controls and interactions are not reproduced one-for-one.",
    }),
    sheet({
      id: "3b29908f-4862-4b47-be9a-ef74e9db89a0",
      name: "Kubernetes",
      visualCount: 1,
      parameterControls: [...COMMON_PROJECT_CONTROLS],
      filterControls: ["Cost Type"],
      visualTypes: { BarChartVisual: 1 },
      nativeCoverage: "PARTIAL",
      nativeEvidence:
        "Cluster cost is shown only when GKE cost allocation is enabled and a supplied cluster label proves the grouping.",
      remainingGap:
        "No cluster value is inferred, and upstream hierarchy-control and chart-layout parity is not claimed.",
    }),
    sheet({
      id: "2e9784db-2bbd-4241-a437-2000e2607919",
      name: "About",
      visualCount: 0,
      parameterControls: [],
      filterControls: ["Cost Type"],
      visualTypes: {},
      nativeCoverage: "ABOUT",
      nativeEvidence:
        "Pinned commits, hashes, exact source totals, activation, lineage and limitations are rendered natively.",
      remainingGap:
        "The upstream About sheet contains layout text, not QuickSight visual objects; layout parity is not claimed.",
    }),
  ]),
  nativeBinding: Object.freeze({
    state: "GCP_BIGQUERY_BILLING_EXPORT_ADAPTER_NOT_DEPLOYED",
    permanentRuntimeAdapterAvailable: false,
    workloadIdentityRequired: true,
    serviceAccountKeyAccepted: false,
    liveProviderGenerationAvailable: false,
  }),
  disclosures: Object.freeze([
    "The official source publishes no release version or changelog at the pinned commit; both remain null.",
    "Exact counts describe immutable public QuickSight source objects, not pixel, geometry, query-result or interaction parity.",
    "Calculated pricing variance and optional recommendation savings are separate from provider billed cost and realized credits.",
    "No sample money, AWS connection, FOCUS export, service-account key or inferred opportunity substitutes for detailed GCP billing evidence.",
    "Provider reconciliation, permanent adapter registration, exact-tree validation, reviewed release, image deployment and live acceptance remain open.",
  ]),
} as const);

export type GcpCloudIntelligenceOfficialDefinition =
  typeof GCP_CLOUD_INTELLIGENCE_OFFICIAL_DEFINITION;

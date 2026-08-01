export type FocusOfficialCoverage =
  | "SUPPORTED"
  | "PARTIAL"
  | "UNAVAILABLE"
  | "ABOUT";

export interface FocusOfficialSheet {
  readonly id: string;
  readonly name: "Billing Summary" | "MoM Trends" | "About";
  readonly visualCount: number;
  readonly parameterControls: readonly string[];
  readonly filterControls: readonly string[];
  readonly documentedPurpose: string | null;
  readonly nativeCoverage: FocusOfficialCoverage;
  readonly nativeEvidence: string;
  readonly remainingGap: string;
}

const sheet = (
  value: FocusOfficialSheet,
): Readonly<FocusOfficialSheet> => Object.freeze({
  ...value,
  parameterControls: Object.freeze(value.parameterControls),
  filterControls: Object.freeze(value.filterControls),
});

/**
 * Frozen, evidence-honest audit of AWS's public FOCUS dashboard definition and
 * the official provider integration repositories linked from its guidance.
 * Counts describe public QuickSight source objects, not rendered pixel parity.
 */
export const FOCUS_OFFICIAL_DEFINITION = Object.freeze({
  schema: "sutra.finops-focus-official-definition.v1",
  guidance: Object.freeze({
    url: "https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/focus-dashboard.html",
    reviewedOn: "2026-08-01",
    documentedPurposes: Object.freeze([
      "Consolidated FOCUS cost and usage across an organization and multiple dimensions.",
      "Consolidation of multiple FOCUS specification versions and cloud providers.",
      "Month-over-month trends with high-level-to-resource drilldown.",
      "Organizational taxonomy derived from tags.",
      "Effective discount-rate calculation.",
    ]),
  }),
  source: Object.freeze({
    repository:
      "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
    dashboardId: "focus-dashboard",
    dashboardName: "FOCUS Dashboard",
    category: "Additional",
    theme: "MIDNIGHT",
    version: "v1.2.0",
    manifestPath: "dashboards/focus/focus.yaml",
    manifestSha256:
      "a9521d2ece8cb8defe0d791ca018c660d6872394a75593fae1d0acfe12b9c4cb",
    definitionPath: "dashboards/focus/focus-definition.yaml",
    definitionSha256:
      "bc7bafbcb47e745dd256a151ee3fbe260aad10515fc5e626e02aec0c6e6ea1cc",
    changelogPath: "changes/CHANGELOG-focus.md",
    changelogSha256:
      "41bb336c1dcfe285c5b5dcfd469c6170a9d2cad4db41055a15f3506257606541",
  }),
  publication: Object.freeze({
    completeQuickSightDefinitionPublished: true,
    standaloneQuickSightDefinitionPath:
      "dashboards/focus/focus-definition.yaml",
    standaloneTemplateBodyPath: null,
    externalTemplateId: null,
    embeddedDatasetCount: 2,
    embeddedViewQueryCount: 2,
    dynamicConsolidationViewPublished: true,
  }),
  artifacts: Object.freeze([
    Object.freeze({
      kind: "MANIFEST_CONTAINER",
      path: "dashboards/focus/focus.yaml",
      sha256:
        "a9521d2ece8cb8defe0d791ca018c660d6872394a75593fae1d0acfe12b9c4cb",
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "STANDALONE_QUICKSIGHT_DEFINITION",
      path: "dashboards/focus/focus-definition.yaml",
      sha256:
        "bc7bafbcb47e745dd256a151ee3fbe260aad10515fc5e626e02aec0c6e6ea1cc",
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "CHANGELOG",
      path: "changes/CHANGELOG-focus.md",
      sha256:
        "41bb336c1dcfe285c5b5dcfd469c6170a9d2cad4db41055a15f3506257606541",
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "CONSOLIDATION_HELPER",
      path: "cid/helpers/focus_consolidation.py",
      sha256:
        "263c68eabf1533823758354935edfd5990cd89240786342af28953d8f066d7e9",
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "CONSOLIDATION_QUERY_TEMPLATE",
      path: "dashboards/focus/focus_consolidation_view/focus_consolidation_view.sql",
      sha256:
        "7961d360f84f0fe60c67ff25931d02b7298f53d5ddcabeb58bdb8f64bd93f1a4",
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "EMBEDDED_DATASET",
      path: "dashboards/focus/focus.yaml#datasets.focus_resource_view",
      sha256:
        "3585537829427afa0a88e0b71033797c444615375917b8395a10abfac4cfe6d2",
      hashBasis: "UTF-8 canonical JSON with recursively sorted object keys",
    }),
    Object.freeze({
      kind: "EMBEDDED_DATASET",
      path: "dashboards/focus/focus.yaml#datasets.focus_summary_view",
      sha256:
        "40c5246f7d7422b4e018ea5190596e7b9fd87a5e75c502670af151e4c2269170",
      hashBasis: "UTF-8 canonical JSON with recursively sorted object keys",
    }),
    Object.freeze({
      kind: "EMBEDDED_VIEW_QUERY",
      path: "dashboards/focus/focus.yaml#views.focus_resource_view.data",
      sha256:
        "36a6a31c9b26c7d8ff22396cdf5bbe5d432efafa70073f10f16e2aee7192ece3",
      hashBasis: "decoded YAML scalar UTF-8 bytes",
    }),
    Object.freeze({
      kind: "EMBEDDED_VIEW_QUERY",
      path: "dashboards/focus/focus.yaml#views.focus_summary_view.data",
      sha256:
        "35f0c6cfb9d8bc24542d15c4f2c96a805a42630a4bc8be7a3dda7105737ab6f2",
      hashBasis: "decoded YAML scalar UTF-8 bytes",
    }),
    Object.freeze({
      kind: "DYNAMIC_CONSOLIDATION_SCHEMA",
      path: "dashboards/focus/focus.yaml#views.focus_consolidation_view",
      sha256:
        "c841e0fa7a9a0c202b5d226fe8b7ec675216fe3e47df6674eb800e8ed25f13d5",
      hashBasis: "UTF-8 canonical JSON of the 58-column schema with recursively sorted object keys",
    }),
  ]),
  totals: Object.freeze({
    sheets: 3,
    visuals: 27,
    parameterControls: 5,
    filterControls: 15,
    parameterDeclarations: 6,
    calculatedFields: 24,
    filterGroups: 45,
    columnConfigurations: 16,
    datasets: 2,
  }),
  visualTypes: Object.freeze({
    ComboChartVisual: 5,
    PivotTableVisual: 4,
    KPIVisual: 8,
    WaterfallVisual: 1,
    BarChartVisual: 6,
    SankeyDiagramVisual: 1,
    WordCloudVisual: 1,
    LineChartVisual: 1,
  }),
  parameters: Object.freeze([
    "Currency",
    "summaryGroupByOne",
    "Cost",
    "MomGroupBy1",
    "MomGroupByTwo",
    "summaryGroupByTwo",
  ]),
  dataContracts: Object.freeze([
    Object.freeze({
      identifier: "focus_resource_view",
      inputColumnCount: 56,
      datasetPublished: true,
      queryPublished: true,
    }),
    Object.freeze({
      identifier: "focus_summary_view",
      inputColumnCount: 51,
      datasetPublished: true,
      queryPublished: true,
    }),
    Object.freeze({
      identifier: "focus_consolidation_view",
      inputColumnCount: 58,
      datasetPublished: false,
      queryPublished: true,
    }),
  ]),
  sheets: Object.freeze<readonly Readonly<FocusOfficialSheet>[]>([
    sheet({
      id: "b729f41b-811e-4850-878a-5af8aaaabcdb",
      name: "Billing Summary",
      visualCount: 18,
      parameterControls: ["Group By", "Cost", "Group By"],
      filterControls: [
        "Charge Category",
        "Billing Account",
        "Sub Account",
        "Publisher",
        "Provider",
        "Billing Period",
      ],
      documentedPurpose:
        "Consolidated cost and usage, organizational taxonomy, and effective discount-rate analysis across selectable dimensions.",
      nativeCoverage: "PARTIAL",
      nativeEvidence:
        "Currency-separated exact cost KPIs, daily trends, two independent groupings, billing controls, governed tag taxonomy, provider/service/account counts, and denominator-safe effective discount rate are native.",
      remainingGap:
        "QuickSight Sankey, waterfall, word-cloud geometry and same-sheet interaction parity are not claimed.",
    }),
    sheet({
      id: "5df6e2a8-5758-4889-89e5-7bdf135ca482",
      name: "MoM Trends",
      visualCount: 9,
      parameterControls: ["Group By", "Group By"],
      filterControls: [
        "Charge Category",
        "Billing Account",
        "Sub Account",
        "Publisher",
        "Provider",
      ],
      documentedPurpose:
        "Month-over-month cost trends from high-level organizational dimensions to detailed resources.",
      nativeCoverage: "PARTIAL",
      nativeEvidence:
        "Bounded monthly dimensions, exact prior/current deltas, top-resource trends, and resource-level billing-line drilldown are native.",
      remainingGap:
        "The nine upstream visual objects, layout, cross-visual actions, and unbounded result parity are not reproduced one-for-one.",
    }),
    sheet({
      id: "d07bd362-bd02-41e8-8c76-4a71cf4984e0",
      name: "About",
      visualCount: 0,
      parameterControls: [],
      filterControls: [
        "Charge Category",
        "Billing Account",
        "Publisher",
        "Provider",
      ],
      documentedPurpose: null,
      nativeCoverage: "ABOUT",
      nativeEvidence:
        "Pinned commits, hashes, exact source-object totals, source versions, immutable generations, and evidence limitations are rendered natively.",
      remainingGap:
        "The upstream About content is held in layout text boxes, not QuickSight visual objects; Sutra does not claim layout parity.",
    }),
  ]),
  providerSources: Object.freeze([
    Object.freeze({
      provider: "AWS",
      sourceKind: "FOCUS_1_2_DATA_EXPORT",
      repository:
        "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
      commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
      nativeBindingState: "BOUND_FOCUS_1_2",
      disclosure:
        "Sutra binds only immutable active AWS FOCUS 1.2 generations; CUR and older FOCUS versions are not fallbacks.",
      artifacts: Object.freeze([]),
    }),
    Object.freeze({
      provider: "AZURE",
      sourceKind: "FOCUS_1_0_OR_1_0R2_EXPORT",
      repository:
        "https://github.com/aws-samples/aws-data-pipelines-for-azure-storage",
      commit: "ca870a82ce9e8fba4670af9a649df4074f931e02",
      nativeBindingState: "AZURE_FOCUS_1_0_NORMALIZED_BINDING_NOT_DEPLOYED",
      disclosure:
        "The official collector publishes Azure FOCUS 1.0/1.0r2 transformation and consolidation artifacts, but Sutra has no deployed normalized binding for them.",
      artifacts: Object.freeze([
        Object.freeze({ kind: "README", path: "README.md", sha256: "3d41c089cbf99c082504c01da029fcddcfc585a272af4b2e1e34ab3ede8c4b2f" }),
        Object.freeze({ kind: "DEPLOYMENT_TEMPLATE", path: "CloudIntelligenceDashboardforAzure/CFN/cid-azure-stack.yaml", sha256: "f91c63ab490f20df14434a14b945178f994ea3089fe9f07ae368b886b2e9dc00" }),
        Object.freeze({ kind: "DASHBOARD_MANIFEST_WITHOUT_EMBEDDED_DEFINITION", path: "CloudIntelligenceDashboardforAzure/CFN/cid-azure-dashboard.yaml", sha256: "7da6faa098d8e56c3bc3620139e70c7a246f58df95281676a4afd734c5c52905" }),
        Object.freeze({ kind: "FOCUS_TRANSFORM", path: "CloudIntelligenceDashboardforAzure/CFN/cid-azure-gluejob-FOCUS-1.0.py", sha256: "8633a21a72941e4ca7fd92c24a8793992b56c657c05c113b6ff6ce1852792be8" }),
        Object.freeze({ kind: "FOCUS_QUERY", path: "CloudIntelligenceDashboardforAzure/TF/cid-azure-focus_consolidation_view.sql", sha256: "c35561bd208984659be28ec06334ae35ba93de5b305c6306fe280b9d58f8f434" }),
        Object.freeze({ kind: "FOCUS_QUERY", path: "CloudIntelligenceDashboardforAzure/TF/cid-azure-focus_resource_view.sql", sha256: "27495242f53cb74ad2fce145165aec9e2ad56edf6197e17d1d89a120d4f7a6c5" }),
        Object.freeze({ kind: "FOCUS_QUERY", path: "CloudIntelligenceDashboardforAzure/TF/cid-azure-focus_summary_view.sql", sha256: "d7b1d6549abc13a7033766311895b9674ca5f5cb1dd66dc7855deaef85330fd9" }),
      ]),
    }),
    Object.freeze({
      provider: "GCP",
      sourceKind: "NATIVE_DETAILED_BILLING_NOT_FOCUS",
      repository: "https://github.com/awslabs/cid-gcp-cost-dashboard",
      commit: "d0b5983db3a0931a63fcc21a9f7e2764483cfcaf",
      nativeBindingState: "GCP_FOCUS_EXPORT_ADAPTER_NOT_DEPLOYED",
      disclosure:
        "The linked official repository consumes native BigQuery detailed billing and pricing exports. Its public 7-sheet/60-visual dashboard is not evidence of a GCP FOCUS adapter and is never relabelled as FOCUS.",
      quickSightDefinition: Object.freeze({
        published: true,
        embeddedDefinitionSha256:
          "f0c8192efe855309d5cd63189b9a7c10e0819b2ee7eb64e124fae47588347b07",
        sheets: 7,
        visuals: 60,
        parameterControls: 47,
        filterControls: 7,
        classification: "SUPPLEMENTAL_NON_FOCUS_DASHBOARD",
      }),
      artifacts: Object.freeze([
        Object.freeze({ kind: "README", path: "README.md", sha256: "3e8baa8574a604fe4d061beebbe1a84cb4ea28afb0fc8e36a35b5c3b5bcd9059" }),
        Object.freeze({ kind: "MANIFEST_AND_EMBEDDED_DEFINITION", path: "GCP-Cost-Dashboard.yaml", sha256: "78ed3d8245be60aea8f212e38f1458d6ea5be8b9f0fe660deee71f494ec7087c" }),
        Object.freeze({ kind: "DEPLOYMENT_TEMPLATE", path: "GCP-Cost-Dashboard-Stack.yaml", sha256: "d6d4b02fd0ca40270e212600e88bf021e431db924875fb0d3670b5ec6cdea8a4" }),
        Object.freeze({ kind: "EMBEDDED_DATASET", path: "GCP-Cost-Dashboard.yaml#datasets.gcp_currency", sha256: "a20a78ce6cc2150640e7f0aa39671c0c2ec5e5964b5fc48141ee6f1d2a6920e8" }),
        Object.freeze({ kind: "EMBEDDED_DATASET", path: "GCP-Cost-Dashboard.yaml#datasets.gcp_summary_with_pricing", sha256: "171af7d3e269bd51871a3bc860cda8354bf37fd3b942ddbd6b63d15a22016624" }),
        Object.freeze({ kind: "EMBEDDED_QUERY", path: "GCP-Cost-Dashboard.yaml#views.gcp_currency", sha256: "0cc292a475e92c5b47eef7308f367dad25f71ef382f8f0d70214a4cf7de449f7" }),
        Object.freeze({ kind: "EMBEDDED_QUERY", path: "GCP-Cost-Dashboard.yaml#views.gcp_current_pricing", sha256: "0edd777957dccca9dcc7d92d8868aaf93dc1b23a22496f3b981e8bf5cac8206b" }),
        Object.freeze({ kind: "EMBEDDED_QUERY", path: "GCP-Cost-Dashboard.yaml#views.gcp_summary", sha256: "d0fe4d58905b1a95a2da2ea24f0c22fce196854112559430352fc26abac5c221" }),
      ]),
    }),
    Object.freeze({
      provider: "OCI",
      sourceKind: "OCI_CUR_TO_FOCUS_PIPELINE",
      repository: "https://github.com/awslabs/cid-oci-cost-dashboard",
      commit: "27459467b931181635b2e070a93a8865bf3314bd",
      nativeBindingState: "OCI_SOURCE_DISCOVERY_AND_BINDING_NOT_DEPLOYED",
      disclosure:
        "The official repository publishes a collector, FOCUS conversion and consolidation queries, but no QuickSight definition and no Sutra discovery or normalized binding.",
      artifacts: Object.freeze([
        Object.freeze({ kind: "README", path: "README.md", sha256: "785addfabc6fff8a193342d6725f5b2a23108a23188f2ca0cb1d477ee6d4fea5" }),
        Object.freeze({ kind: "DEPLOYMENT_TEMPLATE", path: "cid-oci-stack.yaml", sha256: "cfb56c37482bef729ebf5648a7ed9ea7a6156084f46f037f5ad624018a7bc028" }),
        Object.freeze({ kind: "FOCUS_TRANSFORM", path: "src/glue-scripts/oci-focus-csv-to-parquet-glue.py", sha256: "fd39232e7690b1ffb9aa4e6f2bc19163a3d69ca25cba753719adb44f466034d4" }),
        Object.freeze({ kind: "FOCUS_QUERY", path: "src/queries/focus_consolidation_view.sql", sha256: "678f95ce9faba04da504c783584d78fad592baf036a7cd364ec6cdcf18b82b77" }),
        Object.freeze({ kind: "FOCUS_QUERY", path: "src/queries/focus_consolidation_view_currency_conversion.sql", sha256: "6f07f3d9e9524db0087d993d6faf73623c4b7a628208f258fbb98f8ff8116090" }),
        Object.freeze({ kind: "CURRENCY_QUERY", path: "src/queries/currency_rates.sql", sha256: "4d4331778df5f49de1484930abbf4e083d0633a1c0808ebd19d2b7d2b67a2838" }),
      ]),
    }),
  ]),
  disclosures: Object.freeze([
    "Exact object counts describe immutable public QuickSight source, not pixel, geometry, query-result or interaction parity.",
    "Only five analytical purposes are attributed to AWS Guidance; additional structural details come from the hash-pinned definition.",
    "Currencies are never combined and missing optional cost columns remain unavailable rather than zero.",
    "CUR, Azure native cost exports, GCP detailed billing exports, Cost Explorer and sample values are never substituted for FOCUS evidence.",
    "Azure, GCP and OCI provider adapters remain explicitly unbound; discovery does not imply normalized ingestion support.",
  ]),
} as const);

export type FocusOfficialDefinition = typeof FOCUS_OFFICIAL_DEFINITION;

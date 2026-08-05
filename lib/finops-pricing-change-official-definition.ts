export type PricingChangeOfficialCoverage =
  | "NATIVE_EVIDENCE_PARTIAL"
  | "NATIVE_EVIDENCE_UNAVAILABLE"
  | "ABOUT_EVIDENCE";

export interface PricingChangeOfficialVisual {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly coverage: PricingChangeOfficialCoverage;
  readonly nativeEvidence: string;
  readonly remainingGap: string;
}

export interface PricingChangeOfficialControl {
  readonly placement: "parameter" | "filter";
  readonly type: "Dropdown" | "CrossSheet" | "DateTimePicker";
  readonly title: string;
  readonly nativeState: "SUPPORTED" | "SERVER_PINNED" | "UNAVAILABLE";
}

export interface PricingChangeOfficialSheet {
  readonly id: string;
  readonly name: string;
  readonly visualCount: number;
  readonly visualTypes: Readonly<Record<string, number>>;
  readonly visuals: readonly PricingChangeOfficialVisual[];
  readonly controls: readonly PricingChangeOfficialControl[];
}

const visual = (
  id: string,
  type: string,
  title: string,
  coverage: PricingChangeOfficialCoverage,
  nativeEvidence: string,
  remainingGap: string,
): PricingChangeOfficialVisual => Object.freeze({
  id, type, title, coverage, nativeEvidence, remainingGap,
});

const control = (
  placement: PricingChangeOfficialControl["placement"],
  type: PricingChangeOfficialControl["type"],
  title: string,
  nativeState: PricingChangeOfficialControl["nativeState"],
): PricingChangeOfficialControl => Object.freeze({
  placement, type, title, nativeState,
});

/**
 * Frozen audit of the complete public Pricing Change Analysis v1.1.0 artifact.
 * The QuickSight definition, dataset template and Athena view are YAML values
 * embedded in the manifest; no screenshot-derived object is included.
 */
export const PRICING_CHANGE_OFFICIAL_DEFINITION = Object.freeze({
  schema: "sutra.finops-pricing-change-official-definition.v1",
  source: Object.freeze({
    repository:
      "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
    documentationUrl:
      "https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/pricing-change-dashboard.html",
    manifestPath: "dashboards/pca/pca.yaml",
    dashboardId: "pricing-change-analysis",
    name: "Pricing Change Analysis (PCA) Dashboard",
    version: "v1.1.0",
    changelogVersion: "v1.0.1",
    guidanceCategory: "Additional",
    manifestCategory: "ADVANCED",
    theme: "MIDNIGHT",
    datasetIdentifier: "pricing_changes",
    viewName: "pricing_changes",
  }),
  publication: Object.freeze({
    completeDefinitionPublished: true,
    standaloneDefinitionPath: null,
    dashboardSpecificDeploymentTemplatePath: null,
    deploymentUsesSharedCidPluginTemplate: true,
  }),
  artifacts: Object.freeze([
    Object.freeze({
      kind: "MANIFEST_CONTAINER",
      path: "dashboards/pca/pca.yaml",
      sha256: "2919c040bd1913eddac949bfcf5aceb2df14b2e2d0dd28a9e3f399001dfa2ae8",
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "EMBEDDED_QUICKSIGHT_DEFINITION",
      path: "dashboards.PRICING CHANGE ANALYSIS.data",
      sha256: "b8f3c3579f4c7fe9163b5b1a4399c8ca7e40c70ed0155c9312f95eacdfca40fd",
      hashBasis: "exact UTF-8 bytes of the decoded YAML block scalar",
    }),
    Object.freeze({
      kind: "EMBEDDED_DATASET_TEMPLATE",
      path: "datasets.pricing_changes.data",
      sha256: "dbf76e59436e60a4b855cace840d9c8823972b53ee344494b86aefab97fa3af4",
      hashBasis: "UTF-8 canonical JSON with recursively sorted object keys",
    }),
    Object.freeze({
      kind: "EMBEDDED_ATHENA_VIEW",
      path: "views.pricing_changes.data",
      sha256: "d8aa257b9655f94c2112042e57587914a7dceeb38b664209bb7591709634540f",
      hashBasis: "exact UTF-8 bytes of the decoded YAML block scalar",
    }),
    Object.freeze({
      kind: "CHANGELOG",
      path: "changes/CHANGELOG-pca.md",
      sha256: "8ef9302aa2f33a190c6ef84d7f069c79e99afb730cc25dd287e56193ca3122f8",
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "SHARED_DEPLOYMENT_TEMPLATE",
      path: "cfn-templates/cid-plugin.yml",
      sha256: "b96a47e6b53418293ec7127d0a95f96f2ffdae2781cde2b2dffcabad926a713d",
      hashBasis: "raw file bytes",
    }),
  ]),
  totals: Object.freeze({
    sheets: 2,
    visuals: 11,
    parameterControls: 1,
    filterControls: 9,
    controlPlacements: 10,
    parameterDeclarations: 6,
    calculatedFields: 10,
    filterGroups: 8,
    columnConfigurations: 3,
    datasets: 1,
  }),
  visualTypes: Object.freeze({
    BarChartVisual: 4,
    KPIVisual: 2,
    LineChartVisual: 1,
    ComboChartVisual: 1,
    PivotTableVisual: 2,
    InsightVisual: 1,
  }),
  parameterNames: Object.freeze([
    "PreviousNMonths", "Payer", "AccountName", "LinkedAccountIDs",
    "ProductName", "CostType",
  ]),
  dataset: Object.freeze({
    importMode: "SPICE",
    physicalTables: 2,
    pricingChangesInputColumns: 21,
    accountMapInputColumns: 2,
    logicalProjectedColumns: 25,
    dependencies: Object.freeze(["pricing_changes", "account_map"]),
    cur1DependencyColumns: 18,
    queryLineCount: 121,
    documentedWindow: "previous 24 complete months",
  }),
  sheets: Object.freeze<readonly PricingChangeOfficialSheet[]>([
    Object.freeze({
      id: "7c3a2961-769c-4d6f-b603-5070885d61db",
      name: "Pricing Change Analysis",
      visualCount: 10,
      visualTypes: Object.freeze({
        BarChartVisual: 4,
        KPIVisual: 2,
        LineChartVisual: 1,
        ComboChartVisual: 1,
        PivotTableVisual: 2,
      }),
      visuals: Object.freeze([
        visual(
          "01c3bc3d-4441-4a73-a664-22637bce3fbd",
          "BarChartVisual",
          "Total Cost Difference by Region - Service SKUs Impacted by Price Change",
          "NATIVE_EVIDENCE_PARTIAL",
          "Exact Region and service groups with baseline, comparison and modeled-change amounts are available.",
          "SKU is not retained in the report group and the upstream monthly bar geometry is not reproduced.",
        ),
        visual(
          "d9e034fe-002b-4bfd-b45d-ce0b493b0695",
          "BarChartVisual",
          "Total Cost Difference Impact by Account Name and Service",
          "NATIVE_EVIDENCE_PARTIAL",
          "Same-tenant linked-account ID and service groups carry exact modeled-change amounts.",
          "Friendly account-name evidence and the upstream monthly bar geometry are unavailable.",
        ),
        visual(
          "e101edf8-c3b2-41ee-88b5-dade459defd2",
          "KPIVisual",
          "Cost Difference Last month",
          "NATIVE_EVIDENCE_UNAVAILABLE",
          "No current value is synthesized from a missing monthly materialization.",
          "The report compares two pinned catalog dates over one usage window and does not publish a last-month KPI.",
        ),
        visual(
          "5a2492bf-2162-4dfa-88a4-e68257fd6d62",
          "LineChartVisual",
          "Total Cost per Month (pre- and post-price change)",
          "NATIVE_EVIDENCE_UNAVAILABLE",
          "Baseline and comparison totals remain exact and currency-separated.",
          "A complete monthly time series is not persisted or returned, so line-chart parity is not claimed.",
        ),
        visual(
          "d8f5b8f4-d209-4afe-b008-979a756e6987",
          "ComboChartVisual",
          "Monthly Cost Difference by Payer / Account Name (Drill Down Available)",
          "NATIVE_EVIDENCE_UNAVAILABLE",
          "Payer and linked-account IDs are tenant-bound dimensions in exact groups.",
          "Monthly series, friendly account names and the upstream drill-down interaction are not available.",
        ),
        visual(
          "a748d989-196b-46da-8974-dd6ad33091c3",
          "BarChartVisual",
          "Total Cost Difference Impact by Payer Account",
          "NATIVE_EVIDENCE_PARTIAL",
          "Exact modeled-change groups can be filtered by the server-bound payer account.",
          "The upstream 24-month aggregation and bar-chart geometry are not reproduced.",
        ),
        visual(
          "c4b9bb80-b271-494e-a11b-28df0deb83c0",
          "BarChartVisual",
          "Total Cost Difference Impact by Service",
          "NATIVE_EVIDENCE_PARTIAL",
          "Exact modeled-change groups can be filtered by AWS service code.",
          "The upstream 24-month aggregation and bar-chart geometry are not reproduced.",
        ),
        visual(
          "fcb7d558-e86c-45f9-a912-deb2cc4c529a",
          "KPIVisual",
          "Cost Difference 2 Months Ago",
          "NATIVE_EVIDENCE_UNAVAILABLE",
          "No value is synthesized when the required month-specific evidence is absent.",
          "The report does not publish a two-months-ago KPI.",
        ),
        visual(
          "e9dec707-9ace-4f14-8fb0-93faa323454d",
          "PivotTableVisual",
          "Summary of Cost Differences by Service and Month",
          "NATIVE_EVIDENCE_UNAVAILABLE",
          "Service-level exact groups remain available for the selected usage window.",
          "Month is not a report grouping dimension and the pivot/cross-filter interaction is unavailable.",
        ),
        visual(
          "18d3ee4c-9b82-468e-9bfb-17334367c88f",
          "PivotTableVisual",
          "Product SKUs with rate changes (Cost Type Cost)",
          "NATIVE_EVIDENCE_UNAVAILABLE",
          "Exact catalog applicability and exclusion reasons are validated without fuzzy matching.",
          "SKU, description, billed-rate columns, cost-type selection and the upstream pivot are not returned.",
        ),
      ]),
      controls: Object.freeze([
        control("parameter", "Dropdown", "Cost Type", "UNAVAILABLE"),
        control("filter", "CrossSheet", "Service Name", "SUPPORTED"),
        control("filter", "CrossSheet", "Linked Account Name", "UNAVAILABLE"),
        control("filter", "CrossSheet", "Linked Account ID", "SUPPORTED"),
        control("filter", "CrossSheet", "Payer Account ID", "SUPPORTED"),
        control("filter", "DateTimePicker", "Date Range", "SERVER_PINNED"),
      ]),
    }),
    Object.freeze({
      id: "0260e1e4-1884-4827-b587-d939a7ae0e8f",
      name: "About",
      visualCount: 1,
      visualTypes: Object.freeze({ InsightVisual: 1 }),
      visuals: Object.freeze([
        visual(
          "306d1d8c-4d15-4a15-81f3-5ec296ea4865",
          "InsightVisual",
          "Notices",
          "ABOUT_EVIDENCE",
          "Pinned public artifact hashes, immutable Price List and CUR lineage, disclosures and limitations are rendered.",
          "No native QuickSight insight runtime or pixel-layout parity is claimed.",
        ),
      ]),
      controls: Object.freeze([
        control("filter", "CrossSheet", "Service Name", "SUPPORTED"),
        control("filter", "CrossSheet", "Linked Account Name", "UNAVAILABLE"),
        control("filter", "CrossSheet", "Linked Account ID", "SUPPORTED"),
        control("filter", "CrossSheet", "Payer Account ID", "SUPPORTED"),
      ]),
    }),
  ]),
  disclosures: Object.freeze([
    "The complete public definition proves exact QuickSight object inventory, not pixel, geometry, interaction-tree or runtime parity.",
    "The pinned manifest is v1.1.0 while its public changelog currently documents v1.0.1; neither value is rewritten.",
    "The upstream Athena view detects historical billed-rate changes in CUR, while Sutra compares version-pinned public Price List files against held-constant CUR2 usage; the two methods are not represented as equivalent.",
    "Historical AWS Price List provider registration, full-generation CUR2 reading, mapping reconciliation, two-tenant proof, release-SHA review, immutable image deployment and production acceptance remain open.",
  ]),
} as const);

export type PricingChangeOfficialDefinition =
  typeof PRICING_CHANGE_OFFICIAL_DEFINITION;

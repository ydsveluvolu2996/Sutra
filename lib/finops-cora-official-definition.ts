export type CoraOfficialSheetCoverage =
  | "NATIVE_EVIDENCE_PARTIAL"
  | "PROVIDER_DIMENSIONS_BLOCKED"
  | "ABOUT_EVIDENCE";

export interface CoraOfficialVisual {
  readonly id: string;
  readonly title: string;
  readonly type: string;
}

export interface CoraOfficialSheet {
  readonly id: string;
  readonly name: string;
  readonly visualCount: number;
  readonly visualTypes: Readonly<Record<string, number>>;
  readonly visuals: readonly CoraOfficialVisual[];
  readonly parameterControls: readonly string[];
  readonly filterControls: readonly string[];
  readonly coverage: CoraOfficialSheetCoverage;
  readonly nativeEvidence: string;
  readonly remainingGap: string;
}

const visual = (id: string, type: string, title: string): CoraOfficialVisual =>
  Object.freeze({ id, type, title });

/**
 * Frozen structural inventory parsed from the public AWS CID CORA definition.
 * Native coverage is evidence mapping, never a QuickSight layout-parity claim.
 */
export const CORA_OFFICIAL_DEFINITION = Object.freeze({
  schema: "sutra.cora-official-definition.v1",
  source: Object.freeze({
    repository:
      "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
    definitionPath: "dashboards/cora/cora-definition.yaml",
    definitionSha256: "6486f50810f40558423cffb90c245a658678597fccdda8445e26a40e02e6a644",
    manifestPath: "dashboards/cora/cora.yaml",
    manifestSha256: "54bde11bcee2ed0d333c891371eea29a5c2bfc6871e8e63d273682ace01d16bd",
    changelogPath: "changes/CHANGELOG-cora.md",
    changelogSha256: "c44fd6153a8f936a31664ff4207c465eef20abc9c325fe686d590d766313b57b",
    embeddedViewPath: "views.cora_view.data",
    embeddedViewSha256: "1e39c206cf5ae2b2ac9a5f87253935b77782c2ea46cdf3ac180f7db555c2b02e",
    dashboardId: "cora",
    version: "v0.0.11",
    category: "Additional",
    theme: "MIDNIGHT",
    datasetIdentifier: "cora_view",
  }),
  totals: Object.freeze({
    sheets: 5,
    visuals: 28,
    parameterControls: 11,
    filterControls: 41,
    controlPlacements: 52,
    parameterDeclarations: 8,
    calculatedFields: 48,
    filterGroups: 50,
    columnConfigurations: 16,
    datasets: 1,
  }),
  visualTypes: Object.freeze({
    KPIVisual: 1,
    ScatterPlotVisual: 1,
    TableVisual: 5,
    SankeyDiagramVisual: 1,
    BarChartVisual: 10,
    PivotTableVisual: 8,
    PieChartVisual: 2,
  }),
  parameterDeclarations: Object.freeze([
    "SavingsThreshold",
    "ShowCost",
    "Top",
    "Tag1Name",
    "TagSearchInclude",
    "GroupBy",
    "RILevel",
    "SPLevel",
  ]),
  sheets: Object.freeze<readonly CoraOfficialSheet[]>([
    Object.freeze({
      id: "26d95026-2cf8-4ca5-b8fc-d0d628fe5f84",
      name: "Summary",
      visualCount: 13,
      visualTypes: Object.freeze({ KPIVisual: 1, ScatterPlotVisual: 1, TableVisual: 4, SankeyDiagramVisual: 1, BarChartVisual: 3, PivotTableVisual: 2, PieChartVisual: 1 }),
      visuals: Object.freeze([
        visual("e2a58d6f-cc94-4d62-8e79-07de91cfcabf", "KPIVisual", "Number of Actions"),
        visual("0ef241b4-ebdc-4a7a-a5ca-4ea7f249d3d1", "ScatterPlotVisual", "Recommendations (Logarithmic Scale)"),
        visual("22b986fd-d585-4ffe-a79d-5df6d7ada5b8", "TableVisual", "Top Actions and Resource Types"),
        visual("27286779-7acc-4dbd-8fad-4c822d1f62df", "TableVisual", "Recommendations"),
        visual("b820c650-1f2b-49b0-bd90-95aff7702e94", "SankeyDiagramVisual", "Actions Per Resource"),
        visual("65194706-b73a-4b09-95b0-4335dd546a71", "BarChartVisual", "Top Potential Savings Per Action Type"),
        visual("4b4bf95f-a62d-4ff3-bfc3-6083a0c8f104", "PivotTableVisual", "Actions Per Resource"),
        visual("ad9831de-a28b-423c-9d15-1d318c56a3dd", "BarChartVisual", "Top Potential Savings Over Time"),
        visual("d0ea7017-d4e8-444f-aff0-aa49889fbf6a", "PivotTableVisual", "Savings Per Action Type"),
        visual("25c43156-3fae-4590-93a5-fe6ef213a12e", "BarChartVisual", "Top Potential Savings Per GroupBy=${GroupBy}"),
        visual("3cc9cfd2-4c87-4973-b087-696cb672d585", "TableVisual", "Details of Cost Estimation Calculations"),
        visual("36f4f231-4e50-44b9-a44e-b560deb2bd99", "PieChartVisual", "Top Actions Potential Savings"),
        visual("0ed0c7ef-dd4a-46a6-a6d3-0025d697678d", "TableVisual", "Last Refresh"),
      ]),
      parameterControls: Object.freeze([
        "Show Cost", "Show Savings", "Group By", "Savings Plans Level",
        "Reserved Instance Level", "Monthly Savings Threshold (per resource)",
        "Tag Search", "Tag Name",
      ]),
      filterControls: Object.freeze([
        "Restart", "Region", "Resource ID", "Linked Account Id",
        "Linked Account Name", "Resource Type", "FinopsException Tag",
        "Rollback", "Management Account Id", "Effort", "Action Type",
        "Resource equals",
      ]),
      coverage: "NATIVE_EVIDENCE_PARTIAL",
      nativeEvidence: "Resource-deduplicated usage/rate summaries, exact-money evidence, action details, filtering, export and retained history.",
      remainingGap: "The scatter, Sankey, pivot, pie and calculated GroupBy visual geometry is not reproduced one-for-one.",
    }),
    Object.freeze({
      id: "f3d53b7f-0b33-4c9d-9abc-dd42c145b67c",
      name: "Usage Optimization",
      visualCount: 6,
      visualTypes: Object.freeze({ PieChartVisual: 1, PivotTableVisual: 2, BarChartVisual: 3 }),
      visuals: Object.freeze([
        visual("d7401070-7d27-4dea-9561-5358b29e2605", "PieChartVisual", "Top Actions By Action Type"),
        visual("835aeaa7-dfe5-4c1b-acf3-dc7df8124472", "PivotTableVisual", "Savings by Action and GroupBy=${GroupBy}"),
        visual("7ee8ad1d-ec3f-45d0-951f-9a8b56afcaae", "BarChartVisual", "Timeline"),
        visual("7211e4af-749e-4369-bfdf-7ef0e535fd7b", "BarChartVisual", "Top Actions By GroupBy=${GroupBy}"),
        visual("4e8ab7b8-0eb9-4385-b3e6-4d95fd585e14", "PivotTableVisual", "Resources"),
        visual("af1392e4-6b28-4829-a526-c9820c203751", "BarChartVisual", "Top Actions By Resource And Action"),
      ]),
      parameterControls: Object.freeze(["Group By"]),
      filterControls: Object.freeze([
        "Linked Account Name", "Management Account Id", "Linked Account Id",
        "Region", "Resource Type", "FinopsException Tag", "Resource ID",
        "Usage Optimization Type",
      ]),
      coverage: "NATIVE_EVIDENCE_PARTIAL",
      nativeEvidence: "Rightsize, idle/stop, delete, scale-in, upgrade and migration rows with resource drilldown and daily generation history.",
      remainingGap: "The six QuickSight pie, pivot and bar layouts and arbitrary GroupBy interaction are not reproduced.",
    }),
    Object.freeze({
      id: "ae0a3480-65c1-441a-8fcb-ac23c9a50ecd",
      name: "Rate Optimization - Saving Plans",
      visualCount: 2,
      visualTypes: Object.freeze({ PivotTableVisual: 2 }),
      visuals: Object.freeze([
        visual("03f3db63-b479-42f6-8434-4e25cf34b7ac", "PivotTableVisual", "Estimated Savings for SP Per Upfront and Term Options"),
        visual("16667fd7-284d-42a0-a043-f42de1e1b5a4", "PivotTableVisual", "Savings Plan Details"),
      ]),
      parameterControls: Object.freeze(["Group By"]),
      filterControls: Object.freeze([
        "Linked Account Name", "Management Account Id", "Linked Account Id",
        "Region", "Resource Type", "FinopsException Tag", "Terms (years)",
        "Level", "Upfront Options", "Type",
      ]),
      coverage: "PROVIDER_DIMENSIONS_BLOCKED",
      nativeEvidence: "Savings Plans recommendation rows and before/after-discount estimates remain separate from usage optimization.",
      remainingGap: "SP level, term, upfront-option and type dimensions are not normalized, so both official pivot matrices remain partial.",
    }),
    Object.freeze({
      id: "28b4e248-fab2-4e92-87f2-4c77fbbe2ea5",
      name: "Rate Optimization - Reserved Instances",
      visualCount: 7,
      visualTypes: Object.freeze({ PivotTableVisual: 2, TableVisual: 1, BarChartVisual: 4 }),
      visuals: Object.freeze([
        visual("4decc04d-4265-4df0-a774-a454c992b0a1", "PivotTableVisual", "Top Potential RI Savings by Service"),
        visual("2af739d9-3164-4ffc-bd1f-de7cc7b01e60", "TableVisual", "Reserved Instances Potential Savings"),
        visual("0dbc2327-6913-4073-b872-0fc701b7701c", "BarChartVisual", "Top Potential Savings History"),
        visual("deb73839-a4ae-43a2-856f-0a539178b4df", "BarChartVisual", "Top Potential Savings by Region"),
        visual("76f4b247-3af0-47f5-b119-d6789b65fd2f", "BarChartVisual", "Top Potential Savings by GroupBy=${GroupBy}"),
        visual("855ee09d-8b0e-48eb-9a14-fdca1e3f3bf8", "BarChartVisual", "Top Potential RI Savings by Service"),
        visual("4425accc-a760-4098-b83a-c07c3eecc687", "PivotTableVisual", "Details of Potential Savings"),
      ]),
      parameterControls: Object.freeze(["Group By"]),
      filterControls: Object.freeze([
        "Linked Account Name", "Management Account Id", "Linked Account Id",
        "Region", "Resource Type", "FinopsException Tag", "Level",
        "RI SP Term equals", "RI SP Upfront equals", "RI Service equals",
        "Top equals",
      ]),
      coverage: "PROVIDER_DIMENSIONS_BLOCKED",
      nativeEvidence: "Reserved Instance recommendation rows, resource details, Region and before/after-discount estimate evidence.",
      remainingGap: "RI service, level, term and upfront dimensions are not normalized, so the official pivots and comparison bars remain partial.",
    }),
    Object.freeze({
      id: "79b758c8-d5c3-42c1-b73d-7601b14007b9",
      name: "About",
      visualCount: 0,
      visualTypes: Object.freeze({}),
      visuals: Object.freeze([]),
      parameterControls: Object.freeze([]),
      filterControls: Object.freeze([]),
      coverage: "ABOUT_EVIDENCE",
      nativeEvidence: "Freshness, generation lineage, organization coverage, materialization state, hashes, disclosures and limitations.",
      remainingGap: "No QuickSight layout parity is claimed; the pinned About sheet contains zero visual objects.",
    }),
  ]),
  disclosures: Object.freeze([
    "The public definition proves structural objects; it does not prove native pixel, layout, interaction-tree, or QuickSight runtime parity.",
    "The manifest publishes the cora_view Athena SQL inline, but Sutra has not deployed the credential-owning S3/Parquet execution adapter.",
    "Savings Plans and Reserved Instance level, term, upfront and RI service dimensions remain unnormalized.",
    "Live provider reconciliation, two-tenant proof, release-SHA review, immutable image deployment and production acceptance remain open.",
  ]),
} as const);

export type CoraOfficialDefinition = typeof CORA_OFFICIAL_DEFINITION;

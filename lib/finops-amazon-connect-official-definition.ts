export type AmazonConnectOfficialCoverage =
  | "SUPPORTED"
  | "PARTIAL"
  | "UNAVAILABLE"
  | "ABOUT";

export interface AmazonConnectOfficialSheet {
  readonly id: string;
  readonly name: string;
  readonly visualCount: number;
  readonly parameterControls: readonly string[];
  readonly filterControls: readonly string[];
  readonly documentedPurpose: string | null;
  readonly nativeCoverage: AmazonConnectOfficialCoverage;
  readonly nativeEvidence: string;
  readonly remainingGap: string;
}

const sheet = (
  value: AmazonConnectOfficialSheet,
): Readonly<AmazonConnectOfficialSheet> => Object.freeze({
  ...value,
  parameterControls: Object.freeze(value.parameterControls),
  filterControls: Object.freeze(value.filterControls),
});

/**
 * Immutable audit of the complete Amazon Connect QuickSight definition and
 * supporting public artifacts at the pinned AWS CID source commit.
 */
export const AMAZON_CONNECT_OFFICIAL_DEFINITION = Object.freeze({
  schema: "sutra.amazon-connect-official-definition.v1",
  source: Object.freeze({
    repository:
      "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
    documentationUrl:
      "https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/connect-cost-insight.html",
    manifestPath: "dashboards/amazon-connect/amazon-connect.yaml",
    manifestSha256:
      "dc39d46a29881b54384ff57feee193f23fa23bd6631cc3dda39352cd2960cbea",
    embeddedDefinitionSha256:
      "c5078f8b73558a7ab1bc388e24dd52fae0ddd954f5097aec8e50b6552fdfc0b8",
    changelogPath: "changes/CHANGELOG-amazon-connect.md",
    changelogSha256:
      "147cab6cc9d5e2e95126ea39ae1b3df8efbee3b880788daef4114e6ca14383b2",
    dashboardId: "amazon-connect-cost-insight-dashboard",
    dashboardName: "Amazon Connect Cost Insight Dashboard",
    category: "Additional",
    theme: "CLASSIC",
    latestDocumentedVersion: "v1.1.1",
  }),
  publication: Object.freeze({
    completeQuickSightDefinitionEmbedded: true,
    standaloneQuickSightDefinitionPath: null,
    standaloneTemplateBodyPath: null,
    externalTemplateId: null,
    dashboardSpecificDeploymentTemplatePath: null,
  }),
  artifacts: Object.freeze([
    Object.freeze({
      kind: "MANIFEST_CONTAINER",
      path: "dashboards/amazon-connect/amazon-connect.yaml",
      sha256:
        "dc39d46a29881b54384ff57feee193f23fa23bd6631cc3dda39352cd2960cbea",
    }),
    Object.freeze({
      kind: "EMBEDDED_QUICKSIGHT_DEFINITION",
      path: "dashboards/amazon-connect/amazon-connect.yaml#dashboards.AMAZON CONNECT COST INSIGHT DASHBOARD.data",
      sha256:
        "c5078f8b73558a7ab1bc388e24dd52fae0ddd954f5097aec8e50b6552fdfc0b8",
    }),
    Object.freeze({
      kind: "CHANGELOG",
      path: "changes/CHANGELOG-amazon-connect.md",
      sha256:
        "147cab6cc9d5e2e95126ea39ae1b3df8efbee3b880788daef4114e6ca14383b2",
    }),
    Object.freeze({
      kind: "PUBLIC_DEPENDENCY_DATASET_DEFINITION",
      path: "cid/builtin/core/data/datasets/cid/summary_view.json",
      sha256:
        "8e509103b770e7deb220a04eba63703c47db3142f08033bbb70c93498acc3ab8",
    }),
    Object.freeze({
      kind: "PUBLIC_DEPENDENCY_SQL_QUERY",
      path: "cid/builtin/core/data/queries/cid/summary_view.sql",
      sha256:
        "57b8ab6ec7d22e0bd642c1bbe44f5bc5cc2cce8523ef0c795ce410a1ae3dec8e",
    }),
  ]),
  totals: Object.freeze({
    sheets: 8,
    visuals: 121,
    parameterControls: 47,
    filterControls: 14,
    parameterDeclarations: 18,
    calculatedFields: 33,
    filterGroups: 157,
    columnConfigurations: 8,
    datasets: 2,
  }),
  visualTypes: Object.freeze({
    WordCloudVisual: 2,
    KPIVisual: 42,
    ComboChartVisual: 14,
    PivotTableVisual: 13,
    BarChartVisual: 15,
    TableVisual: 9,
    CustomContentVisual: 2,
    PieChartVisual: 2,
    SankeyDiagramVisual: 6,
    GeospatialMapVisual: 1,
    HeatMapVisual: 3,
    ScatterPlotVisual: 5,
    LineChartVisual: 3,
    HistogramVisual: 1,
    FilledMapVisual: 2,
    InsightVisual: 1,
  }),
  dataContracts: Object.freeze([
    Object.freeze({
      identifier: "resource_connect_view",
      datasetDefinitionPublished: false,
      datasetDefinitionPath: null,
      datasetDefinitionSha256: null,
      queryPublished: false,
      queryPath: null,
      querySha256: null,
      inputColumnCount: null,
      disclosure:
        "The identifier and fields referenced by the QuickSight definition are public, but the dataset body and producing query are not committed at the pinned source revision.",
    }),
    Object.freeze({
      identifier: "summary_view",
      datasetDefinitionPublished: true,
      datasetDefinitionPath:
        "cid/builtin/core/data/datasets/cid/summary_view.json",
      datasetDefinitionSha256:
        "8e509103b770e7deb220a04eba63703c47db3142f08033bbb70c93498acc3ab8",
      queryPublished: true,
      queryPath: "cid/builtin/core/data/queries/cid/summary_view.sql",
      querySha256:
        "57b8ab6ec7d22e0bd642c1bbe44f5bc5cc2cce8523ef0c795ce410a1ae3dec8e",
      inputColumnCount: 50,
      disclosure:
        "The shared foundational summary_view dataset contract and SQL are public and hash-pinned; this does not publish the missing resource_connect_view contract.",
    }),
  ]),
  sheets: Object.freeze<readonly Readonly<AmazonConnectOfficialSheet>[]>([
    sheet({
      id: "69ce477d-58df-43d2-be80-c8f2f68d4ae3",
      name: "Overview",
      visualCount: 16,
      parameterControls: ["Last N month", "Group by", "Group by", "Account Id", "Account Name", "Region", "Charge type", "Service", "Payer Id"],
      filterControls: [],
      documentedPurpose: "A high-level summary of Amazon Connect and Contact Center Telecom charges.",
      nativeCoverage: "SUPPORTED",
      nativeEvidence: "Connect and telecom cost, governed instance count, aggregate phone inventory, billing rows and tokenized-contact coverage.",
      remainingGap: "QuickSight geometry and same-sheet interaction parity are not claimed.",
    }),
    sheet({
      id: "9b283c6f-d0b8-458f-a5f5-bf65f7c53092",
      name: "Contact Center",
      visualCount: 8,
      parameterControls: ["Group by", "Charge type", "Account Id", "Account Name", "Region", "Last N month", "Payer Id"],
      filterControls: [],
      documentedPurpose: "Cost and usage metrics for accounts running Amazon Connect and associated contact-center services.",
      nativeCoverage: "UNAVAILABLE",
      nativeEvidence: "Native evidence is intentionally limited to Connect configuration and Connect/telecom CUR2 spend.",
      remainingGap: "A separately governed supporting-AWS-service CUR2 evidence plane is required; those costs are not inferred.",
    }),
    sheet({
      id: "56a1cca6-dbc0-4ca5-a0d2-a8bc3bbfdda9",
      name: "Connect",
      visualCount: 23,
      parameterControls: ["Group by", "Charge type", "Account Id", "Account Name", "Region", "Last N month", "Payer Id"],
      filterControls: [],
      documentedPurpose: "Detailed view of Amazon Connect Voice service usage and costs.",
      nativeCoverage: "PARTIAL",
      nativeEvidence: "Voice billing rows preserve day, direction, charge family, usage type, source unit and exact cost micros.",
      remainingGap: "The 23 upstream visual objects and QuickSight interaction tree are not reproduced one-for-one.",
    }),
    sheet({
      id: "6f5c262c-d27b-41e3-9de5-acbc4688a883",
      name: "Telecom",
      visualCount: 17,
      parameterControls: ["Last N month", "Group by", "Group by", "Account Id", "Account Name", "Region", "Charge type", "Payer Id"],
      filterControls: ["Telecom usage type", "Country", "Unit price range", "Cost greater than"],
      documentedPurpose: "Contact-center telecommunications costs by number types and countries.",
      nativeCoverage: "PARTIAL",
      nativeEvidence: "CUR2 telecom aggregates and pre-broker aggregate phone inventory retain country, number type, direction, source unit and exact cost.",
      remainingGap: "No telephone values are retained, and upstream map/layout parity is not claimed.",
    }),
    sheet({
      id: "a875c03e-f003-413c-9c5d-ce4fbceb2e75",
      name: "Daily Usage",
      visualCount: 27,
      parameterControls: ["Account Id", "Account Name", "Region", "Charge type", "Service", "Payer Id"],
      filterControls: [],
      documentedPurpose: "Thirty-day cost and usage trends with inbound/outbound minutes and phone-number usage drilldowns.",
      nativeCoverage: "PARTIAL",
      nativeEvidence: "A fixed 30-day CUR2 window preserves direction, charge family, usage type, unlike units and exact cost.",
      remainingGap: "The 27 upstream visual objects, drill actions and QuickSight layout are not reproduced one-for-one.",
    }),
    sheet({
      id: "834b0132-db7c-49be-9fbc-d68efaedba63",
      name: "Call Details",
      visualCount: 22,
      parameterControls: ["Account Id", "Account Name", "Region", "Country", "Payer Id"],
      filterControls: ["Connect Instance Name filter", "Contact Call Type", "Filter contact cost above $", "Filter contact cost range $"],
      documentedPurpose: "Key metrics about call patterns, durations and regional distribution.",
      nativeCoverage: "PARTIAL",
      nativeEvidence: "Aggregated call-pattern rows preserve channel, direction, billing country, number type, tokenized-contact count, source unit and cost.",
      remainingGap: "Billing country is not represented as caller location, and usage is not labelled duration unless the source unit proves it.",
    }),
    sheet({
      id: "ff8b2aae-8bb2-468e-9b7b-210636ee9249",
      name: "Contact Search",
      visualCount: 7,
      parameterControls: ["Contact ID", "Region", "Payer Id", "Account Id", "Account Name"],
      filterControls: ["Contact Start Hour", "Contact End Hour", "Inbound Call Country Destination", "Outbound Call Country Destination", "Connect Instance Name", "Call Duration (decimal min)"],
      documentedPurpose: "Detailed analysis of individual contacts and their characteristics.",
      nativeCoverage: "PARTIAL",
      nativeEvidence: "Ordinary FinOps access can inspect privacy-safe aggregate token counts by governed billing dimensions.",
      remainingGap: "Raw contact lookup is deliberately excluded pending a separate approved, audited and expiring privileged route.",
    }),
    sheet({
      id: "402317f2-1ef0-460e-b9a0-fdf0c6332c50",
      name: "About",
      visualCount: 1,
      parameterControls: [],
      filterControls: [],
      documentedPurpose: null,
      nativeCoverage: "ABOUT",
      nativeEvidence: "Pinned source, hashes, exact structural totals, evidence lineage and limitations are rendered natively.",
      remainingGap: "AWS Guidance enumerates seven analytical tabs; About is an additional sheet proven by the embedded definition.",
    }),
  ]),
  disclosures: Object.freeze([
    "Exact object counts describe the pinned public QuickSight definition, not pixel, geometry, query-result or interaction parity.",
    "AWS Guidance documents seven analytical purposes; those purposes are not treated as proof of seven visual objects.",
    "The public source publishes the complete dashboard definition but not the resource_connect_view dataset body or producing query.",
    "The ordinary Sutra UI deliberately excludes raw contact IDs, phone numbers, endpoints, caller identity and HMAC tokens.",
    "Provider registration, supporting-service evidence, controlled live reconciliation, two-tenant proof, release review, image deployment and production acceptance remain open.",
  ]),
} as const);

export type AmazonConnectOfficialDefinition =
  typeof AMAZON_CONNECT_OFFICIAL_DEFINITION;

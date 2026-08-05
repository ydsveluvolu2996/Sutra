export type CostAnomalyOfficialCoverage =
  | "SUPPORTED"
  | "PARTIAL_SEMANTICS"
  | "ABOUT";

export interface CostAnomalyOfficialVisual {
  readonly id: string;
  readonly name: string;
  readonly type: "Bar chart" | "Table" | "Pie chart";
  readonly coverage: CostAnomalyOfficialCoverage;
  readonly nativeEvidence: string;
  readonly remainingGap: string;
}

/**
 * Immutable audit of the public AWS CID Cost Anomaly QuickSight definition.
 *
 * Counts and identifiers are structural facts from the pinned artifact. Native
 * coverage notes deliberately do not claim QuickSight layout or query parity.
 */
export const COST_ANOMALY_OFFICIAL_DEFINITION = Object.freeze({
  schema: "sutra.aws-cost-anomaly-official-definition.v1",
  source: Object.freeze({
    repository:
      "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
    manifestPath: "dashboards/cost-anomalies/cost-anomalies.yaml",
    manifestSha256: "3676df09c3e3933987dfad923e0fc1b418c30db0562c3344d0ff2f0e54726244",
    embeddedDefinitionSha256: "299b580daf221ab61cc243eb5f3fe121aee9c7fb21a88d66be58c007ab6a3b14",
    changelogPath: "changes/CHANGELOG-aws-cost-anomalies.md",
    changelogSha256: "5a78599be4f131feb12944e5ea6da5bb87b38d55cd8d4ae00a0a1e9f205ac104",
    dashboardId: "aws-cost-anomalies",
    category: "Advanced",
    datasetIdentifier: "ca_summary_view",
    queryArtifact: null,
  }),
  totals: Object.freeze({
    sheets: 2,
    visuals: 6,
    parameterControls: 4,
    filterControls: 8,
    parameterDeclarations: 10,
    calculatedFields: 11,
    filterGroups: 9,
    datasets: 1,
  }),
  visualTypes: Object.freeze({
    BarChartVisual: 4,
    TableVisual: 1,
    PieChartVisual: 1,
  }),
  sheets: Object.freeze([
    Object.freeze({
      id: "307f2c1e-fcf1-42f7-b0a2-fa4af0e48d1c",
      name: "AWS Cost Anomalies",
      visualCount: 6,
      parameterControls: Object.freeze([
        "End Date",
        "Start Date",
        "Total Impact Greater then",
        "Days to consider Active",
      ]),
      filterControls: Object.freeze([
        "Account Name",
        "Linked Account Id",
        "Status",
        "Management Account Id",
      ]),
      visuals: Object.freeze<readonly CostAnomalyOfficialVisual[]>([
        Object.freeze({
          id: "b8cec74c-3349-4000-bc25-f902d45db291",
          name: "Daily Cost Anomalies Total Impact",
          type: "Bar chart",
          coverage: "PARTIAL_SEMANTICS",
          nativeEvidence: "Filtered provider impact trend with unavailable values preserved.",
          remainingGap: "The native chart currently groups by anomaly month, not by day.",
        }),
        Object.freeze({
          id: "6d8ba6b3-cbda-4678-b244-e2830bf60f9b",
          name: "Total Impact Cost",
          type: "Bar chart",
          coverage: "SUPPORTED",
          nativeEvidence: "Observed total impact is aggregated only from provider values that are present.",
          remainingGap: "QuickSight chart geometry is not reproduced.",
        }),
        Object.freeze({
          id: "cfe3a1a5-adb0-45d2-9a8b-fd5d64d9ccf9",
          name: "AWS Cost Anomalies - Service (Total Cost Impact)",
          type: "Bar chart",
          coverage: "PARTIAL_SEMANTICS",
          nativeEvidence: "Ranked provider-reported service root-cause contribution is available.",
          remainingGap: "Root-cause contribution is not represented as anomaly-level total impact by service.",
        }),
        Object.freeze({
          id: "adcfaa2c-7ec8-4289-8625-1690a5c855f3",
          name: "AWS Cost Anomalies Details",
          type: "Table",
          coverage: "SUPPORTED",
          nativeEvidence: "Bounded finding details, impact, score, assessment, monitor metadata and root-cause drilldown.",
          remainingGap: "QuickSight table geometry and its dataset-only account-name field are not reproduced.",
        }),
        Object.freeze({
          id: "ad3c54e7-cbcd-4f2e-81e5-0b5a69909476",
          name: "Total Impact Cost by Anomaly Start Date",
          type: "Bar chart",
          coverage: "PARTIAL_SEMANTICS",
          nativeEvidence: "Provider total impact is grouped by the accepted anomaly start month.",
          remainingGap: "The native chart does not expose the upstream per-start-date granularity.",
        }),
        Object.freeze({
          id: "c8851433-215a-4447-bbb0-aec332986e8d",
          name: "Anomalies Status",
          type: "Pie chart",
          coverage: "PARTIAL_SEMANTICS",
          nativeEvidence: "Open-window and ended-window counts are derived from provider anomaly end dates.",
          remainingGap: "AWS CID Active/Past uses last-update age and a configurable day parameter; Sutra does not substitute that calculation.",
        }),
      ]),
    }),
    Object.freeze({
      id: "73835dbf-c978-4de7-bd4c-f538ce56c75d",
      name: "About",
      visualCount: 0,
      parameterControls: Object.freeze([]),
      filterControls: Object.freeze([
        "Account Name",
        "Linked Account Id",
        "Status",
        "Management Account Id",
      ]),
      visuals: Object.freeze<readonly CostAnomalyOfficialVisual[]>([]),
      coverage: "ABOUT" as const,
    }),
  ]),
  parameterDeclarations: Object.freeze([
    "TotalImpactThreshold",
    "numberofdays",
    "linkedaccount",
    "AccountName",
    "payeraccount",
    "status",
    "GroupBy",
    "AnomalyStartDateRange",
    "startdate",
    "enddate",
  ]),
  filterGroups: Object.freeze([
    "anomaly_start_date relative date (details)",
    "anomaly_start_date time range",
    "tota_impact numeric range",
    "Last Update Date is Max Last Update Date equality",
    "anomaly_start_date relative date (daily impact)",
    "linkedaccountname category",
    "linkedaccount category",
    "status category",
    "payer_id category",
  ]),
  disclosures: Object.freeze([
    "The public manifest embeds a complete QuickSight AnalysisDefinition; its exact structural totals are provable at the pinned commit.",
    "No standalone SQL/query artifact for ca_summary_view is published in the pinned repository, so query parity is not claimed.",
    "Native Sutra visuals are evidence-driven equivalents and do not claim pixel, geometry, interaction-tree, or QuickSight runtime parity.",
    "The official Active/Past calculated field differs from Sutra's provider-window lifecycle and remains explicitly partial.",
  ]),
} as const);

export type CostAnomalyOfficialDefinition = typeof COST_ANOMALY_OFFICIAL_DEFINITION;

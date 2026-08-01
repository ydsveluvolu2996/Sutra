export type AwsBudgetsOfficialCoverage =
  "SUPPORTED" | "PARTIAL_EVIDENCE" | "ABOUT";

export interface AwsBudgetsOfficialVisual {
  readonly name: string;
  readonly type: string;
  readonly coverage: AwsBudgetsOfficialCoverage;
  readonly note: string;
}

/** Immutable audit of the AWS CID AWS Budgets definition embedded in its manifest. */
export const AWS_BUDGETS_OFFICIAL_DEFINITION = Object.freeze({
  source: Object.freeze({
    repository:
      "aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
    path: "dashboards/aws-budgets/aws-budgets.yaml",
    sha256: "9a9e2229e551332334363656ab4d1310fd3d73049bdce2eada46bd61c5a52de9",
    dashboardId: "aws-budgets",
  }),
  totals: Object.freeze({
    sheets: 2,
    visuals: 11,
    parameterControls: 2,
    filterControls: 5,
    parameterDeclarations: 3,
    calculatedFields: 11,
    filterGroups: 9,
    datasets: 1,
  }),
  visualTypes: Object.freeze({
    PivotTableVisual: 2,
    GaugeChartVisual: 4,
    BarChartVisual: 1,
    ComboChartVisual: 1,
    SankeyDiagramVisual: 1,
    InsightVisual: 2,
  }),
  sheets: Object.freeze([
    Object.freeze({
      id: "f36cd4e6-26b8-4c72-b330-af26b413b283",
      name: "Budget Summary",
      visualCount: 11,
      parameterControls: Object.freeze(["Group By", "Budget Level"]),
      filterControls: Object.freeze([
        "Budget Name",
        "Account Name",
        "Budget Status",
        "Account ID",
      ]),
      visuals: Object.freeze<readonly AwsBudgetsOfficialVisual[]>([
        Object.freeze({
          name: "Budget Summary",
          type: "Pivot table",
          coverage: "SUPPORTED",
          note: "Native bounded budget, account, hierarchy, status and exact-money drilldown.",
        }),
        Object.freeze({
          name: "Forecast VS Budget This Month",
          type: "Gauge",
          coverage: "SUPPORTED",
          note: "Forecast and budget remain separate exact provider values.",
        }),
        Object.freeze({
          name: "Actual VS Budget This Month",
          type: "Gauge",
          coverage: "SUPPORTED",
          note: "Actual and budget remain separate exact provider values.",
        }),
        Object.freeze({
          name: "Forecast VS Budget",
          type: "Gauge",
          coverage: "SUPPORTED",
          note: "Currency-separated portfolio totals; missing forecast is never zero.",
        }),
        Object.freeze({
          name: "Budget Summary by Group By This Month",
          type: "Bar chart",
          coverage: "PARTIAL_EVIDENCE",
          note: "Account and budget grouping evidence is native; arbitrary QuickSight Group By geometry is not claimed.",
        }),
        Object.freeze({
          name: "Actual VS Budget",
          type: "Gauge",
          coverage: "SUPPORTED",
          note: "Currency-separated portfolio totals and provider health classification.",
        }),
        Object.freeze({
          name: "Budget Summary by Group By This Month",
          type: "Pivot table",
          coverage: "PARTIAL_EVIDENCE",
          note: "Bounded hierarchy table covers account/budget rows without claiming pivot geometry.",
        }),
        Object.freeze({
          name: "Budget History",
          type: "Combo chart",
          coverage: "SUPPORTED",
          note: "Provider budgeted, actual and forecast history is retained separately.",
        }),
        Object.freeze({
          name: "Budget Distribution from Group By to Budget Level",
          type: "Sankey diagram",
          coverage: "PARTIAL_EVIDENCE",
          note: "Exact account-to-cid:budget-level mappings are shown; Sankey geometry remains open.",
        }),
        Object.freeze({
          name: "Total Budgets Summary Insight",
          type: "Insight",
          coverage: "SUPPORTED",
          note: "Native counts and currency-separated exact totals.",
        }),
        Object.freeze({
          name: "Budgets Status Insight",
          type: "Insight",
          coverage: "SUPPORTED",
          note: "Healthy, unhealthy, forecasted unhealthy and unclassified states are explicit.",
        }),
      ]),
    }),
    Object.freeze({
      id: "6227ee28-d3fc-4a81-b586-4ee5d60fb476",
      name: "About",
      visualCount: 0,
      parameterControls: Object.freeze([]),
      filterControls: Object.freeze(["Account Name"]),
      visuals: Object.freeze<readonly AwsBudgetsOfficialVisual[]>([]),
    }),
  ]),
} as const);

export type AwsBudgetsOfficialDefinition =
  typeof AWS_BUDGETS_OFFICIAL_DEFINITION;

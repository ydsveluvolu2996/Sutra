/** Immutable audit of the official AWS Health Events Dashboard v3.1.0. */
export const FINOPS_AWS_HEALTH_OFFICIAL_DEFINITION = Object.freeze({
  source: Object.freeze({
    repository:
      "aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
    dashboardId: "health-events-dashboard",
    version: "v3.1.0",
    manifest: Object.freeze({
      path: "dashboards/health-events/health-events.yaml",
      sha256:
        "64150dfa317077894fd352bf98e6a1aa59ed7557dc51065ee519095fa5e98509",
    }),
    definition: Object.freeze({
      path: "dashboards/health-events/health-events-definition.yaml",
      sha256:
        "4c24253e3eb2bfb3d68f2ca39e07968136d82be32e9a63a9cddc6003a3340a6d",
    }),
    documentationUrl:
      "https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/health-events-dashboard.html",
  }),
  planningSemantics: Object.freeze({
    collectionCadence: "daily",
    minimumDocumentedLagHours: 48,
    notRealTime: true,
    intendedUse: "review_and_long_term_operational_planning",
    currentResponseSource: "AWS Health Notifications and incident tooling",
    preOrganizationViewHistoryMayBeMissing: true,
  }),
  totals: Object.freeze({
    sheets: 3,
    visuals: 33,
    parameterControls: 23,
    filterControls: 5,
    parameterDeclarations: 26,
    calculatedFields: 74,
    filterGroups: 35,
    datasets: 1,
    columnConfigurations: 0,
    visualTypes: Object.freeze({
      KPIVisual: 16,
      PieChartVisual: 2,
      BarChartVisual: 3,
      TableVisual: 8,
      ComboChartVisual: 1,
      PivotTableVisual: 2,
      InsightVisual: 1,
    }),
  }),
  sheets: Object.freeze([
    Object.freeze({
      id: "e523a577-b3fc-4e38-bd7e-bdb892fbbfd6",
      name: "Main",
      visualCount: 25,
      visualTypes: Object.freeze({
        KPIVisual: 14,
        PieChartVisual: 2,
        BarChartVisual: 1,
        TableVisual: 7,
        ComboChartVisual: 1,
      }),
      parameterControls: Object.freeze([
        "STARTS AFTER",
        "STARTS BEFORE",
        "EVENT STATUS",
        "CATEGORY",
        "RESOURCE STATUS",
        "SUMMARY FORMAT",
        "ACTIONABILITY",
        "PERSONAS",
        "EVENT SCOPE",
        "CHART GROUPING",
        "DISPLAY MODE",
        "PAGE",
        "Payer Account",
        "SERVICE",
        "Event ARN",
        "Account Display Format",
        "ACCOUNT",
        "SUMMARY LENGTH (characters)",
        "LOOKBACK DAYS",
        "Near Days Threshold",
        "SEARCH",
      ]),
      filterControls: Object.freeze([]),
      nativeCoverage: "PARTIAL",
      gaps: Object.freeze([
        "Persona, resource-status, payer, pagination, display-format and summary-format controls are not all exposed in the native planning view.",
      ]),
    }),
    Object.freeze({
      id: "d82fb28e-83f3-48d1-b6aa-8dca65396d73",
      name: "Quick View",
      visualCount: 7,
      visualTypes: Object.freeze({
        TableVisual: 1,
        KPIVisual: 2,
        PivotTableVisual: 2,
        BarChartVisual: 2,
      }),
      parameterControls: Object.freeze(["EVENT SCOPE", "Payer Accounts"]),
      filterControls: Object.freeze([
        "EVENT STATUS",
        "RESOURCE STATUS",
        "CATEGORY",
        "ACTIONABILITY",
        "SERVICE",
      ]),
      nativeCoverage: "PARTIAL",
      gaps: Object.freeze([
        "Native summary, timeline, entity and event views cover the planning outcomes; payer and resource-status controls remain provider-evidence gaps.",
      ]),
    }),
    Object.freeze({
      id: "2755b151-e3a9-4e1b-8f66-edaf4646e996",
      name: "About",
      visualCount: 1,
      visualTypes: Object.freeze({ InsightVisual: 1 }),
      parameterControls: Object.freeze([]),
      filterControls: Object.freeze([]),
      nativeCoverage: "SUPPORTED",
      gaps: Object.freeze([]),
    }),
  ]),
} as const);

export type FinopsAwsHealthOfficialDefinition =
  typeof FINOPS_AWS_HEALTH_OFFICIAL_DEFINITION;

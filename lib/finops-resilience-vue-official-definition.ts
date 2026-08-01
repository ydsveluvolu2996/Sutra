export type ResilienceVueOfficialCoverage =
  | "NATIVE_EVIDENCE_PARTIAL"
  | "VERSIONED_SCHEMA_REQUIRED"
  | "ABOUT";

export interface ResilienceVueOfficialControl {
  readonly placement: "parameter" | "filter";
  readonly type: "DateTimePicker" | "Dropdown" | "List";
  readonly title: string;
  readonly nativeState: "SUPPORTED" | "PARTIAL" | "UNAVAILABLE";
}

export interface ResilienceVueOfficialSheet {
  readonly id: string;
  readonly name: string;
  readonly visualCount: number;
  readonly visualTypes: Readonly<Record<string, number>>;
  readonly controls: readonly ResilienceVueOfficialControl[];
  readonly coverage: ResilienceVueOfficialCoverage;
  readonly nativeAreas: readonly string[];
  readonly evidenceNote: string;
  readonly remainingGap: string;
}

const filter = (
  type: ResilienceVueOfficialControl["type"],
  title: string,
  nativeState: ResilienceVueOfficialControl["nativeState"],
): ResilienceVueOfficialControl => Object.freeze({
  placement: "filter", type, title, nativeState,
});

const parameter = (
  type: ResilienceVueOfficialControl["type"],
  title: string,
  nativeState: ResilienceVueOfficialControl["nativeState"],
): ResilienceVueOfficialControl => Object.freeze({
  placement: "parameter", type, title, nativeState,
});

/**
 * Frozen inventory of the public AWS CID ResilienceVue v1.0.0 definition.
 * Counts represent upstream QuickSight objects, not pixel/layout parity.
 */
export const RESILIENCE_VUE_OFFICIAL_DEFINITION = Object.freeze({
  sourceRepository: "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
  sourceCommit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
  manifestPath: "dashboards/resilience-vue/resilience-vue.yaml",
  manifestSha256: "9478243fd9da03b4be2813993c98bd3f99970865443b9b11d8b0346de54d380c",
  definitionPath: "dashboards/resilience-vue/resilience-vue-definition.yaml",
  definitionSha256: "c0fe7edf8648327ca13a3ad14372ae382b4b9bf42b428aacd0223f8a5575b63b",
  dashboardId: "resiliencevue",
  name: "Resilience Vue",
  version: "v1.0.0",
  theme: "MIDNIGHT",
  datasets: Object.freeze([
    "resiliencehub_fis_test_recommendations",
    "resiliencehub_app_recommendations",
    "resiliencehub_resiliency_policy_view",
    "resiliencehub_alarm_recommendations",
    "resiliencehub_complete_view",
    "resiliencehub_sop_recommendations",
    "resiliencehub_daily_assessments",
    "resiliencehub_applications",
    "resiliencehub_resource_types",
  ]),
  totals: Object.freeze({
    sheets: 4,
    visuals: 47,
    parameterControls: 2,
    filterControls: 7,
    parameterDeclarations: 4,
    calculatedFields: 37,
    filterGroups: 15,
    columnConfigurations: 7,
    datasets: 9,
  }),
  visualTypes: Object.freeze({
    SankeyDiagramVisual: 1,
    BarChartVisual: 4,
    TableVisual: 15,
    KPIVisual: 9,
    PieChartVisual: 6,
    WordCloudVisual: 10,
    GaugeChartVisual: 1,
    LineChartVisual: 1,
  }),
  sheets: Object.freeze<readonly ResilienceVueOfficialSheet[]>([
    Object.freeze({
      id: "a566f056-b54c-47aa-8314-43e9a362df47",
      name: "Organizational Summary",
      visualCount: 23,
      visualTypes: Object.freeze({
        SankeyDiagramVisual: 1,
        BarChartVisual: 3,
        TableVisual: 6,
        KPIVisual: 8,
        PieChartVisual: 3,
        WordCloudVisual: 2,
      }),
      controls: Object.freeze([
        filter("DateTimePicker", "Last Assessment Time between", "SUPPORTED"),
        filter("Dropdown", "Region", "SUPPORTED"),
        filter("Dropdown", "Management Account", "PARTIAL"),
        filter("Dropdown", "Resiliency Status", "SUPPORTED"),
      ]),
      coverage: "NATIVE_EVIDENCE_PARTIAL",
      nativeAreas: Object.freeze([
        "account-region scope",
        "assessed and unassessed applications",
        "policy posture and breaches",
        "drift",
        "recommendation backlog",
        "retained generation trends",
      ]),
      evidenceNote: "Native organization summaries are computed only from immutable accepted Resilience Hub target heads.",
      remainingGap: "The Account filter represents collected account targets, not an independently verified multi-payer management-account taxonomy; Sankey and word-cloud layout parity is not claimed.",
    }),
    Object.freeze({
      id: "9318ba71-28ca-4ced-ae11-306a1f598925",
      name: "Application Resiliency",
      visualCount: 17,
      visualTypes: Object.freeze({
        WordCloudVisual: 8,
        TableVisual: 5,
        GaugeChartVisual: 1,
        KPIVisual: 1,
        LineChartVisual: 1,
        BarChartVisual: 1,
      }),
      controls: Object.freeze([
        filter("Dropdown", "Application Name", "SUPPORTED"),
      ]),
      coverage: "NATIVE_EVIDENCE_PARTIAL",
      nativeAreas: Object.freeze([
        "application search",
        "latest assessment posture",
        "latest ten assessment history",
        "resiliency score",
        "RTO and RPO objectives",
        "current and achievable posture",
      ]),
      evidenceNote: "Native application, assessment, policy objective and dimension posture views preserve provider status and missing values.",
      remainingGap: "QuickSight word-cloud, gauge and chart arrangement is not reproduced; provider collection and live reconciliation remain unavailable.",
    }),
    Object.freeze({
      id: "1e5feab6-cf98-4223-9b5c-64fb61031c06",
      name: "Recommendations",
      visualCount: 7,
      visualTypes: Object.freeze({ TableVisual: 4, PieChartVisual: 3 }),
      controls: Object.freeze([
        parameter("List", "Availability Architecture", "UNAVAILABLE"),
        parameter("List", "Optimization Type", "UNAVAILABLE"),
        filter("Dropdown", "App Component", "UNAVAILABLE"),
        filter("Dropdown", "Application Name", "SUPPORTED"),
      ]),
      coverage: "VERSIONED_SCHEMA_REQUIRED",
      nativeAreas: Object.freeze([
        "configuration recommendations",
        "alarm recommendations",
        "SOP recommendations",
        "FIS test recommendations",
        "implementation status",
        "formula-safe export",
        "Sutra inference separated from AWS evidence",
      ]),
      evidenceNote: "Native recommendation evidence and status drilldowns are available; unavailable dimensions are not inferred.",
      remainingGap: "Estimated cost, availability architecture, optimization type and component filtering require a versioned capture-schema migration plus provider validation.",
    }),
    Object.freeze({
      id: "9e1d2d3f-8b5d-4bdf-973d-3dc72500e84a",
      name: "About",
      visualCount: 0,
      visualTypes: Object.freeze({}),
      controls: Object.freeze([]),
      coverage: "ABOUT",
      nativeAreas: Object.freeze([
        "immutable definition",
        "freshness",
        "generation and content hash",
        "capture identity",
        "activation state",
        "limitations",
      ]),
      evidenceNote: "Native provenance and limitation evidence remains inspectable even when collection is not configured.",
      remainingGap: "The pinned upstream About sheet contains zero visual objects; no pixel or layout parity claim is made.",
    }),
  ]),
});

export type ResilienceVueOfficialDefinition = typeof RESILIENCE_VUE_OFFICIAL_DEFINITION;

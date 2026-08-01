export type TrustedAdvisorOfficialSheetCoverage =
  | "NATIVE_STANDARD_CHECKS"
  | "CONDITIONAL_STANDARD_CHECKS"
  | "PROVIDER_SOURCE_REQUIRED"
  | "ABOUT";

export interface TrustedAdvisorOfficialSheet {
  readonly id: string;
  readonly name: string;
  readonly visualCount: number;
  readonly visualTypes: Readonly<Record<string, number>>;
  readonly parameterControls: readonly string[];
  readonly filterControls: readonly string[];
  readonly category: string | null;
  readonly coverage: TrustedAdvisorOfficialSheetCoverage;
  readonly evidenceNote: string;
}

/**
 * Immutable audit of the upstream AWS CID TAO v4.0.1 QuickSight definition.
 * Counts describe the upstream definition, not locally fabricated visuals.
 */
export const TRUSTED_ADVISOR_ORGANIZATIONAL_OFFICIAL_DEFINITION = Object.freeze({
  sourceRepository: "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
  sourceCommit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
  manifestPath: "dashboards/tao/tao.yaml",
  manifestSha256: "dc0168c5655e69d1d87c414e952b30b6f4303ade439cbfac43568187d0cdaf8c",
  definitionPath: "dashboards/tao/tao-definition.yaml",
  definitionSha256: "c2eafc68c9e40ae41d6f397b914c0a039fb39f6b487a1fefe74137dec67dcf43",
  dashboardId: "ta-organizational-view",
  version: "v4.0.1",
  theme: "MIDNIGHT",
  datasets: Object.freeze(["ta-organizational-view", "ta_priority_org_view"]),
  totals: Object.freeze({
    sheets: 11,
    visuals: 147,
    parameterControls: 18,
    filterControls: 4,
    parameterDeclarations: 2,
    calculatedFields: 45,
    filterGroups: 153,
  }),
  visualTypes: Object.freeze({
    BarChart: 70,
    ComboChart: 3,
    Insight: 18,
    KPI: 8,
    PivotTable: 5,
    Table: 43,
  }),
  sheets: Object.freeze<readonly TrustedAdvisorOfficialSheet[]>([
    Object.freeze({
      id: "89945b90-4584-4816-ae54-f03599e02592",
      name: "Summary",
      visualCount: 9,
      visualTypes: Object.freeze({ BarChart: 8, ComboChart: 1 }),
      parameterControls: Object.freeze(["Account", "IsSuppressed"]),
      filterControls: Object.freeze(["Dropdown"]),
      category: null,
      coverage: "NATIVE_STANDARD_CHECKS",
      evidenceNote: "Native account, check, Region, status, suppression and immutable-generation summaries; category-specific historical parity requires upstream TAO rows.",
    }),
    Object.freeze({
      id: "fdb8fe32-8ef0-4d6c-873b-90ccca66dd36",
      name: "TA Explorer",
      visualCount: 3,
      visualTypes: Object.freeze({ PivotTable: 2, Table: 1 }),
      parameterControls: Object.freeze(["Account", "IsSuppressed"]),
      filterControls: Object.freeze([]),
      category: null,
      coverage: "NATIVE_STANDARD_CHECKS",
      evidenceNote: "Native bounded check and resource exploration over the accepted standard-check generation.",
    }),
    Object.freeze({
      id: "1a2d5c97-3dd4-4b5e-b548-c24171754507",
      name: "Security",
      visualCount: 30,
      visualTypes: Object.freeze({ BarChart: 11, Insight: 9, Table: 10 }),
      parameterControls: Object.freeze(["Account", "IsSuppressed"]),
      filterControls: Object.freeze([]),
      category: "security",
      coverage: "NATIVE_STANDARD_CHECKS",
      evidenceNote: "Native category drilldown; named AWS checks appear only when the accepted provider evidence contains them.",
    }),
    Object.freeze({
      id: "ecc10663-8909-40e8-94b4-adcf6d16eef8",
      name: "Security Hub Checks",
      visualCount: 4,
      visualTypes: Object.freeze({ BarChart: 2, Table: 2 }),
      parameterControls: Object.freeze(["IsSuppressed", "Account"]),
      filterControls: Object.freeze([]),
      category: "security",
      coverage: "CONDITIONAL_STANDARD_CHECKS",
      evidenceNote: "Rendered only from accepted standard-check evidence; Sutra does not relabel independent Security Hub findings as Trusted Advisor checks.",
    }),
    Object.freeze({
      id: "b6f2c0e1-7ae2-4677-afe1-af267486d5d3",
      name: "Cost Optimization",
      visualCount: 30,
      visualTypes: Object.freeze({ BarChart: 11, ComboChart: 2, KPI: 8, Table: 9 }),
      parameterControls: Object.freeze(["Account", "IsSuppressed"]),
      filterControls: Object.freeze(["List"]),
      category: "cost_optimizing",
      coverage: "NATIVE_STANDARD_CHECKS",
      evidenceNote: "Native category drilldown; savings values remain absent unless the standard-check record supplies authoritative cost metadata.",
    }),
    Object.freeze({
      id: "5da8de33-7334-41ad-99aa-4146a718d30b",
      name: "Fault Tolerance",
      visualCount: 33,
      visualTypes: Object.freeze({ BarChart: 22, Table: 11 }),
      parameterControls: Object.freeze(["Account", "IsSuppressed"]),
      filterControls: Object.freeze([]),
      category: "fault_tolerance",
      coverage: "NATIVE_STANDARD_CHECKS",
      evidenceNote: "Native category drilldown; check-specific panels are evidence-driven rather than pre-populated.",
    }),
    Object.freeze({
      id: "1a44eb67-09ec-43ad-b19c-aae96053bd01",
      name: "Performance",
      visualCount: 24,
      visualTypes: Object.freeze({ BarChart: 8, Insight: 8, Table: 8 }),
      parameterControls: Object.freeze(["Account", "IsSuppressed"]),
      filterControls: Object.freeze([]),
      category: "performance",
      coverage: "NATIVE_STANDARD_CHECKS",
      evidenceNote: "Native category drilldown over accepted performance checks and resources.",
    }),
    Object.freeze({
      id: "c257f3a1-5895-4f29-9f3e-5f03ae76fa66",
      name: "Service Limits",
      visualCount: 3,
      visualTypes: Object.freeze({ BarChart: 2, Table: 1 }),
      parameterControls: Object.freeze(["Account", "IsSuppressed"]),
      filterControls: Object.freeze([]),
      category: "service_limits",
      coverage: "NATIVE_STANDARD_CHECKS",
      evidenceNote: "Native category drilldown; threshold meaning comes only from the accepted provider check evidence.",
    }),
    Object.freeze({
      id: "23e90a1b-65b0-44de-8eb3-70ae9415b6ed",
      name: "TA Priority",
      visualCount: 7,
      visualTypes: Object.freeze({ BarChart: 4, PivotTable: 2, Table: 1 }),
      parameterControls: Object.freeze([]),
      filterControls: Object.freeze(["Dropdown", "Dropdown"]),
      category: null,
      coverage: "PROVIDER_SOURCE_REQUIRED",
      evidenceNote: "Requires the separate ta_priority_org_view provider dataset; standard checks are never substituted.",
    }),
    Object.freeze({
      id: "07807be3-b394-42b8-a27d-5e230c9c9eb4",
      name: "Well-Architected Reviews",
      visualCount: 3,
      visualTypes: Object.freeze({ BarChart: 2, PivotTable: 1 }),
      parameterControls: Object.freeze(["IsSuppressed", "Account"]),
      filterControls: Object.freeze([]),
      category: null,
      coverage: "PROVIDER_SOURCE_REQUIRED",
      evidenceNote: "The standard Support API snapshot does not contain authoritative workload-review records.",
    }),
    Object.freeze({
      id: "fa9b7c82-21d1-4a61-9e14-86b43314f47f",
      name: "About",
      visualCount: 1,
      visualTypes: Object.freeze({ Insight: 1 }),
      parameterControls: Object.freeze([]),
      filterControls: Object.freeze([]),
      category: null,
      coverage: "ABOUT",
      evidenceNote: "Source, freshness, immutable definition and limitations are exposed natively.",
    }),
  ]),
});

export type TrustedAdvisorOrganizationalOfficialDefinition =
  typeof TRUSTED_ADVISOR_ORGANIZATIONAL_OFFICIAL_DEFINITION;

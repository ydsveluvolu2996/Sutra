export type GravitonOfficialCoverage =
  | "NATIVE_EVIDENCE_PARTIAL"
  | "MODEL_ONLY"
  | "ABOUT";

export interface GravitonOfficialControl {
  readonly type: "Dropdown" | "List" | "Slider";
  readonly title: string;
}

export interface GravitonOfficialSheet {
  readonly id: string;
  readonly name: string;
  readonly visualCount: number;
  readonly visualTypes: Readonly<Record<string, number>>;
  readonly parameterControls: readonly GravitonOfficialControl[];
  readonly filterControls: readonly GravitonOfficialControl[];
  readonly nativeResourceTypes: readonly string[];
  readonly coverage: GravitonOfficialCoverage;
  readonly evidenceNote: string;
  readonly remainingGap: string;
}

const control = (
  type: GravitonOfficialControl["type"],
  title: string,
): GravitonOfficialControl => Object.freeze({ type, title });

/**
 * Frozen object inventory derived from the upstream QuickSight definition.
 * It describes upstream objects and their native evidence mapping; it does not
 * claim pixel or layout parity with QuickSight.
 */
export const GRAVITON_SAVINGS_OFFICIAL_DEFINITION = Object.freeze({
  sourceRepository: "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
  sourceCommit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
  manifestPath: "dashboards/graviton-savings-dashboard/graviton_savings_dashboard.yaml",
  manifestSha256: "a91ec6d00d530fb126c2e235a7ac2b3b69f7d1d2a72c9e86df7b6858c6178eb3",
  definitionPath: "dashboards/graviton-savings-dashboard/graviton_savings_dashboard-definition.yaml",
  definitionSha256: "2dd6358149ac7457de1a1ca0de9c4fcf651eaea7685f7554a27ae338df392ec8",
  dashboardId: "graviton-savings",
  version: "v3.0.2",
  theme: "MIDNIGHT",
  datasets: Object.freeze([
    "graviton_mapping",
    "opensearch_graviton_dashboard",
    "elasticache_graviton_dashboard",
    "ec2_graviton_dashboard",
    "rds_graviton_dashboard",
  ]),
  totals: Object.freeze({
    sheets: 7,
    visuals: 122,
    parameterControls: 39,
    filterControls: 14,
    parameterDeclarations: 44,
    calculatedFields: 68,
    filterGroups: 469,
    columnConfigurations: 48,
    datasets: 5,
  }),
  visualTypes: Object.freeze({
    KPIVisual: 37,
    BarChartVisual: 29,
    PivotTableVisual: 9,
    ComboChartVisual: 12,
    WaterfallVisual: 1,
    InsightVisual: 16,
    PieChartVisual: 17,
    TableVisual: 1,
  }),
  sheets: Object.freeze<readonly GravitonOfficialSheet[]>([
    Object.freeze({
      id: "07505eaa-8830-4ca1-9c45-4ae358ea70d0",
      name: "Summary",
      visualCount: 20,
      visualTypes: Object.freeze({ KPIVisual: 16, BarChartVisual: 4 }),
      parameterControls: Object.freeze([
        control("Dropdown", "Payer Account ID"),
        control("Dropdown", "Linked Account ID"),
        control("Dropdown", "Linked Account Name"),
      ]),
      filterControls: Object.freeze([]),
      nativeResourceTypes: Object.freeze([]),
      coverage: "NATIVE_EVIDENCE_PARTIAL",
      evidenceNote: "Native existing ARM64 usage, service economics, eligibility totals and monthly potential/realized trends across accepted accounts and Regions.",
      remainingGap: "Exact upstream KPI, multi-payer account-name and per-service comparison layout is not reproduced.",
    }),
    Object.freeze({
      id: "491f35e9-66b4-4555-8b1a-6f2ca32e6966",
      name: "EC2",
      visualCount: 28,
      visualTypes: Object.freeze({ PivotTableVisual: 3, BarChartVisual: 6, ComboChartVisual: 6, WaterfallVisual: 1, KPIVisual: 6, InsightVisual: 4, PieChartVisual: 2 }),
      parameterControls: Object.freeze([
        control("List", "Select Value to Display"),
        control("List", "Select Preferred Graviton Generation"),
        control("Dropdown", "Payer Account ID"),
        control("Dropdown", "Linked Account ID"),
        control("Dropdown", "Linked Account Name"),
        control("Dropdown", "Region"),
        control("Dropdown", "Instance Family"),
        control("Dropdown", "Savings Implementation Effort"),
        control("Slider", "Estimated NIH % Reduction, Range:[0-40%]"),
      ]),
      filterControls: Object.freeze([
        control("Dropdown", "Operating System"),
        control("Dropdown", "Existing Instance Family"),
        control("Dropdown", "Purchase Option"),
        control("Dropdown", "Existing Instance Type"),
        control("Dropdown", "Purchase Option"),
        control("Dropdown", "Processor Type"),
      ]),
      nativeResourceTypes: Object.freeze(["EC2_INSTANCE", "AUTO_SCALING_GROUP"]),
      coverage: "NATIVE_EVIDENCE_PARTIAL",
      evidenceNote: "Native EC2 and Auto Scaling usage, authoritative Compute Optimizer estimates where present, explicit compatibility, migration effort, modeled economics and drilldown.",
      remainingGap: "Preferred-generation, NIH reduction, operating-system, purchase-option, processor and detailed family controls are not native projection controls.",
    }),
    Object.freeze({
      id: "290271e2-b908-4c9f-9df8-fa1656e19d24",
      name: "RDS",
      visualCount: 26,
      visualTypes: Object.freeze({ ComboChartVisual: 2, BarChartVisual: 7, InsightVisual: 5, PivotTableVisual: 2, PieChartVisual: 5, KPIVisual: 5 }),
      parameterControls: Object.freeze([
        control("Dropdown", "Payer Account ID"),
        control("Dropdown", "Linked Account ID"),
        control("Dropdown", "Linked Account Name"),
        control("Dropdown", "Region"),
        control("Dropdown", "Graviton Eligible"),
        control("Dropdown", "Database Engine"),
        control("Dropdown", "Instance Type"),
        control("Dropdown", "Deployment Option"),
        control("Dropdown", "Instance Family"),
        control("Dropdown", "RDS Type"),
      ]),
      filterControls: Object.freeze([control("Dropdown", "Purchase Option")]),
      nativeResourceTypes: Object.freeze(["RDS_DB_INSTANCE", "AURORA_DB_INSTANCE"]),
      coverage: "NATIVE_EVIDENCE_PARTIAL",
      evidenceNote: "Native RDS/Aurora usage, eligibility blockers, provider estimates where authoritative, modeled economics and workload drilldown.",
      remainingGap: "Engine/version, deployment, family, RDS type and purchase-option controls require richer provider projection fields.",
    }),
    Object.freeze({
      id: "9adc7381-7fd2-489e-a4d4-e0b45d6abb68",
      name: "ElastiCache",
      visualCount: 25,
      visualTypes: Object.freeze({ PivotTableVisual: 2, BarChartVisual: 7, KPIVisual: 5, ComboChartVisual: 2, PieChartVisual: 5, InsightVisual: 4 }),
      parameterControls: Object.freeze([
        control("Dropdown", "Linked Account IDs"),
        control("Dropdown", "Payer Account ID"),
        control("Dropdown", "Linked Account Name"),
        control("Dropdown", "Region"),
        control("Dropdown", "Instance Family"),
        control("Dropdown", "Cache Engine"),
        control("Dropdown", "Graviton Eligibility"),
        control("Dropdown", "Graviton Instance"),
      ]),
      filterControls: Object.freeze([control("Dropdown", "Purchase Option")]),
      nativeResourceTypes: Object.freeze(["ELASTICACHE_REPLICATION_GROUP"]),
      coverage: "NATIVE_EVIDENCE_PARTIAL",
      evidenceNote: "Native ElastiCache inventory, explicit compatibility, modeled economics and workload drilldown without fabricated Compute Optimizer estimates.",
      remainingGap: "Cache-engine/version, family, target-instance and purchase-option controls require richer provider projection fields.",
    }),
    Object.freeze({
      id: "d40636b7-ad70-4d3f-a3a4-a936ae7e186c",
      name: "OpenSearch",
      visualCount: 22,
      visualTypes: Object.freeze({ ComboChartVisual: 2, BarChartVisual: 5, KPIVisual: 5, PivotTableVisual: 2, PieChartVisual: 5, InsightVisual: 3 }),
      parameterControls: Object.freeze([
        control("Dropdown", "Payer Account ID"),
        control("Dropdown", "Linked Account ID"),
        control("Dropdown", "Linked Account Name"),
        control("Dropdown", "Region"),
        control("Dropdown", "Instance Family"),
        control("Dropdown", "Graviton Eligibility"),
        control("Dropdown", "Engine"),
        control("Dropdown", "Purchase Option"),
      ]),
      filterControls: Object.freeze([]),
      nativeResourceTypes: Object.freeze(["OPENSEARCH_DOMAIN"]),
      coverage: "NATIVE_EVIDENCE_PARTIAL",
      evidenceNote: "Native OpenSearch inventory, explicit compatibility, modeled economics and workload drilldown without fabricated Compute Optimizer estimates.",
      remainingGap: "Engine/version, family and purchase-option controls require richer provider projection fields.",
    }),
    Object.freeze({
      id: "96401897-84b0-4a01-8daa-ae7aa9f02d44",
      name: "Graviton Instance Mapping",
      visualCount: 1,
      visualTypes: Object.freeze({ TableVisual: 1 }),
      parameterControls: Object.freeze([control("Dropdown", "Instance Type")]),
      filterControls: Object.freeze([
        control("Dropdown", "Region"),
        control("Dropdown", "Purchase Option"),
        control("Dropdown", "Offering Class"),
        control("Dropdown", "Lease Contract Length"),
        control("Dropdown", "Term Type"),
        control("Dropdown", "Platform"),
      ]),
      nativeResourceTypes: Object.freeze([]),
      coverage: "MODEL_ONLY",
      evidenceNote: "Versioned target metadata and price-list records participate in compatibility and economics validation but are not exposed as a standalone reference dataset.",
      remainingGap: "A bounded tenant-safe mapping table and the six upstream commercial filters are not implemented.",
    }),
    Object.freeze({
      id: "b8db1149-0d6b-4fcb-9d20-e5b03ab2e898",
      name: "About",
      visualCount: 0,
      visualTypes: Object.freeze({}),
      parameterControls: Object.freeze([]),
      filterControls: Object.freeze([]),
      nativeResourceTypes: Object.freeze([]),
      coverage: "ABOUT",
      evidenceNote: "Native immutable source, freshness, collection state, lineage, history and disclosure evidence.",
      remainingGap: "No QuickSight layout parity is claimed; the pinned upstream About sheet contains zero visual objects.",
    }),
  ]),
});

export type GravitonSavingsOfficialDefinition = typeof GRAVITON_SAVINGS_OFFICIAL_DEFINITION;

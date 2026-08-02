export type AwsConfigOfficialNativeCoverage =
  | "SUPPORTED"
  | "PARTIAL"
  | "UNAVAILABLE";

export interface AwsConfigOfficialSheet {
  readonly id: string;
  readonly name: string;
  readonly visualCount: number;
  readonly visualTypes: Readonly<Record<string, number>>;
  readonly parameterControlCount: number;
  readonly filterControlCount: number;
  readonly documentedPurpose: string;
  readonly publishedControlTitles: readonly string[];
  readonly nativeCoverage: AwsConfigOfficialNativeCoverage;
  readonly nativeEvidence: string;
  readonly remainingGap: string | null;
}

/**
 * Frozen audit of the public AWS Config Resource Compliance Dashboard v5.0.0.
 * AWS Guidance links to the separate aws-samples repository. The pinned CID
 * framework tree contains no CRCD-specific artifact, while the linked public
 * repository contains a complete QuickSight definition and CID-CMD manifest.
 */
export const AWS_CONFIG_COMPLIANCE_OFFICIAL_DEFINITION = Object.freeze({
  schema: "sutra.finops-aws-config-compliance-official-definition.v1",
  guidance: Object.freeze({
    url: "https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/config-resource-compliance-dashboard.html",
    reviewedOn: "2026-08-01",
  }),
  cidFrameworkAudit: Object.freeze({
    repository:
      "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
    dashboardSpecificArtifactCount: 0,
  }),
  sourceRepository:
    "https://github.com/aws-samples/config-resource-compliance-dashboard",
  sourceCommit: "c0d0c6a36d4f0cc04dc32e84d5f077bec2d4b60c",
  dashboardId: "cid-crcd",
  name: "AWS Config Resource Compliance Dashboard (CRCD)",
  version: "v5.0.0",
  theme: "MIDNIGHT",
  completeDefinitionPublished: true,
  exactGeometryClaimed: false,
  artifacts: Object.freeze([
    Object.freeze({
      kind: "CID_CMD_MANIFEST",
      path: "dashboard_template/cid-crcd.yaml",
      sha256:
        "1eabc9654371d23672c95daa6aff90be5505dbe59ab9fa9877e81e9bf47d5ff1",
      count: 1,
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "QUICKSIGHT_DEFINITION",
      path: "dashboard_template/cid-crcd-definition.yaml",
      sha256:
        "7827c3d11e1c7cefd6e7f26913c4c5284866d0cb1126a1c55ae614cff6eb30ee",
      count: 1,
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "CLOUDFORMATION_TEMPLATE",
      path: "cloudformation/cid-crcd-stack.yaml",
      sha256:
        "97542e8c142f5189b57c161a25b3051310b552fbb2826f11aaf96681400d98dc",
      count: 1,
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "BACKFILL_TEMPLATE",
      path: "backfill/crcd-backfill-resources.yaml",
      sha256:
        "27aabcad33304cb63510e88d7d9245e11f227de39ab79e38160fd544c33d5e4a",
      count: 1,
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "CHANGELOG",
      path: "CHANGELOG.md",
      sha256:
        "1f0131ddb4ac458df9b8322be8735d925469e32c1ca18306d22d609a202f04b3",
      count: 1,
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "EMBEDDED_DATASET_DEFINITIONS",
      path: "dashboard_template/cid-crcd.yaml#datasets",
      sha256:
        "6a6a46f386e4e9f4d4073393800c5e7303106b575a45848922b796d78406eef3",
      count: 13,
      hashBasis: "UTF-8 canonical JSON with recursively sorted object keys",
    }),
    Object.freeze({
      kind: "EMBEDDED_ATHENA_VIEW_QUERIES",
      path: "dashboard_template/cid-crcd.yaml#views",
      sha256:
        "aaa904287c86066d4873805581b1a929a798021d5e736092dd32de3fe360ce03",
      count: 14,
      hashBasis: "UTF-8 canonical JSON with recursively sorted object keys",
    }),
  ]),
  datasetNames: Object.freeze([
    "config_compliance",
    "config_compliance_actual",
    "config_compliance_conformance_pack",
    "config_compliance_resource",
    "config_event",
    "config_event_delivery",
    "config_event_rule_evaluation",
    "config_inventory",
    "config_inventory_ebs",
    "config_inventory_ec2",
    "config_inventory_lambda",
    "config_inventory_rds",
    "config_inventory_s3",
  ]),
  viewNames: Object.freeze([
    "config_compliance",
    "config_inventory_account",
    "config_compliance_actual",
    "config_compliance_conformance_pack",
    "config_compliance_resource",
    "config_event",
    "config_event_delivery",
    "config_event_rule_evaluation",
    "config_inventory",
    "config_inventory_ebs",
    "config_inventory_ec2",
    "config_inventory_lambda",
    "config_inventory_rds",
    "config_inventory_s3",
  ]),
  totals: Object.freeze({
    sheets: 7,
    visuals: 124,
    parameterControls: 51,
    filterControls: 13,
    parameterDeclarations: 53,
    calculatedFields: 40,
    filterGroups: 267,
    columnConfigurations: 1,
    datasets: 13,
    views: 14,
  }),
  visualTypes: Object.freeze({
    KPIVisual: 29,
    BarChartVisual: 64,
    TableVisual: 19,
    GaugeChartVisual: 6,
    PivotTableVisual: 1,
    HeatMapVisual: 4,
    PieChartVisual: 1,
  }),
  sheets: Object.freeze<readonly AwsConfigOfficialSheet[]>([
    Object.freeze({
      id: "b2f3f971-fb63-47d7-8b79-d36fed1327c6",
      name: "Compliance",
      visualCount: 30,
      visualTypes: Object.freeze({
        KPIVisual: 12,
        BarChartVisual: 11,
        TableVisual: 4,
        GaugeChartVisual: 3,
      }),
      parameterControlCount: 7,
      filterControlCount: 0,
      documentedPurpose:
        "At-a-glance rule, resource, and conformance-pack compliance, trends, and account/Region/service breakdowns.",
      publishedControlTitles: Object.freeze([
        "Account ID",
        "Region",
        "Compliance Type",
        "Conformance Pack",
        "AWS Config Rule",
        "Resource",
        "Account Name",
      ]),
      nativeCoverage: "PARTIAL",
      nativeEvidence:
        "Current rule/resource evidence, accepted-generation trend, account, Region, rule, compliance, resource-type controls, and conformance-pack rows.",
      remainingGap:
        "The minimized projection does not reproduce every upstream score, service breakdown, control, interaction, or QuickSight layout.",
    }),
    Object.freeze({
      id: "a2a48523-2289-461b-9d18-60f14392da15",
      name: "Tag Compliance",
      visualCount: 13,
      visualTypes: Object.freeze({
        KPIVisual: 4,
        BarChartVisual: 7,
        GaugeChartVisual: 1,
        TableVisual: 1,
      }),
      parameterControlCount: 5,
      filterControlCount: 0,
      documentedPurpose:
        "Required-tag and managed-rule tag compliance across accounts, Regions, resource types, and compliance states.",
      publishedControlTitles: Object.freeze([
        "Account ID",
        "Account Name",
        "Region",
        "Resource Type",
        "Compliance Type",
      ]),
      nativeCoverage: "UNAVAILABLE",
      nativeEvidence:
        "No tag-compliance value is inferred from generic compliance rows.",
      remainingGap:
        "Tag names, values, and tag-rule-specific projections are not collected by the v1 provider boundary.",
    }),
    Object.freeze({
      id: "cccb4da1-d030-4d1a-852a-ef51722f9c1b",
      name: "Resource Inventory",
      visualCount: 29,
      visualTypes: Object.freeze({
        TableVisual: 6,
        BarChartVisual: 17,
        PivotTableVisual: 1,
        KPIVisual: 5,
      }),
      parameterControlCount: 19,
      filterControlCount: 4,
      documentedPurpose:
        "EC2, EBS, S3, RDS, and Lambda inventory, resource-specific filtering, SSM status, tags, and Availability Zone distribution.",
      publishedControlTitles: Object.freeze([
        "Account ID",
        "Region",
        "Account Name",
        "Custom tags",
        "EC2 addresses",
        "EBS state and encryption",
        "RDS engine and certificate",
        "Lambda runtime",
        "AWS Systems Manager Status",
      ]),
      nativeCoverage: "PARTIAL",
      nativeEvidence:
        "A tenant-pinned generic resource inventory and account, Region, and resource-type filtering are available.",
      remainingGap:
        "Resource-specific attributes, custom tags, SSM state, Availability Zone distribution, and linked EC2/EBS interaction are not projected.",
    }),
    Object.freeze({
      id: "edae3ccb-fafc-47c7-b57e-44ccbb32d4cf",
      name: "Config Usage Insights",
      visualCount: 28,
      visualTypes: Object.freeze({
        BarChartVisual: 20,
        HeatMapVisual: 3,
        TableVisual: 4,
        PieChartVisual: 1,
      }),
      parameterControlCount: 14,
      filterControlCount: 0,
      documentedPurpose:
        "Configuration-item changes, rule-evaluation trends, redundant rules, insufficient-data rules, and Config cost contributors.",
      publishedControlTitles: Object.freeze([
        "Rule evaluation",
        "Conformance Pack",
        "Compliance Type",
        "Resource ID",
        "Account ID",
        "Region",
        "Account Name",
        "Time Window",
      ]),
      nativeCoverage: "PARTIAL",
      nativeEvidence:
        "Independent activity counts, duplicate-rule signals, insufficient-data conformance-pack counts, and reconciled CUR 2.0 actual costs are labelled separately.",
      remainingGap:
        "The upstream time-window series, heat maps, and complete duplicate/deployment analysis are not reproduced.",
    }),
    Object.freeze({
      id: "6bd455e9-7d13-47ed-8b23-194d76c68eb5",
      name: "Threat-Informed Security Compliance",
      visualCount: 19,
      visualTypes: Object.freeze({
        BarChartVisual: 8,
        KPIVisual: 8,
        GaugeChartVisual: 2,
        TableVisual: 1,
      }),
      parameterControlCount: 3,
      filterControlCount: 3,
      documentedPurpose:
        "Threat-informed classification of preventable security misconfigurations by compliance and resource type.",
      publishedControlTitles: Object.freeze([
        "Account ID",
        "Account Name",
        "Region",
        "Compliance Type",
        "Resource Type",
        "Initial Access Classification",
      ]),
      nativeCoverage: "UNAVAILABLE",
      nativeEvidence:
        "Sutra does not infer threat classifications from rule names.",
      remainingGap:
        "The upstream classification fields and controlled mapping are not part of the minimized provider projection.",
    }),
    Object.freeze({
      id: "eccc50c7-830a-47b3-807e-1db7d7620a1d",
      name: "Configuration Item Events",
      visualCount: 5,
      visualTypes: Object.freeze({
        TableVisual: 3,
        BarChartVisual: 1,
        HeatMapVisual: 1,
      }),
      parameterControlCount: 3,
      filterControlCount: 6,
      documentedPurpose:
        "Configuration-change timeline, delivery coverage, latest imported data, and account/Region event filtering.",
      publishedControlTitles: Object.freeze([
        "Account ID",
        "Region",
        "Account Name",
        "Date Range",
        "AWS Config Event Type",
        "Resource ID",
        "Resource Type",
      ]),
      nativeCoverage: "UNAVAILABLE",
      nativeEvidence:
        "Only aggregate activity counts are displayed; no event timeline is synthesized.",
      remainingGap:
        "Optional Config delivery objects and normalized configuration-item event rows are not bound to the active collector.",
    }),
    Object.freeze({
      id: "311789e6-1827-4162-898a-9061b4a26954",
      name: "About",
      visualCount: 0,
      visualTypes: Object.freeze({}),
      parameterControlCount: 0,
      filterControlCount: 0,
      documentedPurpose:
        "Dashboard provenance, usage context, and solution information.",
      publishedControlTitles: Object.freeze([]),
      nativeCoverage: "SUPPORTED",
      nativeEvidence:
        "Pinned source, hashes, exact object inventory, activation boundary, and limitations remain visible in ready and null states.",
      remainingGap: null,
    }),
  ]),
  limitations: Object.freeze([
    "The credential-owning adapter, strict signed route, durable replay store, immutable persistence, and production composition are implemented; shared runtime registration is integration-owned.",
    "The native UI maps documented purposes and exact object counts; it does not claim pixel or QuickSight geometry parity.",
    "Tag, resource-specific, threat-classification, and configuration-item event fields remain outside the minimized provider projection; Security Hub and CloudTrail are not substituted.",
  ]),
});

export type AwsConfigComplianceOfficialDefinition =
  typeof AWS_CONFIG_COMPLIANCE_OFFICIAL_DEFINITION;

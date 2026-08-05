/**
 * Immutable audit inventory for the AWS Compute Optimizer Dashboard (COD).
 *
 * AWS publishes the deployable manifest, SPICE dataset and Athena views in
 * git, but the QuickSight template definition itself is referenced by ID and
 * is not committed. Exact dashboard-wide sheet/visual/control counts are
 * therefore deliberately null rather than inferred from a preview image.
 */
export const FINOPS_COMPUTE_OPTIMIZER_OFFICIAL_DEFINITION = Object.freeze({
  source: Object.freeze({
    repository:
      "aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
    dashboardId: "compute-optimizer-dashboard",
    templateId: "compute_optimizer",
    version: "v5.0.0",
    documentationUrl:
      "https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/compute-optimizer-dashboard.html",
    manifest: Object.freeze({
      path: "cid/builtin/core/data/resources.yaml",
      sha256:
        "41ad438cea2a297f62976689e77eee8fda371913a6af53c946fb615bdccb5b71",
    }),
    dataset: Object.freeze({
      path: "cid/builtin/core/data/datasets/co/dataset.json",
      sha256:
        "310718392f10de059efc3255f30b257aabdeebd7f0eba7d2debad0db09097176",
    }),
    unionView: Object.freeze({
      path: "cid/builtin/core/data/queries/co/all_options.sql",
      sha256:
        "6ce1408e8c71291e34c2face7feac9a1e5c0f142ab5651868d8d93ac6188f0d2",
    }),
    changelog: Object.freeze({
      path: "changes/CHANGELOG-cod.md",
      sha256:
        "29e5e8e000fa0bb23a5ab0d0840d93313b959c9c9978adcf0b61bc59aa3b1332",
    }),
    documentedPreview: Object.freeze({
      path:
        "https://docs.aws.amazon.com/images/guidance/latest/cloud-intelligence-dashboards/images/co_demo.png",
      sha256:
        "a85d169cdc252408b29c40125513b90e735cbf564a4d4b22db1602a4d9261eae",
    }),
  }),
  quickSightDefinition: Object.freeze({
    state: "NOT_PUBLICLY_COMMITTED",
    exactSheetCount: null,
    exactVisualCount: null,
    exactFilterControlCount: null,
    exactParameterControlCount: null,
    disclosure:
      "The pinned manifest references a public QuickSight template ID but does not contain its definition. Counts are not inferred from screenshots.",
  }),
  publishedModuleFamilies: Object.freeze([
    "EC2 instance",
    "Auto Scaling group",
    "EBS volume",
    "Lambda function",
    "RDS instance",
    "RDS storage",
    "ECS service",
    "License",
    "Idle resource",
  ]),
  documentedOutcomes: Object.freeze([
    "Organization and all-Region optimization visibility",
    "Overprovisioned and underprovisioned resource findings",
    "Right-sizing recommendations",
    "Potential savings across payer accounts and Regions",
    "Operational risk from underprovisioned resources",
    "Optimization progress over time by account, team, or business unit",
    "Primary and secondary resource-tag filtering",
  ]),
  documentedPreviewVisuals: Object.freeze([
    "Total instances",
    "Findings",
    "Findings by Date",
    "Findings by Business Unit",
    "Operational Risk Finding Count",
    "Maximum Potential Savings EC2",
    "Potential Savings by Date",
    "Potential Savings by Business Unit",
    "Operational Risks by Business Unit",
    "Select Instance",
    "Current versus Recommended Option Projection",
    "Recommended Instance Family Changes",
    "Potential Savings Histogram",
    "Potential Savings by Instance",
  ]),
  datasetControls: Object.freeze([
    "Account",
    "Region",
    "Service",
    "Module",
    "Finding",
    "Business Unit",
    "Primary Tag",
    "Secondary Tag",
    "Resource search",
  ]),
} as const);

export type FinopsComputeOptimizerOfficialDefinition =
  typeof FINOPS_COMPUTE_OPTIMIZER_OFFICIAL_DEFINITION;

/** Immutable FND-01 audit of the AWS CUDOS v5 QuickSight definition. */
export const FINOPS_CUDOS_OFFICIAL_DEFINITION = Object.freeze({
  source: Object.freeze({
    repository:
      "aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "9cecc158b81504344cf96b38d5918b6953b2e97d",
    path: "dashboards/cudos/CUDOS-v5-definition.yaml",
    sha256: "4db8cd567b3aea50b44f4e7c3d175586799a5aaf3e923db260b570ae56d1aea2",
    version: "v5.9.1",
  }),
  documentationUrl:
    "https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/cudos-cid-kpi.html#foundational-cudos-dashboard",
  totals: Object.freeze({
    sheets: 19,
    visuals: 409,
    parameterControls: 88,
    filterControls: 54,
    parameterDeclarations: 40,
    calculatedFields: 402,
    filterGroups: 1_261,
  }),
  sheets: Object.freeze([
    Object.freeze({ name: "Executive: Billing Summary", visualCount: 22, parameterControlCount: 4, filterControlCount: 3, support: "SUPPORTED", gap: null }),
    Object.freeze({ name: "Executive: RI/SP Summary", visualCount: 26, parameterControlCount: 3, filterControlCount: 1, support: "PARTIAL", gap: "Expiry, purchase and provider recommendation context require authoritative commitment evidence." }),
    Object.freeze({ name: "Executive: Trends", visualCount: 15, parameterControlCount: 8, filterControlCount: 5, support: "SUPPORTED", gap: null }),
    Object.freeze({ name: "Compute", visualCount: 38, parameterControlCount: 5, filterControlCount: 6, support: "PARTIAL", gap: "Telemetry-specific utilization and rightsizing are not inferred from billing rows." }),
    Object.freeze({ name: "Storage & Backup", visualCount: 25, parameterControlCount: 3, filterControlCount: 2, support: "PARTIAL", gap: "Resource inventory, age and activity require provider evidence." }),
    Object.freeze({ name: "Amazon S3", visualCount: 21, parameterControlCount: 6, filterControlCount: 1, support: "PARTIAL", gap: "Bucket activity and storage-class recommendations require S3 telemetry." }),
    Object.freeze({ name: "Databases", visualCount: 26, parameterControlCount: 8, filterControlCount: 3, support: "PARTIAL", gap: "Compatibility and utilization are unavailable without provider inventory and metrics." }),
    Object.freeze({ name: "Amazon DynamoDB", visualCount: 26, parameterControlCount: 5, filterControlCount: 12, support: "PARTIAL", gap: "Provisioned-capacity utilization and recommendations require DynamoDB/CloudWatch evidence." }),
    Object.freeze({ name: "AI/ML", visualCount: 50, parameterControlCount: 7, filterControlCount: 2, support: "PARTIAL", gap: "Canonical CUR token and cache usage is native when compatible evidence exists; workload telemetry, inferred cache savings, and provider recommendations remain unavailable." }),
    Object.freeze({ name: "Data Transfer & Networking", visualCount: 25, parameterControlCount: 3, filterControlCount: 3, support: "PARTIAL", gap: "Only canonical source/destination dimensions are shown; missing endpoints remain missing." }),
    Object.freeze({ name: "Messaging and Streaming", visualCount: 13, parameterControlCount: 3, filterControlCount: 1, support: "PARTIAL", gap: "Service telemetry is not substituted with cost data." }),
    Object.freeze({ name: "Monitoring & Observability", visualCount: 25, parameterControlCount: 3, filterControlCount: 4, support: "PARTIAL", gap: "Billing and unit-cost evidence are native; operational telemetry is not." }),
    Object.freeze({ name: "Analytics", visualCount: 23, parameterControlCount: 3, filterControlCount: 1, support: "PARTIAL", gap: "Workload efficiency requires authoritative service telemetry." }),
    Object.freeze({ name: "Security", visualCount: 20, parameterControlCount: 3, filterControlCount: 3, support: "PARTIAL", gap: "Billing allocation is native; security posture is outside CUR evidence." }),
    Object.freeze({ name: "End User Computing", visualCount: 15, parameterControlCount: 3, filterControlCount: 1, support: "PARTIAL", gap: "Billing classification is native; usage telemetry is provided by the separate EUC vertical." }),
    Object.freeze({ name: "GameTech & Media", visualCount: 13, parameterControlCount: 3, filterControlCount: 1, support: "PARTIAL", gap: "Billing classification is native; operational detail is provided by specialized verticals." }),
    Object.freeze({ name: "Taxonomy Explorer", visualCount: 16, parameterControlCount: 5, filterControlCount: 2, support: "PARTIAL", gap: "Tenant taxonomy allocation is native; QuickSight field/layout parity is not claimed." }),
    Object.freeze({ name: "OPTICS Explorer", visualCount: 9, parameterControlCount: 13, filterControlCount: 3, support: "PARTIAL", gap: "Bounded native dimensions are supported; arbitrary QuickSight field parity is not." }),
    Object.freeze({ name: "About", visualCount: 1, parameterControlCount: 0, filterControlCount: 0, support: "SUPPORTED", gap: null }),
  ]),
} as const);

export type FinopsCudosOfficialDefinition =
  typeof FINOPS_CUDOS_OFFICIAL_DEFINITION;

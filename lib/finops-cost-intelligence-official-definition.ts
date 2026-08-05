/** Immutable audit pin for the official AWS Cost Intelligence Dashboard. */
export const FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION = Object.freeze({
  repository: "aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
  commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
  path: "dashboards/cost-intelligence/cost-intelligence-definition.yaml",
  sha256: "71795647fd09a17c3a2e1ea2f1308d6aecb150efe339a0950866ad766ef10ab0",
  documentationUrl:
    "https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/cudos-cid-kpi.html#cost-intelligence-dashboard-cid",
  sheets: Object.freeze([
    Object.freeze({ name: "Billing Summary", visualCount: 12, filterControlCount: 0, parameterControlCount: 3, support: "IMPLEMENTED_LOCAL", gaps: Object.freeze([]) }),
    Object.freeze({ name: "Cost Summary", visualCount: 15, filterControlCount: 0, parameterControlCount: 3, support: "IMPLEMENTED_LOCAL", gaps: Object.freeze([]) }),
    Object.freeze({ name: "Compute Summary", visualCount: 11, filterControlCount: 0, parameterControlCount: 3, support: "PARTIAL_EVIDENCE", gaps: Object.freeze(["EC2-only unit cost and elasticity require complete service-specific usage quantity evidence."]) }),
    Object.freeze({ name: "Storage Summary", visualCount: 12, filterControlCount: 0, parameterControlCount: 3, support: "PARTIAL_EVIDENCE", gaps: Object.freeze(["Bucket, volume, and storage-class coverage require unambiguous resource semantics and complete usage evidence."]) }),
    Object.freeze({ name: "RI/SP Summary", visualCount: 17, filterControlCount: 3, parameterControlCount: 3, support: "PARTIAL_EVIDENCE", gaps: Object.freeze(["Savings and utilization remain partial until unused charge, public on-demand cost, and usage quantity completeness are proved."]) }),
    Object.freeze({ name: "Expiring RI/SP Tracker", visualCount: 2, filterControlCount: 0, parameterControlCount: 3, support: "IMPLEMENTED_LOCAL", gaps: Object.freeze([]) }),
    Object.freeze({ name: "OPTICS Explorer ", visualCount: 3, filterControlCount: 8, parameterControlCount: 12, support: "PARTIAL_CONTROL_PARITY", gaps: Object.freeze(["The safe native explorer supports allow-listed dimensions; the eight official product-specific filters are not all exposed."]) }),
    Object.freeze({ name: "MoM Pivot", visualCount: 2, filterControlCount: 0, parameterControlCount: 3, support: "IMPLEMENTED_LOCAL", gaps: Object.freeze(["Spend pivot is native; usage pivot requires complete, unit-compatible quantity evidence."]) }),
    Object.freeze({ name: "Summary of Changes", visualCount: 1, filterControlCount: 0, parameterControlCount: 0, support: "IMPLEMENTED_LOCAL", gaps: Object.freeze([]) }),
    Object.freeze({ name: "About", visualCount: 2, filterControlCount: 0, parameterControlCount: 0, support: "IMPLEMENTED_LOCAL", gaps: Object.freeze([]) }),
  ]),
  exactVisualCount: 77,
  exactFilterControlCount: 11,
  exactParameterControlCount: 33,
} as const);

export type FinopsCostIntelligenceOfficialDefinition =
  typeof FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION;

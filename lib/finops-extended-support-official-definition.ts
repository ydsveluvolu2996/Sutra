/** Immutable ADV-04 audit of the AWS Extended Support projection definition. */
export const EXTENDED_SUPPORT_OFFICIAL_DEFINITION = Object.freeze({
  source: Object.freeze({
    repository:
      "aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
    path: "dashboards/extended-support-cost-projection/extended-support-cost-projection-definition.yaml",
    sha256: "6e50955ebeab4f2cbcc86c731c939e12c3fe4880d8132514f8de05042cfdb53f",
  }),
  totals: Object.freeze({
    sheets: 5,
    visuals: 60,
    parameterControls: 17,
    filterControls: 0,
    parameterDeclarations: 11,
    calculatedFields: 27,
    filterGroups: 68,
  }),
  sheets: Object.freeze([
    Object.freeze({
      name: "RDS Extended Support (Cost Projection)",
      visualCount: 16,
      parameterControlCount: 5,
      support: "SUPPORTED",
      note: "Native RDS and Aurora evidence classes remain separate while sharing the official RDS planning sheet.",
    }),
    Object.freeze({
      name: "EKS Extended Support (Cost Projection)",
      visualCount: 14,
      parameterControlCount: 4,
      support: "SUPPORTED",
      note: "Native version, lifecycle, Region, enrollment and incremental projection evidence.",
    }),
    Object.freeze({
      name: "OpenSearch Extended Support (Cost Projection)",
      visualCount: 14,
      parameterControlCount: 4,
      support: "SUPPORTED",
      note: "Native domain version, lifecycle, normalized usage basis and projection evidence.",
    }),
    Object.freeze({
      name: "ElastiCache Extended Support (Cost Projection)",
      visualCount: 16,
      parameterControlCount: 4,
      support: "SUPPORTED",
      note: "Native cluster/replication-group version, lifecycle, usage basis and projection evidence.",
    }),
    Object.freeze({
      name: "About",
      visualCount: 0,
      parameterControlCount: 0,
      support: "SUPPORTED",
      note: "Immutable definition, source semantics, freshness and limitations are exposed natively.",
    }),
  ]),
} as const);

export type ExtendedSupportOfficialDefinition =
  typeof EXTENDED_SUPPORT_OFFICIAL_DEFINITION;

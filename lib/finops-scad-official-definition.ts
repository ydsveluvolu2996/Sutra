/** Immutable, evidence-honest ADD-07 audit of AWS's public SCAD catalog. */
export const SCAD_OFFICIAL_DEFINITION = Object.freeze({
  source: Object.freeze({
    repository:
      "aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
    path: "dashboards/scad-containers-cost-allocation/scad-containers-cost-allocation.yaml",
    sha256: "0b27190fecbb87988b3f06ec122f3a2ffc7636b25f8008b3117367ad8302c2d4",
    dashboardId: "scad-containers-cost-allocation",
    templateId: "scad-containers-cost-allocation",
    quickSightDefinitionEmbedded: false,
    quickSightControlInventory: "NOT_DISCLOSED_IN_IMMUTABLE_SOURCE",
    quickSightVisualObjectCount: null,
  }),
  documentationUrl:
    "https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/scad-containers-dashboard.html",
  documentedTabCountClaim: 3,
  documentedSectionCount: 5,
  catalogNote:
    "AWS guidance says the dashboard has three tabs, then names five sections. Sutra preserves the inconsistency and does not relabel it as an exact sheet count.",
  sections: Object.freeze([
    Object.freeze({
      id: "executive-summary",
      label: "Executive Summary",
      support: "SUPPORTED",
      documentedAreas: Object.freeze([
        "CPU, GPU, RAM, shared and total cost KPIs",
        "Total Cost by Account ID",
        "Top Spending Clusters",
      ]),
    }),
    Object.freeze({
      id: "workloads-explorer",
      label: "Workloads Explorer",
      support: "SUPPORTED",
      documentedAreas: Object.freeze([
        "Interactive cost aggregation and filtering",
        "Stacked-bar and pivot-table decision views",
      ]),
    }),
    Object.freeze({
      id: "cluster-breakdown",
      label: "Cluster Breakdown",
      support: "SUPPORTED",
      documentedAreas: Object.freeze(["Coverage and drill-down visuals"]),
    }),
    Object.freeze({
      id: "labels-tags-explorer",
      label: "Labels/Tags Explorer",
      support: "PARTIAL",
      documentedAreas: Object.freeze([
        "Pod/task split cost by custom labels and tags",
        "Tagged AWS resource Total Cost of Ownership",
      ]),
      limitation:
        "SCAD pod/task tag cost is supported. Non-SCAD tagged AWS resource TCO requires a separately governed CUR2 join.",
    }),
    Object.freeze({
      id: "data-on-eks",
      label: "Data on EKS",
      support: "PARTIAL",
      documentedAreas: Object.freeze([
        "Spark and Flink allocation on EKS",
        "EMR on EKS service plus split cost",
      ]),
      limitation:
        "Framework grouping is disclosed Sutra name/tag inference; EMR service cost is not merged without governed non-SCAD evidence.",
    }),
  ]),
} as const);

export type ScadOfficialDefinition = typeof SCAD_OFFICIAL_DEFINITION;

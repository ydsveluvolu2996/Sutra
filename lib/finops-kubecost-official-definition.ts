export type KubecostOfficialNativeCoverage = "PARTIAL" | "UNAVAILABLE";

export interface KubecostOfficialArea {
  readonly name: "Executive Summary" | "Workloads Explorer" | "EKS Breakdown";
  readonly documentedPurpose: string;
  readonly nativeCoverage: KubecostOfficialNativeCoverage;
  readonly nativeEvidence: string;
  readonly remainingGap: string;
}

/**
 * Frozen audit of AWS's Kubecost Containers Cost Allocation Dashboard sources.
 * The linked awslabs repository publishes the CID manifest, dataset, exporter,
 * and deployment source, but references a service-hosted QuickSight template.
 */
export const KUBECOST_OFFICIAL_DEFINITION = Object.freeze({
  schema: "sutra.finops-kubecost-official-definition.v1",
  guidance: Object.freeze({
    url: "https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/kubecost-containers-dashboard.html",
    reviewedOn: "2026-08-01",
  }),
  cidFrameworkAudit: Object.freeze({
    repository: "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
    kubecostDashboardSpecificArtifactCount: 0,
    note: "The similarly named SCAD dashboard is a separate CUR Split Cost Allocation Data vertical and is not Kubecost evidence.",
  }),
  sourceRepository: "https://github.com/awslabs/containers-cost-allocation-dashboard",
  sourceCommit: "8a581332a70ae55d53464e52a0bb8b3dd64cb425",
  dashboardId: "containers-cost-allocation",
  templateId: "containers-cost-allocation",
  name: "Containers Cost Allocation (CCA)",
  publishedVersion: null,
  artifacts: Object.freeze([
    Object.freeze({
      kind: "CID_CMD_MANIFEST",
      path: "cid/containers_cost_allocation.yaml",
      sha256: "2bde67113c8f585d13fc43fe537c3bee3eecf3a416b81cd0f57295226b4ed45b",
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "EMBEDDED_SPICE_DATASET",
      path: "cid/containers_cost_allocation.yaml#datasets",
      sha256: "3cd36937146500be79d7cfe3f6fa78012f999378dd9729ec17a300888c7962a6",
      hashBasis: "UTF-8 canonical JSON with recursively sorted object keys",
    }),
    Object.freeze({
      kind: "EXTRACTED_ATHENA_VIEW_QUERY",
      path: "terraform/terraform-aws-cca/modules/pipeline/locals.tf#athena_view_sql",
      sha256: "2a5db62703b857a19d56a50661e5a20be4d02776aad3d1065422c7bab8b2e07c",
      hashBasis: "exact 247 UTF-8 source bytes between the Terraform heredoc delimiters",
    }),
    Object.freeze({
      kind: "TERRAFORM_ROOT_TEMPLATE",
      path: "terraform/terraform-aws-cca/main.tf",
      sha256: "44761c0335e9b87b1280473e90cc233a77d57a64ea9163df1d24d220c43f414a",
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "TERRAFORM_PIPELINE_TEMPLATE",
      path: "terraform/terraform-aws-cca/modules/pipeline/main.tf",
      sha256: "0d2aa8d88a021763a24e5939682b90f8be32763c272db149ac9682458463018c",
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "HELM_EXPORTER_CRON_TEMPLATE",
      path: "helm/kubecost_s3_exporter/templates/cron.yaml",
      sha256: "0d87ae307676a0fec9db1a774028b318bf9940f22e58deddb26a88a074a3d163",
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "KUBECOST_S3_EXPORTER",
      path: "main.py",
      sha256: "48f44e9147ed57fa2252a6867473fac82fd362b612fe59041b8dc9f4df81fdf3",
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "UPDATE_INSTRUCTIONS",
      path: "UPDATE.md",
      sha256: "f8cc13ac9d922c3063d74dd2d742faaa4267dd6301ca35043e97f9df3ca390fa",
      hashBasis: "raw file bytes; this is not a changelog",
    }),
  ]),
  unavailableArtifacts: Object.freeze({
    quickSightDefinitionPath: null,
    changelogPath: null,
    standaloneDatasetPath: null,
    standaloneQueryPath: null,
  }),
  quickSightDefinition: Object.freeze({
    publishedInRepository: false,
    serviceHostedTemplate: true,
    sheetCount: null,
    visualCount: null,
    parameterControlCount: null,
    filterControlCount: null,
    parameterCount: null,
    calculatedFieldCount: null,
    filterGroupCount: null,
    pixelParityClaimed: false,
    reason: "QUICKSIGHT_DEFINITION_NOT_PUBLISHED_AT_PINNED_COMMIT",
  }),
  publishedData: Object.freeze({
    datasetCount: 1,
    datasetName: "cca_kubecost_view",
    inputColumnCount: 62,
    cidManifestViewCount: 0,
    terraformAthenaViewQueryCount: 1,
  }),
  documentedControlTitles: null,
  documentedAreas: Object.freeze<readonly KubecostOfficialArea[]>([
    Object.freeze({
      name: "Executive Summary",
      documentedPurpose: "High-level KPIs per cost metric, including CPU, RAM, total cost and efficiency, total cost by account, and top spending clusters.",
      nativeCoverage: "PARTIAL",
      nativeEvidence: "Exact currency-separated total/component allocation, CPU and RAM usage-versus-request efficiency, account allocation, and top clusters are available for accepted rows.",
      remainingGap: "AWS describes additional metrics non-exhaustively, and the unpublished QuickSight definition prevents an exact visual/control parity claim.",
    }),
    Object.freeze({
      name: "Workloads Explorer",
      documentedPurpose: "Interactive stacked-bar and pivot exploration of Kubernetes cost across in-dashboard aggregations and filters.",
      nativeCoverage: "PARTIAL",
      nativeEvidence: "Tenant-bounded account, cluster, namespace, allocation-kind and currency filters, exact workload rows, pivots, and hourly allocation are native.",
      remainingGap: "The upstream stacked-bar geometry, exact pivot fields, controls, and cross-visual interactions are unpublished and are not inferred.",
    }),
    Object.freeze({
      name: "EKS Breakdown",
      documentedPurpose: "Pod distribution and coverage by capacity type and instance type, plus namespace drilldown by cost metric.",
      nativeCoverage: "PARTIAL",
      nativeEvidence: "Cluster allocation groups and namespace/component-cost drilldown are available.",
      remainingGap: "Sutra's accepted export contract does not carry node capacity type or instance type, so those documented graphs remain unavailable.",
    }),
  ]),
  supplementalOpenCost: Object.freeze({
    designation: "SUPPLEMENTAL_NOT_AWS_DASHBOARD_PARITY",
    supportedByOfficialAwsDashboard: false,
    acceptedBySutraContract: true,
    disclosure: "The official repository explicitly says OpenCost is not supported. Sutra may accept separately labelled OpenCost-compatible evidence, but it is never counted as official Kubecost dashboard coverage.",
  }),
  limitations: Object.freeze([
    "The customer Kubecost exporter, credential-owning signed ingest adapter, and live provider evidence are not deployed.",
    "Node capacity type and EC2 instance type are absent from Sutra's accepted export contract and are not inferred.",
    "QuickSight object totals and exact geometry remain unknown because the complete definition is service-hosted and unpublished.",
  ]),
});

export type KubecostOfficialDefinition = typeof KUBECOST_OFFICIAL_DEFINITION;

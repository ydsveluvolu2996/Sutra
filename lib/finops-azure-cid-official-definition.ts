export type AzureCidOfficialNativeCoverage = "SUPPORTED" | "PARTIAL" | "PROVIDER_GAP";

export interface AzureCidOfficialArea {
  readonly name: string;
  readonly documentedPurpose: string;
  readonly nativeCoverage: AzureCidOfficialNativeCoverage;
  readonly nativeEvidence: string;
  readonly remainingGap: string | null;
}

/** Frozen audit of the public Cloud Intelligence Dashboard for Azure source. */
export const AZURE_CID_OFFICIAL_DEFINITION = Object.freeze({
  schema: "sutra.finops-azure-cid-official-definition.v1",
  reviewedOn: "2026-08-01",
  officialReferences: Object.freeze([
    "https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/dashboards.html",
    "https://aws.amazon.com/blogs/modernizing-with-aws/cloud-intelligence-dashboard-for-azure/",
  ]),
  cidFrameworkAudit: Object.freeze({
    repository: "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
    azureDashboardSpecificArtifactCount: 0,
  }),
  sourceRepository: "https://github.com/aws-samples/aws-data-pipelines-for-azure-storage",
  sourceCommit: "ca870a82ce9e8fba4670af9a649df4074f931e02",
  dashboardName: "Cloud Intelligence Dashboard for Azure",
  templateId: "cid-azure-cost",
  artifacts: Object.freeze([
    Object.freeze({ kind: "README", path: "README.md", sha256: "3d41c089cbf99c082504c01da029fcddcfc585a272af4b2e1e34ab3ede8c4b2f", hashBasis: "raw file bytes" }),
    Object.freeze({ kind: "CLOUDFORMATION_TEMPLATE", path: "CloudIntelligenceDashboardforAzure/CFN/cid-azure-stack.yaml", sha256: "f91c63ab490f20df14434a14b945178f994ea3089fe9f07ae368b886b2e9dc00", hashBasis: "raw file bytes" }),
    Object.freeze({ kind: "DASHBOARD_MANIFEST", path: "CloudIntelligenceDashboardforAzure/CFN/cid-azure-dashboard.yaml", sha256: "7da6faa098d8e56c3bc3620139e70c7a246f58df95281676a4afd734c5c52905", hashBasis: "raw file bytes" }),
    Object.freeze({ kind: "EMBEDDED_SPICE_DATASET", path: "CloudIntelligenceDashboardforAzure/CFN/cid-azure-dashboard.yaml#datasets", sha256: "46ebf6e4750e4e22a266fcd49bb0f99a9d3a3b5cdbd184db320755bc49c057c9", hashBasis: "UTF-8 canonical JSON with recursively sorted object keys" }),
    Object.freeze({ kind: "EMBEDDED_STANDARD_VIEW_QUERY", path: "CloudIntelligenceDashboardforAzure/CFN/cid-azure-dashboard.yaml#views", sha256: "77b6d8b0ceb69e95913c68bf2bb3ec00d6d751ae3ba6da8e3b2536f0bf74f3e5", hashBasis: "exact UTF-8 bytes of the decoded 204-byte YAML block scalar" }),
    Object.freeze({ kind: "STANDARD_TRANSFORM", path: "CloudIntelligenceDashboardforAzure/CFN/cid-azure-gluejob.py", sha256: "1918596a83ba0a9a503d3a366531ffaf2520b1dd7b3c2a1426d02d45fb122b90", hashBasis: "raw file bytes" }),
    Object.freeze({ kind: "FOCUS_1_0_TRANSFORM", path: "CloudIntelligenceDashboardforAzure/CFN/cid-azure-gluejob-FOCUS-1.0.py", sha256: "8633a21a72941e4ca7fd92c24a8793992b56c657c05c113b6ff6ce1852792be8", hashBasis: "raw file bytes" }),
    Object.freeze({ kind: "STANDARD_QUERY", path: "CloudIntelligenceDashboardforAzure/TF/cid-azure-standard_view.sql", sha256: "3dad019cf030ec5cb8ffd2eabeba80b4168164676554eef5d10eaf37f6241b92", hashBasis: "raw file bytes" }),
    Object.freeze({ kind: "FOCUS_QUERY", path: "CloudIntelligenceDashboardforAzure/TF/cid-azure-focus_consolidation_view.sql", sha256: "c35561bd208984659be28ec06334ae35ba93de5b305c6306fe280b9d58f8f434", hashBasis: "raw file bytes" }),
    Object.freeze({ kind: "FOCUS_QUERY", path: "CloudIntelligenceDashboardforAzure/TF/cid-azure-focus_resource_view.sql", sha256: "27495242f53cb74ad2fce145165aec9e2ad56edf6197e17d1d89a120d4f7a6c5", hashBasis: "raw file bytes" }),
    Object.freeze({ kind: "FOCUS_QUERY", path: "CloudIntelligenceDashboardforAzure/TF/cid-azure-focus_summary_view.sql", sha256: "d7b1d6549abc13a7033766311895b9674ca5f5cb1dd66dc7855deaef85330fd9", hashBasis: "raw file bytes" }),
  ]),
  unavailableArtifacts: Object.freeze({
    quickSightDefinitionPath: null,
    changelogPath: null,
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
    manifestDatasetCount: 1,
    manifestDatasetInputColumnCount: 21,
    manifestEmbeddedViewCount: 1,
    standardTransformCount: 1,
    focusTransformCount: 1,
    standaloneStandardQueryCount: 1,
    standaloneFocusQueryCount: 3,
  }),
  documentedAreas: Object.freeze<readonly AzureCidOfficialArea[]>([
    Object.freeze({
      name: "Azure cost visualizations and reports",
      documentedPurpose: "A common QuickSight experience for Azure cost visibility serving executives, finance, procurement, FinOps, and product owners.",
      nativeCoverage: "PARTIAL",
      nativeEvidence: "Exact currency-isolated summary, monthly trend, service, subscription, Region, resource-group, pricing, charge, tag, and resource views are native for accepted exports.",
      remainingGap: "The hosted QuickSight definition, exact visual inventory, controls, geometry, and interactions are not public and are not inferred.",
    }),
    Object.freeze({
      name: "Recurring Azure cost export",
      documentedPurpose: "Daily Azure Cost Management CSV exports to Blob Storage copied into Amazon S3.",
      nativeCoverage: "PROVIDER_GAP",
      nativeEvidence: "A tenant-pinned collector and durable runtime contract exists, but no Azure credential-owning adapter or observed Blob delivery is deployed.",
      remainingGap: "Live Azure identity, export, Blob, copy, and provider acceptance remain unavailable.",
    }),
    Object.freeze({
      name: "Transformation and tag normalization",
      documentedPurpose: "Glue conversion, type normalization, deduplication, tag-column expansion, Parquet output, and error isolation.",
      nativeCoverage: "PARTIAL",
      nativeEvidence: "Strict Standard Actual Cost and FOCUS 1.0 normalization, duplicate-tag rejection, immutable manifest lineage, and explicit failure states are native contracts.",
      remainingGap: "The official Glue implementation is not executed by Sutra and has no controlled live equivalence proof.",
    }),
    Object.freeze({
      name: "Six-month Athena and SPICE scope",
      documentedPurpose: "Athena exposes the recent six-month cost scope and QuickSight SPICE refreshes the dashboard dataset daily.",
      nativeCoverage: "SUPPORTED",
      nativeEvidence: "Accepted captures require an exact six-month summary and surface immutable freshness, history, and dataset lineage.",
      remainingGap: null,
    }),
    Object.freeze({
      name: "Detailed resource analysis",
      documentedPurpose: "The sample dashboard consumes selected cost fields while the solution supports creating additional QuickSight visualizations.",
      nativeCoverage: "PARTIAL",
      nativeEvidence: "A bounded 30-day resource-detail view, filters, tags, and formula-safe CSV export are native.",
      remainingGap: "The exact upstream sample fields and any customer-created visuals are not an exhaustive public contract.",
    }),
  ]),
  limitations: Object.freeze([
    "No Azure credential, recurring export, delivered Blob manifest, price sheet, reservation recommendation dataset, or provider adapter is configured.",
    "Calculated list and contracted deltas are opportunities, not realized savings.",
    "QuickSight totals and exact geometry remain unknown because the complete definition is unpublished.",
  ]),
});

export type AzureCidOfficialDefinition = typeof AZURE_CID_OFFICIAL_DEFINITION;

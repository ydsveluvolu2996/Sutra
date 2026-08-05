export type DataTransferDocumentedCoverage = "NATIVE_PURPOSE_COVERED";

export interface DataTransferDocumentedVisualPurpose {
  readonly purpose: string;
  readonly coverage: DataTransferDocumentedCoverage;
  readonly nativeEvidence: string;
  readonly remainingGap: string;
}

/**
 * Frozen official-source audit for ADD-10. The pinned repository does not
 * publish a QuickSight definition, so unknown object totals remain null.
 */
export const DATA_TRANSFER_OFFICIAL_AUDIT = Object.freeze({
  schema: "sutra.data-transfer-official-audit.v1",
  source: Object.freeze({
    repository:
      "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
    manifestPath:
      "dashboards/data-transfer/DataTransfer-Cost-Analysis-Dashboard.yaml",
    manifestSha256:
      "85826c34fcd4f9f63599cdb257894eb4afa11bf014c903aad83427fc2704d698",
    dashboardId: "datatransfer-cost-analysis-dashboard",
    dashboardName: "DataTransfer Cost Analysis Dashboard Enhanced",
    category: "Additional",
    datasetIdentifier: "data_transfer_view",
    embeddedQueryPath: "views.data_transfer_view.data",
    embeddedQuerySha256:
      "37c210858303233c2f328cb5484f0031756dff5281696da97715edba5bd954f9",
    externalTemplateId: "data-transfer-aga-cost-analysis-template-enhanced-v6",
    externalTemplateSourceAccountId: "869004330191",
    externalTemplateRegion: "us-east-1",
  }),
  publishedArtifacts: Object.freeze({
    manifest: Object.freeze({ published: true, path: "dashboards/data-transfer/DataTransfer-Cost-Analysis-Dashboard.yaml", sha256: "85826c34fcd4f9f63599cdb257894eb4afa11bf014c903aad83427fc2704d698" }),
    query: Object.freeze({ published: true, path: "dashboards/data-transfer/DataTransfer-Cost-Analysis-Dashboard.yaml#views.data_transfer_view.data", sha256: "37c210858303233c2f328cb5484f0031756dff5281696da97715edba5bd954f9" }),
    quickSightDefinition: Object.freeze({ published: false, path: null, sha256: null }),
    templateBody: Object.freeze({ published: false, path: null, sha256: null }),
    changelog: Object.freeze({ published: false, path: null, sha256: null }),
  }),
  exactObjectTotals: Object.freeze({
    sheets: null,
    visuals: null,
    parameterControls: null,
    filterControls: null,
    parameterDeclarations: null,
    calculatedFields: null,
    filterGroups: null,
    datasets: null,
  }),
  documentedVisualPurposes: Object.freeze<readonly DataTransferDocumentedVisualPurpose[]>([
    Object.freeze({
      purpose: "Data Transfer Summary",
      coverage: "NATIVE_PURPOSE_COVERED",
      nativeEvidence: "Currency- and cost-basis-separated charged transfer summaries with classified, unknown, and unclassified coverage.",
      remainingGap: "The official QuickSight object count, chart type, fields, interactions, and layout are not public.",
    }),
    Object.freeze({
      purpose: "Internet data transfer and AWS Global Accelerator cost estimation details",
      coverage: "NATIVE_PURPOSE_COVERED",
      nativeEvidence: "Internet and Global Accelerator billed CUR2 categories, exact costs, byte evidence, provider dimensions, and resource drilldown.",
      remainingGap: "Global Accelerator remains billed historical evidence; no future price simulation or unpublished QuickSight object parity is claimed.",
    }),
    Object.freeze({
      purpose: "Regional data transfer details",
      coverage: "NATIVE_PURPOSE_COVERED",
      nativeEvidence: "Inter-Region classification with exact provider source/destination when present, account, service, Region, resource, cost, and byte evidence.",
      remainingGap: "Missing CUR2 endpoints remain missing and Region fields are never substituted as both traffic endpoints.",
    }),
    Object.freeze({
      purpose: "Data transfer Availability Zone details",
      coverage: "NATIVE_PURPOSE_COVERED",
      nativeEvidence: "Inter-AZ classification plus exact provider Region, Availability Zone, account, service, resource, cost, and unit evidence.",
      remainingGap: "Historical CUR2 generations without the newly retained provider fields require rematerialization.",
    }),
    Object.freeze({
      purpose: "CloudFront cost and usage analysis",
      coverage: "NATIVE_PURPOSE_COVERED",
      nativeEvidence: "CloudFront is distinguished by provider product code and usage type with exact cost, direction, location, and unit evidence.",
      remainingGap: "No CDN telemetry, request performance, future pricing, or unpublished QuickSight visual parity is claimed.",
    }),
  ]),
  documentedControlPurposes: Object.freeze([]),
  controlPurposeEvidence: "NOT_ENUMERATED_BY_GUIDANCE_OR_PUBLIC_ARTIFACT",
  publicDatasetFields: Object.freeze([
    "product_family", "product_servicecode", "product_servicename",
    "product_code", "usage_date", "billing_period", "payer_account_id",
    "linked_account_id", "product_name", "charge_type", "operation",
    "region", "usage_type", "from_location", "to_location",
    "from_location_type", "resource_id", "tbs", "usage_quantity",
    "blended_cost", "unblended_cost", "public_cost", "blended_rate",
    "unblended_rate", "public_ondemand_rate", "data_transfer_type",
    "account_id", "account_name",
  ]),
  disclosures: Object.freeze([
    "The five AWS guidance bullets are documented purposes, not proof of five QuickSight visual objects.",
    "The manifest references an external QuickSight template ID and source account but publishes no definition or template body.",
    "No official control inventory is enumerated; native Sutra filters are not represented as exact QuickSight controls.",
    "CUR2 provider-field rematerialization, controlled provider reconciliation, two-tenant proof, release-SHA review, immutable image deployment, and production acceptance remain open.",
  ]),
} as const);

export type DataTransferOfficialAudit = typeof DATA_TRANSFER_OFFICIAL_AUDIT;

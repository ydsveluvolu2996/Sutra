/**
 * Frozen audit of the public AWS Trends Dashboard artifacts. The upstream
 * QuickSight template is service-hosted, so object totals deliberately remain
 * unknown instead of being inferred from screenshots or marketing copy.
 */
export const FINOPS_TRENDS_OFFICIAL_DEFINITION = Object.freeze({
  schema: "sutra.finops-trends-official-definition.v1",
  source: Object.freeze({
    repository:
      "aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
    dashboardId: "trends-dashboard",
    templateId: "cudos-trends-dashboard-template",
    category: "Additional",
    latestDocumentedVersion: "v5.1.0",
    manifestMinimumTemplateVersion: 1,
    manifestMinimumTemplateDescription: "v5.0.0",
    documentationUrl:
      "https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/trends-dashboard.html",
    featureArticleUrl:
      "https://aws.amazon.com/blogs/aws-cloud-financial-management/trends-dashboard-with-aws-cost-and-usage-reports-amazon-athena-and-amazon-quicksight/",
  }),
  artifacts: Object.freeze([
    Object.freeze({
      kind: "RESOURCE_MANIFEST",
      path: "cid/builtin/core/data/resources.yaml",
      sha256:
        "41ad438cea2a297f62976689e77eee8fda371913a6af53c946fb615bdccb5b71",
    }),
    Object.freeze({
      kind: "CHANGELOG",
      path: "changes/CHANGELOG-trends.md",
      sha256:
        "7ce940a15cdd50957df18f0a362484a04e9be44f665aefede779c87401f7365e",
    }),
    Object.freeze({
      kind: "DEPLOYMENT_TEMPLATE",
      path: "cfn-templates/cid-plugin.yml",
      sha256:
        "b96a47e6b53418293ec7127d0a95f96f2ffdae2781cde2b2dffcabad926a713d",
    }),
    Object.freeze({
      kind: "ATHENA_QUERY",
      path: "cid/builtin/core/data/queries/trends/daily_anomaly_detection.sql",
      sha256:
        "a17a40f084dfebbf14c146bfc466282f78a14607c5898a19a53b320c13e9901b",
    }),
    Object.freeze({
      kind: "ATHENA_QUERY",
      path: "cid/builtin/core/data/queries/trends/monthly_anomaly_detection.sql",
      sha256:
        "e21fce72e791f95d9e7d4a01952367ed41b27391069a082fc51d19e85e96dfa2",
    }),
    Object.freeze({
      kind: "ATHENA_QUERY",
      path: "cid/builtin/core/data/queries/trends/monthly_bill_by_account.sql",
      sha256:
        "30916d149b3d7d06f8ef9cedbb281cd71e3c14e8d0f41d5f0232abd0019c6fe1",
    }),
    Object.freeze({
      kind: "SPICE_DATASET_DEFINITION",
      path: "cid/builtin/core/data/datasets/trends/daily_anomaly_detection.json",
      sha256:
        "bf9d4e26a4d2fb13f9f6dc05c9f5b38e4853d20733c4fce5370f856cf43aafc5",
    }),
    Object.freeze({
      kind: "SPICE_DATASET_DEFINITION",
      path: "cid/builtin/core/data/datasets/trends/monthly_anomaly_detection.json",
      sha256:
        "705bafb2b8c2abe7d217addc454b026d1c573e85f9d10658c6811aa9711fccb4",
    }),
    Object.freeze({
      kind: "SPICE_DATASET_DEFINITION",
      path: "cid/builtin/core/data/datasets/trends/monthly_bill_by_account.json",
      sha256:
        "f33c76de9e8c12d12129d0491dcf5cb1e326db666ea35b177f81622e5e093739",
    }),
  ]),
  quickSightDefinition: Object.freeze({
    publishedInRepository: false,
    serviceHostedTemplate: true,
    sheetCount: null,
    visualCount: null,
    filterControlCount: null,
    parameterControlCount: null,
    parameterCount: null,
    calculatedFieldCount: null,
    pixelParityClaimed: false,
    reason: "QUICKSIGHT_DEFINITION_NOT_PUBLISHED_AT_PINNED_COMMIT",
  }),
  prerequisites: Object.freeze([
    "At least one Foundational Dashboard: CUDOS, Cost Intelligence, or KPI Dashboard.",
    "Foundational Dashboards CloudFormation version v4.0.0 or later for CloudFormation deployment.",
  ]),
  documentedControls: Object.freeze([
    "Date range",
    "As of Date",
    "PayerAccountId",
    "UsageAccountId",
    "AWS service",
    "charge type",
    "Cost basis: Unblended or Amortized",
  ]),
  controlsNotExhaustivelyEnumeratedByAws: true,
  documentedFeatureAreas: Object.freeze([
    Object.freeze({
      name: "Periodic trends and actuals",
      purpose: "Yearly, monthly and quarterly trends with monthly actuals.",
      nativeCoverage: "SUPPORTED",
      evidence: "Exact monthly actuals and selectable monthly, quarterly and yearly rolling comparisons.",
      gap: null,
    }),
    Object.freeze({
      name: "ML-powered forecast",
      purpose: "QuickSight forecast from historic usage patterns.",
      nativeCoverage: "UNAVAILABLE",
      evidence: "A separately labelled deterministic Sutra estimate is available when evidence is sufficient.",
      gap: "AWS_QUICKSIGHT_ML_FORECAST_EVIDENCE_NOT_INGESTED",
    }),
    Object.freeze({
      name: "Service category and service usage trends",
      purpose: "Expandable category-to-service trends and actual usage.",
      nativeCoverage: "PARTIAL",
      evidence: "CUR2 service taxonomy costs and unit-isolated metered usage are native.",
      gap: "Exact upstream expand/collapse hierarchy and same-sheet cascade behavior are not claimed.",
    }),
    Object.freeze({
      name: "Three-month service percentage change",
      purpose: "Snapshot of service usage change during the latest three months.",
      nativeCoverage: "PARTIAL",
      evidence: "Exact service cost movement and selectable rolling comparison are native.",
      gap: "Usage percentage is unavailable when comparable metered units are incomplete.",
    }),
    Object.freeze({
      name: "AWS account trends",
      purpose: "Payer and usage-account trends with friendly account names.",
      nativeCoverage: "PARTIAL",
      evidence: "Payer/usage roles and non-conflicting CUR2 account-name fields are shown.",
      gap: "AWS_ORGANIZATIONS_API_EVIDENCE_NOT_INGESTED",
    }),
    Object.freeze({
      name: "Filter controls and one-click filtering",
      purpose: "Date, account, service, charge-type and cost-basis filtering with same-sheet interactions.",
      nativeCoverage: "PARTIAL",
      evidence: "Date window, cost basis, currency and month/contributor interactions are native.",
      gap: "Not every documented QuickSight field control is exposed as a native selector.",
    }),
    Object.freeze({
      name: "Global usage map",
      purpose: "Geospatial AWS usage and Region drilldown, excluding AWS China Regions.",
      nativeCoverage: "UNAVAILABLE",
      evidence: "A Region cost and unit-separated usage table is native.",
      gap: "AUTHORITATIVE_REGION_COORDINATES_NOT_INGESTED",
    }),
    Object.freeze({
      name: "Threshold alerts and scheduled delivery",
      purpose: "QuickSight threshold alerts and scheduled dashboard reports.",
      nativeCoverage: "UNAVAILABLE",
      evidence: "Tenant-scoped Sutra alerts and scheduled reports are shown separately.",
      gap: "AWS_QUICKSIGHT_AUTOMATION_EVIDENCE_NOT_INGESTED",
    }),
    Object.freeze({
      name: "AWS Usage v5.1 additions",
      purpose: "Spend by Calendar Period and payer-plus-usage-account pivot.",
      nativeCoverage: "PARTIAL",
      evidence: "Calendar-period spend and explicit payer/usage account evidence are native.",
      gap: "The unpublished upstream pivot layout is not reproduced or claimed.",
    }),
  ]),
  datasets: Object.freeze([
    Object.freeze({
      id: "daily-anomaly-detection",
      view: "daily_anomaly_detection",
      importMode: "SPICE",
      inputColumnCount: 6,
      documentedWindow: "latest 110 days",
    }),
    Object.freeze({
      id: "monthly-anomaly-detection",
      view: "monthly_anomaly_detection",
      importMode: "SPICE",
      inputColumnCount: 6,
      documentedWindow: "latest 20 months",
    }),
    Object.freeze({
      id: "monthly-bill-by-account",
      view: "monthly_bill_by_account",
      importMode: "SPICE",
      inputColumnCount: 14,
      documentedWindow: "all available monthly billing periods",
    }),
  ]),
} as const);

export type FinopsTrendsOfficialDefinition =
  typeof FINOPS_TRENDS_OFFICIAL_DEFINITION;

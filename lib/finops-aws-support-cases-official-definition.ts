/** Immutable public-source audit for the AWS Support Cases Radar dashboard. */
export const AWS_SUPPORT_CASES_OFFICIAL_DEFINITION = Object.freeze({
  source: Object.freeze({
    repository:
      "aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
    manifest: Object.freeze({
      path: "dashboards/support-cases-radar/support-cases-radar.yaml",
      sha256:
        "4d9970206b4c927bb1d0cf1afd4e2a732370472f1b2f54c2681c13d71131e8fa",
    }),
    changelog: Object.freeze({
      path: "changes/CHANGELOG-support-cases-radar.md",
      sha256:
        "385bc28ba04f119c41ada8a3490c2a753abc6f79e3b9a6331213a8c59ea7969c",
    }),
    preview: Object.freeze({
      path: "https://docs.aws.amazon.com/images/guidance/latest/cloud-intelligence-dashboards/images/support_cases_radar_dashboard.png",
      sha256:
        "3702251ed48abe49e529ea5fc12ce3e44a3fce570043f44797a95b94b855852a",
    }),
    dashboardId: "support-cases-radar",
    templateId: "support-cases-radar",
    theme: "MIDNIGHT",
  }),
  quickSightDefinition: Object.freeze({
    state: "NOT_PUBLICLY_COMMITTED",
    exactSheetCount: null,
    exactVisualCount: null,
    exactFilterControlCount: null,
    exactParameterControlCount: null,
    disclosure:
      "The public manifest references a managed QuickSight template ID but does not commit its definition. Exact object counts are not inferred from the preview.",
  }),
  documentedTabs: Object.freeze(["Cases Summary", "Contact Summary", "About"]),
  documentedPreviewPurposes: Object.freeze([
    "Cases by Service",
    "Cases by Account",
    "Cases by severity or selected group",
    "Cases by Creation Time",
    "Data Collected",
  ]),
  documentedPreviewControls: Object.freeze([
    "Management Account",
    "Account ID",
    "Account Name",
    "Severity",
    "Case Created",
    "Status",
    "Service",
    "Group By",
  ]),
  publishedDatasets: Object.freeze([
    Object.freeze({
      name: "support_cases_status_view",
      physicalTables: 1,
      inputColumnOccurrences: 3,
      uniqueInputColumns: 3,
      safePurpose: "Collection freshness by payer and account",
    }),
    Object.freeze({
      name: "support_cases_communications_view",
      physicalTables: 2,
      inputColumnOccurrences: 36,
      uniqueInputColumns: 35,
      safePurpose:
        "Case, status, severity, service, category, timing and communication-transition evidence",
    }),
  ]),
  privacyBoundary: Object.freeze({
    browserSafe: Object.freeze([
      "Masked case reference",
      "Account ID",
      "Status",
      "Severity",
      "Service and category codes",
      "Created and updated timestamps",
      "Communication and attachment counts",
    ]),
    intentionallyExcluded: Object.freeze([
      "Subject",
      "Communication body",
      "Submitter names and email addresses",
      "CC email addresses",
      "Case URL",
      "Raw provider case IDs",
      "Generative summary fields",
    ]),
  }),
  documentedSemantics: Object.freeze({
    collection: "Daily changed-case collection",
    refresh: "Nightly dashboard refresh",
    scope: "Linked accounts and multiple AWS organizations",
    optionalFeature: "Generative AI case summarization plugin",
  }),
} as const);

export type AwsSupportCasesOfficialDefinition =
  typeof AWS_SUPPORT_CASES_OFFICIAL_DEFINITION;

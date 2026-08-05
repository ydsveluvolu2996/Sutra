/**
 * Audited inventory of the pinned AWS CID EUC QuickSight definition.
 * Counts and names come from the immutable upstream artifact, not the live UI.
 */
export const END_USER_COMPUTING_OFFICIAL_DEFINITION = Object.freeze({
  schemaVersion: "sutra.euc-official-definition-audit.v1",
  repository: "aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
  commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
  path: "dashboards/euc/euc-dashboard.yaml",
  sourceUrl: "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/euc/euc-dashboard.yaml",
  artifactSha256: "1342648480b1c839c5f71e8c700c84cdc5525d3f0b74ceaf74aa0c2ec3c85af1",
  dashboardVersion: "v1.2.0",
  sheetCount: 7,
  visualCount: 82,
  controlCount: 24,
  sheets: Object.freeze([
    Object.freeze({ name: "Summary", visualCount: 28, controlCount: 5, localArea: "Service and cost summary", coverage: "EVIDENCE_BACKED" }),
    Object.freeze({ name: "WorkSpaces Desktop Insights", visualCount: 11, controlCount: 6, localArea: "WorkSpaces insights", coverage: "EVIDENCE_BACKED" }),
    Object.freeze({ name: "WorkSpaces Desktop Usage", visualCount: 9, controlCount: 5, localArea: "WorkSpaces usage and logons", coverage: "PRIVACY_LIMITED" }),
    Object.freeze({ name: "WorkSpaces Desktops Metrics", visualCount: 7, controlCount: 2, localArea: "Optional CloudWatch performance", coverage: "EVIDENCE_BACKED" }),
    Object.freeze({ name: "WorkSpaces Applications Summary", visualCount: 19, controlCount: 6, localArea: "WorkSpaces Applications summary", coverage: "EVIDENCE_BACKED" }),
    Object.freeze({ name: "EUC Cost Optimization", visualCount: 8, controlCount: 0, localArea: "Cost-optimization review candidates", coverage: "SIGNALS_ONLY" }),
    Object.freeze({ name: "About", visualCount: 0, controlCount: 0, localArea: "Evidence and limitations", coverage: "CONTEXTUAL_EQUIVALENT" }),
  ]),
} as const);

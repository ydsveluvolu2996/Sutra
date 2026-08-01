/** Immutable audit of the pinned AWS CID Sustainability QuickSight definition. */
export const SUSTAINABILITY_OFFICIAL_DEFINITION = Object.freeze({
  schemaVersion: "sutra.sustainability-official-definition-audit.v1",
  commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
  path: "dashboards/sustainability-proxy-metrics/sustainability-proxy-metrics.yaml",
  sourceUrl: "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/sustainability-proxy-metrics/sustainability-proxy-metrics.yaml",
  artifactSha256: "dff730465da14a7278dfa722340026265d5a16ec0a824fb310cbd6c89004e269",
  sheetCount: 6,
  visualCount: 25,
  controlCount: 17,
  sheets: Object.freeze([
    Object.freeze({ name: "Regional Footprint", visualCount: 3, controlCount: 0, coverage: "SCHEMA_GAP", localArea: "Region-filtered resource proxies" }),
    Object.freeze({ name: "Compute Proxies", visualCount: 5, controlCount: 4, coverage: "PARTIAL", localArea: "Compute resource-use proxy trends" }),
    Object.freeze({ name: "Storage Proxies", visualCount: 4, controlCount: 4, coverage: "PARTIAL", localArea: "Storage resource-use proxy trends" }),
    Object.freeze({ name: "Data Transfer / Networking Proxies", visualCount: 4, controlCount: 4, coverage: "PARTIAL", localArea: "Data-transfer resource-use proxy trends" }),
    Object.freeze({ name: "Carbon Emissions", visualCount: 7, controlCount: 5, coverage: "EVIDENCE_BACKED", localArea: "Provider carbon trends and scopes" }),
    Object.freeze({ name: "About", visualCount: 2, controlCount: 0, coverage: "CONTEXTUAL_EQUIVALENT", localArea: "Provenance, separation and limitations" }),
  ]),
  unavailableDimensions: Object.freeze([
    "regional renewable-energy classification and map coordinates",
    "EC2 processor architecture and instance family",
    "EBS volume type and S3 storage class",
    "data-transfer path classification",
    "idle NAT Gateway and Elastic Load Balancer resource evidence",
    "server-owned business KPI denominators and targets",
  ]),
} as const);

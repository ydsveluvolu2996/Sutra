/** Immutable ADD-05 audit of the AWS Marketplace SPG definition and docs catalog. */
export const MARKETPLACE_SPG_OFFICIAL_DEFINITION = Object.freeze({
  source: Object.freeze({
    repository: "aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
    path: "dashboards/aws-marketplace/aws-marketplace-spg.yaml",
    sha256: "67aaab07865d8c5096379bd3baf962f92e2337762d365b75bbfb8cbc28276f5d",
    dashboardId: "aws-marketplace",
    templateId: "aws-marketplace",
    category: "Additional",
    theme: "MIDNIGHT",
    quickSightDefinitionEmbedded: false,
    quickSightControlInventory: "NOT_DISCLOSED_IN_IMMUTABLE_SOURCE",
    quickSightVisualObjectCount: null,
  }),
  documentationUrl:
    "https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/marketplace-dashboard.html",
  documentedTabCount: 5,
  documentedVisualAreaCount: 23,
  tabs: Object.freeze([
    Object.freeze({
      id: "spend-summary",
      label: "Spend Summary",
      areas: Object.freeze([
        Object.freeze({ name: "Cumulative Spend by Seller", support: "SUPPORTED" }),
        Object.freeze({ name: "Cumulative Spend by Product", support: "SUPPORTED" }),
        Object.freeze({ name: "Spend by Seller", support: "SUPPORTED" }),
        Object.freeze({ name: "Spend and Usage by Seller Product", support: "PARTIAL", limitation: "Spend and CUR2 row evidence are available; usage quantity and unit are not present in the minimized projection." }),
        Object.freeze({ name: "Marketplace Invoice Tracker", support: "SUPPORTED" }),
      ]),
    }),
    Object.freeze({
      id: "spend-deep-dive",
      label: "Spend Deep Dive",
      areas: Object.freeze([
        Object.freeze({ name: "Spend by Product", support: "SUPPORTED" }),
        Object.freeze({ name: "Spend by AWS Account ID", support: "SUPPORTED" }),
        Object.freeze({ name: "Spend Mapping by Seller", support: "SUPPORTED" }),
        Object.freeze({ name: "Spend Details by Invoice", support: "SUPPORTED" }),
      ]),
    }),
    Object.freeze({
      id: "bedrock-3p-foundational-model-spend",
      label: "Bedrock 3P Foundational Model Spend",
      areas: Object.freeze([
        Object.freeze({ name: "3P FM Spend by Seller", support: "UNAVAILABLE", limitation: "The approved evidence contract has no authoritative Bedrock third-party model classification." }),
        Object.freeze({ name: "Spend and Usage by FM Product", support: "UNAVAILABLE", limitation: "Product names and spend rows are not used to infer foundational-model classification or usage units." }),
      ]),
    }),
    Object.freeze({
      id: "granted-entitled-licenses",
      label: "Granted and Entitled Licenses",
      areas: Object.freeze([
        Object.freeze({ name: "Upcoming Contract Expirations", support: "SUPPORTED" }),
        Object.freeze({ name: "Org View of Licenses", support: "SUPPORTED" }),
        Object.freeze({ name: "License Summary by Product", support: "SUPPORTED" }),
        Object.freeze({ name: "License Grant and Sharing Details", support: "SUPPORTED" }),
        Object.freeze({ name: "Product mapping to License Grants", support: "SUPPORTED" }),
      ]),
    }),
    Object.freeze({
      id: "marketplace-agreements",
      label: "Marketplace Agreements",
      areas: Object.freeze([
        Object.freeze({ name: "Active Agreement Count by Deployment Status", support: "SUPPORTED" }),
        Object.freeze({ name: "Active Agreement Value by Deployment Status", support: "PARTIAL", limitation: "Known lifecycle commitment is shown separately and is never represented as realized spend." }),
        Object.freeze({ name: "Agreement Information", support: "SUPPORTED" }),
        Object.freeze({ name: "Active Agreement Acceptances", support: "SUPPORTED" }),
        Object.freeze({ name: "Agreement Charges by Month", support: "SUPPORTED" }),
        Object.freeze({ name: "Agreement Charge Details", support: "SUPPORTED" }),
        Object.freeze({ name: "Agreement Legal Terms", support: "PARTIAL", limitation: "Only legal document type is retained; document URLs and contents are deliberately excluded." }),
      ]),
    }),
  ]),
} as const);

export type MarketplaceSpgOfficialDefinition =
  typeof MARKETPLACE_SPG_OFFICIAL_DEFINITION;

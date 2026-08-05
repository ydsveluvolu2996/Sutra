"use client";

import type { ReactNode } from "react";
import type {
  FinopsDashboardCatalogEntry,
  FinopsSharedAnalysisSection,
} from "../../lib/finops-dashboard-catalog";
import { FinopsAmazonConnectCostInsightsDashboard } from "./finops-amazon-connect-cost-insights-dashboard";
import { FinopsAwsBudgetsOrganizationDashboard } from "./finops-aws-budgets-organization-dashboard";
import { FinopsAwsConfigResourceComplianceDashboard } from "./finops-aws-config-resource-compliance-dashboard";
import { FinopsAwsNewsFeedsDashboard } from "./finops-aws-news-feeds-dashboard";
import { FinopsAwsSupportCasesRadarDashboard } from "./finops-aws-support-cases-radar-dashboard";
import { FinopsAzureCloudIntelligenceDashboard } from "./finops-azure-cloud-intelligence-dashboard";
import { FinopsComputeOptimizerDashboard } from "./finops-compute-optimizer-dashboard";
import { FinopsCoraDashboard } from "./finops-cora-dashboard";
import { FinopsCostAnomalyDashboard } from "./finops-cost-anomaly-dashboard";
import { FinopsCostIntelligenceSheetsDashboard } from "./finops-cost-intelligence-sheets-dashboard";
import { FinopsCudosDashboard } from "./finops-cudos-dashboard";
import { FinopsDataTransferDashboard } from "./finops-data-transfer-dashboard";
import { FinopsKpiSheetsDashboard } from "./finops-kpi-sheets-dashboard";
import { FinopsTrendsDashboard } from "./finops-trends-dashboard";
import { FinopsDataCollectionMonitorDashboard } from "./finops-data-collection-monitor-dashboard";
import { FinopsEndUserComputingDashboard } from "./finops-end-user-computing-dashboard";
import { FinopsExtendedSupportProjectionDashboard } from "./finops-extended-support-projection-dashboard";
import { FinopsFocusDashboard } from "./finops-focus-dashboard";
import { FinopsGcpCloudIntelligenceDashboard } from "./finops-gcp-cloud-intelligence-dashboard";
import { FinopsGravitonSavingsDashboard } from "./finops-graviton-savings-dashboard";
import { FinopsHealthEventsDashboard } from "./finops-health-events-dashboard";
import { FinopsKubecostAllocationDashboard } from "./finops-kubecost-allocation-dashboard";
import { FinopsMarketplaceSpgDashboard } from "./finops-marketplace-spg-dashboard";
import { FinopsMediaServicesInsightsDashboard } from "./finops-media-services-insights-dashboard";
import { FinopsPricingChangeDashboard } from "./finops-pricing-change-dashboard";
import { FinopsResilienceVueDashboard } from "./finops-resilience-vue-dashboard";
import { FinopsScadAllocationDashboard } from "./finops-scad-allocation-dashboard";
import { FinopsSustainabilityCarbonDashboard } from "./finops-sustainability-carbon-dashboard";
import { FinopsTrustedAdvisorOrganizationalDashboard } from "./finops-trusted-advisor-organizational-dashboard";

/**
 * Everything a dedicated dashboard view may read. Views receive this one
 * context instead of bespoke prop lists so a new dashboard is registered by
 * adding a single entry below rather than by extending a conditional chain.
 */
export interface FinopsDashboardViewContext {
  readonly connectionId: string | null;
  readonly dashboard: FinopsDashboardCatalogEntry;
  readonly openSharedAnalysis: (section: FinopsSharedAnalysisSection) => void;
}

export type FinopsDashboardView = (context: FinopsDashboardViewContext) => ReactNode;

/**
 * Dedicated views keyed by catalog dashboard id. A dashboard with no entry here
 * is not missing from the catalog — it renders the shared capability shell,
 * which states its real evidence position instead of implying a finished view.
 */
const FINOPS_DASHBOARD_VIEWS: Readonly<Record<string, FinopsDashboardView>> = {
  // Foundational: presented as the sheets AWS publishes, driven by each
  // dashboard's hash-pinned official definition.
  cudos: ({ connectionId }) => (
    <FinopsCudosDashboard connectionId={connectionId} />
  ),
  cost_intelligence_dashboard: ({ connectionId }) => (
    <FinopsCostIntelligenceSheetsDashboard connectionId={connectionId} />
  ),
  kpi_dashboard: ({ connectionId }) => (
    <FinopsKpiSheetsDashboard connectionId={connectionId} />
  ),
  trusted_advisor_organizational: ({ connectionId, dashboard }) => (
    <FinopsTrustedAdvisorOrganizationalDashboard connectionId={connectionId} dashboard={dashboard} />
  ),
  cost_anomaly: ({ connectionId }) => (
    <FinopsCostAnomalyDashboard connectionId={connectionId} />
  ),
  trends: ({ connectionId }) => (
    <FinopsTrendsDashboard connectionId={connectionId} />
  ),
  data_transfer: ({ connectionId }) => (
    <FinopsDataTransferDashboard connectionId={connectionId} />
  ),
  compute_optimizer: ({ connectionId }) => (
    <FinopsComputeOptimizerDashboard connectionId={connectionId} />
  ),
  extended_support_projection: ({ connectionId, dashboard }) => (
    <FinopsExtendedSupportProjectionDashboard connectionId={connectionId} dashboard={dashboard} />
  ),
  graviton_savings: ({ connectionId }) => (
    <FinopsGravitonSavingsDashboard connectionId={connectionId} />
  ),
  health_events: ({ connectionId }) => (
    <FinopsHealthEventsDashboard connectionId={connectionId} />
  ),
  aws_news_feeds: ({ connectionId }) => (
    <FinopsAwsNewsFeedsDashboard connectionId={connectionId} />
  ),
  aws_budgets: ({ connectionId }) => (
    <FinopsAwsBudgetsOrganizationDashboard connectionId={connectionId} />
  ),
  support_cases_radar: ({ connectionId, dashboard }) => (
    <FinopsAwsSupportCasesRadarDashboard connectionId={connectionId} dashboard={dashboard} />
  ),
  resiliencevue: ({ connectionId }) => (
    <FinopsResilienceVueDashboard connectionId={connectionId} />
  ),
  end_user_computing: ({ connectionId }) => (
    <FinopsEndUserComputingDashboard connectionId={connectionId} />
  ),
  data_collection_monitor: ({ connectionId }) => (
    <FinopsDataCollectionMonitorDashboard connectionId={connectionId} />
  ),
  media_services_insights: ({ connectionId }) => (
    <FinopsMediaServicesInsightsDashboard connectionId={connectionId} />
  ),
  cora: ({ connectionId }) => (
    <FinopsCoraDashboard connectionId={connectionId} />
  ),
  // Azure billing delivery is a separate provider connection, never an AWS
  // trust role, so no AWS connection id is threaded into this view.
  azure_cid: ({ dashboard }) => (
    <FinopsAzureCloudIntelligenceDashboard sourceId={null} dashboard={dashboard} />
  ),
  gcp_cid: () => <FinopsGcpCloudIntelligenceDashboard />,
  focus: ({ connectionId, dashboard, openSharedAnalysis }) => (
    <FinopsFocusDashboard
      connectionId={connectionId}
      dashboard={dashboard}
      onOpenSharedAnalysis={() => openSharedAnalysis("explorer")}
    />
  ),
  marketplace_spg: ({ connectionId, dashboard }) => (
    <FinopsMarketplaceSpgDashboard connectionId={connectionId} dashboard={dashboard} />
  ),
  kubecost_container_allocation: ({ connectionId }) => (
    <FinopsKubecostAllocationDashboard connectionId={connectionId} />
  ),
  scad_container_allocation: ({ connectionId }) => (
    <FinopsScadAllocationDashboard connectionId={connectionId} />
  ),
  sustainability_proxy: ({ connectionId }) => (
    <FinopsSustainabilityCarbonDashboard connectionId={connectionId} />
  ),
  amazon_connect_cost_insights: ({ connectionId, dashboard }) => (
    <FinopsAmazonConnectCostInsightsDashboard connectionId={connectionId} dashboard={dashboard} />
  ),
  config_resource_compliance: ({ connectionId, dashboard }) => (
    <FinopsAwsConfigResourceComplianceDashboard connectionId={connectionId} dashboard={dashboard} />
  ),
  pricing_change: ({ connectionId, dashboard, openSharedAnalysis }) => (
    <FinopsPricingChangeDashboard
      connectionId={connectionId}
      dashboard={dashboard}
      onOpenSharedAnalysis={() => openSharedAnalysis("explorer")}
    />
  ),
};

/** Ids that have a dedicated view, for coverage assertions and tests. */
export const FINOPS_DASHBOARD_VIEW_IDS: readonly string[] =
  Object.freeze(Object.keys(FINOPS_DASHBOARD_VIEWS));

/**
 * Resolve a dedicated view. Own-property lookup only, so an inherited member
 * name can never be mistaken for a registered dashboard view.
 */
export function getFinopsDashboardView(id: string): FinopsDashboardView | null {
  return Object.hasOwn(FINOPS_DASHBOARD_VIEWS, id) ? FINOPS_DASHBOARD_VIEWS[id] ?? null : null;
}

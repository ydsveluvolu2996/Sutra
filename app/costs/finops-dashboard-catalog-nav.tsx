"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FINOPS_DASHBOARD_CATALOG,
  getFinopsDashboardCatalogEntry,
  listFinopsDashboardsByLevel,
  type FinopsDashboardCatalogEntry,
  type FinopsDashboardLevel,
  type FinopsSharedAnalysisSection,
} from "../../lib/finops-dashboard-catalog";
import { FinopsCapabilityShell, type FinopsCapabilityViewState } from "./finops-capability-shell";
import { FinopsAwsConfigResourceComplianceDashboard } from "./finops-aws-config-resource-compliance-dashboard";
import { FinopsAwsBudgetsOrganizationDashboard } from "./finops-aws-budgets-organization-dashboard";
import { FinopsAwsNewsFeedsDashboard } from "./finops-aws-news-feeds-dashboard";
import { FinopsAwsSupportCasesRadarDashboard } from "./finops-aws-support-cases-radar-dashboard";
import { FinopsAmazonConnectCostInsightsDashboard } from "./finops-amazon-connect-cost-insights-dashboard";
import { FinopsAzureCloudIntelligenceDashboard } from "./finops-azure-cloud-intelligence-dashboard";
import { FinopsComputeOptimizerDashboard } from "./finops-compute-optimizer-dashboard";
import { FinopsDataCollectionMonitorDashboard } from "./finops-data-collection-monitor-dashboard";
import { FinopsEndUserComputingDashboard } from "./finops-end-user-computing-dashboard";
import { FinopsExtendedSupportProjectionDashboard } from "./finops-extended-support-projection-dashboard";
import { FinopsCoraDashboard } from "./finops-cora-dashboard";
import { FinopsFocusDashboard } from "./finops-focus-dashboard";
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
import styles from "./costs.module.css";

interface FinopsDashboardCatalogNavProps {
  readonly connectionId: string | null;
  readonly onOpenSharedAnalysis: (section: FinopsSharedAnalysisSection) => void;
}

const LEVELS: readonly FinopsDashboardLevel[] = [
  "foundational",
  "advanced",
  "additional",
];

const LEVEL_LABELS: Readonly<Record<FinopsDashboardLevel, string>> = {
  foundational: "Foundational",
  advanced: "Advanced",
  additional: "Additional",
};

const MATURITY_LABELS = {
  LOCAL_VERTICAL_CANDIDATE: "Local candidate",
  PARTIAL_PIPELINE: "Partial pipeline",
  ENGINE_ONLY: "Engine only",
  ABSENT: "Absent",
  LOCAL_VERTICAL_VERIFIED: "Local verified",
  LIVE_ACCEPTED: "Live accepted",
} as const;

function shellState(dashboard: FinopsDashboardCatalogEntry): {
  readonly state: FinopsCapabilityViewState;
  readonly title: string;
  readonly detail: string;
} {
  if (dashboard.currentMaturity === "LOCAL_VERTICAL_CANDIDATE") {
    return {
      state: "partial",
      title: "Related local capability exists; catalog parity is not yet proven",
      detail: "Open the related shared analysis to inspect current evidence. Sutra does not label this official dashboard complete until its full provider, persistence, API, visual, and acceptance contract is verified.",
    };
  }
  if (dashboard.currentMaturity === "PARTIAL_PIPELINE") {
    return {
      state: "partial",
      title: "Only part of the delivery pipeline exists",
      detail: "Available ingestion or persistence is not presented as a finished dashboard. Missing layers remain explicit until end-to-end evidence exists.",
    };
  }
  if (dashboard.currentMaturity === "ABSENT") {
    return {
      state: "not_implemented",
      title: `${dashboard.provider.toUpperCase()} provider connector is not implemented`,
      detail: "An AWS trust-role connection cannot prove this provider’s billing data is configured. Sutra will not substitute AWS data, fixtures, or sample multicloud spend.",
    };
  }
  return {
    state: "not_implemented",
    title: "The domain engine is not an end-to-end dashboard",
    detail: "Collector, tenant-scoped persistence, authenticated API, or visual delivery is still missing. Engine output alone is never labelled ready.",
  };
}

function dashboardFromHash(): FinopsDashboardCatalogEntry | null {
  if (typeof window === "undefined") return null;
  const match = /^#finops-dashboard-(.+)$/u.exec(window.location.hash);
  return match === null ? null : getFinopsDashboardCatalogEntry(match[1] ?? "");
}

export function FinopsDashboardCatalogNav({
  connectionId,
  onOpenSharedAnalysis,
}: FinopsDashboardCatalogNavProps) {
  const [selectedId, setSelectedId] = useState<string>(FINOPS_DASHBOARD_CATALOG[0].id);
  const selected = useMemo(
    () => getFinopsDashboardCatalogEntry(selectedId) ?? FINOPS_DASHBOARD_CATALOG[0],
    [selectedId],
  );
  const selectedState = shellState(selected);

  const select = useCallback((dashboard: FinopsDashboardCatalogEntry) => {
    setSelectedId(dashboard.id);
    if (typeof window !== "undefined") {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#finops-dashboard-${dashboard.slug}`,
      );
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncFromHash = () => {
      const requested = dashboardFromHash();
      if (requested !== null) setSelectedId(requested.id);
    };
    window.addEventListener("hashchange", syncFromHash);
    const frame = window.requestAnimationFrame(syncFromHash);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", syncFromHash);
    };
  }, []);

  return (
    <section className={styles.dashboardCatalog} id="finops-dashboard-catalog" aria-labelledby="finops-dashboard-catalog-heading">
      <header className={styles.dashboardCatalogHeading}>
        <div>
          <p className="eyebrow">Official AWS Cloud Intelligence catalog</p>
          <h2 id="finops-dashboard-catalog-heading">29 evidence-tracked dashboards</h2>
          <p>Browse every Foundational, Advanced, and Additional dashboard. Maturity describes local delivery only; no entry is presented as production accepted.</p>
        </div>
        <span>{FINOPS_DASHBOARD_CATALOG.length} catalog entries</span>
      </header>

      <div className={styles.dashboardCatalogLayout}>
        <nav className={styles.dashboardCatalogNav} aria-label="Cloud Intelligence dashboards">
          {LEVELS.map((level) => {
            const dashboards = listFinopsDashboardsByLevel(level);
            return (
              <section key={level} aria-labelledby={`finops-dashboard-level-${level}`}>
                <header>
                  <h3 id={`finops-dashboard-level-${level}`}>{LEVEL_LABELS[level]}</h3>
                  <span>{dashboards.length}</span>
                </header>
                <div>
                  {dashboards.map((dashboard) => (
                    <button
                      aria-current={selected.id === dashboard.id ? "page" : undefined}
                      className={selected.id === dashboard.id ? styles.dashboardCatalogNavActive : undefined}
                      data-maturity={dashboard.currentMaturity.toLowerCase()}
                      key={dashboard.id}
                      onClick={() => select(dashboard)}
                      type="button"
                    >
                      <span><strong>{dashboard.shortName}</strong><small>{dashboard.provider}</small></span>
                      <i>{MATURITY_LABELS[dashboard.currentMaturity]}</i>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </nav>

        <div className={styles.dashboardCatalogDetail}>
          {selected.id === "focus" ? (
            <FinopsFocusDashboard
              connectionId={connectionId}
              dashboard={selected}
              onOpenSharedAnalysis={() => onOpenSharedAnalysis("explorer")}
            />
          ) : selected.id === "trusted_advisor_organizational" ? (
            <FinopsTrustedAdvisorOrganizationalDashboard
              connectionId={connectionId}
              dashboard={selected}
            />
          ) : selected.id === "compute_optimizer" ? (
            <FinopsComputeOptimizerDashboard connectionId={connectionId} />
          ) : selected.id === "extended_support_projection" ? (
            <FinopsExtendedSupportProjectionDashboard
              connectionId={connectionId}
              dashboard={selected}
            />
          ) : selected.id === "graviton_savings" ? (
            <FinopsGravitonSavingsDashboard connectionId={connectionId} />
          ) : selected.id === "health_events" ? (
            <FinopsHealthEventsDashboard connectionId={connectionId} />
          ) : selected.id === "data_collection_monitor" ? (
            <FinopsDataCollectionMonitorDashboard connectionId={connectionId} />
          ) : selected.id === "azure_cid" ? (
            <FinopsAzureCloudIntelligenceDashboard
              sourceId={null}
              dashboard={selected}
            />
          ) : selected.id === "cora" ? (
            <FinopsCoraDashboard connectionId={connectionId} />
          ) : selected.id === "config_resource_compliance" ? (
            <FinopsAwsConfigResourceComplianceDashboard
              connectionId={connectionId}
              dashboard={selected}
            />
          ) : selected.id === "pricing_change" ? (
            <FinopsPricingChangeDashboard
              connectionId={connectionId}
              dashboard={selected}
              onOpenSharedAnalysis={() => onOpenSharedAnalysis("explorer")}
            />
          ) : selected.id === "aws_news_feeds" ? (
            <FinopsAwsNewsFeedsDashboard connectionId={connectionId} />
          ) : selected.id === "aws_budgets" ? (
            <FinopsAwsBudgetsOrganizationDashboard connectionId={connectionId} />
          ) : selected.id === "support_cases_radar" ? (
            <FinopsAwsSupportCasesRadarDashboard
              connectionId={connectionId}
              dashboard={selected}
            />
          ) : selected.id === "resiliencevue" ? (
            <FinopsResilienceVueDashboard connectionId={connectionId} />
          ) : selected.id === "end_user_computing" ? (
            <FinopsEndUserComputingDashboard connectionId={connectionId} />
          ) : selected.id === "media_services_insights" ? (
            <FinopsMediaServicesInsightsDashboard connectionId={connectionId} />
          ) : selected.id === "marketplace_spg" ? (
            <FinopsMarketplaceSpgDashboard
              connectionId={connectionId}
              dashboard={selected}
            />
          ) : selected.id === "kubecost_container_allocation" ? (
            <FinopsKubecostAllocationDashboard connectionId={connectionId} />
          ) : selected.id === "scad_container_allocation" ? (
            <FinopsScadAllocationDashboard connectionId={connectionId} />
          ) : selected.id === "sustainability_proxy" ? (
            <FinopsSustainabilityCarbonDashboard connectionId={connectionId} />
          ) : selected.id === "amazon_connect_cost_insights" ? (
            <FinopsAmazonConnectCostInsightsDashboard
              connectionId={connectionId}
              dashboard={selected}
            />
          ) : (
            <FinopsCapabilityShell
              dashboard={selected}
              state={selectedState.state}
              stateTitle={selectedState.title}
              stateDetail={selectedState.detail}
              actions={(
                <>
                  {selected.relatedSharedAnalysis === null ? null : (
                    <button
                      aria-controls={`finops-${selected.relatedSharedAnalysis}`}
                      className="button button-secondary"
                      onClick={() => onOpenSharedAnalysis(selected.relatedSharedAnalysis as FinopsSharedAnalysisSection)}
                      type="button"
                    >
                      Open related shared analysis
                    </button>
                  )}
                  <a className="button button-secondary" href={selected.documentationUrl} rel="noreferrer" target="_blank">AWS guidance</a>
                </>
              )}
            />
          )}
          <section className={styles.dashboardAudience} aria-label={`${selected.name} target audience`}>
            <strong>Target audience</strong>
            <div>{selected.targetAudience.map((audience) => <span key={audience}>{audience}</span>)}</div>
          </section>
        </div>
      </div>
    </section>
  );
}

"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import type {
  FinopsDashboardCatalogEntry,
  FinopsSharedAnalysisSection,
} from "../../../../lib/finops-dashboard-catalog";
import { FinopsCapabilityShell, type FinopsCapabilityViewState } from "../../finops-capability-shell";
import { getFinopsDashboardView } from "../../finops-dashboard-views";
import { usePilotState } from "../../../components/use-pilot-state";
import { FINOPS_MATURITY_MEANING } from "../dashboard-catalog-presentation";
import styles from "../dashboards.module.css";

/**
 * Renders one dashboard on its own route.
 *
 * The AWS connection is resolved client-side from pilot state, exactly as the
 * in-page catalog browser does, so the route never accepts a connection
 * identifier from the URL. Tenant and customer scope stay server-derived in the
 * API layer; this component only forwards the connection the signed-in operator
 * already has.
 */
export function FinopsDashboardRouteView({
  dashboard,
}: {
  readonly dashboard: FinopsDashboardCatalogEntry;
}) {
  const { state, loading, error } = usePilotState();
  const connectionId = state?.connection?.id ?? null;
  const router = useRouter();
  const view = getFinopsDashboardView(dashboard.id);

  /**
   * Concern-based analysis lives on the workspace page. Deep-link into it rather
   * than duplicating those panels here, so there is one implementation of each.
   */
  // Client-side navigation, not a full document load: `window.location.href`
  // discarded the router state and re-fetched the whole app to move between two
  // pages of the same workspace. Next 16.3 lints for this directly.
  const openSharedAnalysis = useCallback((section: FinopsSharedAnalysisSection) => {
    router.push(`/costs#finops-${section}`);
  }, [router]);

  if (loading && connectionId === null && error === null) {
    return (
      <FinopsCapabilityShell
        dashboard={dashboard}
        state={"loading" satisfies FinopsCapabilityViewState}
        stateTitle="Resolving the AWS connection"
        stateDetail="Sutra is loading the signed-in workspace connection before requesting any evidence."
      />
    );
  }

  if (error !== null) {
    return (
      <FinopsCapabilityShell
        dashboard={dashboard}
        state={"failed" satisfies FinopsCapabilityViewState}
        stateTitle="The workspace connection could not be loaded"
        stateDetail={error}
      />
    );
  }

  if (view === null) {
    return (
      <FinopsCapabilityShell
        dashboard={dashboard}
        state={"partial" satisfies FinopsCapabilityViewState}
        stateTitle="This dashboard has no dedicated view yet"
        stateDetail={`${FINOPS_MATURITY_MEANING[dashboard.currentMaturity]} Related analysis is available in the FinOps workspace; Sutra does not present a placeholder as a finished dashboard.`}
        actions={(
          <>
            {dashboard.relatedSharedAnalysis === null ? null : (
              <a
                className="button button-secondary"
                href={`/costs#finops-${dashboard.relatedSharedAnalysis}`}
              >
                Open related shared analysis
              </a>
            )}
            <a
              className="button button-secondary"
              href={dashboard.documentationUrl}
              rel="noreferrer"
              target="_blank"
            >
              AWS guidance
            </a>
          </>
        )}
      />
    );
  }

  return (
    <div className={`${styles.page} dashboard-surface`}>
      {view({ connectionId, dashboard, openSharedAnalysis })}
    </div>
  );
}

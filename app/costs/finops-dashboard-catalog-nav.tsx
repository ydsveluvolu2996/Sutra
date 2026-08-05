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
import { getFinopsDashboardView } from "./finops-dashboard-views";
import { GlyphIcon } from "../components/nav-icon";
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
  const selectedView = useMemo(() => getFinopsDashboardView(selected.id), [selected.id]);

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
                      <span
                        aria-hidden="true"
                        className={`nav-glyph-chip ${styles.dashboardCatalogNavIcon}`}
                        data-tone={dashboard.tone}
                      >
                        <GlyphIcon name={dashboard.icon} />
                      </span>
                      <span className={styles.dashboardCatalogNavLabel}>
                        <strong>{dashboard.shortName}</strong>
                        <small>{dashboard.catalogId} · {dashboard.provider}</small>
                      </span>
                      <i>{MATURITY_LABELS[dashboard.currentMaturity]}</i>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </nav>

        <div className={styles.dashboardCatalogDetail}>
          {selectedView === null ? (
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
          ) : selectedView({
            connectionId,
            dashboard: selected,
            openSharedAnalysis: onOpenSharedAnalysis,
          })}
          <section className={styles.dashboardAudience} aria-label={`${selected.name} target audience`}>
            <strong>Target audience</strong>
            <div>{selected.targetAudience.map((audience) => <span key={audience}>{audience}</span>)}</div>
          </section>
        </div>
      </div>
    </section>
  );
}

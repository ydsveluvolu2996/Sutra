"use client";

import type { FinopsDashboardCatalogEntry } from "../../lib/finops-dashboard-catalog";
import { GlyphIcon } from "../components/nav-icon";
import styles from "./costs.module.css";

/**
 * The selected dashboard's identity: its catalog glyph, catalog id, name and
 * summary.
 *
 * This is rendered once by the catalog nav for every dashboard rather than by
 * each view, because a dashboard's identity does not depend on whether it has
 * a dedicated view yet. Before this existed only the nine views that wrap
 * themselves in `FinopsCapabilityShell` showed a heading at all, so selecting
 * any of the other eighteen replaced the detail pane with unlabelled content
 * and the icon the list had just shown disappeared on open.
 *
 * The heading owns `finops-dashboard-<slug>`, the id `FinopsCapabilityShell`
 * points its `aria-labelledby` at. The shell renders inside this component's
 * sibling subtree, and id references resolve document-wide, so the shell stays
 * correctly labelled without repeating the name.
 */
export function FinopsDashboardIdentity({
  dashboard,
}: {
  readonly dashboard: FinopsDashboardCatalogEntry;
}) {
  return (
    <header className={styles.dashboardIdentity}>
      <span
        aria-hidden="true"
        className={`nav-glyph-chip ${styles.dashboardIdentityIcon}`}
        data-tone={dashboard.tone}
      >
        <GlyphIcon name={dashboard.icon} size={22} />
      </span>
      <div className={styles.dashboardIdentityText}>
        <p className="eyebrow">
          {dashboard.catalogId} · {dashboard.level} · {dashboard.provider}
        </p>
        <h2 id={`finops-dashboard-${dashboard.slug}`}>{dashboard.name}</h2>
        <p>{dashboard.summary}</p>
      </div>
    </header>
  );
}

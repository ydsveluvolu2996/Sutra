import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "../../../components/app-shell";
import { GlyphIcon } from "../../../components/nav-icon";
import {
  FINOPS_DASHBOARD_CATALOG,
  getFinopsDashboardCatalogEntry,
  type FinopsDashboardCatalogEntry,
} from "../../../../lib/finops-dashboard-catalog";
import {
  FINOPS_DASHBOARD_LEVEL_LABEL,
  FINOPS_MATURITY_LABEL,
  FINOPS_MATURITY_MEANING,
} from "../dashboard-catalog-presentation";
import { FinopsDashboardRail } from "../finops-dashboard-rail";
import { FinopsDashboardRouteView } from "./finops-dashboard-route-view";
import styles from "../dashboards.module.css";

export const dynamic = "force-dynamic";

/**
 * Resolve a dashboard from the URL. Only a catalogued slug is accepted — an
 * unknown or crafted segment is a 404, never a partially rendered shell.
 * `getFinopsDashboardCatalogEntry` also matches on id, so the canonical slug is
 * checked explicitly to keep exactly one URL per dashboard.
 */
function dashboardForSlug(slug: string): FinopsDashboardCatalogEntry | null {
  const entry = getFinopsDashboardCatalogEntry(slug);
  return entry !== null && entry.slug === slug ? entry : null;
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ readonly slug: string }>;
}): Promise<Metadata> {
  const dashboard = dashboardForSlug((await params).slug);
  return {
    title: dashboard === null ? "Cloud Intelligence dashboards" : dashboard.name,
    description: dashboard?.summary,
  };
}

/** Pre-declare every catalogued slug so the route set is the catalog itself. */
export function generateStaticParams(): readonly { readonly slug: string }[] {
  return FINOPS_DASHBOARD_CATALOG.map((dashboard) => ({ slug: dashboard.slug }));
}

export default async function FinopsDashboardPage({
  params,
}: {
  readonly params: Promise<{ readonly slug: string }>;
}) {
  const dashboard = dashboardForSlug((await params).slug);
  if (dashboard === null) notFound();

  return (
    <AppShell active="costs">
      <div className={styles.detailLayout}>
        <FinopsDashboardRail activeSlug={dashboard.slug} />
        <div className={styles.page}>
          <header className={styles.detailHead}>
            <nav aria-label="Breadcrumb" className={styles.breadcrumb}>
              <Link href="/costs">AWS cost &amp; FinOps</Link>
              <span aria-hidden="true">/</span>
              <Link href="/costs/dashboards">Cloud Intelligence dashboards</Link>
              <span aria-hidden="true">/</span>
              <span>{FINOPS_DASHBOARD_LEVEL_LABEL[dashboard.level]}</span>
              <span aria-hidden="true">/</span>
              <strong aria-current="page">{dashboard.shortName}</strong>
            </nav>

            <div className={styles.detailTitle}>
              <span aria-hidden="true" className="nav-glyph-chip" data-tone={dashboard.tone}>
                <GlyphIcon name={dashboard.icon} size={20} />
              </span>
              <h1>{dashboard.name}</h1>
            </div>

            <div className={styles.detailBadges}>
              <span className={styles.cardId}>{dashboard.catalogId}</span>
              <span
                className={styles.maturity}
                data-maturity={dashboard.currentMaturity.toLowerCase()}
                title={FINOPS_MATURITY_MEANING[dashboard.currentMaturity]}
              >
                {FINOPS_MATURITY_LABEL[dashboard.currentMaturity]}
              </span>
              <span className={styles.provider}>{dashboard.provider}</span>
            </div>

            <p className={styles.detailSummary}>{dashboard.summary}</p>

            <div className={styles.audience}>
              <strong>Target audience</strong>
              {dashboard.targetAudience.map((audience) => <span key={audience}>{audience}</span>)}
            </div>

            <div className={styles.detailActions}>
              <a
                className="button button-secondary"
                href={dashboard.documentationUrl}
                rel="noreferrer"
                target="_blank"
              >
                AWS guidance
              </a>
              <Link className="button button-secondary" href="/costs#finops-dashboard-catalog">
                Full catalog browser
              </Link>
            </div>
          </header>

          <FinopsDashboardRouteView dashboard={dashboard} />
        </div>
      </div>
    </AppShell>
  );
}

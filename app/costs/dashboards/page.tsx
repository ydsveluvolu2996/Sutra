import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "../../components/app-shell";
import { GlyphIcon } from "../../components/nav-icon";
import { DonutChart, ShareBar } from "../../components/charts";
import { FINOPS_DASHBOARD_CATALOG } from "../../../lib/finops-dashboard-catalog";
import {
  FINOPS_MATURITY_LABEL,
  FINOPS_MATURITY_MEANING,
  finopsDashboardHref,
  groupFinopsDashboardsByLevel,
  maturityTone,
  tallyMaturity,
} from "./dashboard-catalog-presentation";
import styles from "./dashboards.module.css";

export const metadata: Metadata = { title: "Cloud Intelligence dashboards" };

const count = (value: number, noun: string) =>
  `${value} ${value === 1 ? noun : `${noun}s`}`;

/**
 * Index of the official AWS Cloud Intelligence Dashboards catalog.
 *
 * A server component: the catalog is static, typed data, so the whole page
 * renders without shipping a single byte of client JavaScript. The maturity
 * overview is derived from the catalog rather than from any collected evidence,
 * and is labelled as delivery maturity so it is never read as spend or health.
 */
export default function FinopsDashboardsIndexPage() {
  const groups = groupFinopsDashboardsByLevel();
  const overall = tallyMaturity(FINOPS_DASHBOARD_CATALOG);

  return (
    <AppShell active="costs">
      <div className={styles.page}>
        <header className={styles.pageHead}>
          <nav aria-label="Breadcrumb" className={styles.breadcrumb}>
            <Link href="/costs">AWS cost &amp; FinOps</Link>
            <span aria-hidden="true">/</span>
            <strong aria-current="page">Cloud Intelligence dashboards</strong>
          </nav>
          <h1>Cloud Intelligence dashboards</h1>
          <p>
            Every dashboard in the official AWS Cloud Intelligence catalog, grouped by the
            level AWS publishes it under. Each entry keeps its official identifier so it
            traces to its evidence record. Maturity describes local delivery only — no
            dashboard here is presented as production accepted.
          </p>
        </header>

        <section className={styles.overview} aria-labelledby="finops-catalog-maturity">
          <h2 className="sr-only" id="finops-catalog-maturity">
            Delivery maturity across the catalog
          </h2>
          <DonutChart
            ariaLabel={`Delivery maturity across ${FINOPS_DASHBOARD_CATALOG.length} catalogued dashboards`}
            centerLabel="Dashboards"
            centerValue={String(FINOPS_DASHBOARD_CATALOG.length)}
            formatValue={(value) => count(value, "dashboard")}
            size={186}
            slices={overall.map((tally) => ({
              id: tally.maturity,
              label: tally.label,
              value: tally.count,
              tone: maturityTone(tally.maturity),
            }))}
          />
          <div className={styles.overviewLevels}>
            {groups.map((group) => (
              <div className={styles.overviewLevel} key={group.level}>
                <div className={styles.overviewLevelHead}>
                  <strong>{group.label}</strong>
                  <span>{count(group.dashboards.length, "dashboard")}</span>
                </div>
                <ShareBar
                  ariaLabel={`${group.label} delivery maturity: ${group.tallies
                    .map((tally) => `${tally.count} ${tally.label.toLowerCase()}`)
                    .join(", ")}`}
                  formatValue={(value) => count(value, "dashboard")}
                  segments={group.tallies.map((tally) => ({
                    id: `${group.level}-${tally.maturity}`,
                    label: tally.label,
                    value: tally.count,
                    tone: maturityTone(tally.maturity),
                  }))}
                />
              </div>
            ))}
            <p className={styles.overviewNote}>
              {overall
                .map((tally) => `${tally.label}: ${FINOPS_MATURITY_MEANING[tally.maturity]}`)
                .join(" ")}
            </p>
          </div>
        </section>

        {groups.map((group) => (
          <section aria-labelledby={`finops-level-${group.level}`} className={styles.level} key={group.level}>
            <header className={styles.levelHead}>
              <div>
                <h2 id={`finops-level-${group.level}`}>{group.label}</h2>
                <p>{group.summary}</p>
              </div>
              <span className={styles.levelCount}>{count(group.dashboards.length, "dashboard")}</span>
            </header>
            <div className={styles.cards}>
              {group.dashboards.map((dashboard) => (
                <Link
                  className={styles.card}
                  href={finopsDashboardHref(dashboard.slug)}
                  key={dashboard.id}
                >
                  <span
                    aria-hidden="true"
                    className={`nav-glyph-chip ${styles.cardIcon}`}
                    data-tone={dashboard.tone}
                  >
                    <GlyphIcon name={dashboard.icon} size={19} />
                  </span>
                  <span className={styles.cardTitle}>
                    <strong>{dashboard.shortName}</strong>
                    <span className={styles.cardId}>{dashboard.catalogId}</span>
                  </span>
                  <p className={styles.cardSummary}>{dashboard.summary}</p>
                  <span className={styles.cardMeta}>
                    <span
                      className={styles.maturity}
                      data-maturity={dashboard.currentMaturity.toLowerCase()}
                      title={FINOPS_MATURITY_MEANING[dashboard.currentMaturity]}
                    >
                      {FINOPS_MATURITY_LABEL[dashboard.currentMaturity]}
                    </span>
                    <span className={styles.provider}>{dashboard.provider}</span>
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </AppShell>
  );
}

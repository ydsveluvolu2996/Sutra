import Link from "next/link";
import { GlyphIcon } from "../../components/nav-icon";
import { finopsDashboardHref, groupFinopsDashboardsByLevel } from "./dashboard-catalog-presentation";
import styles from "./dashboards.module.css";

/**
 * Level-grouped rail of every catalogued dashboard.
 *
 * A server component built from real `<Link>`s, so each dashboard is a
 * bookmarkable, shareable URL and the rail works with browser history, opening
 * in a new tab and keyboard navigation without any client JavaScript.
 */
export function FinopsDashboardRail({ activeSlug }: { readonly activeSlug: string }) {
  const groups = groupFinopsDashboardsByLevel();
  return (
    <nav aria-label="Cloud Intelligence dashboards" className={styles.rail}>
      {groups.map((group) => (
        <section key={group.level}>
          <h2 id={`rail-level-${group.level}`}>{group.label}</h2>
          <ul aria-labelledby={`rail-level-${group.level}`}>
            {group.dashboards.map((dashboard) => {
              const active = dashboard.slug === activeSlug;
              return (
                <li key={dashboard.id}>
                  <Link
                    aria-current={active ? "page" : undefined}
                    className={active ? `${styles.railLink} ${styles.railLinkActive}` : styles.railLink}
                    href={finopsDashboardHref(dashboard.slug)}
                  >
                    <span aria-hidden="true" className="nav-glyph-chip" data-tone={dashboard.tone}>
                      <GlyphIcon name={dashboard.icon} size={15} />
                    </span>
                    <span className={styles.railText}>
                      <strong>{dashboard.shortName}</strong>
                      <small>{dashboard.catalogId}</small>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}

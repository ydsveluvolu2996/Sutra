import { GlyphIcon } from "../components/nav-icon";
import {
  buildFinopsOnboardingCoverage,
  describeSourceReads,
  describeTransport,
  type FinopsOnboardingDashboardView,
  type FinopsOnboardingSourceView,
} from "./finops-onboarding-source-map";
import styles from "./finops-onboarding-sources.module.css";

/**
 * Onboarding-time answer to "what will this account actually feed?".
 *
 * A server component: every value is static, declared contract data, so this
 * ships no client JavaScript and the server-owned runtime registry never
 * reaches the browser. It is read-only and additive — it reads no connection,
 * and it renders no ExternalId, account ID, ARN or credential.
 */

function packChip(dashboard: FinopsOnboardingDashboardView) {
  if (dashboard.requiredPack === null) return null;
  const { version, accepted, deployedByOnboardingTemplate } = dashboard.requiredPack;
  return (
    <span
      className={styles.packChip}
      data-available={accepted ? "true" : "false"}
      title={!accepted
        ? "This permission pack is reserved and is not accepted by this build's collector."
        : deployedByOnboardingTemplate
          ? "The role template this screen deploys already grants this pack. Data still only appears once a delivery is observed."
          : "This permission pack exists in this build. The customer must still deploy it."}
    >
      Needs <code>{version}</code>
      {accepted ? "" : " · reserved"}
    </span>
  );
}

function SourceRow({ source }: { readonly source: FinopsOnboardingSourceView }) {
  const grant = source.grant;
  return (
    <li className={styles.sourceRow}>
      <div className={styles.sourceHead}>
        <strong>{source.name}</strong>
        <span className={styles.sourceKind}>{source.kind}</span>
        {source.adapterRegistered ? null : (
          <span className={styles.sourceFlag} data-tone="warn">Provider adapter not registered</span>
        )}
      </div>
      <p className={styles.sourceReads}>
        <span className={styles.sourceLabel}>Reads</span>
        {describeSourceReads(source)}
      </p>
      <p className={styles.sourceReads}>
        <span className={styles.sourceLabel}>Path</span>
        {describeTransport(source.transport)} · freshness target {source.freshnessSlaHours}h
      </p>
      <p className={styles.sourceReads}>
        <span className={styles.sourceLabel}>Permission</span>
        {grant.kind === "successor_pack" ? (
          <>
            Permission pack <code>{grant.pack.version}</code>
            {grant.contractId === null ? "" : <> · source contract <code>{grant.contractId}</code></>}
            {grant.note === undefined ? "" : ` — ${grant.note}`}
          </>
        ) : grant.kind === "reserved_pack" ? (
          <>
            Permission pack <code>{grant.pack.version}</code> is reserved for {grant.reservedFor} and
            is not accepted by this build&apos;s collector, so this source cannot be attested or
            collected yet.
          </>
        ) : (
          grant.reason
        )}
      </p>
    </li>
  );
}

function DashboardCard({ dashboard }: { readonly dashboard: FinopsOnboardingDashboardView }) {
  return (
    <article className={styles.card} data-state={dashboard.state}>
      <div className={styles.cardHead}>
        <span aria-hidden="true" className={`nav-glyph-chip ${styles.cardIcon}`} data-tone={dashboard.tone}>
          <GlyphIcon name={dashboard.icon} size={18} />
        </span>
        <div className={styles.cardTitle}>
          <strong>{dashboard.shortName}</strong>
          <span className={styles.cardId}>{dashboard.catalogId}</span>
        </div>
        {packChip(dashboard)}
      </div>

      <span className={styles.stateLabel} data-state={dashboard.state}>{dashboard.stateLabel}</span>

      {dashboard.requiredSources.length > 0 ? (
        <>
          <p className={styles.sectionLabel}>Required sources</p>
          <ul className={styles.sourceList}>
            {dashboard.requiredSources.map((source) => (
              <SourceRow key={source.sourceId} source={source} />
            ))}
          </ul>
        </>
      ) : null}

      {dashboard.supplementalSources.length > 0 ? (
        <p className={styles.supplemental}>
          <span className={styles.sourceLabel}>Supplemental</span>
          {dashboard.supplementalSources.map((source) => source.name).join(" · ")} — these add context
          and never make a missing required source look delivered.
        </p>
      ) : null}

      <p className={styles.sectionLabel}>Why it is not collecting yet</p>
      <ul className={styles.blockerList}>
        {dashboard.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
      </ul>
    </article>
  );
}

export function FinopsOnboardingSources() {
  const coverage = buildFinopsOnboardingCoverage();

  return (
    <section className={styles.wrap} aria-labelledby="onboard-finops-coverage-title">
      <header className={styles.head}>
        <div>
          <p className="eyebrow">What this account will feed</p>
          <h2 id="onboard-finops-coverage-title">FinOps dashboards and data sources</h2>
          <p className={styles.lede}>
            The official Cloud Intelligence Dashboards catalog, grouped by level, with the exact AWS
            reads and permission pack each source needs. This is the declared onboarding contract, not
            a health reading: nothing here is collecting until Sutra observes a real delivery, whether
            or not the permissions are already granted.
          </p>
        </div>
      </header>

      <div className="summary-band">
        <div>
          <small>AWS-backed dashboards</small>
          <strong>{coverage.summary.awsBackedDashboards}</strong>
          <span>{coverage.summary.notAwsBacked} catalog entries need a non-AWS provider</span>
        </div>
        <div>
          <small>Collecting from this role today</small>
          <strong>{coverage.summary.collectingNow}</strong>
          <span>onboarding proves trust; it delivers no FinOps export</span>
        </div>
        <div>
          <small>Granted, awaiting first delivery</small>
          <strong>{coverage.summary.awaitingFirstDelivery}</strong>
          <span>this role grants every read; no delivery observed yet</span>
        </div>
        <div>
          <small>Awaiting a pack upgrade</small>
          <strong>{coverage.summary.awaitingPackDeployment}</strong>
          <span>pack exists in this build and must be deployed</span>
        </div>
        <div>
          <small>Pack unavailable</small>
          <strong>{coverage.summary.packUnavailable}</strong>
          <span>reserved or unassigned permission pack</span>
        </div>
      </div>

      <div className={styles.contractNote} role="note">
        <strong>The role this screen deploys pins <code>{coverage.templatePackVersion}</code>.</strong>
        <span>
          That template grants the read-only source contracts declared up to and including that
          pack, so {coverage.summary.awaitingFirstDelivery} of the{" "}
          {coverage.summary.awsBackedDashboards} AWS-backed dashboards already have every permission
          they need — and none of them is collecting, because a granted permission is not an observed
          delivery. {coverage.summary.awaitingPackDeployment} still need a higher pack deployed and{" "}
          {coverage.summary.packUnavailable} need a pack this build does not accept. This
          build&apos;s collector accepts successor packs only through{" "}
          <code>{coverage.acceptedPackCeiling}</code>; anything above that is reserved and cannot be
          attested yet. {coverage.summary.customerAccountSources} of the declared sources read from the
          customer account; the rest are public feeds or Sutra&apos;s own persisted evidence.
        </span>
      </div>

      {coverage.levels.map((group) => (
        <section className={styles.level} key={group.level} aria-labelledby={`onboard-finops-${group.level}`}>
          <div className={styles.levelHead}>
            <h3 id={`onboard-finops-${group.level}`}>{group.label}</h3>
            <span className={styles.levelCount}>
              {group.dashboards.length} dashboard{group.dashboards.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className={styles.cards}>
            {group.dashboards.map((dashboard) => (
              <DashboardCard dashboard={dashboard} key={dashboard.catalogId} />
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}

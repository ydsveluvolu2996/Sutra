import type { ReactNode } from "react";
import type {
  FinopsDashboardCatalogEntry,
  FinopsDashboardMaturity,
} from "../../lib/finops-dashboard-catalog";
import styles from "./costs.module.css";

export type FinopsCapabilityViewState =
  | "loading"
  | "configuration_required"
  | "waiting"
  | "empty"
  | "partial"
  | "stale"
  | "failed"
  | "complete"
  | "not_implemented";

export interface FinopsCapabilityEvidence {
  readonly sourceLabel: string;
  readonly collectedAt: string | null;
  readonly dataThroughAt: string | null;
  readonly freshnessAgeHours: number | null;
  readonly freshnessSlaHours: number | null;
  readonly acceptedRecords: number | null;
  readonly rejectedRecords: number | null;
  readonly generationId: string | null;
  readonly contentSha256: string | null;
  readonly limitations: readonly string[];
}

interface FinopsCapabilityShellProps {
  readonly dashboard: FinopsDashboardCatalogEntry;
  readonly state: FinopsCapabilityViewState;
  readonly stateTitle: string;
  readonly stateDetail: string;
  readonly evidence?: FinopsCapabilityEvidence | null;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
}

const MATURITY_PRESENTATION: Readonly<Record<FinopsDashboardMaturity, {
  readonly label: string;
  readonly detail: string;
}>> = {
  LOCAL_VERTICAL_CANDIDATE: {
    label: "Local vertical candidate",
    detail: "Related local collector, persistence, API, and UI evidence exists, but full catalog parity and production acceptance remain unproven.",
  },
  PARTIAL_PIPELINE: {
    label: "Partial pipeline",
    detail: "Some authoritative ingestion or persistence exists; the end-to-end dashboard slice is incomplete.",
  },
  ENGINE_ONLY: {
    label: "Engine only",
    detail: "A bounded domain engine exists, but collector, persistence, API, or visual delivery remains incomplete.",
  },
  ABSENT: {
    label: "Absent",
    detail: "No provider-specific end-to-end capability is implemented in Sutra yet.",
  },
  LOCAL_VERTICAL_VERIFIED: {
    label: "Local vertical verified",
    detail: "The end-to-end local capability and exact-tree verification gates passed; controlled provider and deployment acceptance remain separate.",
  },
  LIVE_ACCEPTED: {
    label: "Live accepted",
    detail: "The exact deployed digest passed controlled provider, tenant-isolation, rollback, and post-deploy acceptance gates.",
  },
};

const STATE_LABELS: Readonly<Record<FinopsCapabilityViewState, string>> = {
  loading: "Loading evidence",
  configuration_required: "Configuration required",
  waiting: "Waiting for delivery",
  empty: "Complete delivery · no matching records",
  partial: "Partial capability",
  stale: "Stale evidence",
  failed: "Latest attempt failed",
  complete: "Complete evidence",
  not_implemented: "End-to-end slice not implemented",
};

function compact(value: string | null): string {
  if (value === null) return "Not available";
  return value.length <= 22 ? value : `${value.slice(0, 10)}…${value.slice(-10)}`;
}

function timestamp(value: string | null): string {
  if (value === null) return "Not reported";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "Invalid timestamp";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(parsed)) + " UTC";
}

export function FinopsCapabilityShell({
  dashboard,
  state,
  stateTitle,
  stateDetail,
  evidence = null,
  actions,
  children,
}: FinopsCapabilityShellProps) {
  const maturity = MATURITY_PRESENTATION[dashboard.currentMaturity];
  const mayRenderEvidence = state === "partial"
    || state === "stale"
    || state === "failed"
    || state === "complete"
    || state === "empty";

  return (
    <article className={styles.capabilityShell} aria-labelledby={`finops-dashboard-${dashboard.slug}`}>
      <header className={styles.capabilityShellHeading}>
        <div>
          <p className="eyebrow">{dashboard.level} · {dashboard.provider}</p>
          <h2 id={`finops-dashboard-${dashboard.slug}`}>{dashboard.name}</h2>
          <p>{dashboard.summary}</p>
        </div>
        <div className={styles.capabilityShellBadges}>
          <span data-maturity={dashboard.currentMaturity.toLowerCase()}>{maturity.label}</span>
          <span data-state={state}>{STATE_LABELS[state]}</span>
        </div>
      </header>

      <div className={styles.capabilityMaturityNote} role="note">
        <strong>{maturity.label}</strong>
        <span>{maturity.detail}</span>
      </div>

      <section
        className={styles.capabilityStateBoundary}
        data-state={state}
        role={state === "failed" ? "alert" : "status"}
      >
        {state === "loading" ? <span className="loading-spinner" /> : <b aria-hidden="true">{state === "complete" ? "✓" : "i"}</b>}
        <div>
          <strong>{stateTitle}</strong>
          <p>{stateDetail}</p>
        </div>
        {actions === undefined ? null : <div className={styles.capabilityActions}>{actions}</div>}
      </section>

      {evidence !== null && mayRenderEvidence ? (
        <details className={styles.capabilityEvidence}>
          <summary>Source evidence and limitations</summary>
          <dl>
            <div><dt>Source</dt><dd>{evidence.sourceLabel}</dd></div>
            <div><dt>Collected</dt><dd>{timestamp(evidence.collectedAt)}</dd></div>
            <div><dt>Data through</dt><dd>{timestamp(evidence.dataThroughAt)}</dd></div>
            <div><dt>Freshness</dt><dd>{evidence.freshnessAgeHours === null ? "Not reported" : `${evidence.freshnessAgeHours} hours`} {evidence.freshnessSlaHours === null ? "" : `· ${evidence.freshnessSlaHours}-hour SLA`}</dd></div>
            <div><dt>Accepted / rejected</dt><dd>{evidence.acceptedRecords === null || evidence.rejectedRecords === null ? "Not reported" : `${evidence.acceptedRecords} / ${evidence.rejectedRecords}`}</dd></div>
            <div><dt>Generation</dt><dd title={evidence.generationId ?? undefined}>{compact(evidence.generationId)}</dd></div>
            <div><dt>SHA-256</dt><dd title={evidence.contentSha256 ?? undefined}>{compact(evidence.contentSha256)}</dd></div>
          </dl>
          {evidence.limitations.length === 0 ? null : (
            <ul>{evidence.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
          )}
        </details>
      ) : null}

      {mayRenderEvidence ? children : null}
    </article>
  );
}

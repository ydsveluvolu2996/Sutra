"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  FinopsCapabilityReadiness,
  FinopsDashboardLevel,
  FinopsSourceHealth,
  FinopsSourceReadinessReport,
  FinopsSourceState,
} from "../../lib/finops-source-health";
import styles from "./costs.module.css";

interface FinopsSourcesPanelProps {
  readonly connectionId: string | null;
}

interface ApiErrorBody {
  readonly error?: {
    readonly message?: string;
  };
}

const SOURCE_STATES: readonly FinopsSourceState[] = [
  "healthy",
  "partial",
  "stale",
  "failed",
  "waiting_first_delivery",
  "not_configured",
] as const;

const LEVELS: readonly FinopsDashboardLevel[] = [
  "foundational",
  "advanced",
  "additional",
] as const;

const STATE_PRESENTATION: Readonly<Record<FinopsSourceState, {
  readonly label: string;
  readonly shortLabel: string;
  readonly className: string;
}>> = {
  healthy: { label: "Healthy", shortLabel: "Healthy", className: styles.sourceStateHealthy },
  partial: { label: "Partial coverage", shortLabel: "Partial", className: styles.sourceStatePartial },
  stale: { label: "Stale", shortLabel: "Stale", className: styles.sourceStateStale },
  failed: { label: "Failed", shortLabel: "Failed", className: styles.sourceStateFailed },
  waiting_first_delivery: {
    label: "Waiting for first delivery",
    shortLabel: "Waiting",
    className: styles.sourceStateWaiting,
  },
  not_configured: {
    label: "Not configured",
    shortLabel: "Not configured",
    className: styles.sourceStateMissing,
  },
};

const LEVEL_PRESENTATION: Readonly<Record<FinopsDashboardLevel, {
  readonly label: string;
  readonly description: string;
}>> = {
  foundational: {
    label: "Foundational",
    description: "Core Cloud Intelligence Dashboards that depend on reconciled billing exports.",
  },
  advanced: {
    label: "Advanced",
    description: "Organization-wide advisory, operational, lifecycle, and collection capabilities.",
  },
  additional: {
    label: "Additional AWS capabilities",
    description: "Specialized allocation, marketplace, sustainability, service, and pricing views.",
  },
};

function formatTimestamp(value: string | null): string {
  if (value === null) return "Not reported";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) return "Invalid source timestamp";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(timestamp) + " UTC";
}

function formatAge(hours: number | null): string {
  if (hours === null) return "Age not reported";
  if (hours < 1) return "Less than 1 hour old";
  if (hours < 24) return `${Math.round(hours)} ${Math.round(hours) === 1 ? "hour" : "hours"} old`;
  const days = Math.round((hours / 24) * 10) / 10;
  return `${days} ${days === 1 ? "day" : "days"} old`;
}

function formatCoverage(source: FinopsSourceHealth): string {
  if (source.coverage.percent !== null) return `${source.coverage.percent}%`;
  if (source.coverage.assessment === "complete") return "Complete";
  if (source.coverage.assessment === "partial") return "Partial; percentage not reported";
  return "Not reported";
}

function coverageDetail(source: FinopsSourceHealth): string {
  const { acceptedRecords, expectedRecords, rejectedRecords } = source.coverage;
  const accepted = acceptedRecords !== null && expectedRecords !== null
    ? `${acceptedRecords.toLocaleString("en-US")} of ${expectedRecords.toLocaleString("en-US")} accepted`
    : acceptedRecords !== null
      ? `${acceptedRecords.toLocaleString("en-US")} accepted`
      : "Record totals not reported";
  return rejectedRecords !== null
    ? `${accepted} · ${rejectedRecords.toLocaleString("en-US")} rejected`
    : accepted;
}

function requestError(value: unknown): string {
  return value instanceof Error ? value.message : "Sutra could not load FinOps source health";
}

async function readSourceReport(response: Response): Promise<FinopsSourceReadinessReport> {
  const body = await response.json().catch(() => null) as FinopsSourceReadinessReport | ApiErrorBody | null;
  if (!response.ok || body === null || !("sources" in body) || !Array.isArray(body.sources)) {
    const apiError = body !== null && "error" in body ? body.error?.message : undefined;
    throw new Error(apiError ?? "Sutra could not load FinOps source health");
  }
  return body;
}

function SourceStateBadge({ state }: { readonly state: FinopsSourceState }) {
  const presentation = STATE_PRESENTATION[state];
  return (
    <span className={`${styles.sourceStateBadge} ${presentation.className}`}>
      <i aria-hidden="true" />
      {presentation.label}
    </span>
  );
}

function SourceHealthCard({ source }: { readonly source: FinopsSourceHealth }) {
  const freshness = source.freshness.fresh === true
    ? `Within ${source.freshness.slaHours}-hour SLA`
    : source.freshness.fresh === false
      ? `Outside ${source.freshness.slaHours}-hour SLA`
      : `${source.freshness.slaHours}-hour SLA; freshness not reported`;
  const lastError = source.lastError;

  return (
    <article className={styles.sourceHealthCard}>
      <header className={styles.sourceCardHeading}>
        <div>
          <span className={styles.sourceKind}>{source.kind.replaceAll("-", " ")}</span>
          <h3>{source.name}</h3>
        </div>
        <SourceStateBadge state={source.state} />
      </header>

      <dl className={styles.sourceMetrics}>
        <div>
          <dt>Freshness</dt>
          <dd>{formatAge(source.freshness.ageHours)}</dd>
          <small>{freshness}</small>
        </div>
        <div>
          <dt>Coverage</dt>
          <dd>{formatCoverage(source)}</dd>
          <small>{coverageDetail(source)}</small>
        </div>
        <div>
          <dt>Last success</dt>
          <dd>{formatTimestamp(source.freshness.lastSuccessAt)}</dd>
          <small>Data through {formatTimestamp(source.freshness.dataThroughAt)}</small>
        </div>
        <div>
          <dt>Last error</dt>
          <dd>{lastError === null ? "None recorded" : lastError.code}</dd>
          <small>{lastError === null ? "No persisted source error" : `${lastError.message} · ${formatTimestamp(lastError.at)}`}</small>
        </div>
      </dl>

      <div className={styles.sourceEvidence}>
        <span>
          <b>Evidence</b>
          {source.evidenceBasis ?? "No persisted configuration or delivery evidence"}
        </span>
        <span>
          <b>Last attempt</b>
          {source.lastAttemptOutcome === null
            ? "Not reported"
            : `${source.lastAttemptOutcome.replaceAll("_", " ")} · ${formatTimestamp(source.lastAttemptAt)}`}
        </span>
      </div>

      {source.limitations.length > 0 ? (
        <ul className={styles.sourceLimitations} aria-label={`${source.name} limitations`}>
          {source.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
        </ul>
      ) : null}
    </article>
  );
}

function CapabilityRow({
  capability,
  sourceNames,
}: {
  readonly capability: FinopsCapabilityReadiness;
  readonly sourceNames: ReadonlyMap<string, string>;
}) {
  return (
    <article className={styles.capabilityRow}>
      <div className={styles.capabilityName}>
        <SourceStateBadge state={capability.state} />
        <h4>{capability.name}</h4>
        <a
          aria-label={`Open AWS guidance for ${capability.name} in a new tab`}
          href={capability.documentationUrl}
          rel="noreferrer"
          target="_blank"
        >
          AWS guidance
        </a>
      </div>
      <div className={styles.capabilityPrerequisites}>
        <b>Prerequisites</b>
        <div>
          {capability.requiredSources.map((source) => (
            <span className={styles.prerequisiteChip} key={source.sourceId}>
              {sourceNames.get(source.sourceId) ?? source.sourceId}
              <i className={STATE_PRESENTATION[source.state].className}>
                {STATE_PRESENTATION[source.state].shortLabel}
              </i>
            </span>
          ))}
        </div>
      </div>
      {capability.supplementalSources.length > 0 ? (
        <div className={styles.capabilitySupplemental}>
          <b>Supporting evidence</b>
          <span>
            {capability.supplementalSources
              .map((source) => `${sourceNames.get(source.sourceId) ?? source.sourceId} (${STATE_PRESENTATION[source.state].shortLabel})`)
              .join(" · ")}
          </span>
        </div>
      ) : null}
      {!capability.ready && capability.blockingSourceIds.length > 0 ? (
        <p className={styles.capabilityBlocker}>
          <b>Blocked by:</b>{" "}
          {capability.blockingSourceIds.map((sourceId) => sourceNames.get(sourceId) ?? sourceId).join(" · ")}
        </p>
      ) : null}
    </article>
  );
}

export function FinopsSourcesPanel({ connectionId }: FinopsSourcesPanelProps) {
  const [report, setReport] = useState<FinopsSourceReadinessReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (connectionId === null) {
      setReport(null);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(
        `/api/v1/finops/sources?connectionId=${encodeURIComponent(connectionId)}`,
        { cache: "no-store", credentials: "same-origin", signal },
      );
      const nextReport = await readSourceReport(response);
      setReport(nextReport);
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(requestError(caught));
    } finally {
      if (signal?.aborted !== true) setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [load]);

  const sourceNames = useMemo(
    () => new Map(report?.sources.map((source) => [source.id, source.name]) ?? []),
    [report?.sources],
  );

  if (connectionId === null) {
    return (
      <section className={`panel ${styles.sourcesEmpty}`}>
        <span aria-hidden="true">DS</span>
        <div>
          <p className="eyebrow">Data-source readiness</p>
          <h2>Connect an AWS account to assess source health</h2>
          <p>Readiness is evaluated only against persisted evidence for a tenant-scoped cloud connection.</p>
        </div>
        <a className="button button-primary" href="/onboard">Connect AWS account</a>
      </section>
    );
  }

  if (report === null && error === null) {
    return (
      <div className={styles.sourcesLoading} role="status">
        <span className="loading-spinner" />
        Evaluating persisted source deliveries and capability prerequisites…
      </div>
    );
  }

  if (error !== null && report === null) {
    return (
      <div className="page-alert page-alert-error" role="alert">
        <strong>Source health needs attention</strong>
        <span>{error}</span>
        <button onClick={() => void load()} type="button">Retry</button>
      </div>
    );
  }

  if (report === null) return null;

  return (
    <div className={styles.sourcesWorkspace}>
      {error !== null ? (
        <div className="page-alert page-alert-error" role="alert">
          <strong>Latest source-health refresh failed</strong>
          <span>{error}. The last successful assessment remains visible below.</span>
          <button onClick={() => void load()} type="button">Retry</button>
        </div>
      ) : null}
      <section className={styles.sourcesHero} aria-labelledby="finops-source-readiness-heading">
        <div>
          <p className="eyebrow">Tenant-scoped readiness</p>
          <h2 id="finops-source-readiness-heading">Authoritative source health</h2>
          <p>{report.disclaimer}</p>
          <small>Assessed {formatTimestamp(report.generatedAt)}</small>
        </div>
        <div className={styles.capabilityScore} aria-label={`${report.summary.readyCapabilities} of ${report.summary.totalCapabilities} capabilities ready`}>
          <span>Capabilities ready</span>
          <strong>{report.summary.readyCapabilities}<i>/ {report.summary.totalCapabilities}</i></strong>
          <button disabled={loading} onClick={() => void load()} type="button">
            {loading ? "Refreshing…" : "Refresh assessment"}
          </button>
        </div>
      </section>

      <section className={styles.sourceStateSummary} aria-label="Source and capability state counts">
        {SOURCE_STATES.map((state) => {
          const presentation = STATE_PRESENTATION[state];
          return (
            <article className={presentation.className} key={state}>
              <span><i aria-hidden="true" />{presentation.label}</span>
              <strong>{report.summary.sources[state]}</strong>
              <small>{report.summary.capabilities[state]} capabilities</small>
            </article>
          );
        })}
      </section>

      <section className={`panel ${styles.sourcesPanel}`} aria-labelledby="source-inventory-heading">
        <header className={styles.sourcesPanelHeading}>
          <div>
            <p className="eyebrow">Delivery controls</p>
            <h2 id="source-inventory-heading">Source inventory</h2>
            <p>Freshness, coverage, attempts, and failures are reported from persisted evidence. Absent evidence remains not configured.</p>
          </div>
          <span className="result-count">{report.sources.length} authoritative sources</span>
        </header>
        <div className={styles.sourceHealthGrid}>
          {report.sources.map((source) => <SourceHealthCard key={source.id} source={source} />)}
        </div>
      </section>

      <section className={`panel ${styles.sourcesPanel}`} aria-labelledby="capability-readiness-heading">
        <header className={styles.sourcesPanelHeading}>
          <div>
            <p className="eyebrow">Enterprise capability tracker</p>
            <h2 id="capability-readiness-heading">Capability readiness</h2>
            <p>Every capability stays blocked until all authoritative prerequisites are healthy.</p>
          </div>
          <span className="result-count">{report.summary.totalCapabilities} capabilities assessed</span>
        </header>

        <div className={styles.capabilityGroups}>
          {LEVELS.map((level) => {
            const presentation = LEVEL_PRESENTATION[level];
            const capabilities = report.capabilities.filter((capability) => capability.level === level);
            const ready = capabilities.filter((capability) => capability.ready).length;
            return (
              <section className={styles.capabilityGroup} aria-labelledby={`capability-level-${level}`} key={level}>
                <header>
                  <div>
                    <h3 id={`capability-level-${level}`}>{presentation.label}</h3>
                    <p>{presentation.description}</p>
                  </div>
                  <span>{ready} / {capabilities.length} ready</span>
                </header>
                <div className={styles.capabilityList}>
                  {capabilities.map((capability) => (
                    <CapabilityRow capability={capability} key={capability.id} sourceNames={sourceNames} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </section>
    </div>
  );
}

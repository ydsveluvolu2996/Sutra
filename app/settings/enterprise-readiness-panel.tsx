"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  EnterpriseActivationReadiness,
  EnterpriseReadinessState,
} from "../../lib/enterprise-activation-readiness";
import { readAuthResponse } from "../components/use-session";

const STATE_LABEL: Readonly<Record<EnterpriseReadinessState, string>> = {
  ready: "Ready",
  attention: "Needs attention",
  blocked: "Blocked",
  not_configured: "Not configured",
};

export function EnterpriseReadinessPanel({
  connectionId,
}: {
  readonly connectionId: string | null;
}) {
  const [readiness, setReadiness] = useState<EnterpriseActivationReadiness | null>(null);
  const [loading, setLoading] = useState(connectionId !== null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (connectionId === null) {
      setReadiness(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ connectionId });
      const response = await fetch(`/api/v1/enterprise/readiness?${query}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      setReadiness(await readAuthResponse<EnterpriseActivationReadiness>(response));
    } catch (caught) {
      setReadiness(null);
      setError(caught instanceof Error ? caught.message : "Sutra could not assess activation readiness");
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    let active = true;
    if (connectionId === null) return;
    const query = new URLSearchParams({ connectionId });
    void fetch(`/api/v1/enterprise/readiness?${query}`, {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then((response) => readAuthResponse<EnterpriseActivationReadiness>(response))
      .then((next) => {
        if (!active) return;
        setReadiness(next);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setReadiness(null);
        setError(caught instanceof Error ? caught.message : "Sutra could not assess activation readiness");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [connectionId]);

  return (
    <section className="panel" aria-label="Enterprise activation readiness">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Production evidence</p>
          <h2>Enterprise activation readiness</h2>
          <p>Evidence-backed activation state for the selected connection. Dormant routes and empty dashboards never count as ready.</p>
        </div>
        <span className={`status-pill ${readiness?.overall === "ready" ? "status-positive" : ""}`}>
          {readiness === null ? "No assessment" : STATE_LABEL[readiness.overall]}
        </span>
      </div>
      {connectionId === null ? (
        <div className="empty-state"><strong>No selected connection</strong><span>Select or onboard an AWS connection to assess tenant-scoped activation.</span></div>
      ) : null}
      {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Assessing production evidence…</div> : null}
      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Readiness unavailable</strong><span>{error}</span><button onClick={() => void load()} type="button">Retry</button></div> : null}
      {readiness ? (
        <>
          <div className="report-metrics">
            <div><small>Ready</small><strong>{readiness.summary.ready}</strong><span>Evidence and activation complete</span></div>
            <div><small>Needs attention</small><strong>{readiness.summary.attention}</strong><span>Partial or stale evidence</span></div>
            <div><small>Blocked</small><strong>{readiness.summary.blocked}</strong><span>Required dependency unavailable</span></div>
            <div><small>Not configured</small><strong>{readiness.summary.not_configured}</strong><span>No activation evidence</span></div>
          </div>
          <div className="data-table">
            <div className="data-row data-header"><span>Capability</span><span>State</span><span>Observed evidence</span><span>Required action</span></div>
            {readiness.domains.map((domain) => (
              <div className="data-row" key={domain.key}>
                <span className="primary-cell"><strong>{domain.title}</strong><small>{domain.summary}</small></span>
                <span><span className={`connection-status connection-${domain.state === "ready" ? "active" : domain.state === "blocked" ? "disabled" : "pending"}`}>{STATE_LABEL[domain.state]}</span></span>
                <span>{domain.evidence.join(" · ")}</span>
                <span>{domain.actions.length === 0 ? "No action required" : domain.actions.join(" ")}</span>
              </div>
            ))}
          </div>
          <p className="panel-footnote">Generated {new Date(readiness.generatedAt).toLocaleString()}. {readiness.disclaimer}</p>
        </>
      ) : null}
    </section>
  );
}

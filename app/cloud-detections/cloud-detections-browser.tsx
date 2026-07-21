"use client";

import { useCallback, useEffect, useState } from "react";
import type { CloudDetectionReport } from "../../lib/cloud-detection";
import type { CloudDetectionCoverage } from "../../lib/cloud-detection-inputs";
import { compactIdentifier, formatTimestamp, usePilotState } from "../components/use-pilot-state";

interface SourceState {
  readonly collected: boolean;
  readonly status: string;
  readonly eventsAnalyzed: number;
  readonly eventsBySource?: Readonly<Record<string, number>>;
  readonly totalEventsStored: number;
  readonly lastCollectedAt: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  readonly guardDuty?: { readonly collected: boolean; readonly findingsAnalyzed: number };
}

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  cloudtrail: "AWS CloudTrail",
  guardduty: "AWS GuardDuty",
  "k8s-audit": "Kubernetes audit",
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

interface CloudDetectionsResponse {
  readonly report: CloudDetectionReport;
  readonly coverage: CloudDetectionCoverage;
  readonly source: SourceState;
  readonly error?: { readonly message?: string };
}

function severityTone(severity: string): string {
  return `severity-badge severity-${severity}`;
}

export function CloudDetectionsBrowser() {
  const { state, loading, error, refresh } = usePilotState();
  const connection = state?.connection ?? null;
  const connectionId = connection?.id ?? null;
  const [data, setData] = useState<CloudDetectionsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (connectionId === null) { setData(null); setLoadError(null); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/cloud-detections?connectionId=${encodeURIComponent(connectionId)}`, { cache: "no-store", credentials: "same-origin" });
      const body = await response.json() as CloudDetectionsResponse;
      if (!response.ok || body.report === undefined) throw new Error(body.error?.message ?? "Cloud detections are unavailable");
      setData(body);
      setLoadError(null);
    } catch (caught) {
      setData(null);
      setLoadError(caught instanceof Error ? caught.message : "Cloud detections are unavailable");
    } finally {
      setBusy(false);
    }
  }, [connectionId]);
  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const report = data?.report ?? null;
  const coverage = data?.coverage ?? null;
  const source = data?.source ?? null;

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Cloud detection &amp; response</p>
          <h1>Cloud detections</h1>
          <p className="page-subtitle">Rule-based, point-in-time detections evaluated over multiple already-collected sources — AWS CloudTrail management events and read-only AWS GuardDuty findings — each detection labeled with the source that proved it and a confidence. A detection is emitted only when the collected evidence proves it; sources that are not collected are disclosed as absent, never a fabricated log stream or a claim of full-coverage CDR.</p>
        </div>
        <div className="heading-actions">
          <a className="button button-secondary" href="/security-events">Security events</a>
          <button className="button button-primary" disabled={busy} onClick={() => { void refresh(); void load(); }} type="button">{busy ? "Refreshing…" : "Refresh"}</button>
        </div>
      </section>

      {coverage !== null ? (
        <div className="trust-strip" role="note">
          <span className="trust-icon">{coverage.zeroCoverage ? "i" : "!"}</span>
          <span>
            <strong>{coverage.zeroCoverage ? "Zero coverage." : "Single-source coverage."}</strong> {coverage.notice}
            {" "}Sources present: {coverage.sourcesPresent.join(", ") || "none"}. Not collected: {coverage.sourcesAbsent.join(", ")}.
          </span>
          <a href="/security-events">Collect events</a>
        </div>
      ) : null}

      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Evidence unavailable</strong><span>{error}</span><button onClick={() => void refresh()} type="button">Retry</button></div> : null}
      {loadError ? <div className="page-alert page-alert-error" role="alert"><strong>Cloud detections unavailable</strong><span>{loadError}</span><button onClick={() => void load()} type="button">Retry</button></div> : null}
      {(loading || busy) && data === null ? <div className="loading-state" role="status"><span className="loading-spinner" />Evaluating collected CloudTrail management events…</div> : null}

      {!loading && connection === null ? (
        <section className="panel empty-workspace"><span className="empty-workspace-icon">CD</span><h2>No AWS account is connected</h2><p>Connect and validate a customer account, then collect a bounded CloudTrail window on the Security Events page so Sutra has management events to evaluate.</p><a className="button button-primary" href="/onboard">Connect AWS account</a></section>
      ) : null}

      {report !== null && coverage !== null && source !== null ? (
        coverage.zeroCoverage ? (
          <section className="panel empty-workspace">
            <span className="empty-workspace-icon">0</span>
            <h2>Zero coverage — no events collected</h2>
            <p>No CloudTrail management events have been collected for this connection yet, so there is nothing to evaluate. This is not a finding of &ldquo;no threats&rdquo;: an empty source cannot prove the account is clean.</p>
            <a className="button button-primary" href="/security-events">Collect CloudTrail events</a>
          </section>
        ) : (
          <>
            <section className="metric-row">
              <div className="metric-card"><span className="metric-label">Detections</span><span className="metric-value">{report.summary.detections}</span></div>
              <div className="metric-card"><span className="metric-label">Critical / High</span><span className="metric-value">{report.summary.bySeverity.critical + report.summary.bySeverity.high}</span></div>
              <div className="metric-card"><span className="metric-label">Events evaluated</span><span className="metric-value">{report.summary.evaluated}</span></div>
              <div className="metric-card"><span className="metric-label">Unclassified</span><span className="metric-value">{report.summary.unclassified}</span></div>
            </section>

            <section className="panel">
              <h2>Source coverage</h2>
              <p className="page-subtitle">Each detection carries the source that proved it. A source with no collection pipeline is disclosed as not collected — an empty result for it is never presented as &ldquo;clean&rdquo;.</p>
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>Source</th><th>Status</th><th>Events analyzed</th></tr></thead>
                  <tbody>
                    {coverage.sourcesPresent.map((item) => (
                      <tr key={item}><td><strong>{sourceLabel(item)}</strong><small>{item}</small></td><td><span className="compliance-status compliance-status-pass">Collected</span></td><td>{source.eventsBySource?.[item] ?? 0}</td></tr>
                    ))}
                    {coverage.sourcesAbsent.map((item) => (
                      <tr key={item}><td><strong>{sourceLabel(item)}</strong><small>{item}</small></td><td><span className="compliance-status compliance-status-unknown">Not collected</span></td><td>—</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="page-footnote">Analyzed {source.eventsAnalyzed} event{source.eventsAnalyzed === 1 ? "" : "s"} across all collected sources · CloudTrail {source.eventsBySource?.cloudtrail ?? 0} of {source.totalEventsStored} stored · GuardDuty {source.guardDuty?.collected ? `${source.guardDuty.findingsAnalyzed} finding${source.guardDuty.findingsAnalyzed === 1 ? "" : "s"}` : "not collected"} · CloudTrail source {source.status}{source.lastCollectedAt !== null ? ` · last collected ${formatTimestamp(source.lastCollectedAt)}` : ""}{source.windowStart !== null ? ` · window ${formatTimestamp(source.windowStart)} → ${formatTimestamp(source.windowEnd)}` : ""}</p>
            </section>

            <section className="panel">
              <h2>Detections</h2>
              {report.detections.length === 0 ? (
                <div className="empty-state"><strong>No rule matched the collected evidence</strong><span>{report.summary.evaluated} event{report.summary.evaluated === 1 ? "" : "s"} were evaluated across the collected sources and {report.summary.unclassified} had no applicable rule. This does not prove the account is free of threats; only the collected sources ({coverage.sourcesPresent.map(sourceLabel).join(", ")}) were evaluated.</span></div>
              ) : (
                <div className="table-scroll">
                  <table className="data-table">
                    <thead><tr><th>Severity</th><th>Source</th><th>Confidence</th><th>Detection</th><th>Actor</th><th>Resource</th><th>Evidence</th></tr></thead>
                    <tbody>
                      {report.detections.map((detection) => (
                        <tr key={detection.id}>
                          <td><span className={severityTone(detection.severity)}>{detection.severity}</span></td>
                          <td><code>{sourceLabel(detection.source)}</code></td>
                          <td>{detection.confidence}</td>
                          <td><strong>{detection.title}</strong><small>{detection.ruleId}</small></td>
                          <td title={detection.actor}><code>{compactIdentifier(detection.actor, 24)}</code></td>
                          <td>{detection.resourceRef ?? "—"}</td>
                          <td className="cell-detail">{detection.evidence.name} · {formatTimestamp(detection.evidence.time)}{detection.evidence.sourceIp !== undefined ? ` · ${detection.evidence.sourceIp}` : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {report.correlated.length > 0 ? (
              <section className="panel">
                <h2>Correlated actors</h2>
                <p className="page-subtitle">Actors with more than one detection in this window, grouped by tenant-scoped identity. No time-windowing is applied.</p>
                <div className="table-scroll">
                  <table className="data-table">
                    <thead><tr><th>Actor</th><th>Detections</th></tr></thead>
                    <tbody>
                      {report.correlated.map((group) => (
                        <tr key={`${group.tenant ?? ""}:${group.actor}`}><td title={group.actor}><code>{compactIdentifier(group.actor, 32)}</code></td><td>{group.detectionIds.length}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}

            <p className="page-footnote">{report.disclaimer}</p>
          </>
        )
      ) : null}
    </>
  );
}

"use client";

import { useMemo, useState } from "react";
import type { JsonValue, PilotFinding } from "../../lib/pilot-types";
import { compactIdentifier, formatTimestamp, postPilot, usePilotState } from "../components/use-pilot-state";

const severityOrder = ["critical", "high", "medium", "low", "informational"] as const;

function evidenceValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "Sutra could not update the finding";
}

export function FindingsBrowser() {
  const { state, health, loading, refreshing, error, refresh } = usePilotState();
  const [severity, setSeverity] = useState("all");
  const [status, setStatus] = useState("open");
  const [query, setQuery] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const findings = useMemo(() => state?.findings ?? [], [state?.findings]);
  const connection = state?.connection ?? null;
  const resourceMap = useMemo(() => new Map((state?.resources ?? []).map((resource) => [resource.resourceKey, resource])), [state?.resources]);
  const filtered = useMemo(() => findings.filter((finding) => {
    const resource = finding.resourceKey ? resourceMap.get(finding.resourceKey) : null;
    const haystack = `${finding.title} ${finding.summary} ${finding.controlKey} ${resource?.name ?? ""} ${resource?.nativeId ?? ""} ${resource?.service ?? ""} ${resource?.region ?? ""}`.toLowerCase();
    return (severity === "all" || finding.severity === severity) && (status === "all" || finding.status === status) && haystack.includes(query.toLowerCase());
  }), [findings, query, resourceMap, severity, status]);
  const openFindings = findings.filter((finding) => finding.status === "open");

  async function runAssessment() {
    if (!connection) return;
    setSyncing(true);
    setActionError(null);
    try {
      await postPilot("/api/pilot/connections/sync", { connectionId: connection.id });
      await refresh();
    } catch (caught) {
      setActionError(errorMessage(caught));
      await refresh();
    } finally {
      setSyncing(false);
    }
  }

  async function updateWorkflow(finding: PilotFinding, nextStatus: "open" | "acknowledged") {
    if (!connection) return;
    setUpdating(finding.fingerprint);
    setActionError(null);
    try {
      await postPilot("/api/pilot/findings/workflow", {
        connectionId: connection.id,
        fingerprint: finding.fingerprint,
        status: nextStatus,
        note: nextStatus === "acknowledged" ? "Acknowledged by the local pilot operator" : "Reopened by the local pilot operator",
      });
      await refresh();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setUpdating(null);
    }
  }

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Evidence-backed posture</p><h1>Security findings</h1><p className="page-subtitle">Explainable configuration checks, affected resources, evidence, and suggested remediation from the active snapshot.</p></div>
        <div className="heading-actions"><a className="button button-secondary" href="/api/pilot/export?format=csv">Export CSV</a><a className="button button-secondary" href="/controls">Control library</a><button className="button button-primary" type="button" disabled={!connection || connection.status !== "active" || syncing || refreshing} onClick={() => void runAssessment()}>{syncing ? "Assessing…" : "Run assessment"}</button></div>
      </section>
      <div className="trust-strip" role="note"><span className="trust-icon">i</span><span><strong>{health?.mode === "live" ? "AWS configuration evidence." : health?.mode === "fixture" ? "Fixture evidence for local evaluation." : "Stored finding evidence."}</strong> These findings are deterministic posture observations—not proof of compromise, behavior analytics, package vulnerability scanning, or an AWS Inspector/GuardDuty replacement.</span><a href="/controls#architecture">See limitations</a></div>

      {error || actionError ? <div className="page-alert page-alert-error" role="alert"><strong>Findings action needs attention</strong><span>{actionError ?? error}</span><button type="button" onClick={() => void refresh()}>Retry</button></div> : null}
      {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading configuration findings…</div> : null}

      {!loading && !connection ? <section className="panel empty-workspace"><span className="empty-workspace-icon">CSPM</span><h2>No AWS account is connected</h2><p>Connect and validate a customer account before Sutra can evaluate configuration evidence.</p><a className="button button-primary" href="/onboard">Connect AWS account</a></section> : null}

      {connection ? (
        <>
          <section className="finding-summary">
            {severityOrder.slice(0, 4).map((level) => <article key={level}><span className={`severity-dot severity-${level}`} /><small>{level}</small><strong>{openFindings.filter((finding) => finding.severity === level).length}</strong></article>)}
            <article><span className="severity-dot severity-info" /><small>Affected resources</small><strong>{new Set(openFindings.map((finding) => finding.resourceKey).filter(Boolean)).size}</strong></article>
          </section>

          {!state?.activeSnapshot ? <section className="panel empty-workspace compact-empty"><h2>No finding evidence yet</h2><p>Publish the first complete inventory snapshot to run the configured checks.</p><a className="button button-primary" href="/onboard">Finish onboarding</a></section> : null}

          {state?.activeSnapshot ? <section className="panel findings-panel">
            <div className="panel-heading"><div><p className="eyebrow">Workflow queue</p><h2>Current findings</h2></div><span className="result-count">{filtered.length} of {findings.length} findings</span></div>
            <div className="filter-bar">
              <label className="search-field"><span className="sr-only">Search findings</span><input className="filter-control" placeholder="Search finding, control, resource or region" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
              <label><span className="sr-only">Filter by severity</span><select className="filter-control" value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="all">All severities</option>{severityOrder.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
              <label><span className="sr-only">Filter by status</span><select className="filter-control" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All workflow states</option><option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="suppressed">Suppressed</option><option value="resolved">Resolved in snapshot</option></select></label>
              {(query || severity !== "all" || status !== "open") ? <button className="button button-secondary button-small" onClick={() => { setQuery(""); setSeverity("all"); setStatus("open"); }} type="button">Clear</button> : null}
            </div>
            <div className="finding-list">
              {filtered.map((finding) => {
                const resource = finding.resourceKey ? resourceMap.get(finding.resourceKey) : null;
                return <details className="finding-item" key={finding.fingerprint}>
                  <summary>
                    <span className={`severity-badge severity-${finding.severity}`}>{finding.severity}</span>
                    <span className="finding-title"><strong>{finding.title}</strong><small>{resource ? `${resource.name ?? resource.nativeId} · ${resource.region}` : "Account-level finding"}</small></span>
                    <span className="finding-scope"><strong>{connection.customerName}</strong><small>{connection.awsAccountId}</small></span>
                    <span className="finding-service">{resource?.service.toUpperCase() ?? "ACCOUNT"}</span>
                    <span className="finding-chevron">⌄</span>
                  </summary>
                  <div className="finding-detail">
                    <div><p className="eyebrow">Observation</p><p>{finding.summary}</p><p className="limitation-note">Control {finding.controlKey} · v{finding.controlVersion} · evaluated {formatTimestamp(finding.evaluatedAt)}</p></div>
                    <div><p className="eyebrow">Evidence</p><dl>{Object.entries(finding.evidence).map(([key, value]) => <div key={key}><dt>{key}</dt><dd title={evidenceValue(value)}>{compactIdentifier(evidenceValue(value), 42)}</dd></div>)}</dl></div>
                    <div><p className="eyebrow">Suggested remediation</p><p>{finding.remediation}</p><div className="finding-workflow"><span className={`workflow-status workflow-${finding.status}`}>{finding.status}</span><button className="button button-secondary button-small" disabled={updating === finding.fingerprint} onClick={() => void updateWorkflow(finding, finding.status === "acknowledged" ? "open" : "acknowledged")} type="button">{updating === finding.fingerprint ? "Saving…" : finding.status === "acknowledged" ? "Reopen" : "Acknowledge"}</button></div></div>
                  </div>
                </details>;
              })}
              {filtered.length === 0 ? <div className="empty-state"><strong>No matching findings</strong><span>Adjust the filters or run a new assessment.</span></div> : null}
            </div>
          </section> : null}
        </>
      ) : null}
    </>
  );
}

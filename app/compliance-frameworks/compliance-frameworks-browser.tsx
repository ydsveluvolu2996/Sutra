"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  FrameworkReadiness,
  ReadinessState,
} from "../../lib/compliance-frameworks";
import { formatTimestamp, usePilotState } from "../components/use-pilot-state";

interface FrameworksResponse {
  readonly schemaVersion: "sutra.compliance-frameworks.v1";
  readonly frameworks: readonly FrameworkReadiness[];
  readonly scope: { readonly collectedAt: string | null; readonly collectionId: string | null };
  readonly evidence: {
    readonly awsControls: number;
    readonly kubernetesControls: number;
    readonly clusters: number;
    readonly snapshotCoverageState: "complete" | "partial" | null;
  };
  readonly reportSha256: string;
  readonly error?: { readonly message?: string };
}

const STATE_ORDER: readonly ReadinessState[] = ["FAIL", "UNKNOWN", "NOT_COLLECTED", "PASS"];

const STATE_LABEL: Readonly<Record<ReadinessState, string>> = {
  PASS: "Pass", FAIL: "Fail", UNKNOWN: "Unknown", NOT_COLLECTED: "Not collected",
};

function statusClass(state: ReadinessState): string {
  const suffix = state === "PASS" ? "pass" : state === "FAIL" ? "fail" : state === "UNKNOWN" ? "unknown" : "not-applicable";
  return `compliance-status compliance-status-${suffix}`;
}

function availabilityLabel(availability: string): string {
  if (availability === "available") return "Available";
  if (availability === "licensed-content-required") return "Licensed content required";
  return "Mapping review required";
}

// PASS / (PASS + FAIL), the honest scorable ratio; null when nothing is scorable.
function scorePercent(summary: Readonly<Record<ReadinessState, number>>): number | null {
  const scorable = summary.PASS + summary.FAIL;
  return scorable === 0 ? null : Math.round((summary.PASS / scorable) * 1000) / 10;
}

export function ComplianceFrameworksBrowser() {
  const { state, loading, error, refresh } = usePilotState();
  const connection = state?.connection ?? null;
  const connectionId = connection?.id ?? null;
  const [data, setData] = useState<FrameworksResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (connectionId === null) { setData(null); setLoadError(null); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/compliance/frameworks?connectionId=${encodeURIComponent(connectionId)}`, { cache: "no-store", credentials: "same-origin" });
      const body = await response.json() as FrameworksResponse;
      if (!response.ok || body.frameworks === undefined) throw new Error(body.error?.message ?? "Compliance framework readiness is unavailable");
      setData(body);
      setLoadError(null);
    } catch (caught) {
      setData(null);
      setLoadError(caught instanceof Error ? caught.message : "Compliance framework readiness is unavailable");
    } finally {
      setBusy(false);
    }
  }, [connectionId]);
  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const exportHref = (frameworkId: string, format: "csv" | "json"): string =>
    `/api/v1/compliance/frameworks?connectionId=${encodeURIComponent(connectionId ?? "")}&framework=${encodeURIComponent(frameworkId)}&format=${format}`;

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Governed readiness mapping</p>
          <h1>Compliance frameworks</h1>
          <p className="page-subtitle">PCI DSS v4, HIPAA Security Rule, ISO 27001:2022 Annex A, NIST CSF 2.0 and SOC 2 — each mapped control-by-control to Sutra&rsquo;s collected AWS and Kubernetes control evidence. Readiness, not certification.</p>
        </div>
        <div className="heading-actions">
          <a className="button button-secondary" href="/compliance">Compliance posture</a>
          {connectionId !== null ? <a className="button button-secondary" href={`/api/v1/compliance/frameworks?connectionId=${encodeURIComponent(connectionId)}&format=pack`}>Download evidence pack</a> : null}
          <button className="button button-primary" disabled={busy} onClick={() => { void refresh(); void load(); }} type="button">{busy ? "Refreshing…" : "Refresh"}</button>
        </div>
      </section>

      <div className="trust-strip" role="note"><span className="trust-icon">!</span><span><strong>Readiness mapping, not an audit opinion.</strong> States are computed over the exact collected point-in-time control evidence only. A control mapping with no collected evidence reports &ldquo;Not collected&rdquo; — never a fabricated pass. Framework relationships are informative and must be confirmed with your assessor.</span></div>

      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Evidence unavailable</strong><span>{error}</span><button onClick={() => void refresh()} type="button">Retry</button></div> : null}
      {loadError ? <div className="page-alert page-alert-error" role="alert"><strong>Framework readiness unavailable</strong><span>{loadError}</span><button onClick={() => void load()} type="button">Retry</button></div> : null}
      {(loading || busy) && data === null ? <div className="loading-state" role="status"><span className="loading-spinner" />Mapping collected evidence to frameworks…</div> : null}

      {!loading && connection === null ? (
        <section className="panel empty-workspace"><span className="empty-workspace-icon">CF</span><h2>No AWS account is connected</h2><p>Connect and validate a customer account so Sutra can map its collected control evidence to each framework.</p><a className="button button-primary" href="/onboard">Connect AWS account</a></section>
      ) : null}

      {data !== null ? <>
        <section className="inventory-stats">
          <article><small>Frameworks mapped</small><strong>{data.frameworks.length}</strong><span>PCI · HIPAA · ISO · NIST · SOC 2</span></article>
          <article><small>AWS controls collected</small><strong>{data.evidence.awsControls}</strong><span>{data.evidence.snapshotCoverageState === "partial" ? "partial coverage" : "baseline assessment"}</span></article>
          <article><small>Kubernetes controls collected</small><strong>{data.evidence.kubernetesControls}</strong><span>{data.evidence.clusters} active cluster{data.evidence.clusters === 1 ? "" : "s"}</span></article>
          <article><small>Evidence collected</small><strong>{data.scope.collectedAt ? formatTimestamp(data.scope.collectedAt) : "—"}</strong><span>point-in-time</span></article>
        </section>

        {data.frameworks.map((framework) => {
          const score = scorePercent(framework.summary);
          const open = expanded === framework.framework.id;
          return (
            <section className="panel" key={framework.framework.id}>
              <div className="panel-heading">
                <div><p className="eyebrow">{availabilityLabel(framework.framework.availability)}</p><h2>{framework.framework.title}</h2></div>
                <span className="result-count">{score === null ? "Not scorable" : `${score}% ready`}</span>
              </div>
              <div className="framework-readiness-counts">
                {STATE_ORDER.map((stateKey) => <span className={statusClass(stateKey)} key={stateKey}>{STATE_LABEL[stateKey]} · {framework.summary[stateKey]}</span>)}
              </div>
              <p className="panel-footnote">{framework.framework.claimBoundary}</p>
              <div className="heading-actions" style={{ marginTop: 10 }}>
                <button className="button button-secondary button-small" onClick={() => setExpanded(open ? null : framework.framework.id)} type="button">{open ? "Hide controls" : `Show ${framework.controls.length} controls`}</button>
                <a className="button button-secondary button-small" href={exportHref(framework.framework.id, "csv")}>Export CSV</a>
                <a className="button button-secondary button-small" href={exportHref(framework.framework.id, "json")}>Export JSON</a>
              </div>
              {open ? <div className="framework-control-list">
                {framework.controls.map((control) => <article className="framework-control-row" key={control.controlId}>
                  <span className={statusClass(control.state)}>{STATE_LABEL[control.state]}</span>
                  <div><strong>{control.controlId}</strong><small>{control.title}</small>{control.mappedEvidence.length > 0 ? <small className="framework-evidence">Evidence: {control.mappedEvidence.map((entry) => `${entry.sutraControlId} (${STATE_LABEL[entry.state]})`).join(" · ")}</small> : null}</div>
                </article>)}
                {framework.unmappedControlIds.length > 0 ? <p className="panel-footnote">{framework.unmappedControlIds.length} collected control{framework.unmappedControlIds.length === 1 ? "" : "s"} did not map to this framework.</p> : null}
              </div> : null}
            </section>
          );
        })}

        <p className="panel-footnote">Report integrity SHA-256: <code>{data.reportSha256.slice(0, 16)}…</code>. Exports carry the full hash. Mapping is informative only and does not constitute a certification or audit opinion.</p>
      </> : null}
    </>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { DriftReport, DriftSeverity } from "../../../lib/kubernetes-drift";
import { formatTimestamp, usePilotState } from "../../components/use-pilot-state";
import { useKubernetesEvidence } from "../use-kubernetes-evidence";

type DriftResponse = DriftReport & {
  readonly latestScanAt: string | null;
  readonly previousScanAt: string | null;
  readonly error?: { readonly message?: string };
};

function severityBadge(severity: DriftSeverity): string {
  return `severity-badge severity-${severity}`;
}

export function DriftWorkspace() {
  const { state, loading, error, refresh } = usePilotState();
  const kubernetes = useKubernetesEvidence(state);
  const cluster = kubernetes.clusters.find((item) => item.status === "active") ?? null;
  const connectionId = state?.connection?.id ?? null;
  const [report, setReport] = useState<DriftResponse | null>(null);
  const [driftError, setDriftError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (connectionId === null || cluster === null) { setReport(null); setDriftError(null); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/kubernetes/drift?connectionId=${encodeURIComponent(connectionId)}&clusterId=${encodeURIComponent(cluster.id)}`, { cache: "no-store", credentials: "same-origin" });
      const body = await response.json() as DriftResponse;
      if (!response.ok) throw new Error(body.error?.message ?? "Drift is unavailable");
      setReport(body);
      setDriftError(null);
    } catch (caught) {
      setReport(null);
      setDriftError(caught instanceof Error ? caught.message : "Drift is unavailable");
    } finally {
      setBusy(false);
    }
  }, [cluster, connectionId]);
  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Kubernetes · Runtime integrity</p><h1>Configuration &amp; image drift</h1><p className="page-subtitle">Where a running workload no longer matches its previously-observed spec — a container that became privileged, lost run-as-non-root, gained host access, or swapped its image between scans.</p></div>
        <div className="heading-actions"><Link className="button button-secondary" href="/kubernetes/issues">Issues</Link><button className="button button-primary" disabled={busy} onClick={() => { void refresh(); void kubernetes.refresh(); void load(); }} type="button">{busy ? "Refreshing…" : "Refresh"}</button></div>
      </section>

      <div className="trust-strip" role="note"><span className="trust-icon">Δ</span><span>Drift compares the two most recent scans of the same workload. A security regression is reported only when the earlier scan recorded the safer value; nothing is inferred.</span></div>

      {error || kubernetes.error ? <div className="page-alert page-alert-error" role="alert"><strong>Evidence unavailable</strong><span>{error ?? kubernetes.error}</span><button onClick={() => { void refresh(); void kubernetes.refresh(); }} type="button">Retry</button></div> : null}
      {driftError ? <div className="page-alert page-alert-error" role="alert"><strong>Drift unavailable</strong><span>{driftError}</span><button onClick={() => void load()} type="button">Retry</button></div> : null}
      {loading || kubernetes.loading || busy ? <div className="loading-state" role="status"><span className="loading-spinner" />Comparing workload specs across scans…</div> : null}

      {report !== null && !busy ? <>
        <section className="inventory-stats">
          <article><small>Drift changes</small><strong>{report.summary.changes}</strong><span>{report.summary.critical} critical · {report.summary.high} high</span></article>
          <article><small>Workloads drifted</small><strong>{report.summary.workloadsDrifted}</strong><span>Changed since last scan</span></article>
          <article><small>Compared from</small><strong>{report.previousScanAt ? formatTimestamp(report.previousScanAt) : "—"}</strong><span>Previous scan</span></article>
          <article><small>Compared to</small><strong>{report.latestScanAt ? formatTimestamp(report.latestScanAt) : "—"}</strong><span>Latest scan</span></article>
        </section>

        {!report.hasPrevious ? <div className="empty-state"><strong>Only one scan on record</strong><span>Drift detection needs at least two scans of the cluster. As it re-scans over time, changes to any workload&apos;s security spec or image will appear here.</span></div> : null}

        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">Spec changed between scans</p><h2>Detected drift</h2></div><span className="result-count">{report.changes.length}</span></div>
          {report.changes.length > 0 ? <div className="drift-list">
            {report.changes.map((change, index) => <article className="drift-row" key={`${change.workload}:${change.kind}:${change.container ?? ""}:${index}`}>
              <span className={severityBadge(change.severity)}>{change.severity}</span>
              <div className="drift-body">
                <strong>{change.detail}</strong>
                <small>{change.workload}{change.container ? ` · container ${change.container}` : ""}</small>
              </div>
              <div className="drift-transition"><code>{change.from}</code><span aria-hidden="true">→</span><code>{change.to}</code></div>
            </article>)}
          </div> : <div className="empty-state"><strong>{report.hasPrevious ? "No drift between the last two scans" : "Awaiting a second scan"}</strong><span>{report.hasPrevious ? "Every workload's security spec and image matched its previous scan." : "Drift detection begins once a second scan is uploaded."}</span></div>}
        </section>
        <p className="panel-footnote">{report.disclaimer}</p>
      </> : null}
    </>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildKubernetesIssues,
  type IssueExposureInput,
  type IssueReachability,
  type IssueSeverity,
} from "../../../lib/kubernetes-issues";
import { buildKubernetesAttackPaths } from "../../../lib/kubernetes-attack-paths";
import type { NormalizedFalcoRuntimeEvent } from "../../../lib/falco-runtime-types";
import type { NormalizedHubbleFlow } from "../../../lib/hubble-flow-evidence";
import type { KubernetesSupplyChainEvidence } from "../../../lib/kubernetes-supply-chain";
import { usePilotState } from "../../components/use-pilot-state";
import { buildKubernetesProjection } from "../kubernetes-projection";
import { useKubernetesEvidence } from "../use-kubernetes-evidence";

// Falco reports the pod name; strip trailing hash-like segments to recover the
// workload name. A miss simply fails to join (no false issue) — never invents.
function podToWorkloadName(pod: string): string {
  const segments = pod.split("-");
  while (segments.length > 1) {
    const last = segments[segments.length - 1] ?? "";
    if (/^[a-z0-9]{5,10}$/u.test(last) && /[0-9]/u.test(last)) segments.pop();
    else break;
  }
  return segments.join("-");
}

// Posture subjects are "Kind/namespace/name" or "Kind/name".
function parsePostureSubject(subject: string): { namespace: string | null; name: string } | null {
  const parts = subject.split("/");
  if (parts.length === 3 && parts[2]) return { namespace: parts[1] ?? null, name: parts[2] };
  if (parts.length === 2 && parts[1]) return { namespace: null, name: parts[1] };
  return null;
}

const REACHABILITY_LABEL: Readonly<Record<IssueReachability, string>> = {
  confirmed: "Confirmed reachable",
  theoretical: "Theoretical exposure",
  not_exposed: "Not exposed",
};

function reachabilityPill(reachability: IssueReachability): string {
  if (reachability === "confirmed") return "compliance-status-fail";
  if (reachability === "theoretical") return "compliance-status-unknown";
  return "compliance-status-not-applicable";
}

export function IssuesWorkspace() {
  const { state, loading, error, refresh } = usePilotState();
  const kubernetes = useKubernetesEvidence(state);
  const cluster = kubernetes.clusters.find((item) => item.status === "active") ?? null;
  const connectionId = state?.connection?.id ?? null;
  const [severityFilter, setSeverityFilter] = useState<IssueSeverity | "all">("all");
  const [signals, setSignals] = useState<{
    readonly runtimeEvents: readonly NormalizedFalcoRuntimeEvent[];
    readonly networkFlows: readonly NormalizedHubbleFlow[];
    readonly supplyChainEvidence: readonly KubernetesSupplyChainEvidence[];
  }>({ runtimeEvents: [], networkFlows: [], supplyChainEvidence: [] });
  const [signalError, setSignalError] = useState<string | null>(null);
  const [signalLoading, setSignalLoading] = useState(false);

  const refreshSignals = useCallback(async () => {
    if (connectionId === null || cluster === null) {
      setSignals({ runtimeEvents: [], networkFlows: [], supplyChainEvidence: [] });
      setSignalError(null);
      return;
    }
    setSignalLoading(true);
    const scope = `connectionId=${encodeURIComponent(connectionId)}&clusterId=${encodeURIComponent(cluster.id)}&limit=500`;
    try {
      const [runtimeResponse, networkResponse, supplyResponse] = await Promise.all([
        fetch(`/api/v1/kubernetes/runtime-events?${scope}`, { cache: "no-store" }),
        fetch(`/api/v1/kubernetes/network-flows?${scope}`, { cache: "no-store" }),
        fetch(`/api/v1/kubernetes/supply-chain?${scope}`, { cache: "no-store" }),
      ]);
      const [runtime, network, supply] = await Promise.all([
        runtimeResponse.json(), networkResponse.json(), supplyResponse.json(),
      ]) as [
        { events?: readonly NormalizedFalcoRuntimeEvent[]; error?: { message?: string } },
        { flows?: readonly NormalizedHubbleFlow[]; error?: { message?: string } },
        { evidence?: readonly KubernetesSupplyChainEvidence[]; error?: { message?: string } },
      ];
      if (!runtimeResponse.ok || !networkResponse.ok || !supplyResponse.ok) {
        throw new Error(runtime.error?.message ?? network.error?.message ?? supply.error?.message ?? "Context signal APIs are unavailable");
      }
      setSignals({
        runtimeEvents: runtime.events ?? [],
        networkFlows: network.flows ?? [],
        supplyChainEvidence: supply.evidence ?? [],
      });
      setSignalError(null);
    } catch (caught) {
      setSignals({ runtimeEvents: [], networkFlows: [], supplyChainEvidence: [] });
      setSignalError(caught instanceof Error ? caught.message : "Context signal APIs are unavailable");
    } finally {
      setSignalLoading(false);
    }
  }, [cluster, connectionId]);
  useEffect(() => {
    const task = window.setTimeout(() => void refreshSignals(), 0);
    return () => window.clearTimeout(task);
  }, [refreshSignals]);

  const report = useMemo(() => {
    const projection = buildKubernetesProjection(kubernetes.projectionInput);
    const workloadByKey = new Map<string, { namespace: string | null; name: string }>();
    for (const record of projection.records) {
      if (record.category === "workload") {
        workloadByKey.set(record.resource.resourceKey, { namespace: record.namespace, name: record.displayName });
      }
    }
    const paths = buildKubernetesAttackPaths({
      resources: kubernetes.projectionInput.resources,
      relationships: kubernetes.projectionInput.relationships,
      findings: kubernetes.projectionInput.findings,
      ...signals,
    }).paths;
    // Exposure is derived from the attack-path graph, which already links an
    // internet / load-balancer / exposure entry to the workload it fronts.
    const exposures: IssueExposureInput[] = [];
    for (const path of paths) {
      const entry = path.nodes.find((node) => node.kind === "internet")
        ?? path.nodes.find((node) => node.kind === "load_balancer")
        ?? path.nodes.find((node) => node.kind === "kubernetes_exposure");
      if (entry === undefined) continue;
      const kind: IssueExposureInput["kind"] = entry.kind === "internet" ? "internet"
        : entry.kind === "load_balancer" ? "load_balancer" : "service";
      for (const node of path.nodes) {
        if (node.kind !== "kubernetes_workload" || node.resourceKey === null) continue;
        const workload = workloadByKey.get(node.resourceKey);
        if (workload === undefined) continue;
        exposures.push({ workload, kind, evidence: `${entry.label} → ${node.label} (${path.title})` });
      }
    }

    const scanner = kubernetes.workspace?.scannerEvidence.findings ?? [];
    const posture = kubernetes.workspace?.findings ?? [];
    return buildKubernetesIssues({
      vulnerabilities: scanner
        .filter((finding) => finding.severity !== "unknown" && finding.affectedResource.name !== null)
        .map((finding) => ({
          workload: { namespace: finding.affectedResource.namespace, name: finding.affectedResource.name as string },
          severity: finding.severity as IssueSeverity,
          cveId: finding.cveId,
          title: finding.title,
          fixedVersion: finding.fixedVersion,
          packageName: finding.packageName,
        })),
      posture: posture
        .filter((finding) => finding.state === "FAIL")
        .flatMap((finding) => {
          const workload = parsePostureSubject(finding.subject);
          return workload === null ? [] : [{ workload, controlId: finding.controlId, severity: finding.severity, message: finding.message }];
        }),
      exposures,
      flows: signals.networkFlows
        .filter((flow) => flow.destination.workloadName !== null)
        .map((flow) => ({
          workload: { namespace: flow.destination.namespace, name: flow.destination.workloadName as string },
          fromExternal: flow.source.world,
          verdict: flow.verdict,
          observedAt: flow.observedAt,
        })),
      runtime: signals.runtimeEvents
        .filter((event) => event.podName !== null)
        .map((event) => ({
          workload: { namespace: event.namespace, name: podToWorkloadName(event.podName as string) },
          rule: event.rule,
          priority: event.priority,
          observedAt: event.occurredAt,
        })),
    });
  }, [kubernetes.projectionInput, kubernetes.workspace, signals]);

  const issues = severityFilter === "all" ? report.issues : report.issues.filter((issue) => issue.severity === severityFilter);

  const downloadIssues = useCallback((format: "csv" | "json") => {
    const body = format === "json"
      ? JSON.stringify(report, null, 2)
      : ["priority,severity,reachability,runtime_observed,title,workload,recommendation",
        ...report.issues.map((issue) => [
          issue.priority, issue.severity, issue.reachability, issue.runtimeObserved, issue.title, issue.workload, issue.recommendation,
        ].map((cell) => {
          const text = String(cell);
          return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
        }).join(","))].join("\r\n");
    const blob = new Blob([body], { type: format === "csv" ? "text/csv" : "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `sutra-kubernetes-issues.${format}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
  }, [report]);

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Kubernetes · Contextual security</p><h1>Issues</h1><p className="page-subtitle">Deduplicated toxic combinations ranked by real signal, not CVE count. Reachability is confirmed only from observed traffic, and priority rises with runtime activity — so the handful that are actually reachable and active surface above dormant criticals.</p></div>
        <div className="heading-actions">
          <button className="button button-secondary" disabled={report.issues.length === 0} onClick={() => downloadIssues("csv")} type="button">Export CSV</button>
          <Link className="button button-secondary" href="/kubernetes/attack-paths">Security graph</Link>
          <button className="button button-primary" disabled={signalLoading} onClick={() => { void refresh(); void kubernetes.refresh(); void refreshSignals(); }} type="button">{signalLoading ? "Refreshing…" : "Refresh"}</button>
        </div>
      </section>
      <div className="trust-strip" role="note"><span className="trust-icon">!</span><span>{report.disclaimer}</span></div>

      {error || kubernetes.error ? <div className="page-alert page-alert-error" role="alert"><strong>Issue evidence unavailable</strong><span>{error ?? kubernetes.error}</span><button onClick={() => { void refresh(); void kubernetes.refresh(); }} type="button">Retry</button></div> : null}
      {signalError ? <div className="page-alert page-alert-warning" role="status"><strong>Runtime and network signals unavailable</strong><span>{signalError}. Vulnerability and posture issues remain; no runtime or reachability signal is inferred.</span><button onClick={() => void refreshSignals()} type="button">Retry signals</button></div> : null}
      {loading || kubernetes.loading || signalLoading ? <div className="loading-state" role="status"><span className="loading-spinner" />Correlating issues…</div> : null}

      {!loading && !kubernetes.loading && !signalLoading ? <>
        <section className="inventory-stats">
          <article><small>Open issues</small><strong>{report.totals.issues}</strong><span>{report.totals.critical} critical · {report.totals.high} high</span></article>
          <article><small>Confirmed reachable</small><strong>{report.totals.confirmedReachable}</strong><span>External traffic observed</span></article>
          <article><small>Runtime active</small><strong>{report.totals.runtimeObserved}</strong><span>Falco activity observed</span></article>
          <article><small>Lower priority</small><strong>{report.totals.medium + report.totals.low}</strong><span>Medium and low severity</span></article>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div><p className="eyebrow">Ranked by exploitability signal</p><h2>Prioritized issues</h2></div>
            <div className="heading-actions">
              <label><span className="sr-only">Filter severity</span><select className="filter-control" value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value as IssueSeverity | "all")}><option value="all">All severities</option><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
              <button className="button button-secondary" disabled={report.issues.length === 0} onClick={() => downloadIssues("json")} type="button">Export JSON</button>
            </div>
          </div>
          {issues.length > 0 ? <div className="issue-list">
            {issues.map((issue, index) => <article className="issue-card" key={issue.id}>
              <div className="issue-head">
                <span className="issue-rank">{index + 1}</span>
                <span className={`severity-badge severity-${issue.severity}`}>{issue.severity}</span>
                <div className="issue-title"><strong>{issue.title}</strong><small>{issue.workload}</small></div>
                <div className="issue-priority"><strong>{issue.priority}</strong><small>priority</small></div>
              </div>
              <div className="issue-chips">
                <span className={`compliance-status ${reachabilityPill(issue.reachability)}`}>{REACHABILITY_LABEL[issue.reachability]}</span>
                {issue.runtimeObserved ? <span className="compliance-status compliance-status-fail">Runtime active</span> : null}
              </div>
              <ul className="issue-factors">
                {issue.factors.map((factor, factorIndex) => <li key={`${issue.id}:${factorIndex}`}><b>{factor.kind}</b> {factor.detail}</li>)}
              </ul>
              <p className="issue-reco"><strong>Recommendation:</strong> {issue.recommendation}</p>
            </article>)}
          </div> : <section className="empty-workspace compact-empty"><span className="empty-workspace-icon">OK</span><h2>No prioritized issues</h2><p>No toxic combination is present in the current authorized evidence. This does not prove absence of risk; it may reflect collector, runtime, or network-flow coverage.</p></section>}
        </section>
        <p className="panel-footnote">Signals correlated: {report.totals.issues} issues from vulnerability, posture, exposure{signals.networkFlows.length > 0 ? ", observed network flow" : ""}{signals.runtimeEvents.length > 0 ? ", runtime" : ""} evidence{cluster ? ` for ${cluster.name}` : ""}.</p>
      </> : null}
    </>
  );
}

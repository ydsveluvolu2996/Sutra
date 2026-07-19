"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildKubernetesAttackPaths,
  type AttackPathType,
  type KubernetesAttackPath,
} from "../../../lib/kubernetes-attack-paths";
import type { JsonValue } from "../../../lib/pilot-types";
import type { NormalizedFalcoRuntimeEvent } from "../../../lib/falco-runtime-types";
import type { NormalizedHubbleFlow } from "../../../lib/hubble-flow-evidence";
import type { KubernetesSupplyChainEvidence } from "../../../lib/kubernetes-supply-chain";
import { usePilotState } from "../../components/use-pilot-state";
import { formatTimestamp } from "../../components/use-pilot-state";
import { useKubernetesEvidence } from "../use-kubernetes-evidence";
import { SecurityGraph } from "./security-graph";
import { buildKubernetesRiskQueue, toRiskQueueCsv } from "../../../lib/kubernetes-risk-queue";

const typeLabels: Readonly<Record<AttackPathType, string>> = {
  cloud_to_kubernetes: "Cloud → Kubernetes → AWS",
  rbac_privilege_escalation: "RBAC escalation",
  vulnerable_exposed_privileged_workload: "Exposure + vulnerability + privilege",
  runtime_to_aws_blast_radius: "Runtime → workload → AWS",
  observed_network_to_workload: "Observed network → workload",
  supply_chain_to_runtime: "Image digest → runtime",
};

function evidenceValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function PathCard({
  path,
  highlighted,
  onHighlight,
}: {
  readonly path: KubernetesAttackPath;
  readonly highlighted: boolean;
  readonly onHighlight: (pathId: string | null) => void;
}) {
  return (
    <article className="attack-path-card">
      <header>
        <div>
          <span className={`severity-badge severity-${path.risk}`}>{path.risk}</span>
          <p className="eyebrow">{typeLabels[path.type]}</p>
          <h2>{path.title}</h2>
        </div>
        <div className="attack-path-header-actions">
          <button
            type="button"
            className={`button ${highlighted ? "button-primary" : "button-secondary"}`}
            onClick={() => onHighlight(highlighted ? null : path.id)}
          >
            {highlighted ? "Highlighted in graph" : "Highlight in graph"}
          </button>
          <div className="attack-path-score"><strong>{path.score}</strong><span>/ 100</span><small>deterministic score</small></div>
        </div>
      </header>
      <div className="attack-path-flow" aria-label={`${path.title} evidence sequence`}>
        {path.nodes.map((node, index) => (
          <div className="attack-path-hop" key={`${path.id}:${node.key}`}>
            <div className={`attack-node attack-node-${node.kind}`}>
              <span>{node.kind.replaceAll("_", " ")}</span>
              <strong>{node.label}</strong>
              {node.resourceKey !== null ? <Link href={`/cmdb/resource?key=${encodeURIComponent(node.resourceKey)}`}>Source record</Link> : <small>Evidence-derived boundary</small>}
            </div>
            {index < path.edges.length ? <div className="attack-edge"><span>→</span><small>{path.edges[index]?.relation}</small></div> : null}
          </div>
        ))}
      </div>
      <div className="attack-path-detail-grid">
        <section>
          <h3>Why this score</h3>
          <div className="attack-factor-list">
            {path.factors.map((factor) => <div key={factor.key}><span>+{factor.points}</span><div><strong>{factor.label}</strong><small>{factor.evidence}</small></div></div>)}
            {path.factors.length === 0 ? <p className="panel-footnote">The explicit sequence has no configured risk factor.</p> : null}
          </div>
        </section>
        <section>
          <h3>Blast radius</h3>
          {path.blastRadius.length > 0 ? <ul>{path.blastRadius.map((node) => <li key={node.key}><Link href={`/cmdb/resource?key=${encodeURIComponent(node.key)}`}>{node.label}</Link><span>{node.kind.replaceAll("_", " ")}</span></li>)}</ul> : <p className="panel-footnote">No downstream AWS resource is established by this path.</p>}
        </section>
        <section>
          <h3>Operator-validated breaks</h3>
          {path.remediations.length > 0 ? <ul>{path.remediations.map((item) => <li key={item.key}><div><strong>{item.title}</strong><small>{item.guidance}</small></div><span>{item.breaksAt}</span></li>)}</ul> : <p className="panel-footnote">No bounded remediation suggestion is available for this evidence sequence.</p>}
          <p className="panel-footnote">Suggestions do not prove exploitability, successful mitigation or containment.</p>
        </section>
      </div>
      {path.observedFrom !== null ? <p className="panel-footnote attack-path-time">Timestamped evidence: {formatTimestamp(path.observedFrom)}{path.observedTo !== path.observedFrom ? ` → ${formatTimestamp(path.observedTo)}` : ""}. Untimestamped configuration edges remain snapshot-bound.</p> : null}
      <details className="attack-evidence">
        <summary>Inspect {path.edges.length} cited edges</summary>
        <div>
          {path.edges.map((edge, index) => <article key={`${path.id}:edge:${index}`}>
            <span>{index + 1}</span>
            <div>
              <strong>{edge.relation}</strong>
              <small>{edge.from} → {edge.to}</small>
              <code>{edge.evidence.source === "relationship"
                ? `relationship:${edge.evidence.relationType}`
                : `${edge.evidence.fieldPath} = ${evidenceValue(edge.evidence.observedValue)}`}</code>
              <small>Source: {edge.evidence.sourceResourceKey}</small>
              {edge.evidence.observedAt !== null ? <small>Observed: {formatTimestamp(edge.evidence.observedAt)} · SHA-256 {edge.evidence.evidenceSha256?.slice(0, 12)}</small> : null}
            </div>
          </article>)}
        </div>
      </details>
    </article>
  );
}

export function AttackPathsWorkspace() {
  const { state, loading, error, refresh } = usePilotState();
  const kubernetes = useKubernetesEvidence(state);
  const cluster = kubernetes.clusters.find((item) => item.status === "active") ?? null;
  const connectionId = state?.connection?.id ?? null;
  const [type, setType] = useState<AttackPathType | "all">("all");
  const [selectedPathId, setSelectedPathId] = useState<string | null>(null);
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
  const projection = useMemo(() => buildKubernetesAttackPaths({
    resources: kubernetes.projectionInput.resources,
    relationships: kubernetes.projectionInput.relationships,
    findings: kubernetes.projectionInput.findings,
    ...signals,
  }), [kubernetes.projectionInput, signals]);
  const riskQueue = useMemo(() => buildKubernetesRiskQueue({
    attackPaths: projection.paths,
    postureFindings: (kubernetes.workspace?.findings ?? []).map((finding) => ({
      controlId: finding.controlId,
      subject: finding.subject,
      state: finding.state,
      severity: finding.severity,
      message: finding.message,
    })),
    scannerFindings: (kubernetes.workspace?.scannerEvidence.findings ?? []).map((finding) => ({
      fingerprint: finding.fingerprint,
      severity: finding.severity,
      title: finding.title,
      cveId: finding.cveId,
      checkId: finding.checkId,
      fixedVersion: finding.fixedVersion,
      packageName: finding.packageName,
      affectedResource: { namespace: finding.affectedResource.namespace, name: finding.affectedResource.name },
    })),
  }), [projection.paths, kubernetes.workspace]);
  const downloadRiskQueue = useCallback((format: "csv" | "json") => {
    const body = format === "csv" ? toRiskQueueCsv(riskQueue) : JSON.stringify(riskQueue, null, 2);
    const blob = new Blob([body], { type: format === "csv" ? "text/csv" : "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `sutra-kubernetes-risk-queue.${format}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
  }, [riskQueue]);
  const paths = type === "all" ? projection.paths : projection.paths.filter((path) => path.type === type);
  const critical = projection.paths.filter((path) => path.risk === "critical").length;
  const evidencedEdges = new Set(projection.paths.flatMap((path) =>
    path.edges.map((edge) => `${edge.from}\n${edge.to}\n${edge.relation}`),
  )).size;

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Kubernetes · Contextual security</p><h1>Attack paths & blast radius</h1><p className="page-subtitle">Trace explicit cloud, Kubernetes identity, RBAC and AWS relationships. Every displayed hop links to normalized relationship or configuration evidence.</p></div>
        <div className="heading-actions"><Link className="button button-secondary" href="/kubernetes/security">Security findings</Link><Link className="button button-primary" href="/kubernetes">Kubernetes overview</Link></div>
      </section>
      <div className="trust-strip" role="note"><span className="trust-icon">E</span><span><strong>Evidence graph, not simulated reachability.</strong> Sutra follows directed relationships and a narrow set of exact configuration references. Missing, reversed, or ambiguous links stop a path. Scores use visible fixed factors and are not ML predictions.</span></div>
      {error || kubernetes.error ? <div className="page-alert page-alert-error" role="alert"><strong>Attack-path evidence unavailable</strong><span>{error ?? kubernetes.error}</span><button onClick={() => { void refresh(); void kubernetes.refresh(); }} type="button">Retry</button></div> : null}
      {signalError ? <div className="page-alert page-alert-warning" role="status"><strong>Context signal correlation unavailable</strong><span>{signalError}. Snapshot-only paths remain visible and no missing signal is inferred.</span><button onClick={() => void refreshSignals()} type="button">Retry signals</button></div> : null}
      {loading || kubernetes.loading || signalLoading ? <div className="loading-state" role="status"><span className="loading-spinner" />Building authorized evidence graph…</div> : null}
      {!loading && !kubernetes.loading && !signalLoading ? <>
        <section className="inventory-stats">
          <article><small>Evidenced paths</small><strong>{projection.paths.length}</strong><span>Complete supported sequences only</span></article>
          <article><small>Critical paths</small><strong>{critical}</strong><span>Score 80 or above</span></article>
          <article><small>Cited edges</small><strong>{evidencedEdges}</strong><span>Used by displayed paths</span></article>
          <article><small>Correlated signals</small><strong>{projection.correlatedRuntimeEventCount + projection.correlatedNetworkFlowCount + projection.correlatedSupplyChainEvidenceCount}</strong><span>{projection.correlatedRuntimeEventCount} runtime · {projection.correlatedNetworkFlowCount} flow · {projection.correlatedSupplyChainEvidenceCount} image</span></article>
        </section>
        <section className="panel attack-path-workspace">
          <div className="panel-heading">
            <div><p className="eyebrow">Prioritized remediation queue</p><h2>Triage worklist</h2></div>
            <div className="heading-actions">
              <span className="result-count">{riskQueue.totals.items} item{riskQueue.totals.items === 1 ? "" : "s"}</span>
              <button className="button button-secondary" disabled={riskQueue.totals.items === 0} onClick={() => downloadRiskQueue("csv")} type="button">Export CSV</button>
              <button className="button button-secondary" disabled={riskQueue.totals.items === 0} onClick={() => downloadRiskQueue("json")} type="button">Export JSON</button>
            </div>
          </div>
          <div className="trust-strip" role="note"><span className="trust-icon">Q</span><span>{riskQueue.disclaimer}</span></div>
          {riskQueue.items.length > 0 ? <div className="risk-queue-list">
            {riskQueue.items.slice(0, 50).map((item, index) => <article className="risk-queue-item" key={item.id}>
              <span className="risk-queue-rank">{index + 1}</span>
              <span className={`severity-badge severity-${item.severity}`}>{item.severity}</span>
              <div className="risk-queue-body">
                <strong>{item.title}</strong>
                <small>{item.source.replaceAll("_", " ")} · {item.subject}{item.blastRadius > 0 ? ` · blast radius ${item.blastRadius}` : ""}</small>
                <span>{item.recommendation}</span>
              </div>
              <div className="risk-queue-priority"><strong>{item.priority}</strong><small>priority</small></div>
            </article>)}
          </div> : <div className="empty-state"><strong>No prioritized risks in the current evidence</strong><span>No attack path, failing posture control, or scanner finding is present. This does not prove absence of risk; it may reflect collector coverage.</span></div>}
          {riskQueue.items.length > 50 ? <p className="panel-footnote">Showing the top 50 of {riskQueue.items.length} ranked items; export for the full list.</p> : null}
        </section>
        <section className="panel attack-path-workspace">
          <div className="panel-heading">
            <div><p className="eyebrow">Interactive evidence graph</p><h2>Security graph</h2></div>
            <span className="result-count">Click an entity to inspect its findings and cited edges; search or switch to the table.</span>
          </div>
          <SecurityGraph paths={paths} findings={kubernetes.projectionInput.findings} selectedPathId={selectedPathId} onSelectPath={setSelectedPathId} />
        </section>
        <section className="panel attack-path-workspace">
          <div className="panel-heading">
            <div><p className="eyebrow">Authorized snapshot</p><h2>Contextual risk sequences</h2></div>
            <label><span className="sr-only">Filter path type</span><select className="filter-control" value={type} onChange={(event) => setType(event.target.value as AttackPathType | "all")}><option value="all">All path types</option>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          </div>
          {paths.length > 0 ? <div className="attack-path-list">{paths.map((path) => <PathCard key={path.id} path={path} highlighted={selectedPathId === path.id} onHighlight={setSelectedPathId} />)}</div> : <section className="empty-workspace compact-empty"><span className="empty-workspace-icon">G</span><h2>No complete evidenced paths</h2><p>No supported end-to-end sequence is established in the current authorized snapshot. This does not prove absence of risk; it may reflect collector or relationship coverage.</p></section>}
          {projection.unknowns.length > 0 ? <section className="attack-unknowns"><h3>Evidence gaps</h3><ul>{projection.unknowns.map((unknown) => <li key={unknown}>{unknown}</li>)}</ul></section> : null}
        </section>
      </> : null}
    </>
  );
}

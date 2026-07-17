"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  buildKubernetesAttackPaths,
  type AttackPathType,
  type KubernetesAttackPath,
} from "../../../lib/kubernetes-attack-paths";
import type { JsonValue } from "../../../lib/pilot-types";
import { usePilotState } from "../../components/use-pilot-state";

const typeLabels: Readonly<Record<AttackPathType, string>> = {
  cloud_to_kubernetes: "Cloud → Kubernetes → AWS",
  rbac_privilege_escalation: "RBAC escalation",
  vulnerable_exposed_privileged_workload: "Exposure + vulnerability + privilege",
};

function evidenceValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function PathCard({ path }: { readonly path: KubernetesAttackPath }) {
  return (
    <article className="attack-path-card">
      <header>
        <div>
          <span className={`severity-badge severity-${path.risk}`}>{path.risk}</span>
          <p className="eyebrow">{typeLabels[path.type]}</p>
          <h2>{path.title}</h2>
        </div>
        <div className="attack-path-score"><strong>{path.score}</strong><span>/ 100</span><small>deterministic score</small></div>
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
      </div>
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
            </div>
          </article>)}
        </div>
      </details>
    </article>
  );
}

export function AttackPathsWorkspace() {
  const { state, loading, error, refresh } = usePilotState();
  const [type, setType] = useState<AttackPathType | "all">("all");
  const projection = useMemo(() => buildKubernetesAttackPaths({
    resources: state?.resources ?? [],
    relationships: state?.relationships ?? [],
    findings: state?.findings ?? [],
  }), [state?.findings, state?.relationships, state?.resources]);
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
      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Attack-path evidence unavailable</strong><span>{error}</span><button onClick={() => void refresh()} type="button">Retry</button></div> : null}
      {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Building authorized evidence graph…</div> : null}
      {!loading ? <>
        <section className="inventory-stats">
          <article><small>Evidenced paths</small><strong>{projection.paths.length}</strong><span>Complete supported sequences only</span></article>
          <article><small>Critical paths</small><strong>{critical}</strong><span>Score 80 or above</span></article>
          <article><small>Cited edges</small><strong>{evidencedEdges}</strong><span>Used by displayed paths</span></article>
          <article><small>AWS blast radius</small><strong>{projection.blastRadiusResourceCount}</strong><span>Unique explicit downstream resources</span></article>
        </section>
        <section className="panel attack-path-workspace">
          <div className="panel-heading">
            <div><p className="eyebrow">Authorized snapshot</p><h2>Contextual risk sequences</h2></div>
            <label><span className="sr-only">Filter path type</span><select className="filter-control" value={type} onChange={(event) => setType(event.target.value as AttackPathType | "all")}><option value="all">All path types</option>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          </div>
          {paths.length > 0 ? <div className="attack-path-list">{paths.map((path) => <PathCard key={path.id} path={path} />)}</div> : <section className="empty-workspace compact-empty"><span className="empty-workspace-icon">G</span><h2>No complete evidenced paths</h2><p>No supported end-to-end sequence is established in the current authorized snapshot. This does not prove absence of risk; it may reflect collector or relationship coverage.</p></section>}
          {projection.unknowns.length > 0 ? <section className="attack-unknowns"><h3>Evidence gaps</h3><ul>{projection.unknowns.map((unknown) => <li key={unknown}>{unknown}</li>)}</ul></section> : null}
        </section>
      </> : null}
    </>
  );
}

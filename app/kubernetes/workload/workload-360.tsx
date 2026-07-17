"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { JsonValue } from "../../../lib/pilot-types";
import { compactIdentifier, formatTimestamp, usePilotState } from "../../components/use-pilot-state";
import { buildKubernetesProjection } from "../kubernetes-projection";
import { useKubernetesEvidence } from "../use-kubernetes-evidence";

function renderValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function Workload360({ resourceKey }: { readonly resourceKey: string }) {
  const { state, loading, error, refresh } = usePilotState();
  const kubernetes = useKubernetesEvidence(state);
  const projection = useMemo(() => buildKubernetesProjection({
    resources: kubernetes.projectionInput.resources,
    relationships: kubernetes.projectionInput.relationships,
    findings: kubernetes.projectionInput.findings,
    coverage: kubernetes.projectionInput.coverage,
  }), [kubernetes.projectionInput]);
  const record = projection.records.find((candidate) =>
    candidate.resource.resourceKey === resourceKey && candidate.category === "workload",
  ) ?? null;
  const relatedKeys = new Set(kubernetes.projectionInput.relationships.flatMap((relationship) => {
    if (relationship.fromResourceKey === resourceKey) return [relationship.toResourceKey];
    if (relationship.toResourceKey === resourceKey) return [relationship.fromResourceKey];
    return [];
  }));
  const related = kubernetes.projectionInput.resources.filter((resource) => relatedKeys.has(resource.resourceKey));

  return (
    <>
      {error || kubernetes.error ? <div className="page-alert page-alert-error" role="alert"><strong>Workload evidence unavailable</strong><span>{error ?? kubernetes.error}</span><button onClick={() => { void refresh(); void kubernetes.refresh(); }} type="button">Retry</button></div> : null}
      {loading || kubernetes.loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading Workload 360…</div> : null}
      {!loading && !kubernetes.loading && record === null ? <section className="panel empty-workspace"><span className="empty-workspace-icon">404</span><h2>Normalized workload not found</h2><p>The resource may be outside the authorized customer scope, absent from the active snapshot, or not explicitly typed as a Kubernetes workload.</p><Link className="button button-primary" href="/kubernetes/workloads">Return to workloads</Link></section> : null}
      {record ? <>
        <section className="page-heading">
          <div><p className="eyebrow">Kubernetes · Workload 360</p><h1>{record.displayName}</h1><p className="page-subtitle">{record.kind} · {record.clusterName ?? "Cluster not reported"} · {record.namespace ?? "Namespace not reported"}</p></div>
          <div className="heading-actions"><Link className="button button-secondary" href="/kubernetes/workloads">All workloads</Link><Link className="button button-primary" href={`/cmdb/resource?key=${encodeURIComponent(record.resource.resourceKey)}`}>Source CMDB record</Link></div>
        </section>
        <div className="trust-strip" role="note"><span className="trust-icon">W</span><span><strong>Snapshot-bound resource view.</strong> Configuration, relationships and findings below come from the same authorized normalized projection. No live pod query, logs, exec, secrets, packages or runtime events are requested.</span></div>
        <section className="inventory-stats">
          <article><small>Attached findings</small><strong>{record.findings.length}</strong><span>{record.highestSeverity ?? "No attached severity"}</span></article>
          <article><small>Relationships</small><strong>{record.relationshipCount}</strong><span>{related.length} related records visible</span></article>
          <article><small>Lifecycle state</small><strong className="kubernetes-workload-state">{record.resource.state || "observed"}</strong><span>Reported by source API</span></article>
          <article><small>Collected</small><strong className="kubernetes-workload-time">{formatTimestamp(record.resource.source.collectedAt)}</strong><span>{record.resource.source.api}</span></article>
        </section>
        <div className="kubernetes-workload-grid">
          <section className="panel">
            <div className="panel-heading"><div><p className="eyebrow">Reported configuration</p><h2>Workload metadata</h2></div><span className="status-pill">{Object.keys(record.resource.configuration).length} fields</span></div>
            <dl className="kubernetes-configuration-list">{Object.entries(record.resource.configuration).map(([key, value]) => <div key={key}><dt>{key}</dt><dd title={renderValue(value)}>{compactIdentifier(renderValue(value), 72)}</dd></div>)}</dl>
            {Object.keys(record.resource.configuration).length === 0 ? <div className="empty-state"><strong>No configuration reported</strong><span>Collector coverage determines available fields.</span></div> : null}
          </section>
          <section className="panel">
            <div className="panel-heading"><div><p className="eyebrow">Asset graph</p><h2>Related resources</h2></div><span className="status-pill">{related.length} visible</span></div>
            <div className="kubernetes-related-list">{related.map((resource) => <article key={resource.resourceKey}><div><strong>{resource.name ?? resource.nativeId}</strong><small>{resource.resourceType} · {resource.region}</small></div><Link href={`/cmdb/resource?key=${encodeURIComponent(resource.resourceKey)}`}>Open →</Link></article>)}{related.length === 0 ? <div className="empty-state"><strong>No relationships reported</strong><span>Absence may reflect collector coverage rather than isolation.</span></div> : null}</div>
          </section>
        </div>
        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">Security workload</p><h2>Attached normalized findings</h2></div><Link className="text-link" href="/kubernetes/security">Kubernetes security →</Link></div>
          <div className="kubernetes-finding-rows">{record.findings.map((finding) => <article key={finding.fingerprint}><span className={`severity-badge severity-${finding.severity}`}>{finding.severity}</span><div><strong>{finding.title}</strong><small>{finding.controlKey} · {finding.status}</small></div><p>{finding.summary}</p></article>)}{record.findings.length === 0 ? <div className="empty-state"><strong>No findings attached to this workload</strong><span>This does not establish vulnerability or runtime safety; review source coverage.</span></div> : null}</div>
        </section>
      </> : null}
    </>
  );
}

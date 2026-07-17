"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { FindingSeverity, JsonValue, PilotFinding } from "../../lib/pilot-types";
import { compactIdentifier, formatTimestamp, snapshotOriginLabel, usePilotState } from "../components/use-pilot-state";
import {
  buildKubernetesProjection,
  type KubernetesCategory,
  type KubernetesResourceRecord,
} from "./kubernetes-projection";
import { useKubernetesEvidence } from "./use-kubernetes-evidence";

export type KubernetesView = "overview" | "inventory" | "security";

const severityOrder: readonly FindingSeverity[] = ["critical", "high", "medium", "low", "informational"];
const categoryOrder: readonly KubernetesCategory[] = ["cluster", "namespace", "workload", "node", "network", "access", "other"];

function evidenceValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function KubernetesTabs({ active }: { readonly active: KubernetesView }) {
  return (
    <nav className="kubernetes-tabs" aria-label="Kubernetes workspace sections">
      <Link aria-current={active === "overview" ? "page" : undefined} href="/kubernetes">Overview</Link>
      <Link aria-current={active === "inventory" ? "page" : undefined} href="/kubernetes/inventory">Inventory</Link>
      <Link aria-current={active === "security" ? "page" : undefined} href="/kubernetes/security">Security</Link>
    </nav>
  );
}

function EmptyKubernetesEvidence({ connected }: { readonly connected: boolean }) {
  return (
    <section className="panel empty-workspace kubernetes-empty">
      <span className="empty-workspace-icon">K8s</span>
      <h2>{connected ? "Kubernetes evidence is not collected yet" : "Connect an AWS account before Kubernetes discovery"}</h2>
      <p>{connected
        ? "The active normalized snapshot contains no Kubernetes or EKS resources, and no Kubernetes collector coverage was recorded. Sutra does not infer clusters from unrelated EC2 resources."
        : "AWS trust-role onboarding establishes the customer boundary. Kubernetes inventory still requires an approved EKS/Kubernetes metadata collector and permission pack."}</p>
      <div className="heading-actions">
        <Link className="button button-primary" href="/onboard">{connected ? "Review AWS connection" : "Onboard AWS account"}</Link>
        <Link className="button button-secondary" href="/roadmap">Review collector roadmap</Link>
      </div>
    </section>
  );
}

function ResourceDetails({ record }: { readonly record: KubernetesResourceRecord }) {
  const configuration = Object.entries(record.resource.configuration).slice(0, 8);
  return (
    <details className="kubernetes-resource-card">
      <summary>
        <span className="kubernetes-kind">{record.kind}</span>
        <span><strong>{record.displayName}</strong><small>{record.clusterName ?? "Cluster not reported"} · {record.namespace ?? "Namespace not reported"}</small></span>
        <span className={`resource-state${record.highestSeverity ? " kubernetes-risk" : ""}`}>{record.highestSeverity ?? record.resource.state ?? "observed"}</span>
        <span className="finding-chevron">⌄</span>
      </summary>
      <div className="kubernetes-resource-detail">
        <dl>
          <div><dt>Normalized type</dt><dd>{record.resource.resourceType}</dd></div>
          <div><dt>Region</dt><dd>{record.resource.region}</dd></div>
          <div><dt>Relationships</dt><dd>{record.relationshipCount}</dd></div>
          <div><dt>Findings</dt><dd>{record.findings.length}</dd></div>
          <div><dt>Observed via</dt><dd>{record.resource.source.api}</dd></div>
          <div><dt>Collected</dt><dd>{formatTimestamp(record.resource.source.collectedAt)}</dd></div>
        </dl>
        <div>
          <p className="eyebrow">Reported configuration</p>
          {configuration.length > 0 ? <dl>{configuration.map(([key, value]) => <div key={key}><dt>{key}</dt><dd title={evidenceValue(value)}>{compactIdentifier(evidenceValue(value), 48)}</dd></div>)}</dl> : <p className="panel-footnote">No configuration fields were reported.</p>}
        </div>
        <div className="kubernetes-detail-actions">
          {record.category === "workload" ? <Link className="text-link" href={`/kubernetes/workload/${encodeURIComponent(record.resource.resourceKey)}`}>Open Workload 360 →</Link> : null}
          <Link className="text-link" href={`/cmdb/resource?key=${encodeURIComponent(record.resource.resourceKey)}`}>Open Resource 360 →</Link>
          {record.findings.length > 0 ? <Link className="text-link" href="/kubernetes/security">Review security findings →</Link> : null}
        </div>
      </div>
    </details>
  );
}

function Overview({
  projection,
}: {
  readonly projection: ReturnType<typeof buildKubernetesProjection>;
}) {
  const openFindings = projection.findings.filter((finding) => finding.status === "open");
  const observedClusterRecords = projection.records.filter((record) => record.category === "cluster");
  return (
    <>
      <section className="inventory-stats">
        <article><small>Observed clusters</small><strong>{projection.categoryCounts.cluster}</strong><span>Normalized cluster resource records only</span></article>
        <article><small>Namespaces</small><strong>{projection.categoryCounts.namespace}</strong><span>{projection.namespaces.length} named in metadata</span></article>
        <article><small>Workloads</small><strong>{projection.categoryCounts.workload}</strong><span>Reported workload objects</span></article>
        <article><small>Open findings</small><strong>{openFindings.length}</strong><span>{openFindings.filter((finding) => finding.severity === "critical" || finding.severity === "high").length} critical or high</span></article>
      </section>

      <section className="panel kubernetes-cluster-panel">
        <div className="panel-heading"><div><p className="eyebrow">Cluster drilldown</p><h2>Observed cluster resources</h2></div><Link className="text-link" href="/kubernetes/inventory">Open full inventory →</Link></div>
        {observedClusterRecords.length > 0 ? <div className="kubernetes-cluster-grid">{observedClusterRecords.map((cluster) => {
          const related = projection.records.filter((record) => record.clusterName === cluster.displayName);
          return <article key={cluster.resource.resourceKey}>
            <div><span className="kubernetes-kind">{cluster.kind}</span><span className={`connection-status connection-${cluster.findings.length > 0 ? "pending" : "active"}`}>{cluster.findings.length} findings</span></div>
            <h3>{cluster.displayName}</h3>
            <p>{cluster.resource.region} · {cluster.resource.source.accountId}</p>
            <dl><div><dt>Namespaces</dt><dd>{new Set(related.map((record) => record.namespace).filter(Boolean)).size}</dd></div><div><dt>Workloads</dt><dd>{related.filter((record) => record.category === "workload").length}</dd></div><div><dt>Graph edges</dt><dd>{cluster.relationshipCount}</dd></div></dl>
            <details><summary>Show related resources</summary><ul>{related.slice(0, 8).map((record) => <li key={record.resource.resourceKey}><Link href={`/cmdb/resource?key=${encodeURIComponent(record.resource.resourceKey)}`}>{record.kind} · {record.displayName}</Link></li>)}</ul></details>
          </article>;
        })}</div> : <div className="empty-state"><strong>No cluster resource record was reported</strong><span>Workload metadata may name a cluster, but Sutra does not promote that identifier to a discovered cluster asset.</span></div>}
      </section>
    </>
  );
}

function Inventory({
  projection,
}: {
  readonly projection: ReturnType<typeof buildKubernetesProjection>;
}) {
  const [query, setQuery] = useState("");
  const [cluster, setCluster] = useState("all");
  const [namespace, setNamespace] = useState("all");
  const [category, setCategory] = useState("all");
  const filtered = useMemo(() => projection.records.filter((record) => {
    const haystack = `${record.displayName} ${record.kind} ${record.resource.nativeId} ${record.resource.resourceType} ${record.clusterName ?? ""} ${record.namespace ?? ""}`.toLocaleLowerCase("en-US");
    return haystack.includes(query.toLocaleLowerCase("en-US")) &&
      (cluster === "all" || record.clusterName === cluster) &&
      (namespace === "all" || record.namespace === namespace) &&
      (category === "all" || record.category === category);
  }), [category, cluster, namespace, projection.records, query]);
  return (
    <section className="panel kubernetes-inventory">
      <div className="panel-heading"><div><p className="eyebrow">Normalized workload inventory</p><h2>Clusters, namespaces and workloads</h2></div><span className="result-count">{filtered.length} of {projection.records.length} records</span></div>
      <div className="kubernetes-filter-bar">
        <label className="search-field"><span className="sr-only">Search Kubernetes resources</span><input className="filter-control" placeholder="Search kind, name, type or identifier" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <label><span className="sr-only">Filter cluster</span><select className="filter-control" value={cluster} onChange={(event) => setCluster(event.target.value)}><option value="all">All reported clusters</option>{projection.clusters.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><span className="sr-only">Filter namespace</span><select className="filter-control" value={namespace} onChange={(event) => setNamespace(event.target.value)}><option value="all">All namespaces</option>{projection.namespaces.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><span className="sr-only">Filter kind category</span><select className="filter-control" value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">All categories</option>{categoryOrder.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      </div>
      <div className="kubernetes-resource-list">
        {filtered.map((record) => <ResourceDetails key={record.resource.resourceKey} record={record} />)}
        {filtered.length === 0 ? <div className="empty-state"><strong>No matching Kubernetes records</strong><span>Adjust the filters or review collector coverage.</span></div> : null}
      </div>
    </section>
  );
}

function FindingRow({ finding, record }: { readonly finding: PilotFinding; readonly record: KubernetesResourceRecord | undefined }) {
  return (
    <details className="finding-item">
      <summary>
        <span className={`severity-badge severity-${finding.severity}`}>{finding.severity}</span>
        <span className="finding-title"><strong>{finding.title}</strong><small>{record ? `${record.kind} · ${record.displayName}` : "Normalized Kubernetes resource"}</small></span>
        <span className="finding-scope"><strong>{record?.clusterName ?? "Cluster not reported"}</strong><small>{record?.namespace ?? "Namespace not reported"}</small></span>
        <span className="finding-service">{finding.status}</span>
        <span className="finding-chevron">⌄</span>
      </summary>
      <div className="finding-detail">
        <div><p className="eyebrow">Observation</p><p>{finding.summary}</p><p className="limitation-note">Control {finding.controlKey} · evaluated {formatTimestamp(finding.evaluatedAt)}</p></div>
        <div><p className="eyebrow">Normalized evidence</p><dl>{Object.entries(finding.evidence).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{compactIdentifier(evidenceValue(value), 42)}</dd></div>)}</dl></div>
        <div><p className="eyebrow">Suggested remediation</p><p>{finding.remediation}</p>{record ? <Link className="text-link" href={`/cmdb/resource?key=${encodeURIComponent(record.resource.resourceKey)}`}>Open affected resource →</Link> : null}</div>
      </div>
    </details>
  );
}

function Security({
  projection,
}: {
  readonly projection: ReturnType<typeof buildKubernetesProjection>;
}) {
  const [severity, setSeverity] = useState("all");
  const [status, setStatus] = useState("open");
  const recordsByKey = useMemo(() => new Map(projection.records.map((record) => [record.resource.resourceKey, record])), [projection.records]);
  const filtered = projection.findings.filter((finding) =>
    (severity === "all" || finding.severity === severity) &&
    (status === "all" || finding.status === status),
  );
  return (
    <>
      <div className="trust-strip" role="note"><span className="trust-icon">i</span><span><strong>No synthetic vulnerability claims.</strong> This view shows only findings attached to normalized Kubernetes resource keys. Sutra does not create CVEs, package vulnerabilities, runtime detections, or admission-control results when those sources are absent.</span></div>
      <section className="finding-summary">
        {severityOrder.slice(0, 4).map((value) => <article key={value}><span className={`severity-dot severity-${value}`} /><small>{value}</small><strong>{projection.findings.filter((finding) => finding.status === "open" && finding.severity === value).length}</strong></article>)}
        <article><span className="severity-dot severity-info" /><small>Affected resources</small><strong>{new Set(projection.findings.map((finding) => finding.resourceKey)).size}</strong></article>
      </section>
      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">Evidence-backed security queue</p><h2>Kubernetes findings</h2></div><span className="result-count">{filtered.length} findings</span></div>
        <div className="filter-bar">
          <span />
          <label><span className="sr-only">Filter severity</span><select className="filter-control" value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="all">All severities</option>{severityOrder.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label><span className="sr-only">Filter status</span><select className="filter-control" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All states</option><option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="suppressed">Suppressed</option><option value="resolved">Resolved</option></select></label>
        </div>
        <div className="finding-list">
          {filtered.map((finding) => <FindingRow finding={finding} key={finding.fingerprint} record={finding.resourceKey ? recordsByKey.get(finding.resourceKey) : undefined} />)}
          {filtered.length === 0 ? <div className="empty-state"><strong>No matching Kubernetes findings</strong><span>This is not proof that workloads are vulnerability-free. Confirm collector and scanner coverage below.</span></div> : null}
        </div>
      </section>
    </>
  );
}

export function KubernetesWorkspace({ view }: { readonly view: KubernetesView }) {
  const { state, loading, error, refresh } = usePilotState();
  const kubernetes = useKubernetesEvidence(state);
  const projection = useMemo(() => buildKubernetesProjection({
    resources: kubernetes.projectionInput.resources,
    relationships: kubernetes.projectionInput.relationships,
    findings: kubernetes.projectionInput.findings,
    coverage: kubernetes.projectionInput.coverage,
  }), [kubernetes.projectionInput]);
  const connection = state?.connection ?? null;
  return (
    <>
      <section className="page-heading kubernetes-heading">
        <div><p className="eyebrow">Container operations</p><h1>Kubernetes workspace</h1><p className="page-subtitle">Customer-scoped cluster, namespace, workload and security evidence from Sutra&apos;s normalized CMDB API.</p></div>
        <div className="heading-actions"><Link className="button button-secondary" href="/onboard">AWS trust onboarding</Link><Link className="button button-primary" href="/cmdb">Open source CMDB</Link></div>
      </section>
      <KubernetesTabs active={view} />
      <div className="trust-strip" role="note"><span className="trust-icon">K</span><span><strong>{state?.activeSnapshot ? `${snapshotOriginLabel(state.activeSnapshot.origin)} · ${formatTimestamp(state.activeSnapshot.collectedAt)}.` : "No active normalized snapshot."}</strong> Kubernetes absence is reported as unknown when collector coverage is absent; an AWS-complete snapshot does not by itself prove Kubernetes completeness.</span></div>
      {error || kubernetes.error ? <div className="page-alert page-alert-error" role="alert"><strong>Kubernetes evidence is unavailable</strong><span>{error ?? kubernetes.error}</span><button onClick={() => { void refresh(); void kubernetes.refresh(); }} type="button">Retry</button></div> : null}
      {loading || kubernetes.loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading authorized Kubernetes evidence…</div> : null}
      {!loading && !kubernetes.loading && projection.records.length === 0 ? <EmptyKubernetesEvidence connected={connection !== null} /> : null}
      {!loading && !kubernetes.loading && projection.records.length > 0 ? (
        view === "overview" ? <Overview projection={projection} /> :
          view === "inventory" ? <Inventory projection={projection} /> :
            <Security projection={projection} />
      ) : null}
      {!loading && !kubernetes.loading ? <section className="panel kubernetes-coverage">
        <div className="panel-heading"><div><p className="eyebrow">Collection truth</p><h2>Kubernetes collector coverage</h2></div><span className={`status-pill ${projection.coverage.some((entry) => entry.status === "succeeded") ? "status-positive" : "status-medium"}`}>{projection.coverage.length > 0 ? `${projection.coverage.length} checks` : "Not reported"}</span></div>
        {projection.coverage.length > 0 ? <div className="coverage-grid">{projection.coverage.map((entry) => <article key={`${entry.collectorKey}:${entry.region}`}><span className={`coverage-state coverage-${entry.status}`} /><div><strong>{entry.collectorKey}</strong><small>{entry.region}</small></div><b>{entry.status}</b><span>{entry.itemsObserved} items</span></article>)}</div> : <div className="empty-state"><strong>No Kubernetes collector coverage in this snapshot</strong><span>The current permission pack and collector do not establish EKS control-plane, Kubernetes API, image, package, runtime, or admission-policy visibility.</span></div>}
      </section> : null}
    </>
  );
}

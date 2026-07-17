"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { JsonValue, PilotFinding } from "../../lib/pilot-types";
import { compactIdentifier, formatTimestamp, usePilotState } from "../components/use-pilot-state";
import { buildKubernetesProjection, type KubernetesResourceRecord } from "./kubernetes-projection";
import type { KubernetesSectionDefinition } from "./kubernetes-sections";
import { useKubernetesEvidence } from "./use-kubernetes-evidence";
import type { KubernetesStoredWorkspace } from "../../db/kubernetes-repository";
import { KubernetesRuntimeWorkspace } from "./kubernetes-runtime-workspace";
import { buildKubernetesComplianceReadinessReport } from "../../lib/kubernetes-compliance-readiness";

function findReportedImages(value: JsonValue, key = "", depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof value === "string") {
    return /image/iu.test(key) && value.trim().length > 0 ? [value.trim()] : [];
  }
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => findReportedImages(item, key, depth + 1));
  return Object.entries(value).flatMap(([childKey, child]) => findReportedImages(child, childKey, depth + 1));
}

function ResourceRows({
  records,
  workloadLinks = false,
}: {
  readonly records: readonly KubernetesResourceRecord[];
  readonly workloadLinks?: boolean;
}) {
  return (
    <div className="kubernetes-enterprise-list">
      {records.map((record) => (
        <article key={record.resource.resourceKey}>
          <span className="kubernetes-kind">{record.kind}</span>
          <div><strong>{record.displayName}</strong><small>{record.resource.resourceType} · {record.resource.region}</small></div>
          <div><strong>{record.clusterName ?? "Not reported"}</strong><small>{record.namespace ?? "Namespace not reported"}</small></div>
          <div><strong>{record.findings.length}</strong><small>attached findings · {record.relationshipCount} edges</small></div>
          <Link className="text-link" href={workloadLinks
            ? `/kubernetes/workload/${encodeURIComponent(record.resource.resourceKey)}`
            : `/cmdb/resource?key=${encodeURIComponent(record.resource.resourceKey)}`}>
            Open →
          </Link>
        </article>
      ))}
      {records.length === 0 ? <div className="empty-state"><strong>No normalized records for this section</strong><span>Confirm Kubernetes collector coverage before treating this as proof of absence.</span></div> : null}
    </div>
  );
}

function FindingRows({ findings }: { readonly findings: readonly PilotFinding[] }) {
  return (
    <div className="kubernetes-finding-rows">
      {findings.map((finding) => <article key={finding.fingerprint}>
        <span className={`severity-badge severity-${finding.severity}`}>{finding.severity}</span>
        <div><strong>{finding.title}</strong><small>{finding.controlKey} · {finding.status}</small></div>
        <p>{finding.summary}</p>
      </article>)}
      {findings.length === 0 ? <div className="empty-state"><strong>No matching normalized findings</strong><span>No vulnerability, exposure, compliance, or policy result is generated from missing evidence.</span></div> : null}
    </div>
  );
}

function SectionContent({
  section,
  projection,
  snapshotAt,
  workspace,
  connectionId,
}: {
  readonly section: KubernetesSectionDefinition;
  readonly projection: ReturnType<typeof buildKubernetesProjection>;
  readonly snapshotAt: string | null;
  readonly workspace: KubernetesStoredWorkspace | null;
  readonly connectionId: string | null;
}) {
  if (section.key === "clusters") return <ResourceRows records={projection.records.filter((record) => record.category === "cluster")} />;
  if (section.key === "namespaces") return <ResourceRows records={projection.records.filter((record) => record.category === "namespace")} />;
  if (section.key === "workloads") return <ResourceRows records={projection.records.filter((record) => record.category === "workload")} workloadLinks />;
  if (section.key === "rbac") return <ResourceRows records={projection.records.filter((record) => record.category === "access")} />;
  if (section.key === "network") return <ResourceRows records={projection.records.filter((record) => record.category === "network")} />;
  if (section.key === "images") {
    const images = [...new Set(projection.records.flatMap((record) =>
      findReportedImages(record.resource.configuration).map((image) => `${record.resource.resourceKey}\u0000${image}`),
    ))].map((entry) => {
      const [resourceKey, image] = entry.split("\u0000");
      return { resourceKey, image };
    });
    const vulnerabilityFindings = projection.findings.filter((finding) =>
      /(?:vulnerab|container.?image|package|\bCVE-\d{4}-\d+\b)/iu.test(
        `${finding.controlKey} ${finding.title} ${finding.summary}`,
      ),
    );
    return <>
      <div className="trust-strip" role="note"><span className="trust-icon">i</span><span><strong>Source evidence only.</strong> Image references are extracted from normalized configuration fields named for images. CVEs and packages appear only when a normalized finding explicitly reports them.</span></div>
      <div className="kubernetes-image-grid">{images.map((item) => <article key={`${item.resourceKey}:${item.image}`}><span>IMG</span><div><strong>{item.image}</strong><small>{compactIdentifier(item.resourceKey, 30)}</small></div><Link href={`/cmdb/resource?key=${encodeURIComponent(item.resourceKey)}`}>Open</Link></article>)}{images.length === 0 ? <div className="empty-state"><strong>No container image references reported</strong><span>The current API evidence does not provide an image inventory.</span></div> : null}</div>
      <section className="kubernetes-subsection"><h3>Source-native vulnerability findings</h3><FindingRows findings={vulnerabilityFindings} /></section>
    </>;
  }
  if (section.key === "exposure") {
    const exposureFindings = projection.findings.filter((finding) =>
      /(?:expos|public|internet|ingress|external|load.?balanc)/iu.test(
        `${finding.controlKey} ${finding.title} ${finding.summary}`,
      ),
    );
    return <><ResourceRows records={projection.records.filter((record) => record.category === "network")} /><section className="kubernetes-subsection"><h3>Exposure-related findings</h3><FindingRows findings={exposureFindings} /></section></>;
  }
  if (section.key === "runtime") {
    return <KubernetesRuntimeWorkspace connectionId={connectionId} clusterId={workspace?.cluster.id ?? null} />;
  }
  if (section.key === "compliance") {
    const controlFindings = projection.findings.filter((finding) => /kubernetes|k8s|eks/iu.test(finding.controlKey));
    const readiness = buildKubernetesComplianceReadinessReport({
      findings: workspace?.findings ?? [],
      collectedAt: workspace?.scan?.collectedAt ?? null,
    });
    return <>
      <div className="trust-strip" role="note"><span className="trust-icon">!</span><span><strong>Assessment, not certification.</strong> Results are point-in-time interpretations of normalized evidence and do not establish conformity, audit readiness, or absence of risk.</span></div>
      <section className="kubernetes-subsection">
        <h3>Framework readiness mappings</h3>
        <p className="page-subtitle">{readiness.disclaimer}{readiness.collectedAt ? ` Evidence collected ${formatTimestamp(readiness.collectedAt)}.` : " No promoted Kubernetes scan supplies control evidence yet."}</p>
        {readiness.frameworks.map((entry) => <article className="panel kubernetes-readiness-framework" key={entry.framework.key}>
          <div className="panel-heading"><div><p className="eyebrow">{entry.framework.availability === "available" ? "Available" : entry.framework.availability === "licensed-content-required" ? "Licensed content required" : "Mapping review required"}{entry.framework.version ? ` · ${entry.framework.version}` : ""}</p><h4>{entry.framework.name}</h4></div><span className="result-count">{entry.summary.PASS} pass · {entry.summary.FAIL} fail · {entry.summary.UNKNOWN} unknown · {entry.summary.NOT_COLLECTED} not collected</span></div>
          <p className="page-subtitle">{entry.framework.claimBoundary}</p>
          <div className="kubernetes-policy-grid">{entry.controls.map((control) => <article key={`${entry.framework.key}:${control.controlId}`}>
            <span className={`severity-dot severity-${control.state === "FAIL" ? "high" : control.state === "PASS" ? "info" : "medium"}`} />
            <div><strong>{control.title}</strong><small>{control.controlId} · {control.references.join(", ")}</small></div>
            <span className={`compliance-status compliance-status-${control.state === "FAIL" ? "fail" : control.state === "PASS" ? "pass" : control.state === "UNKNOWN" ? "unknown" : "not-applicable"}`}>{control.state === "NOT_COLLECTED" ? "NOT COLLECTED" : control.state}{control.state === "FAIL" ? ` · ${control.failCount}` : ""}</span>
          </article>)}</div>
        </article>)}
        {readiness.unmappedControlIds.length > 0 ? <div className="empty-state"><strong>{readiness.unmappedControlIds.length} control result{readiness.unmappedControlIds.length === 1 ? "" : "s"} without a framework mapping</strong><span>{readiness.unmappedControlIds.join(", ")}</span></div> : null}
      </section>
      <section className="kubernetes-subsection"><h3>Normalized compliance findings</h3><FindingRows findings={controlFindings} /></section>
    </>;
  }
  if (section.key === "policies") {
    const controls = [...new Map(projection.findings.map((finding) => [finding.controlKey, finding])).values()];
    return <div className="kubernetes-policy-grid">{controls.map((finding) => <article key={finding.controlKey}><span className={`severity-dot severity-${finding.severity}`} /><div><strong>{finding.controlKey}</strong><small>Observed result · {finding.status}</small></div><span className={`status-pill status-${finding.status === "open" ? "medium" : "positive"}`}>{finding.status}</span></article>)}{controls.length === 0 ? <div className="empty-state"><strong>No Kubernetes policy results reported</strong><span>Sutra does not claim admission enforcement or create policy outcomes without findings.</span></div> : null}</div>;
  }
  if (section.key === "scan-history") {
    return workspace?.scan ? <div className="kubernetes-enterprise-list"><article>
      <span className="kubernetes-kind">SCAN</span>
      <div><strong>{workspace.scan.id}</strong><small>{formatTimestamp(workspace.scan.collectedAt)} · immutable publication</small></div>
      <div><strong>{workspace.scan.status}</strong><small>{workspace.scan.coverageCount} coverage domains</small></div>
      <div><strong>{workspace.scan.resourceCount}</strong><small>resources · {workspace.scan.findingCount} posture results</small></div>
      <Link className="text-link" href="/kubernetes/coverage">Evidence →</Link>
    </article></div> : <section className="empty-workspace compact-empty"><span className="empty-workspace-icon">H</span><h2>No promoted Kubernetes scan</h2><p>{snapshotAt ? `AWS evidence was published ${formatTimestamp(snapshotAt)}, but AWS inventory is not relabelled as a Kubernetes scan.` : "No complete Kubernetes scan has been atomically published."}</p><Link className="button button-secondary" href="/kubernetes/onboard">Import a collector artifact</Link></section>;
  }
  if (section.key === "coverage") {
    const scannerEvidence = workspace === null
      ? []
      : [...workspace.scannerEvidence.findings, ...workspace.scannerEvidence.sboms];
    const scannerSources = [...new Map(scannerEvidence.map((item) => {
      const source = "source" in item ? item.source : "sbom_report";
      return [`${source}:${item.scanner.name}:${item.scanner.version}`, {
        source,
        scanner: item.scanner,
        count: scannerEvidence.filter((candidate) =>
          ("source" in candidate ? candidate.source : "sbom_report") === source &&
          candidate.scanner.name === item.scanner.name &&
          candidate.scanner.version === item.scanner.version
        ).length,
      }] as const;
    })).values()];
    return <>
      {projection.coverage.length > 0 ? <div className="coverage-grid">{projection.coverage.map((entry) => <article key={`${entry.collectorKey}:${entry.region}`}><span className={`coverage-state coverage-${entry.status}`} /><div><strong>{entry.collectorKey}</strong><small>{entry.region}</small></div><b>{entry.status}</b><span>{entry.itemsObserved} items</span></article>)}</div> : <div className="empty-state"><strong>Kubernetes coverage is not reported</strong><span>The current API does not establish control-plane or workload visibility.</span></div>}
      <section className="kubernetes-subsection"><h3>Trivy report provenance</h3>
        {scannerSources.length > 0 ? <div className="coverage-grid">{scannerSources.map((entry) => <article key={`${entry.source}:${entry.scanner.name}:${entry.scanner.version}`}><span className="coverage-state coverage-succeeded" /><div><strong>{entry.source}</strong><small>{entry.scanner.name} {entry.scanner.version}</small></div><b>{entry.count} record{entry.count === 1 ? "" : "s"}</b><span>{entry.scanner.reportUpdatedAt ? formatTimestamp(entry.scanner.reportUpdatedAt) : "Update timestamp not reported"}</span></article>)}</div> : <div className="empty-state"><strong>No persisted Trivy report provenance</strong><span>No scanner finding or SBOM proves report generation. Review live collector coverage before interpreting an empty result as clean.</span></div>}
      </section>
    </>;
  }
  return <div className="empty-state"><strong>Kubernetes coverage is not reported</strong><span>The current API does not establish control-plane, workload, image, runtime, admission, or package-scanning visibility.</span></div>;
}

export function KubernetesEnterpriseSection({ section }: { readonly section: KubernetesSectionDefinition }) {
  const { state, loading, error, refresh } = usePilotState();
  const kubernetes = useKubernetesEvidence(state);
  const [query, setQuery] = useState("");
  const projection = useMemo(() => buildKubernetesProjection({
    resources: kubernetes.projectionInput.resources,
    relationships: kubernetes.projectionInput.relationships,
    findings: kubernetes.projectionInput.findings,
    coverage: kubernetes.projectionInput.coverage,
  }), [kubernetes.projectionInput]);
  const filteredProjection = useMemo(() => {
    if (!query.trim()) return projection;
    const normalized = query.toLocaleLowerCase("en-US");
    const records = projection.records.filter((record) =>
      `${record.displayName} ${record.kind} ${record.clusterName ?? ""} ${record.namespace ?? ""}`.toLocaleLowerCase("en-US").includes(normalized),
    );
    const keys = new Set(records.map((record) => record.resource.resourceKey));
    return {
      ...projection,
      records,
      findings: projection.findings.filter((finding) =>
        (finding.resourceKey !== null && keys.has(finding.resourceKey)) ||
        `${finding.title} ${finding.controlKey}`.toLocaleLowerCase("en-US").includes(normalized),
      ),
    };
  }, [projection, query]);
  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Kubernetes · Enterprise workspace</p><h1>{section.title}</h1><p className="page-subtitle">{section.description}</p></div>
        <div className="heading-actions"><Link className="button button-secondary" href="/kubernetes/onboard">Onboard cluster</Link><Link className="button button-primary" href="/kubernetes">Kubernetes overview</Link></div>
      </section>
      <div className="trust-strip" role="note"><span className="trust-icon">K</span><span><strong>Authorized normalized evidence only.</strong> Missing collector data is displayed as not configured or unknown; resources, scans, policies, vulnerabilities and runtime events are never synthesized.</span></div>
      {error || kubernetes.error ? <div className="page-alert page-alert-error" role="alert"><strong>Kubernetes workspace unavailable</strong><span>{error ?? kubernetes.error}</span><button onClick={() => { void refresh(); void kubernetes.refresh(); }} type="button">Retry</button></div> : null}
      {loading || kubernetes.loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading Kubernetes evidence…</div> : null}
      {!loading && !kubernetes.loading ? <section className="panel kubernetes-enterprise-section">
        <div className="panel-heading"><div><p className="eyebrow">Current projection</p><h2>{section.label}</h2></div><span className="result-count">{filteredProjection.records.length} Kubernetes records</span></div>
        {!["runtime", "scan-history", "coverage"].includes(section.key) ? <label className="search-field kubernetes-section-search"><span className="sr-only">Filter this Kubernetes section</span><input className="filter-control" placeholder="Filter by resource, cluster, namespace or finding" value={query} onChange={(event) => setQuery(event.target.value)} /></label> : null}
        <SectionContent connectionId={state?.connection?.id ?? null} section={section} projection={filteredProjection} snapshotAt={state?.activeSnapshot?.collectedAt ?? null} workspace={kubernetes.workspace} />
      </section> : null}
    </>
  );
}

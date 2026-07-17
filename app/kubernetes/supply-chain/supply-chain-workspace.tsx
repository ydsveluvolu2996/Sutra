"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { KubernetesSupplyChainEvidence } from "../../../lib/kubernetes-supply-chain";
import { formatTimestamp, usePilotState } from "../../components/use-pilot-state";
import { useKubernetesEvidence } from "../use-kubernetes-evidence";

interface SupplyChainBody {
  readonly schemaVersion: "sutra.kubernetes-supply-chain-workspace.v1";
  readonly configured: boolean;
  readonly clusterId: string;
  readonly evidence: readonly KubernetesSupplyChainEvidence[];
  readonly error?: { readonly message?: string };
}

function imageReference(evidence: KubernetesSupplyChainEvidence): string {
  return `${evidence.image.repository}@${evidence.image.digest}`;
}

export function SupplyChainWorkspace() {
  const { state, loading: pilotLoading, error: pilotError, refresh: refreshPilot } = usePilotState();
  const kubernetes = useKubernetesEvidence(state);
  const [payload, setPayload] = useState<SupplyChainBody | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedClusterId, setSelectedClusterId] = useState("");
  const activeClusters = useMemo(
    () => kubernetes.clusters.filter((cluster) => cluster.status === "active"),
    [kubernetes.clusters],
  );
  const activeCluster = activeClusters.find((cluster) => cluster.id === selectedClusterId) ??
    activeClusters[0] ??
    null;
  const connectionId = state?.connection?.id ?? null;

  const refresh = useCallback(async () => {
    if (connectionId === null || activeCluster === null) {
      setPayload(null);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(
        `/api/v1/kubernetes/supply-chain?connectionId=${encodeURIComponent(connectionId)}&clusterId=${encodeURIComponent(activeCluster.id)}&limit=200`,
        { cache: "no-store" },
      );
      const body = await response.json().catch(() => null) as SupplyChainBody | null;
      if (
        !response.ok ||
        body === null ||
        body.schemaVersion !== "sutra.kubernetes-supply-chain-workspace.v1" ||
        !Array.isArray(body.evidence)
      ) throw new Error(body?.error?.message ?? "Supply-chain evidence could not be loaded");
      setPayload(body);
      setError(null);
    } catch (caught) {
      setPayload(null);
      setError(caught instanceof Error ? caught.message : "Supply-chain evidence could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [activeCluster, connectionId]);

  useEffect(() => {
    const task = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(task);
  }, [refresh]);

  const evidence = useMemo(() => payload?.evidence ?? [], [payload?.evidence]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("en-US");
    if (!normalized) return evidence;
    return evidence.filter((item) =>
      `${item.image.repository} ${item.image.digest} ${item.image.tag ?? ""} ${item.signature.state} ${item.provenance.state} ${item.priority.rating}`
        .toLocaleLowerCase("en-US")
        .includes(normalized),
    );
  }, [evidence, query]);
  const uniqueDigests = new Set(evidence.map((item) => item.image.digest)).size;
  const critical = evidence.filter((item) => item.priority.rating === "critical").length;
  const verified = evidence.filter((item) =>
    item.signature.state === "verified" && item.provenance.state === "verified",
  ).length;

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Kubernetes · Software supply chain</p><h1>Images, SBOMs & provenance</h1><p className="page-subtitle">Review immutable image-digest evidence normalized from Trivy, SBOM metadata, Cosign verification and build provenance signals.</p></div>
        <div className="heading-actions"><Link className="button button-secondary" href="/kubernetes/admission">Admission governance</Link><Link className="button button-primary" href="/kubernetes">Kubernetes overview</Link></div>
      </section>
      <div className="trust-strip" role="note"><span className="trust-icon">D</span><span><strong>Digest-bound evidence only.</strong> Sutra stores vulnerability counts, SBOM document hashes and bounded verifier identities for one immutable image digest. Raw manifests, package lists, attestations, certificates, tokens and registry credentials are not retained or requested by this browser.</span></div>
      {pilotError || kubernetes.error || error ? <div className="page-alert page-alert-error" role="alert"><strong>Supply-chain workspace unavailable</strong><span>{pilotError ?? kubernetes.error ?? error}</span><button onClick={() => void Promise.all([refreshPilot(), kubernetes.refresh(), refresh()])} type="button">Retry</button></div> : null}
      {pilotLoading || kubernetes.loading || loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading normalized image evidence…</div> : null}
      {!pilotLoading && !kubernetes.loading && !loading ? <>
        <section className="inventory-stats">
          <article><small>Immutable images</small><strong>{uniqueDigests || "—"}</strong><span>{evidence.length > 0 ? `${evidence.length} normalized evidence record${evidence.length === 1 ? "" : "s"}` : "Evidence not configured"}</span></article>
          <article><small>Critical priorities</small><strong>{evidence.length > 0 ? critical : "—"}</strong><span>Deterministic contextual score</span></article>
          <article><small>Signature + provenance</small><strong>{evidence.length > 0 ? verified : "—"}</strong><span>Both verification states reported</span></article>
          <article><small>Active cluster</small><strong>{activeCluster?.name ?? "—"}</strong><span>{activeCluster ? activeCluster.distribution ?? "Kubernetes" : "Not registered"}</span></article>
        </section>
        <section className="panel supply-chain-panel">
          <div className="panel-heading"><div><p className="eyebrow">Authenticated tenant scope</p><h2>Normalized image evidence</h2></div><div className="supply-chain-panel-actions">{activeClusters.length > 1 ? <label><span className="sr-only">Select Kubernetes cluster</span><select className="filter-control" value={activeCluster?.id ?? ""} onChange={(event) => setSelectedClusterId(event.target.value)}>{activeClusters.map((cluster) => <option key={cluster.id} value={cluster.id}>{cluster.name}</option>)}</select></label> : null}{payload?.configured ? <span className="status-pill status-positive">Connected</span> : <span className="status-pill">Not configured</span>}</div></div>
          {evidence.length > 0 ? <>
            <label className="search-field supply-chain-search"><span className="sr-only">Filter supply-chain evidence</span><input className="filter-control" placeholder="Filter repository, digest, tag or verification state" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
            <div className="supply-chain-list">{filtered.map((item) => <details key={item.evidenceSha256} className="supply-chain-card">
              <summary>
                <span className={`severity-badge severity-${item.priority.rating}`}>{item.priority.rating}</span>
                <div><strong>{item.image.repository}</strong><code>{item.image.digest}</code></div>
                <div><strong>{item.vulnerabilityScan.critical} critical · {item.vulnerabilityScan.high} high</strong><small>Trivy {item.vulnerabilityScan.scannerVersion}</small></div>
                <span className="finding-chevron">⌄</span>
              </summary>
              <div className="supply-chain-detail">
                <section><h3>Immutable subject</h3><dl><div><dt>Reference</dt><dd>{imageReference(item)}</dd></div><div><dt>Observed tag</dt><dd>{item.image.tag ?? "Not reported"}</dd></div><div><dt>Collected</dt><dd>{formatTimestamp(item.collectedAt)}</dd></div><div><dt>Evidence SHA-256</dt><dd><code>{item.evidenceSha256}</code></dd></div></dl></section>
                <section><h3>Vulnerability summary</h3><dl><div><dt>Critical</dt><dd>{item.vulnerabilityScan.critical}</dd></div><div><dt>High</dt><dd>{item.vulnerabilityScan.high}</dd></div><div><dt>Medium / low</dt><dd>{item.vulnerabilityScan.medium} / {item.vulnerabilityScan.low}</dd></div><div><dt>Known fix</dt><dd>{item.vulnerabilityScan.fixedAvailable}</dd></div></dl></section>
                <section><h3>SBOM</h3>{item.sbom ? <dl><div><dt>Format</dt><dd>{item.sbom.format}</dd></div><div><dt>Components</dt><dd>{item.sbom.componentCount}</dd></div><div><dt>Document hash</dt><dd><code>{item.sbom.documentSha256}</code></dd></div></dl> : <p className="panel-footnote">No SBOM evidence was reported for this digest.</p>}</section>
                <section><h3>Trust verification</h3><dl><div><dt>Signature</dt><dd>{item.signature.state}</dd></div><div><dt>Issuer / subject</dt><dd>{item.signature.issuer ?? "Not reported"} / {item.signature.subject ?? "Not reported"}</dd></div><div><dt>Provenance</dt><dd>{item.provenance.state}</dd></div><div><dt>Builder / commit</dt><dd>{item.provenance.builderId ?? "Not reported"} / {item.provenance.commitSha ?? "Not reported"}</dd></div></dl></section>
              </div>
              <div className="supply-chain-factors"><strong>Priority {item.priority.score}/100</strong>{item.priority.factors.map((factor) => <span key={factor}>{factor}</span>)}</div>
            </details>)}</div>
            {filtered.length === 0 ? <div className="empty-state"><strong>No matching digest evidence</strong><span>Adjust the filter; stored evidence was not modified.</span></div> : null}
          </> : <section className="empty-workspace compact-empty"><span className="empty-workspace-icon">SC</span><h2>Supply-chain evidence is not configured</h2><p>{activeCluster ? `${activeCluster.name} is registered, but no normalized, digest-bound Trivy/SBOM/Cosign/provenance artifact exists in this authorized tenant scope.` : "Register and scan a Kubernetes cluster before publishing supply-chain evidence."} Sutra does not infer verification from an image name or tag.</p><Link className="button button-secondary" href="/kubernetes/coverage">Review collector coverage</Link></section>}
        </section>
      </> : null}
    </>
  );
}

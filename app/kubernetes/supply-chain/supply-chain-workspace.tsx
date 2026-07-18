"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { KubernetesSupplyChainEvidence } from "../../../lib/kubernetes-supply-chain";
import { formatTimestamp, usePilotState } from "../../components/use-pilot-state";
import { useKubernetesEvidence } from "../use-kubernetes-evidence";
import { SupplyChainTrustPanel } from "./supply-chain-trust-panel";

interface SupplyChainBody {
  readonly schemaVersion: "sutra.kubernetes-supply-chain-workspace.v1";
  readonly configured: boolean;
  readonly clusterId: string;
  readonly evidence: readonly KubernetesSupplyChainEvidence[];
  readonly error?: { readonly message?: string };
}

interface SbomHistoryBody {
  readonly schemaVersion: "sutra.kubernetes-sbom-history.v1";
  readonly history: readonly {
    readonly scanRunId: string;
    readonly collectedAt: string;
    readonly reportFingerprint: string;
    readonly namespace: string | null;
    readonly reportName: string;
    readonly imageRepository: string | null;
    readonly imageDigest: string | null;
    readonly format: string | null;
    readonly specVersion: string | null;
    readonly componentCount: number;
    readonly declaredComponentCount: number | null;
    readonly scannerName: string;
    readonly scannerVersion: string;
  }[];
}

interface ComponentSearchBody {
  readonly schemaVersion: "sutra.kubernetes-sbom-component-search.v1";
  readonly matches: readonly {
    readonly scanRunId: string;
    readonly collectedAt: string;
    readonly imageRepository: string | null;
    readonly imageDigest: string | null;
    readonly namespace: string | null;
    readonly component: {
      readonly fingerprint: string;
      readonly type: string | null;
      readonly name: string;
      readonly version: string | null;
      readonly packageUrl: string | null;
      readonly licenses: readonly string[];
    };
  }[];
  readonly componentsInspected: number;
  readonly truncated: boolean;
}

interface LicensePolicyBody {
  readonly schemaVersion: "sutra.kubernetes-sbom-license-policies.v1";
  readonly policies: readonly {
    readonly id: string;
    readonly version: number;
    readonly policySha256: string;
    readonly policy: {
      readonly name: string;
      readonly deniedLicenses: readonly string[];
      readonly allowedLicenses: readonly string[];
      readonly requireIdentifiedLicense: boolean;
    };
  }[];
}

interface LicenseEvaluationBody {
  readonly schemaVersion: "sutra.kubernetes-sbom-license-evaluation.v1";
  readonly policy: LicensePolicyBody["policies"][number];
  readonly scanRunId: string | null;
  readonly collectedAt: string | null;
  readonly evaluation: {
    readonly status: "pass" | "fail" | "not_evaluated";
    readonly componentsEvaluated: number;
    readonly compliantComponents: number;
    readonly truncated: boolean;
    readonly claimBoundary: "OBSERVED_SBOM_LICENSE_METADATA_ONLY";
    readonly violations: readonly {
      readonly componentFingerprint: string;
      readonly componentName: string;
      readonly componentVersion: string | null;
      readonly reason: "DENIED_LICENSE" | "UNIDENTIFIED_LICENSE" | "NOT_IN_ALLOWLIST";
      readonly observedLicenses: readonly string[];
    }[];
  };
}

interface SbomDiffBody {
  readonly schemaVersion: "sutra.kubernetes-sbom-diff.v1";
  readonly currentScanRunId: string | null;
  readonly previousScanRunId: string | null;
  readonly collectedAt: string | null;
  readonly previousCollectedAt: string | null;
  readonly diff: {
    readonly hasPrevious: boolean;
    readonly summary: {
      readonly added: number;
      readonly removed: number;
      readonly versionChanged: number;
      readonly licenseChanged: number;
      readonly unchanged: number;
    };
    readonly changes: readonly {
      readonly kind: "added" | "removed" | "version-changed" | "license-changed";
      readonly name: string;
      readonly packageUrl: string | null;
      readonly type: string | null;
      readonly from: string;
      readonly to: string;
    }[];
  };
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
  const [componentQuery, setComponentQuery] = useState("");
  const [history, setHistory] = useState<SbomHistoryBody["history"]>([]);
  const [componentSearch, setComponentSearch] = useState<ComponentSearchBody | null>(null);
  const [policies, setPolicies] = useState<LicensePolicyBody["policies"]>([]);
  const [licenseEvaluation, setLicenseEvaluation] = useState<LicenseEvaluationBody | null>(null);
  const [sbomDiff, setSbomDiff] = useState<SbomDiffBody | null>(null);
  const [policyName, setPolicyName] = useState("Production workload license policy");
  const [deniedLicenses, setDeniedLicenses] = useState("GPL-3.0-only, AGPL-3.0-only");
  const [allowedLicenses, setAllowedLicenses] = useState("");
  const [requireIdentifiedLicense, setRequireIdentifiedLicense] = useState(true);
  const [workflowBusy, setWorkflowBusy] = useState(false);
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
      const scope = `connectionId=${encodeURIComponent(connectionId)}&clusterId=${encodeURIComponent(activeCluster.id)}`;
      const [historyResponse, policyResponse, diffResponse] = await Promise.all([
        fetch(`/api/v1/kubernetes/sboms?${scope}&view=history&limit=20`, { cache: "no-store" }),
        fetch(`/api/v1/kubernetes/sboms?${scope}&view=policies`, { cache: "no-store" }),
        fetch(`/api/v1/kubernetes/sboms?${scope}&view=diff`, { cache: "no-store" }),
      ]);
      const historyBody = await historyResponse.json().catch(() => null) as SbomHistoryBody | null;
      const policyBody = await policyResponse.json().catch(() => null) as LicensePolicyBody | null;
      const diffBody = await diffResponse.json().catch(() => null) as SbomDiffBody | null;
      if (
        !historyResponse.ok || historyBody?.schemaVersion !== "sutra.kubernetes-sbom-history.v1" ||
        !policyResponse.ok || policyBody?.schemaVersion !== "sutra.kubernetes-sbom-license-policies.v1"
      ) throw new Error("SBOM history or license policy state could not be loaded");
      setHistory(historyBody.history);
      setPolicies(policyBody.policies);
      setSbomDiff(diffResponse.ok && diffBody?.schemaVersion === "sutra.kubernetes-sbom-diff.v1" ? diffBody : null);
      setError(null);
    } catch (caught) {
      setPayload(null);
      setError(caught instanceof Error ? caught.message : "Supply-chain evidence could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [activeCluster, connectionId]);

  const searchComponents = useCallback(async () => {
    const normalized = componentQuery.trim();
    if (connectionId === null || activeCluster === null || normalized.length < 2) {
      setComponentSearch(null);
      return;
    }
    setWorkflowBusy(true);
    try {
      const response = await fetch(
        `/api/v1/kubernetes/sboms?connectionId=${encodeURIComponent(connectionId)}&clusterId=${encodeURIComponent(activeCluster.id)}&view=components&query=${encodeURIComponent(normalized)}&limit=100&scanLimit=20`,
        { cache: "no-store" },
      );
      const body = await response.json().catch(() => null) as ComponentSearchBody | null;
      if (!response.ok || body?.schemaVersion !== "sutra.kubernetes-sbom-component-search.v1") {
        throw new Error("Component search could not be completed");
      }
      setComponentSearch(body);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Component search could not be completed");
    } finally {
      setWorkflowBusy(false);
    }
  }, [activeCluster, componentQuery, connectionId]);

  const publishPolicy = useCallback(async () => {
    if (connectionId === null || activeCluster === null) return;
    const existing = policies.find((item) => item.policy.name === policyName);
    const values = (text: string) => text.split(",").map((item) => item.trim()).filter(Boolean);
    setWorkflowBusy(true);
    try {
      const response = await fetch("/api/v1/kubernetes/sboms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "publish-license-policy-version",
          connectionId,
          clusterId: activeCluster.id,
          expectedVersion: existing?.version ?? 0,
          policy: {
            name: policyName,
            deniedLicenses: values(deniedLicenses),
            allowedLicenses: values(allowedLicenses),
            requireIdentifiedLicense,
          },
        }),
      });
      const body = await response.json().catch(() => null) as { readonly error?: { readonly message?: string } } | null;
      if (!response.ok) throw new Error(body?.error?.message ?? "License policy version could not be published");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "License policy version could not be published");
    } finally {
      setWorkflowBusy(false);
    }
  }, [
    activeCluster, allowedLicenses, connectionId, deniedLicenses, policies,
    policyName, refresh, requireIdentifiedLicense,
  ]);

  const evaluatePolicy = useCallback(async (policyId: string) => {
    if (connectionId === null || activeCluster === null) return;
    setWorkflowBusy(true);
    try {
      const response = await fetch(
        `/api/v1/kubernetes/sboms?connectionId=${encodeURIComponent(connectionId)}&clusterId=${encodeURIComponent(activeCluster.id)}&view=evaluation&policyId=${encodeURIComponent(policyId)}&limit=2000`,
        { cache: "no-store" },
      );
      const body = await response.json().catch(() => null) as LicenseEvaluationBody | null;
      if (!response.ok || body?.schemaVersion !== "sutra.kubernetes-sbom-license-evaluation.v1") {
        throw new Error("License policy evaluation could not be completed");
      }
      setLicenseEvaluation(body);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "License policy evaluation could not be completed");
    } finally {
      setWorkflowBusy(false);
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
      <div className="trust-strip" role="note"><span className="trust-icon">D</span><span><strong>Digest-bound evidence only.</strong> Sutra stores vulnerability counts, SBOM document hashes, bounded component metadata and observed license identifiers for immutable scanner snapshots. Raw manifests, attestations, certificates, tokens and registry credentials are not retained or requested by this browser.</span></div>
      {pilotError || kubernetes.error || error ? <div className="page-alert page-alert-error" role="alert"><strong>Supply-chain workspace unavailable</strong><span>{pilotError ?? kubernetes.error ?? error}</span><button onClick={() => void Promise.all([refreshPilot(), kubernetes.refresh(), refresh()])} type="button">Retry</button></div> : null}
      {pilotLoading || kubernetes.loading || loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading normalized image evidence…</div> : null}
      {!pilotLoading && !kubernetes.loading && !loading ? <>
        <section className="inventory-stats">
          <article><small>Immutable images</small><strong>{uniqueDigests || "—"}</strong><span>{evidence.length > 0 ? `${evidence.length} normalized evidence record${evidence.length === 1 ? "" : "s"}` : "Evidence not configured"}</span></article>
          <article><small>Critical priorities</small><strong>{evidence.length > 0 ? critical : "—"}</strong><span>Deterministic contextual score</span></article>
          <article><small>Signature + provenance</small><strong>{evidence.length > 0 ? verified : "—"}</strong><span>Both verification states reported</span></article>
          <article><small>Active cluster</small><strong>{activeCluster?.name ?? "—"}</strong><span>{activeCluster ? activeCluster.distribution ?? "Kubernetes" : "Not registered"}</span></article>
        </section>
        <SupplyChainTrustPanel evidence={evidence} />
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
        <section className="panel supply-chain-panel">
          <div className="panel-heading"><div><p className="eyebrow">Immutable scan timeline</p><h2>SBOM history</h2></div><span className="status-pill">{history.length} report{history.length === 1 ? "" : "s"}</span></div>
          {history.length > 0 ? <div className="supply-chain-list">{history.map((item) => <article className="supply-chain-card" key={`${item.scanRunId}:${item.reportFingerprint}`}>
            <div className="supply-chain-detail">
              <section><h3>{item.imageRepository ?? item.reportName}</h3><dl><div><dt>Collected</dt><dd>{formatTimestamp(item.collectedAt)}</dd></div><div><dt>Namespace</dt><dd>{item.namespace ?? "cluster"}</dd></div><div><dt>Digest</dt><dd><code>{item.imageDigest ?? "Not reported"}</code></dd></div></dl></section>
              <section><h3>Document evidence</h3><dl><div><dt>Format</dt><dd>{item.format ?? "Not reported"} {item.specVersion ?? ""}</dd></div><div><dt>Stored components</dt><dd>{item.componentCount}</dd></div><div><dt>Declared components</dt><dd>{item.declaredComponentCount ?? "Not reported"}</dd></div><div><dt>Scanner</dt><dd>{item.scannerName} {item.scannerVersion}</dd></div></dl></section>
            </div>
          </article>)}</div> : <div className="empty-state"><strong>No historical SBOM evidence</strong><span>Sutra reports only immutable scanner snapshots received in this tenant and cluster scope.</span></div>}
        </section>
        <section className="panel supply-chain-panel">
          <div className="panel-heading"><div><p className="eyebrow">Component drift</p><h2>SBOM diff (latest two scans)</h2></div>{sbomDiff?.diff.hasPrevious ? <span className="status-pill">{sbomDiff.diff.changes.length} change{sbomDiff.diff.changes.length === 1 ? "" : "s"}</span> : null}</div>
          {sbomDiff === null || !sbomDiff.diff.hasPrevious ? <div className="empty-state"><strong>No previous scan to compare</strong><span>SBOM diff needs at least two immutable scans in this cluster scope. Nothing is inferred from a single scan.</span></div> : <>
            <div className="inventory-stats">
              <article><small>Added</small><strong>{sbomDiff.diff.summary.added}</strong><span>new components</span></article>
              <article><small>Removed</small><strong>{sbomDiff.diff.summary.removed}</strong><span>no longer present</span></article>
              <article><small>Version changed</small><strong>{sbomDiff.diff.summary.versionChanged}</strong><span>{sbomDiff.diff.summary.licenseChanged} license changed</span></article>
              <article><small>Unchanged</small><strong>{sbomDiff.diff.summary.unchanged}</strong><span>since {formatTimestamp(sbomDiff.previousCollectedAt ?? "")}</span></article>
            </div>
            {sbomDiff.diff.changes.length > 0 ? <div className="vuln-delta-list">{sbomDiff.diff.changes.slice(0, 100).map((change) => <article className="posture-priority-row" key={`${change.kind}:${change.name}:${change.packageUrl ?? ""}`}>
              <span className={`settings-pill ${change.kind === "removed" ? "is-good" : change.kind === "added" ? "is-risk" : ""}`}>{change.kind}</span>
              <div><strong>{change.name}</strong><small>{change.packageUrl ?? change.type ?? "component"}</small><small className="posture-priority-msg">{change.from} → {change.to}</small></div>
            </article>)}</div> : <div className="empty-state"><strong>No component drift</strong><span>The component inventory is identical across the two most recent scans.</span></div>}
            {sbomDiff.diff.changes.length > 100 ? <p className="panel-footnote">Showing the first 100 of {sbomDiff.diff.changes.length} changes.</p> : null}
          </>}
        </section>
        <section className="panel supply-chain-panel">
          <div className="panel-heading"><div><p className="eyebrow">Bounded evidence search</p><h2>Components and licenses</h2></div>{componentSearch ? <span className="status-pill">{componentSearch.componentsInspected} inspected</span> : null}</div>
          <form className="supply-chain-panel-actions" onSubmit={(event) => { event.preventDefault(); void searchComponents(); }}>
            <label className="search-field supply-chain-search"><span className="sr-only">Search SBOM components</span><input className="filter-control" minLength={2} maxLength={128} placeholder="Search package, version, purl or observed license" value={componentQuery} onChange={(event) => setComponentQuery(event.target.value)} /></label>
            <button className="button button-secondary" disabled={workflowBusy || componentQuery.trim().length < 2} type="submit">Search evidence</button>
          </form>
          {componentSearch ? <>{componentSearch.truncated ? <div className="page-alert" role="note"><strong>Bounded result</strong><span>The result limit was reached. Refine the search to narrow the evidence set.</span></div> : null}<div className="supply-chain-list">{componentSearch.matches.map((item) => <article className="supply-chain-card" key={`${item.scanRunId}:${item.component.fingerprint}`}>
            <div className="supply-chain-detail"><section><h3>{item.component.name}</h3><dl><div><dt>Version</dt><dd>{item.component.version ?? "Not reported"}</dd></div><div><dt>Type</dt><dd>{item.component.type ?? "Not reported"}</dd></div><div><dt>Observed licenses</dt><dd>{item.component.licenses.join(", ") || "Not reported"}</dd></div><div><dt>Package URL</dt><dd><code>{item.component.packageUrl ?? "Not reported"}</code></dd></div></dl></section><section><h3>Evidence source</h3><dl><div><dt>Image</dt><dd>{item.imageRepository ?? "Not reported"}</dd></div><div><dt>Digest</dt><dd><code>{item.imageDigest ?? "Not reported"}</code></dd></div><div><dt>Collected</dt><dd>{formatTimestamp(item.collectedAt)}</dd></div><div><dt>Namespace</dt><dd>{item.namespace ?? "cluster"}</dd></div></dl></section></div>
          </article>)}</div>{componentSearch.matches.length === 0 ? <div className="empty-state"><strong>No component evidence matched</strong><span>No package or license metadata was inferred.</span></div> : null}</> : <p className="panel-footnote">Searches inspect at most 20 recent snapshots and 25,000 sanitized component records.</p>}
        </section>
        <section className="panel supply-chain-panel">
          <div className="panel-heading"><div><p className="eyebrow">Versioned governance</p><h2>License policy</h2></div><span className="status-pill">{policies.length} active polic{policies.length === 1 ? "y" : "ies"}</span></div>
          <div className="supply-chain-detail">
            <section><h3>Publish a policy version</h3><label className="search-field"><span>Policy name</span><input className="filter-control" maxLength={128} value={policyName} onChange={(event) => setPolicyName(event.target.value)} /></label><label className="search-field"><span>Denied identifiers</span><input className="filter-control" placeholder="GPL-3.0-only, AGPL-3.0-only" value={deniedLicenses} onChange={(event) => setDeniedLicenses(event.target.value)} /></label><label className="search-field"><span>Optional allowlist</span><input className="filter-control" placeholder="Apache-2.0, MIT" value={allowedLicenses} onChange={(event) => setAllowedLicenses(event.target.value)} /></label><label><input checked={requireIdentifiedLicense} onChange={(event) => setRequireIdentifiedLicense(event.target.checked)} type="checkbox" /> Require an observed license identifier</label><button className="button button-primary" disabled={workflowBusy || policyName.trim().length < 3} onClick={() => void publishPolicy()} type="button">Publish immutable version</button></section>
            <section><h3>Current policies</h3>{policies.length > 0 ? <dl>{policies.map((item) => <div key={item.id}><dt>{item.policy.name} · v{item.version}</dt><dd>Denied: {item.policy.deniedLicenses.join(", ") || "none"} · Allowed: {item.policy.allowedLicenses.join(", ") || "any reported identifier"} · Unknown: {item.policy.requireIdentifiedLicense ? "fail" : "allowed"} <button className="button button-secondary" disabled={workflowBusy} onClick={() => void evaluatePolicy(item.id)} type="button">Evaluate latest snapshot</button></dd></div>)}</dl> : <p className="panel-footnote">No policy has been published. A policy evaluates only license identifiers observed in imported SBOM evidence; it is not legal advice.</p>}</section>
          </div>
          {licenseEvaluation ? <div className={`page-alert ${licenseEvaluation.evaluation.status === "fail" ? "page-alert-error" : ""}`} role="status"><strong>{licenseEvaluation.policy.policy.name}: {licenseEvaluation.evaluation.status}</strong><span>{licenseEvaluation.scanRunId === null ? "No scanner snapshot was available; this result is not evidence of compliance." : `${licenseEvaluation.evaluation.compliantComponents}/${licenseEvaluation.evaluation.componentsEvaluated} components passed against observed license metadata from ${formatTimestamp(licenseEvaluation.collectedAt ?? "")}.`} {licenseEvaluation.evaluation.violations.length} violation{licenseEvaluation.evaluation.violations.length === 1 ? "" : "s"}.</span></div> : null}
        </section>
      </> : null}
    </>
  );
}

"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type {
  KubernetesAdmissionEvidence,
  KubernetesPolicyResult,
} from "../../../lib/kubernetes-admission";
import { formatTimestamp, usePilotState } from "../../components/use-pilot-state";
import { useKubernetesEvidence } from "../use-kubernetes-evidence";

const policyFamilies = [
  { name: "Workload security", rules: 7, covers: "Privilege, host access, capabilities, non-root and seccomp" },
  { name: "Workload reliability", rules: 2, covers: "CPU/memory requests and limits, liveness and readiness probes" },
  { name: "Image supply chain", rules: 2, covers: "Trusted registries and immutable digest pinning" },
] as const;

const promotionChecks = [
  "Representative Audit observation window completed",
  "All current failures resolved or assigned an expiring exception",
  "Policy bundle digest pinned and independently reviewed",
  "Admission availability and rollback tested",
  "Different authorized human approved promotion",
] as const;

function compatibleAdmissionEvidence(value: unknown): KubernetesAdmissionEvidence | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== "sutra.kubernetes-admission.v1" ||
    record.source !== "KYVERNO_POLICY_REPORT" ||
    (record.mode !== "audit" && record.mode !== "enforce") ||
    !Array.isArray(record.results) ||
    typeof record.evidenceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.evidenceSha256)
  ) return null;
  return value as KubernetesAdmissionEvidence;
}

function admissionFromWorkspace(workspace: unknown): KubernetesAdmissionEvidence | null {
  if (typeof workspace !== "object" || workspace === null || Array.isArray(workspace)) return null;
  return compatibleAdmissionEvidence((workspace as Record<string, unknown>).admissionEvidence);
}

function PolicyResultRow({ result }: { readonly result: KubernetesPolicyResult }) {
  const resource = result.resources[0];
  return (
    <article className="admission-result">
      <span className={`status-pill admission-result-${result.state.toLocaleLowerCase("en-US")}`}>{result.state}</span>
      <div><strong>{result.policy} · {result.rule}</strong><small>{result.category ?? "Uncategorized"} · {result.source}</small></div>
      <div><strong>{resource ? `${resource.namespace ?? "cluster"}/${resource.name}` : "No bounded resource identity"}</strong><small>{resource?.kind ?? "Unknown kind"} · {result.timestamp ? formatTimestamp(result.timestamp) : "Timestamp not reported"}</small></div>
      <span className={`severity-badge severity-${result.severity === "unknown" ? "informational" : result.severity}`}>{result.severity}</span>
    </article>
  );
}

export function AdmissionWorkspace() {
  const { state, loading: pilotLoading, error: pilotError, refresh: refreshPilot } = usePilotState();
  const kubernetes = useKubernetesEvidence(state);
  const [checks, setChecks] = useState<Readonly<Record<number, boolean>>>({});
  const [exceptionDays, setExceptionDays] = useState(7);
  const admission = useMemo(() => admissionFromWorkspace(kubernetes.workspace), [kubernetes.workspace]);
  const loading = pilotLoading || kubernetes.loading;
  const activeCluster = kubernetes.clusters.find((cluster) => cluster.status === "active") ?? null;
  const completeChecks = promotionChecks.filter((_, index) => checks[index]).length;
  const exceptionExpiry = useMemo(() => {
    const value = new Date();
    value.setUTCDate(value.getUTCDate() + exceptionDays);
    return value.toISOString();
  }, [exceptionDays]);

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Kubernetes · Admission assurance</p><h1>Kyverno policy governance</h1><p className="page-subtitle">Review an audit-first policy pack, inspect sanitized PolicyReport evidence, and prepare an independently approved promotion to enforcement.</p></div>
        <div className="heading-actions"><Link className="button button-secondary" href="/kubernetes/policies">Policy findings</Link><Link className="button button-primary" href="/kubernetes">Kubernetes overview</Link></div>
      </section>
      <div className="trust-strip" role="note"><span className="trust-icon">A</span><span><strong>No browser-to-cluster mutation.</strong> This workspace cannot run Helm, kubectl, install Kyverno, create exceptions, or promote a policy. Customer-controlled GitOps or another approved change system must apply a reviewed immutable bundle.</span></div>
      {pilotError || kubernetes.error ? <div className="page-alert page-alert-error" role="alert"><strong>Admission workspace unavailable</strong><span>{pilotError ?? kubernetes.error}</span><button onClick={() => void Promise.all([refreshPilot(), kubernetes.refresh()])} type="button">Retry</button></div> : null}
      {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading admission evidence…</div> : null}
      {!loading ? <>
        <section className="inventory-stats">
          <article><small>Policy mode</small><strong>{admission?.mode === "enforce" ? "Enforce reported" : "Audit first"}</strong><span>{admission ? "From normalized report evidence" : "Default pack configuration"}</span></article>
          <article><small>Audit rules</small><strong>11</strong><span>Across three policy families</span></article>
          <article><small>Reported failures</small><strong>{admission?.summary.FAIL ?? "—"}</strong><span>{admission ? "Point-in-time PolicyReport" : "Evidence not connected"}</span></article>
          <article><small>Promotion readiness</small><strong>{completeChecks}/5</strong><span>Local review checklist only</span></article>
        </section>
        <section className="panel admission-policy-pack">
          <div className="panel-heading"><div><p className="eyebrow">Version-controlled assets</p><h2>Sutra admission policy pack</h2></div><span className="status-pill status-medium">Audit</span></div>
          <div className="admission-policy-families">{policyFamilies.map((family) => <article key={family.name}><span>{family.rules}</span><div><strong>{family.name}</strong><p>{family.covers}</p></div><small>PolicyReport</small></article>)}</div>
          <div className="admission-exclusion-note"><strong>Default system exclusions</strong><span>kube-system, kube-public, kube-node-lease and kyverno. Additional exclusions require customer review and must not silently broaden this list.</span></div>
          <div className="admission-template-warning"><strong>Signature and provenance are explicit opt-in templates.</strong><span>They are excluded from the default Kustomize target and contain required SET_ME trust values. Once deliberately configured and promoted, their failure behavior is fail closed.</span></div>
        </section>
        <section className="panel admission-evidence-panel">
          <div className="panel-heading"><div><p className="eyebrow">Normalized source evidence</p><h2>Kyverno PolicyReport results</h2></div>{admission ? <span className={`status-pill ${admission.mode === "enforce" ? "status-risk" : "status-medium"}`}>{admission.mode}</span> : <span className="status-pill">Not connected</span>}</div>
          {admission ? <>
            <div className="admission-evidence-meta"><div><small>Cluster</small><strong>{admission.clusterId}</strong></div><div><small>Collected</small><strong>{formatTimestamp(admission.collectedAt)}</strong></div><div><small>Report</small><strong>{admission.reportNamespace ? `${admission.reportNamespace}/` : ""}{admission.reportName}</strong></div><div><small>Evidence SHA-256</small><code>{admission.evidenceSha256}</code></div></div>
            <div className="admission-result-list">{admission.results.map((result, index) => <PolicyResultRow key={`${result.policy}:${result.rule}:${index}`} result={result} />)}</div>
            {admission.results.length === 0 ? <div className="empty-state"><strong>The normalized report contains no results</strong><span>This is not proof that all resources passed or that admission requests were blocked.</span></div> : null}
          </> : <div className="empty-state"><strong>Kyverno admission evidence is not connected</strong><span>{activeCluster ? `${activeCluster.name} is registered, but the authenticated Kubernetes API does not expose a compatible sutra.kubernetes-admission.v1 PolicyReport artifact.` : "No active Kubernetes cluster is registered for the current authorized customer."} Sutra does not derive admission outcomes from posture findings.</span></div>}
        </section>
        <div className="admission-governance-grid">
          <section className="panel">
            <div className="panel-heading"><div><p className="eyebrow">Human change gate</p><h2>Audit → Enforce review</h2></div><span className="status-pill">{completeChecks === promotionChecks.length ? "Ready for independent review" : "Draft"}</span></div>
            <p className="panel-footnote">Checking these boxes records no server state and grants no approval. A production workflow must authenticate the requester and a different reviewer, bind the evidence digest, and write an immutable audit event.</p>
            <div className="admission-checklist">{promotionChecks.map((check, index) => <label key={check}><input checked={checks[index] ?? false} onChange={(event) => setChecks((current) => ({ ...current, [index]: event.target.checked }))} type="checkbox" /><span>{check}</span></label>)}</div>
            <button className="button button-primary" disabled type="button">Submit through approved change system</button>
          </section>
          <section className="panel">
            <div className="panel-heading"><div><p className="eyebrow">Exception representation</p><h2>Exact and expiring</h2></div><span className="status-pill status-medium">Draft only</span></div>
            <label className="admission-duration"><span>Example duration</span><select className="filter-control" value={exceptionDays} onChange={(event) => setExceptionDays(Number(event.target.value))}><option value={1}>1 day</option><option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option></select></label>
            <dl className="admission-exception-preview"><div><dt>Scope</dt><dd>Exact policy + rule + namespace + resource identity</dd></div><div><dt>Status</dt><dd>Pending independent approval</dd></div><div><dt>Expires</dt><dd>{formatTimestamp(exceptionExpiry)}</dd></div><div><dt>Required</dt><dd>Rationale, compensating control, owner and different reviewer</dd></div></dl>
            <p className="panel-footnote">Expiry never converts a failure into a pass. An expired, pending, mismatched or revoked exception has no effect.</p>
          </section>
        </div>
      </> : null}
    </>
  );
}

"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { buildKubernetesCiem, type CiemFlag } from "../../../lib/kubernetes-ciem";
import { deriveCiemInputs } from "../../../lib/kubernetes-ciem-evidence";
import { usePilotState } from "../../components/use-pilot-state";
import { useKubernetesEvidence } from "../use-kubernetes-evidence";

const FLAG_LABEL: Readonly<Record<CiemFlag, string>> = {
  "cluster-admin": "Cluster-admin",
  "impersonate": "Impersonate",
  "escalate-or-bind": "Escalate / bind",
  "secrets-access": "Reads Secrets",
  "pod-exec": "Pod exec",
  "wildcard-verb": "Wildcard verb",
  "wildcard-resource": "Wildcard resource",
  "aws-write": "AWS write",
  "aws-reachable": "Reaches AWS",
  "default-serviceaccount-in-use": "Default SA in use",
  "unused-serviceaccount": "Unused (bound, no pod)",
};

function flagClass(flag: CiemFlag): string {
  if (flag === "cluster-admin" || flag === "aws-write" || flag === "impersonate" || flag === "escalate-or-bind") return "compliance-status-fail";
  if (flag === "secrets-access" || flag === "pod-exec" || flag === "wildcard-verb" || flag === "wildcard-resource" || flag === "default-serviceaccount-in-use") return "compliance-status-unknown";
  return "compliance-status-not-applicable";
}

export function PermissionsWorkspace() {
  const { state, loading, error, refresh } = usePilotState();
  const kubernetes = useKubernetesEvidence(state);
  const [onlyRisky, setOnlyRisky] = useState(true);

  const report = useMemo(
    () => buildKubernetesCiem(deriveCiemInputs(kubernetes.projectionInput.resources)),
    [kubernetes.projectionInput.resources],
  );
  const subjects = onlyRisky ? report.subjects.filter((subject) => subject.flags.length > 0) : report.subjects;

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Kubernetes · Identity & entitlements</p><h1>Effective permissions (CIEM)</h1><p className="page-subtitle">What each identity can actually do — the union of every role bound to it — and, via its IRSA role, what it can reach in AWS. Answers &ldquo;can this pod read Secrets, or delete an S3 bucket?&rdquo; from cited RBAC and IAM evidence.</p></div>
        <div className="heading-actions"><Link className="button button-secondary" href="/kubernetes/issues">Issues</Link><button className="button button-primary" onClick={() => { void refresh(); void kubernetes.refresh(); }} type="button">Refresh</button></div>
      </section>
      <div className="trust-strip" role="note"><span className="trust-icon">K</span><span>{report.disclaimer}</span></div>

      {error || kubernetes.error ? <div className="page-alert page-alert-error" role="alert"><strong>Permission evidence unavailable</strong><span>{error ?? kubernetes.error}</span><button onClick={() => { void refresh(); void kubernetes.refresh(); }} type="button">Retry</button></div> : null}
      {loading || kubernetes.loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Resolving effective permissions…</div> : null}

      {!loading && !kubernetes.loading ? <>
        <section className="inventory-stats">
          <article><small>Resolved identities</small><strong>{report.totals.subjects}</strong><span>From collected RBAC bindings</span></article>
          <article><small>Cluster-admins</small><strong>{report.totals.clusterAdmins}</strong><span>Full wildcard authority</span></article>
          <article><small>Read Secrets</small><strong>{report.totals.secretsReaders}</strong><span>get/list/watch on secrets</span></article>
          <article><small>Reach AWS</small><strong>{report.totals.awsReachable}</strong><span>{report.totals.awsWrite} with write access (IRSA / Pod Identity)</span></article>
          <article><small>Unused SAs</small><strong>{report.totals.unusedServiceAccounts}</strong><span>Bound, no workload assumes them</span></article>
          <article><small>Default SA in use</small><strong>{report.totals.defaultInUse}</strong><span>Privileged default SA mounted by a pod</span></article>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div><p className="eyebrow">Ranked by entitlement risk</p><h2>Identities</h2></div>
            <label className="filter-toggle"><input checked={onlyRisky} onChange={(event) => setOnlyRisky(event.target.checked)} type="checkbox" /> Only flagged identities</label>
          </div>
          {subjects.length > 0 ? <div className="ciem-list">
            {subjects.map((subject) => <article className="ciem-card" key={subject.subject}>
              <div className="ciem-head">
                <div><strong>{subject.subject}</strong><small>{subject.boundRoles.length} bound role{subject.boundRoles.length === 1 ? "" : "s"}: {subject.boundRoles.join(", ") || "none resolved"}{subject.usedByWorkloads !== null ? ` · used by ${subject.usedByWorkloads} workload${subject.usedByWorkloads === 1 ? "" : "s"}` : ""}</small></div>
                <div className="ciem-risk"><strong>{subject.riskScore}</strong><small>risk</small></div>
              </div>
              {subject.flags.length > 0 ? <div className="ciem-flags">{subject.flags.map((flag) => <span className={`compliance-status ${flagClass(flag)}`} key={flag}>{FLAG_LABEL[flag]}</span>)}</div> : <p className="panel-footnote">No high-risk entitlement flag.</p>}
              {subject.awsReach !== null ? <div className="ciem-aws">
                <p className="eyebrow">AWS reach via {subject.awsReach.linkage === "pod-identity" ? "EKS Pod Identity" : subject.awsReach.linkage === "irsa" ? "IRSA" : "role"} · {subject.awsReach.roleArn}</p>
                {subject.awsReach.allowedActions.length > 0
                  ? <p><code>{subject.awsReach.allowedActions.slice(0, 12).join(", ")}{subject.awsReach.allowedActions.length > 12 ? ` +${subject.awsReach.allowedActions.length - 12} more` : ""}</code> on <code>{subject.awsReach.allowedResources.slice(0, 4).join(", ") || "unspecified"}</code></p>
                  : <p className="panel-footnote">IRSA role annotated but its IAM policy was not collected — AWS reach is unresolved, not assumed empty.</p>}
              </div> : null}
              <details className="ciem-perms"><summary>{subject.permissions.length} effective permission{subject.permissions.length === 1 ? "" : "s"}</summary>
                <ul>{subject.permissions.slice(0, 60).map((perm, index) => <li key={`${subject.subject}:${index}`}><code>{perm.verb}</code> {perm.resource}{perm.apiGroup ? ` (${perm.apiGroup})` : ""}</li>)}</ul>
                {subject.permissions.length > 60 ? <p className="panel-footnote">Showing 60 of {subject.permissions.length}.</p> : null}
              </details>
            </article>)}
          </div> : <section className="empty-workspace compact-empty"><span className="empty-workspace-icon">RB</span><h2>No resolved identities</h2><p>No RBAC binding evidence with subjects is present in the current authorized snapshot. Import a collector artifact that includes Role/ClusterRole rules and RoleBinding subjects. This does not prove least privilege; it reflects collector coverage.</p></section>}
        </section>
      </> : null}
    </>
  );
}

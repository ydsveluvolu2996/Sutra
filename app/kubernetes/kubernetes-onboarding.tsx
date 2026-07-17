"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { EksEnrollmentPlan } from "../../lib/eks-enrollment";
import { formatTimestamp, postPilot, usePilotState } from "../components/use-pilot-state";
import { buildKubernetesProjection } from "./kubernetes-projection";
import { useKubernetesEvidence } from "./use-kubernetes-evidence";

const steps = [
  "Discover EKS",
  "Select cluster",
  "Visibility tier",
  "Install plan",
  "Verify evidence",
] as const;

export function KubernetesOnboarding() {
  const { state, loading, refreshing, error, refresh } = usePilotState();
  const kubernetes = useKubernetesEvidence(state);
  const [step, setStep] = useState(1);
  const [clusterKey, setClusterKey] = useState("");
  const [plan, setPlan] = useState<EksEnrollmentPlan | null>(null);
  const [working, setWorking] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<string | null>(null);
  const discoveryProjection = useMemo(() => buildKubernetesProjection({
    resources: state?.resources ?? [],
    relationships: state?.relationships ?? [],
    findings: state?.findings ?? [],
    coverage: state?.coverage ?? [],
  }), [state?.coverage, state?.findings, state?.relationships, state?.resources]);
  const projection = useMemo(() => buildKubernetesProjection(kubernetes.projectionInput), [kubernetes.projectionInput]);
  const clusters = discoveryProjection.records.filter((record) =>
    record.category === "cluster" &&
    record.resource.service === "eks" &&
    record.resource.resourceType === "aws.eks.cluster");
  const selected = clusters.find((record) => record.resource.resourceKey === clusterKey) ?? null;
  const registered = selected === null || state?.connection === null || state?.connection === undefined
    ? null
    : kubernetes.clusters.find((cluster) =>
      cluster.clusterUid === `${state.connection?.awsAccountId}:${selected.resource.region}:${selected.resource.nativeId}`);
  const successfulCoverage = projection.coverage.filter((entry) => entry.status === "succeeded");
  const canContinue = step === 1 || (step === 2 && selected !== null) || step >= 3;

  async function registerSelected(): Promise<void> {
    if (selected === null || state?.connection === null || state?.connection === undefined) return;
    setWorking(true);
    setOperationError(null);
    try {
      const result = await postPilot<{ cluster: { id: string }; plan: EksEnrollmentPlan }>(
        "/api/v1/kubernetes",
        {
          operation: "register-discovered-eks",
          connectionId: state.connection.id,
          resourceKey: selected.resource.resourceKey,
        },
      );
      setPlan(result.plan);
      window.dispatchEvent(new Event("sutra:kubernetes-changed"));
      await kubernetes.refresh();
    } catch (caught) {
      setOperationError(caught instanceof Error ? caught.message : "Sutra could not register this EKS cluster");
    } finally {
      setWorking(false);
    }
  }

  async function publishArtifact(file: File): Promise<void> {
    if (
      registered == null || state?.connection === null || state?.connection === undefined ||
      file.size < 2 || file.size > 2_750 * 1024
    ) {
      setOperationError("Select a registered cluster and a JSON artifact smaller than 2.7 MiB");
      return;
    }
    setWorking(true);
    setOperationError(null);
    setScanResult(null);
    try {
      const artifact = JSON.parse(await file.text()) as unknown;
      const result = await postPilot<{ scan: { id: string; status: string; resourceCount: number; findingCount: number } }>(
        "/api/v1/kubernetes/scans",
        {
          connectionId: state.connection.id,
          clusterId: registered.id,
          idempotencyKey: `scan_${crypto.randomUUID().replaceAll("-", "")}`,
          artifact,
        },
      );
      setScanResult(`${result.scan.status} scan stored · ${result.scan.resourceCount} resources · ${result.scan.findingCount} posture results`);
      window.dispatchEvent(new Event("sutra:kubernetes-changed"));
      await kubernetes.refresh();
    } catch (caught) {
      setOperationError(caught instanceof Error ? caught.message : "Sutra could not publish this scan artifact");
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Kubernetes onboarding</p><h1>Connect cluster visibility</h1><p className="page-subtitle">Discover an authorized EKS cluster, review the visibility contract, prepare a Helm installation plan, then verify only evidence actually returned to Sutra.</p></div>
        <div className="heading-actions"><Link className="button button-secondary" href="/kubernetes/coverage">Review coverage</Link><Link className="button button-primary" href="/kubernetes">Kubernetes overview</Link></div>
      </section>
      <div className="trust-strip" role="note"><span className="trust-icon">!</span><span><strong>Private-beta visibility workflow.</strong> Registration and scan persistence are functional. Customer-admin EKS access and the checked-in read-only Helm role remain explicit review steps; Sutra never accepts kubeconfig, tokens, Secrets, exec access, or runtime privileges here.</span></div>
      {error || kubernetes.error || operationError ? <div className="page-alert page-alert-error" role="alert"><strong>Discovery unavailable</strong><span>{error ?? kubernetes.error ?? operationError}</span><button onClick={() => { void refresh(); void kubernetes.refresh(); }} type="button">Retry</button></div> : null}
      {loading || kubernetes.loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Reading authorized cluster evidence…</div> : null}

      {!loading && !kubernetes.loading ? <section className="panel kubernetes-onboarding">
        <ol className="kubernetes-onboarding-steps" aria-label="Kubernetes onboarding progress">
          {steps.map((label, index) => <li className={step === index + 1 ? "active" : step > index + 1 ? "complete" : ""} key={label}><span>{step > index + 1 ? "✓" : index + 1}</span><strong>{label}</strong></li>)}
        </ol>

        <div className="kubernetes-onboarding-stage">
          {step === 1 ? <section>
            <p className="eyebrow">Step 1 · AWS discovery</p><h2>Discover EKS cluster records</h2>
            <p>Sutra reads only the current authorized normalized snapshot. It does not probe AWS or Kubernetes from this browser.</p>
            <div className="kubernetes-discovery-summary">
              <div><small>AWS account</small><strong>{state?.connection?.awsAccountId ?? "Not connected"}</strong></div>
              <div><small>Snapshot</small><strong>{state?.activeSnapshot ? formatTimestamp(state.activeSnapshot.collectedAt) : "Not published"}</strong></div>
              <div><small>Observed clusters</small><strong>{clusters.length}</strong></div>
              <div><small>Registered clusters</small><strong>{kubernetes.clusters.length}</strong></div>
            </div>
            {state?.connection === null ? <div className="empty-state"><strong>No AWS account connection</strong><span>Complete trust-role onboarding before EKS discovery.</span><Link className="button button-primary" href="/onboard">Onboard AWS account</Link></div> : null}
          </section> : null}

          {step === 2 ? <section>
            <p className="eyebrow">Step 2 · Exact selection</p><h2>Select an observed cluster</h2>
            <p>Only normalized resources explicitly typed as EKS or Kubernetes clusters are selectable.</p>
            <div className="kubernetes-cluster-selector">
              {clusters.map((cluster) => <label className={clusterKey === cluster.resource.resourceKey ? "selected" : ""} key={cluster.resource.resourceKey}>
                <input checked={clusterKey === cluster.resource.resourceKey} name="cluster" onChange={() => setClusterKey(cluster.resource.resourceKey)} type="radio" />
                <span><strong>{cluster.displayName}</strong><small>{cluster.resource.region} · {cluster.resource.source.accountId}</small><small>{cluster.resource.nativeId}</small></span>
                <span className="status-pill status-positive">Observed</span>
              </label>)}
              {clusters.length === 0 ? <div className="empty-state"><strong>No EKS cluster records in the active snapshot</strong><span>Run an approved collector after the EKS permission pack is available. Sutra will not infer a cluster from EC2 nodes.</span><div className="heading-actions"><Link className="button button-secondary" href="/onboard">Review AWS connection</Link><Link className="button button-secondary" href="/roadmap">Collector roadmap</Link></div></div> : null}
            </div>
          </section> : null}

          {step === 3 ? <section>
            <p className="eyebrow">Step 3 · Collection tier</p><h2>Choose the visibility boundary</h2>
            <div className="kubernetes-tier-grid">
              <label className="selected"><input checked readOnly type="radio" /><span><strong>Visibility</strong><small>Read-only inventory, selected configuration metadata, RBAC/network posture inputs and explicit coverage.</small><b>Selected</b></span></label>
              <label aria-disabled="true" className="disabled"><input disabled type="radio" /><span><strong>Advanced</strong><small>Runtime telemetry, admission enforcement and deeper workload signals require an approved sensor release not present in this build.</small><b>Unavailable</b></span></label>
            </div>
            <div className="limitation-note"><strong>Visibility does not include:</strong> secrets, ConfigMap values, pod logs, exec access, packet contents, image layers, package SBOMs, runtime events, admission mutation, or workload changes.</div>
          </section> : null}

          {step === 4 ? <section>
            <p className="eyebrow">Step 4 · Customer-reviewed installation</p><h2>Generated visibility installation plan</h2>
            {selected ? <>
              <div className="deployment-parameters">
                <div><small>Cluster</small><code>{selected.displayName}</code></div>
                <div><small>Region</small><code>{selected.resource.region}</code></div>
                <div><small>Mode</small><code>visibility-only</code></div>
              </div>
              <ol className="kubernetes-install-checklist">
                <li><span>1</span><div><strong>Register the exact discovered cluster</strong><p>Creates only a customer-scoped, credential-free identity in Sutra PostgreSQL.</p></div></li>
                <li><span>2</span><div><strong>Review customer-owned access</strong><p>The generated EKS access entry maps the existing trust role to the exact <code>sutra:readers</code> Kubernetes group.</p></div></li>
                <li><span>3</span><div><strong>Install the read-only role</strong><p>The local Helm chart grants get/list only, excludes Secret and ConfigMap access, and performs no workload mutations.</p></div></li>
              </ol>
              <button className="button button-primary" disabled={working} onClick={() => void registerSelected()} type="button">{working ? "Preparing…" : registered ? "Regenerate reviewed plan" : "Register and generate plan"}</button>
              {plan ? <div className="kubernetes-command-preview">
                <div><strong>Customer administrator commands</strong><span>Review before execution</span></div>
                <pre>{`${plan.commands.createAccessEntry}\n\n${plan.commands.installVisibilityRole}`}</pre>
              </div> : <div className="limitation-note"><strong>No command is executed by Sutra.</strong> Generate the plan, review it with the customer, then run it only from an authenticated customer administrator terminal.</div>}
              {registered ? <div className="kubernetes-command-preview">
                <div><strong>Credential-free evidence command</strong><span>Runs locally</span></div>
                <pre>{`pnpm kubernetes:scan --context ${selected.resource.nativeId} \\\n  --cluster-id ${registered.clusterUid} \\\n  --cluster-name ${selected.displayName}`}</pre>
              </div> : null}
              <div className="kubernetes-values-preview"><p className="eyebrow">Generated non-secret values</p><pre>{`cluster:\n  id: ${JSON.stringify(selected.resource.nativeId)}\n  name: ${JSON.stringify(selected.displayName)}\n  region: ${JSON.stringify(selected.resource.region)}\nmode: visibility-only\nruntime:\n  enabled: false\nsecrets:\n  collect: false`}</pre></div>
            </> : <div className="empty-state"><strong>No cluster selected</strong><span>Return to cluster selection before generating an installation plan.</span></div>}
          </section> : null}

          {step === 5 ? <section>
            <p className="eyebrow">Step 5 · Evidence verification</p><h2>Verify reported status</h2>
            <p>Import the credential-free JSON artifact produced by the Sutra collector. The server validates tenant scope, cluster identity, size, evidence schema and idempotency before one atomic publication.</p>
            <div className="kubernetes-verification-grid">
              <article><span className={selected ? "positive" : "unknown"}>{selected ? "✓" : "—"}</span><div><strong>EKS resource observed</strong><small>{selected ? `${selected.displayName} exists in the normalized CMDB` : "No selected cluster record"}</small></div></article>
              <article><span className={successfulCoverage.length > 0 ? "positive" : "unknown"}>{successfulCoverage.length > 0 ? "✓" : "—"}</span><div><strong>Kubernetes API coverage</strong><small>{successfulCoverage.length > 0 ? `${successfulCoverage.length} successful checks reported for this account` : "No successful Kubernetes collector checks"}</small></div></article>
              <article><span className={registered ? "positive" : "unknown"}>{registered ? "✓" : "—"}</span><div><strong>Sutra registration</strong><small>{registered ? `Customer-scoped cluster ${registered.id}` : "Cluster is not registered"}</small></div></article>
              <article><span className="unknown">—</span><div><strong>Runtime sensor</strong><small>Not enabled and not supported in this release</small></div></article>
            </div>
            <label className="button button-primary" aria-disabled={registered === null || working}>
              {working ? "Validating scan…" : "Import collector JSON"}
              <input accept="application/json,.json" disabled={registered === null || working} hidden onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) void publishArtifact(file);
                event.currentTarget.value = "";
              }} type="file" />
            </label>
            {scanResult ? <div className="page-alert page-alert-success" role="status"><strong>Evidence published</strong><span>{scanResult}</span></div> : null}
            <button className="button button-secondary" disabled={refreshing || working} onClick={() => { void refresh(); void kubernetes.refresh(); }} type="button">{refreshing ? "Refreshing evidence…" : "Refresh normalized evidence"}</button>
          </section> : null}
        </div>

        <div className="kubernetes-wizard-actions">
          <button className="button button-secondary" disabled={step === 1} onClick={() => setStep((current) => Math.max(1, current - 1))} type="button">Back</button>
          {step < steps.length ? <button className="button button-primary" disabled={!canContinue || (step === 1 && state?.connection === null)} onClick={() => setStep((current) => Math.min(steps.length, current + 1))} type="button">Continue</button> : <Link className="button button-primary" href="/kubernetes/coverage">Open coverage</Link>}
        </div>
      </section> : null}
    </>
  );
}

"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { EksEnrollmentPlan } from "../../lib/eks-enrollment";
import {
  KUBERNETES_INSTALLATION_MODULES,
  type KubernetesInstallationModule,
  type KubernetesInstallationPlan,
} from "../../lib/kubernetes-installation-plan";
import { formatTimestamp, postPilot, usePilotState } from "../components/use-pilot-state";
import { buildKubernetesProjection } from "./kubernetes-projection";
import { useKubernetesEvidence } from "./use-kubernetes-evidence";

interface AgentDeploymentHealth {
  readonly agentId: string;
  readonly state: "online" | "offline" | "revoked";
  readonly agentVersion: string;
  readonly deployment: {
    readonly namespace: string;
    readonly podName: string;
    readonly startedAt: string;
  } | null;
  readonly modules: Readonly<Record<string, string>>;
  readonly lastHeartbeatAt: string | null;
  readonly lastScanAt: string | null;
}

const steps = [
  "Discover EKS",
  "Select cluster",
  "Select modules",
  "Review access",
  "Installation plan",
  "Health",
  "Lifecycle",
] as const;

const moduleCards: Readonly<Record<KubernetesInstallationModule, {
  readonly name: string;
  readonly summary: string;
  readonly risk: "Low" | "Medium" | "High";
}>> = {
  inventory: {
    name: "Inventory and KSPM",
    summary: "Read-only resources, RBAC, exposure, posture and continuous evidence.",
    risk: "Low",
  },
  trivy: {
    name: "Trivy",
    summary: "Image CVEs, configuration, RBAC, compliance and CycloneDX SBOM evidence.",
    risk: "Low",
  },
  kyverno: {
    name: "Kyverno",
    summary: "Audit-first admission policies, PolicyReports, exceptions and promotion.",
    risk: "Medium",
  },
  falco: {
    name: "Falco",
    summary: "Signed runtime detection events from a privileged node sensor.",
    risk: "Medium",
  },
  cilium: {
    name: "Cilium and Hubble",
    summary: "AWS VPC CNI-chained network flow metadata and service maps.",
    risk: "High",
  },
  "supply-chain": {
    name: "Supply chain",
    summary: "Trivy, Syft, Cosign, provenance and immutable ECR release evidence.",
    risk: "Medium",
  },
};

export function KubernetesOnboarding() {
  const { state, loading, refreshing, error, refresh } = usePilotState();
  const kubernetes = useKubernetesEvidence(state);
  const [step, setStep] = useState(1);
  const [clusterKey, setClusterKey] = useState("");
  const [plan, setPlan] = useState<EksEnrollmentPlan | null>(null);
  const [installationPlan, setInstallationPlan] = useState<KubernetesInstallationPlan | null>(null);
  const [selectedModules, setSelectedModules] = useState<readonly KubernetesInstallationModule[]>([
    "inventory", "trivy", "kyverno", "falco", "supply-chain",
  ]);
  const [contextName, setContextName] = useState("");
  const [working, setWorking] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [agentHealth, setAgentHealth] = useState<readonly AgentDeploymentHealth[] | null>(null);
  const [agentHealthError, setAgentHealthError] = useState<string | null>(null);

  async function refreshAgentHealth(): Promise<void> {
    if (registered == null || state?.connection === null || state?.connection === undefined) {
      setAgentHealth(null);
      setAgentHealthError("Register the cluster before reading agent deployment health");
      return;
    }
    try {
      const response = await fetch(
        `/api/v1/kubernetes/agents?connectionId=${encodeURIComponent(state.connection.id)}&clusterId=${encodeURIComponent(registered.id)}`,
        { cache: "no-store", credentials: "same-origin" },
      );
      const body = await response.json() as { agents?: readonly AgentDeploymentHealth[]; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Agent deployment health is unavailable");
      setAgentHealth(body.agents ?? []);
      setAgentHealthError(null);
    } catch (caught) {
      setAgentHealth(null);
      setAgentHealthError(caught instanceof Error ? caught.message : "Agent deployment health is unavailable");
    }
  }
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
  const canContinue =
    step === 1 ||
    (step === 2 && selected !== null) ||
    (step === 3 && selectedModules.length > 0) ||
    step >= 4;

  async function registerSelected(): Promise<{ readonly cluster: { readonly id: string } } | null> {
    if (selected === null || state?.connection === null || state?.connection === undefined) return null;
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
      if (!contextName) setContextName(selected.resource.nativeId);
      window.dispatchEvent(new Event("sutra:kubernetes-changed"));
      await kubernetes.refresh();
      return { cluster: result.cluster };
    } catch (caught) {
      setOperationError(caught instanceof Error ? caught.message : "Sutra could not register this EKS cluster");
    } finally {
      setWorking(false);
    }
    return null;
  }

  function toggleModule(module: KubernetesInstallationModule): void {
    setInstallationPlan(null);
    setSelectedModules((current) =>
      current.includes(module)
        ? current.filter((candidate) => candidate !== module)
        : KUBERNETES_INSTALLATION_MODULES.filter((candidate) =>
          current.includes(candidate) || candidate === module));
  }

  async function generateInstallationPlan(): Promise<void> {
    if (selected === null || state?.connection === null || state?.connection === undefined) return;
    setWorking(true);
    setOperationError(null);
    try {
      let clusterId = registered?.id ?? null;
      if (clusterId === null) {
        const result = await postPilot<{ cluster: { id: string }; plan: EksEnrollmentPlan }>(
          "/api/v1/kubernetes",
          {
            operation: "register-discovered-eks",
            connectionId: state.connection.id,
            resourceKey: selected.resource.resourceKey,
          },
        );
        clusterId = result.cluster.id;
        setPlan(result.plan);
      }
      const result = await postPilot<{ plan: KubernetesInstallationPlan }>(
        "/api/v1/kubernetes/installations/plan",
        {
          operation: "create-plan",
          connectionId: state.connection.id,
          clusterId,
          context: contextName || selected.resource.nativeId,
          modules: selectedModules,
        },
      );
      setInstallationPlan(result.plan);
      window.dispatchEvent(new Event("sutra:kubernetes-changed"));
      await kubernetes.refresh();
    } catch (caught) {
      setOperationError(caught instanceof Error ? caught.message : "Sutra could not create the installation plan");
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
        <div><p className="eyebrow">Kubernetes onboarding</p><h1>Deploy approved cluster protection</h1><p className="page-subtitle">Discover an authorized EKS cluster, select security modules, review exact access, generate a pinned plan and verify evidence-driven health and rollback.</p></div>
        <div className="heading-actions"><Link className="button button-secondary" href="/kubernetes/coverage">Review coverage</Link><Link className="button button-primary" href="/kubernetes">Kubernetes overview</Link></div>
      </section>
      <div className="trust-strip" role="note"><span className="trust-icon">!</span><span><strong>Customer-approved installation workflow.</strong> Registration, tenant-scoped planning and evidence persistence are functional. This browser never accepts kubeconfig, bearer tokens or Kubernetes Secret payloads, and it cannot execute the generated cluster commands.</span></div>
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
            <p className="eyebrow">Step 3 · Protection modules</p><h2>Select only the protection the customer approves</h2>
            <p>Every module is independently reviewable. Cilium changes the cluster datapath and is never preselected.</p>
            <div className="kubernetes-module-selector">
              {KUBERNETES_INSTALLATION_MODULES.map((module) => {
                const card = moduleCards[module];
                const checked = selectedModules.includes(module);
                return <label className={checked ? "selected" : ""} key={module}>
                  <input checked={checked} onChange={() => toggleModule(module)} type="checkbox" />
                  <span><strong>{card.name}</strong><small>{card.summary}</small></span>
                  <b className={`module-risk module-risk-${card.risk.toLowerCase()}`}>{card.risk} risk</b>
                </label>;
              })}
            </div>
            <div className="limitation-note"><strong>Always excluded:</strong> Kubernetes Secret payloads, ConfigMap values, pod logs, exec access, packet payloads and long-lived cloud credentials.</div>
          </section> : null}

          {step === 4 ? <section>
            <p className="eyebrow">Step 4 · Access and change review</p><h2>Know what each selected module can do</h2>
            {selected ? <>
              <div className="deployment-parameters">
                <div><small>Cluster</small><code>{selected.displayName}</code></div>
                <div><small>Region</small><code>{selected.resource.region}</code></div>
                <div><small>Selected modules</small><code>{selectedModules.length}</code></div>
              </div>
              <div className="kubernetes-permission-review">
                {selectedModules.map((module) => {
                  const card = moduleCards[module];
                  const permission = module === "inventory" || module === "trivy"
                    ? "Read-only metadata and report access"
                    : module === "kyverno"
                      ? "Admission webhook; audit-only policies by default"
                      : module === "falco"
                        ? "Privileged node sensor and signed event gateway"
                        : module === "cilium"
                          ? "Privileged network component; explicit CNI approval required"
                          : "GitHub OIDC, ECR digest and signature metadata";
                  return <article key={module}><span>{card.name.slice(0, 2).toUpperCase()}</span><div><strong>{card.name}</strong><small>{permission}</small></div><b className={`module-risk module-risk-${card.risk.toLowerCase()}`}>{card.risk}</b></article>;
                })}
              </div>
              <button className="button button-secondary" disabled={working} onClick={() => void registerSelected()} type="button">{working ? "Preparing…" : registered ? "Regenerate EKS access plan" : "Register cluster and generate EKS access plan"}</button>
              {plan ? <div className="kubernetes-command-preview">
                <div><strong>Read-only EKS access commands</strong><span>Customer review required</span></div>
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
            <p className="eyebrow">Step 5 · Reviewed installation</p><h2>Generate a pinned, non-executing plan</h2>
            <p>The plan API verifies the session, tenant, customer connection and registered cluster. It returns commands but cannot accept credentials or execute cluster mutations.</p>
            <label className="kubernetes-context-field"><span>Kubernetes context name</span><input maxLength={254} onChange={(event) => { setContextName(event.target.value); setInstallationPlan(null); }} placeholder={selected?.resource.nativeId ?? "customer-cluster"} value={contextName} /></label>
            <button className="button button-primary" disabled={working || selectedModules.length === 0 || selected === null} onClick={() => void generateInstallationPlan()} type="button">{working ? "Generating reviewed plan…" : "Generate installation plan"}</button>
            {installationPlan ? <>
              <div className="page-alert page-alert-success" role="status"><strong>Plan ready; no changes made</strong><span>{installationPlan.modules.length} modules · install order recorded · rollback order verified</span></div>
              <ol className="kubernetes-install-checklist">
                {installationPlan.prerequisites.map((item, index) => <li key={item.id}><span>{index + 1}</span><div><strong>{item.label}</strong><p>{item.review}</p></div></li>)}
              </ol>
              <div className="kubernetes-command-preview">
                <div><strong>Preflight command</strong><span>No mutations</span></div>
                <pre>{installationPlan.lifecycle.preflightCommand}</pre>
              </div>
              <div className="kubernetes-plan-modules">
                {installationPlan.modules.map((module) => <article key={module.id}><div><strong>{module.name}</strong><small>{module.version} · {module.risk} risk</small></div><code>{module.installCommands.join("\n")}</code></article>)}
              </div>
            </> : <div className="limitation-note"><strong>Planning is safe.</strong> This action registers the exact cluster if needed and creates a tenant-scoped plan. It does not run Helm, kubectl or AWS commands.</div>}
          </section> : null}

          {step === 6 ? <section>
            <p className="eyebrow">Step 6 · Health and evidence</p><h2>Verify only what the cluster reports</h2>
            <p>Machine-readable health is produced by the reviewed cluster-side command. Inventory evidence can also be imported through the bounded, idempotent publication API.</p>
            <div className="kubernetes-verification-grid">
              <article><span className={selected ? "positive" : "unknown"}>{selected ? "✓" : "—"}</span><div><strong>EKS resource observed</strong><small>{selected ? `${selected.displayName} exists in the normalized CMDB` : "No selected cluster record"}</small></div></article>
              <article><span className={successfulCoverage.length > 0 ? "positive" : "unknown"}>{successfulCoverage.length > 0 ? "✓" : "—"}</span><div><strong>Kubernetes API coverage</strong><small>{successfulCoverage.length > 0 ? `${successfulCoverage.length} successful checks reported for this account` : "No successful Kubernetes collector checks"}</small></div></article>
              <article><span className={registered ? "positive" : "unknown"}>{registered ? "✓" : "—"}</span><div><strong>Sutra registration</strong><small>{registered ? `Customer-scoped cluster ${registered.id}` : "Cluster is not registered"}</small></div></article>
              <article><span className={installationPlan ? "positive" : "unknown"}>{installationPlan ? "✓" : "—"}</span><div><strong>Module health contract</strong><small>{installationPlan ? "Machine-readable health command generated" : "Generate the installation plan first"}</small></div></article>
            </div>
            {installationPlan ? <div className="kubernetes-command-preview"><div><strong>Health evidence command</strong><span>JSON output</span></div><pre>{installationPlan.lifecycle.healthCommand}</pre></div> : null}
            <section className="kubernetes-subsection">
              <div className="panel-heading"><div><h3>Module deployment health</h3><p className="panel-footnote">Reported only from signed agent heartbeats; a missing agent is shown as absent, never assumed healthy.</p></div><button className="button button-secondary" disabled={registered == null} onClick={() => void refreshAgentHealth()} type="button">Read heartbeat health</button></div>
              {agentHealthError ? <div className="empty-state"><strong>No heartbeat evidence</strong><span>{agentHealthError}</span></div> : null}
              {agentHealth !== null && agentHealth.length === 0 ? <div className="empty-state"><strong>No enrolled agent for this cluster</strong><span>Install the visibility agent with a one-time enrollment token to begin heartbeat health reporting.</span></div> : null}
              {agentHealth !== null && agentHealth.length > 0 ? <div className="kubernetes-verification-grid">
                {agentHealth.map((agent) => <article key={agent.agentId}>
                  <span className={agent.state === "online" ? "positive" : "unknown"}>{agent.state === "online" ? "✓" : "—"}</span>
                  <div>
                    <strong>{agent.deployment ? `${agent.deployment.namespace}/${agent.deployment.podName}` : agent.agentId} · {agent.state}</strong>
                    <small>v{agent.agentVersion}{agent.lastHeartbeatAt ? ` · heartbeat ${formatTimestamp(agent.lastHeartbeatAt)}` : " · no heartbeat received"}{agent.lastScanAt ? ` · scan ${formatTimestamp(agent.lastScanAt)}` : ""}</small>
                    <small>{Object.entries(agent.modules).length > 0
                      ? Object.entries(agent.modules).map(([name, value]) => `${name}: ${value.toLocaleLowerCase("en-US").replaceAll("_", " ")}`).join(" · ")
                      : "No module health reported yet"}</small>
                  </div>
                </article>)}
              </div> : null}
            </section>
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

          {step === 7 ? <section>
            <p className="eyebrow">Step 7 · Upgrade and rollback</p><h2>Review the full module lifecycle</h2>
            <p>Upgrades remain pinned and atomic. Rollback runs in reverse dependency order; Cilium removal refuses to continue unless the AWS VPC CNI is fully healthy.</p>
            {installationPlan ? <>
              <div className="kubernetes-lifecycle-summary">
                <div><small>Plan state</small><strong>{installationPlan.lifecycle.state}</strong></div>
                <div><small>Install order</small><strong>{installationPlan.lifecycle.installOrder.join(" → ")}</strong></div>
                <div><small>Rollback order</small><strong>{installationPlan.lifecycle.rollbackOrder.join(" → ")}</strong></div>
                <div><small>CNI approval</small><strong>{installationPlan.lifecycle.requiresCniApproval ? "Required" : "Not selected"}</strong></div>
              </div>
              <div className="kubernetes-plan-modules">
                {installationPlan.modules.map((module) => <article key={module.id}><div><strong>{module.name}</strong><small>Expected checks: {module.expectedHealthChecks.join(", ")}</small></div><code>{`Upgrade: ${module.upgradeCommand}\nRollback: ${module.rollbackCommand}`}</code></article>)}
              </div>
              <div className="limitation-note"><strong>Live state is evidence-driven.</strong> “Healthy”, “upgraded” or “rolled back” is shown only after a signed agent heartbeat or machine-readable lifecycle result is received.</div>
            </> : <div className="empty-state"><strong>No lifecycle plan yet</strong><span>Generate an installation plan before reviewing upgrade and rollback operations.</span><button className="button button-secondary" onClick={() => setStep(5)} type="button">Return to plan</button></div>}
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

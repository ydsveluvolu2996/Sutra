"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { FleetHealthSummary } from "../../../lib/kubernetes-fleet-health";
import {
  agentDisplayName,
  agentRevocationActionLabel,
  agentRevocationConfirmation,
  applyAgentRevocation,
  buildAgentRevocationRequest,
  isRevocable,
  type ManagedAgent,
} from "../../../lib/kubernetes-agent-revocation";
import { formatTimestamp, usePilotState } from "../../components/use-pilot-state";

const CLUSTER_STATE_LABEL: Readonly<Record<string, string>> = {
  online: "Online",
  degraded: "Degraded",
  offline: "Offline",
  not_enrolled: "Not enrolled",
};

const AGENT_STATE_LABEL: Readonly<Record<ManagedAgent["state"], string>> = {
  online: "Online",
  offline: "Offline",
  revoked: "Revoked",
};

function agentStatePill(state: ManagedAgent["state"]): string {
  if (state === "online") return "status-positive";
  if (state === "offline") return "compliance-status-fail";
  return "compliance-status-not-applicable";
}

function clusterStatePill(state: string): string {
  if (state === "online") return "status-positive";
  if (state === "degraded") return "status-medium";
  if (state === "offline") return "compliance-status-fail";
  return "compliance-status-not-applicable";
}

function moduleDot(state: string): string {
  if (state === "AVAILABLE") return "severity-info";
  if (state === "DEGRADED") return "severity-high";
  if (state === "NOT_CONFIGURED") return "severity-low";
  return "severity-medium";
}

export function FleetHealthWorkspace() {
  const { state, loading, error, refresh } = usePilotState();
  const connectionId = state?.connection?.id ?? null;
  const [fleet, setFleet] = useState<FleetHealthSummary | null>(null);
  const [fleetError, setFleetError] = useState<string | null>(null);
  const [fleetLoading, setFleetLoading] = useState(false);
  // Agent-credential management is opened for one cluster at a time: the agents
  // API is scoped to a single (connection, cluster) pair, so there is no
  // org-wide agent read to page through.
  const [managedClusterId, setManagedClusterId] = useState<string | null>(null);
  const [agents, setAgents] = useState<readonly ManagedAgent[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [confirmingAgentId, setConfirmingAgentId] = useState<string | null>(null);
  const [revokingAgentId, setRevokingAgentId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeResult, setRevokeResult] = useState<string | null>(null);

  const managedCluster = fleet?.clusters.find((cluster) => cluster.clusterId === managedClusterId) ?? null;

  const refreshFleet = useCallback(async () => {
    if (connectionId === null) {
      setFleet(null);
      setFleetError(null);
      return;
    }
    setFleetLoading(true);
    try {
      const response = await fetch(`/api/v1/kubernetes/fleet?connectionId=${encodeURIComponent(connectionId)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const body = await response.json() as FleetHealthSummary & { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Fleet health is unavailable");
      setFleet(body);
      setFleetError(null);
    } catch (caught) {
      setFleet(null);
      setFleetError(caught instanceof Error ? caught.message : "Fleet health is unavailable");
    } finally {
      setFleetLoading(false);
    }
  }, [connectionId]);

  const loadAgents = useCallback(async (clusterId: string) => {
    if (connectionId === null) return;
    setAgentsLoading(true);
    try {
      const response = await fetch(
        `/api/v1/kubernetes/agents?connectionId=${encodeURIComponent(connectionId)}&clusterId=${encodeURIComponent(clusterId)}`,
        { cache: "no-store", credentials: "same-origin" },
      );
      const body = await response.json().catch(() => null) as
        { agents?: readonly ManagedAgent[]; error?: { message?: string } } | null;
      if (!response.ok || body === null) {
        throw new Error(body?.error?.message ?? "Agent credentials are unavailable");
      }
      setAgents(body.agents ?? []);
      setAgentsError(null);
    } catch (caught) {
      setAgents(null);
      setAgentsError(caught instanceof Error ? caught.message : "Agent credentials are unavailable");
    } finally {
      setAgentsLoading(false);
    }
  }, [connectionId]);

  function closeAgents(): void {
    setManagedClusterId(null);
    setAgents(null);
    setAgentsError(null);
    setConfirmingAgentId(null);
    setRevokeError(null);
    setRevokeResult(null);
  }

  function openAgents(clusterId: string): void {
    if (managedClusterId === clusterId) {
      closeAgents();
      return;
    }
    setManagedClusterId(clusterId);
    setAgents(null);
    setAgentsError(null);
    setConfirmingAgentId(null);
    setRevokeError(null);
    setRevokeResult(null);
    void loadAgents(clusterId);
  }

  async function revokeAgent(agent: ManagedAgent, clusterName: string): Promise<void> {
    if (connectionId === null || managedClusterId === null || revokingAgentId !== null) return;
    setRevokingAgentId(agent.agentId);
    setRevokeError(null);
    setRevokeResult(null);
    try {
      const { path, body } = buildAgentRevocationRequest({
        agentId: agent.agentId,
        connectionId,
        clusterId: managedClusterId,
        clusterName,
      });
      const response = await fetch(path, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => null) as
        { status?: string; error?: { message?: string } } | null;
      if (!response.ok || result === null) {
        // Surface the real API error rather than a generic failure.
        throw new Error(result?.error?.message ?? `Revocation failed (HTTP ${String(response.status)})`);
      }
      setAgents((current) => (current === null ? current : applyAgentRevocation(current, agent.agentId)));
      setConfirmingAgentId(null);
      setRevokeResult(
        `Credential revoked for agent ${agent.agentId} on cluster ${clusterName}. ` +
        "It stops reporting until it is re-enrolled.",
      );
      await refreshFleet();
    } catch (caught) {
      setRevokeError(caught instanceof Error ? caught.message : "Revocation failed");
    } finally {
      setRevokingAgentId(null);
    }
  }

  useEffect(() => {
    const task = window.setTimeout(() => void refreshFleet(), 0);
    return () => window.clearTimeout(task);
  }, [refreshFleet]);

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Kubernetes · Fleet operations</p><h1>Fleet deployment health</h1><p className="page-subtitle">Signed-heartbeat health for every registered cluster and its security modules. A cluster without a heartbeat is shown as not enrolled or offline, never assumed healthy.</p></div>
        <div className="heading-actions"><Link className="button button-secondary" href="/kubernetes/onboard">Onboard cluster</Link><button className="button button-primary" disabled={fleetLoading || connectionId === null} onClick={() => void refreshFleet()} type="button">{fleetLoading ? "Refreshing…" : "Refresh health"}</button></div>
      </section>
      <div className="trust-strip" role="note"><span className="trust-icon">FH</span><span><strong>Heartbeat evidence only.</strong> Module health is the worst state reported across a cluster&apos;s online agents; offline agents never mask a degraded sibling.</span></div>

      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Workspace unavailable</strong><span>{error}</span><button onClick={() => void refresh()} type="button">Retry</button></div> : null}
      {fleetError ? <div className="page-alert page-alert-error" role="alert"><strong>Fleet health unavailable</strong><span>{fleetError}</span><button onClick={() => void refreshFleet()} type="button">Retry</button></div> : null}
      {loading || fleetLoading ? <div className="loading-state" role="status"><span className="loading-spinner" />Reading agent heartbeats…</div> : null}

      {!loading && !fleetLoading && state?.connection === null ? <section className="empty-workspace compact-empty"><span className="empty-workspace-icon">FH</span><h2>No AWS connection</h2><p>Connect an AWS account and onboard a cluster before fleet health is available.</p><Link className="button button-primary" href="/onboard">Onboard AWS account</Link></section> : null}

      {fleet !== null && !fleetLoading ? <>
        <section className="inventory-stats">
          <article><small>Registered clusters</small><strong>{fleet.totals.clusters}</strong><span>{fleet.totals.enrolledAgents} enrolled agent{fleet.totals.enrolledAgents === 1 ? "" : "s"}</span></article>
          <article><small>Online</small><strong>{fleet.totals.online}</strong><span>{fleet.totals.onlineAgents} agent{fleet.totals.onlineAgents === 1 ? "" : "s"} online</span></article>
          <article><small>Degraded</small><strong>{fleet.totals.degraded}</strong><span>Partial coverage or degraded module</span></article>
          <article><small>Offline / not enrolled</small><strong>{fleet.totals.offline + fleet.totals.notEnrolled}</strong><span>{fleet.totals.offline} offline · {fleet.totals.notEnrolled} not enrolled</span></article>
        </section>

        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">Every registered cluster</p><h2>Cluster health</h2></div><span className="result-count">{fleet.clusters.length} cluster{fleet.clusters.length === 1 ? "" : "s"}</span></div>
          {fleet.clusters.length > 0 ? <div className="fleet-health-list">
            {fleet.clusters.map((cluster) => <article className="fleet-health-row" key={cluster.clusterId}>
              <div className="fleet-health-cluster">
                <span className={`compliance-status ${clusterStatePill(cluster.state)}`}>{CLUSTER_STATE_LABEL[cluster.state] ?? cluster.state}</span>
                <div><strong>{cluster.clusterName}</strong><small>{cluster.distribution ?? "Kubernetes"} {cluster.version ?? ""} · {cluster.onlineAgentCount}/{cluster.agentCount} agent{cluster.agentCount === 1 ? "" : "s"} online</small></div>
              </div>
              <div className="fleet-health-modules">
                {Object.entries(cluster.modules).length > 0
                  ? Object.entries(cluster.modules).map(([name, moduleState]) => <span className="fleet-module" key={name}><span className={`severity-dot ${moduleDot(moduleState)}`} />{name}: {moduleState.toLocaleLowerCase("en-US").replaceAll("_", " ")}</span>)
                  : <span className="panel-footnote">No module health reported</span>}
              </div>
              <div className="fleet-health-times">
                <small>Heartbeat: {cluster.lastHeartbeatAt ? formatTimestamp(cluster.lastHeartbeatAt) : "none"}</small>
                <small>Scan: {cluster.lastScanAt ? formatTimestamp(cluster.lastScanAt) : "none"}</small>
                <button
                  aria-controls="fleet-agent-credentials"
                  aria-expanded={managedClusterId === cluster.clusterId}
                  aria-label={`${managedClusterId === cluster.clusterId ? "Hide" : "Manage"} enrolled agents for cluster ${cluster.clusterName}`}
                  className="button button-secondary"
                  disabled={revokingAgentId !== null}
                  onClick={() => openAgents(cluster.clusterId)}
                  type="button"
                >{managedClusterId === cluster.clusterId ? "Hide agents" : "Manage agents"}</button>
              </div>
            </article>)}
          </div> : <div className="empty-state"><strong>No registered clusters</strong><span>Onboard an EKS cluster to begin fleet health monitoring.</span></div>}
        </section>

        {managedClusterId !== null ? <section className="panel" id="fleet-agent-credentials">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Agent credentials</p>
              <h2>Enrolled agents · {managedCluster?.clusterName ?? managedClusterId}</h2>
              <p className="panel-footnote">Every agent enrolled against this cluster and the credential state Sutra holds for it. Revoking a credential is a security operation, not a cleanup step.</p>
            </div>
            <div className="heading-actions">
              <button className="button button-secondary" disabled={agentsLoading || revokingAgentId !== null} onClick={() => void loadAgents(managedClusterId)} type="button">{agentsLoading ? "Reading…" : "Reload agents"}</button>
              <button className="button button-secondary" disabled={revokingAgentId !== null} onClick={() => closeAgents()} type="button">Close</button>
            </div>
          </div>
          <div className="limitation-note"><strong>No credential material is ever shown.</strong> Sutra stores only a one-way digest of an agent token; this surface reads state and can revoke, never reveal or re-issue.</div>
          {revokeResult !== null ? <div className="page-alert page-alert-success" role="alert"><strong>Credential revoked</strong><span>{revokeResult}</span></div> : null}
          {revokeError !== null ? <div className="page-alert page-alert-error" role="alert"><strong>Revocation failed</strong><span>{revokeError}</span></div> : null}
          {agentsError !== null ? <div className="empty-state"><strong>Agent credentials unavailable</strong><span>{agentsError}</span></div> : null}
          {agentsLoading ? <div className="loading-state" role="status"><span className="loading-spinner" />Reading enrolled agents…</div> : null}
          {!agentsLoading && agents !== null && agents.length === 0 ? <div className="empty-state"><strong>No enrolled agent for this cluster</strong><span>Install the visibility agent with a one-time enrollment token before agent credentials exist.</span></div> : null}
          {!agentsLoading && agents !== null && agents.length > 0 ? <div className="fleet-health-list">
            {agents.map((agent) => {
              const clusterName = managedCluster?.clusterName ?? agent.clusterId;
              const confirming = confirmingAgentId === agent.agentId;
              const inFlight = revokingAgentId === agent.agentId;
              return <article className="fleet-health-row" key={agent.agentId}>
                <div className="fleet-health-cluster">
                  <span className={`compliance-status ${agentStatePill(agent.state)}`}>{AGENT_STATE_LABEL[agent.state]}</span>
                  <div>
                    <strong>{agentDisplayName(agent)}</strong>
                    <small>{agent.agentId}</small>
                    <small>v{agent.agentVersion} · cluster {clusterName}</small>
                  </div>
                </div>
                <div className="fleet-health-times">
                  <small>Heartbeat: {agent.lastHeartbeatAt ? formatTimestamp(agent.lastHeartbeatAt) : "none"}</small>
                  <small>Scan: {agent.lastScanAt ? formatTimestamp(agent.lastScanAt) : "none"}</small>
                </div>
                <div className="fleet-health-times">
                  {!isRevocable(agent)
                    ? <small>Credential already revoked</small>
                    : confirming
                      ? <>
                        <div className="page-alert page-alert-error" id={`revoke-confirm-${agent.agentId}`} role="alert">
                          <strong>Confirm revocation</strong>
                          <span>{agentRevocationConfirmation({ agentId: agent.agentId, connectionId: connectionId ?? "", clusterId: agent.clusterId, clusterName })}</span>
                        </div>
                        <button
                          aria-describedby={`revoke-confirm-${agent.agentId}`}
                          aria-label={`Confirm ${agentRevocationActionLabel(agent, clusterName).toLocaleLowerCase("en-US")}`}
                          className="button button-primary"
                          disabled={revokingAgentId !== null}
                          onClick={() => void revokeAgent(agent, clusterName)}
                          type="button"
                        >{inFlight ? "Revoking…" : "Revoke credential"}</button>
                        <button
                          aria-label={`Keep the credential for agent ${agentDisplayName(agent)} on cluster ${clusterName}`}
                          className="button button-secondary"
                          disabled={revokingAgentId !== null}
                          onClick={() => setConfirmingAgentId(null)}
                          type="button"
                        >Keep credential</button>
                      </>
                      : <button
                        aria-label={agentRevocationActionLabel(agent, clusterName)}
                        className="button button-secondary"
                        disabled={revokingAgentId !== null}
                        onClick={() => { setRevokeError(null); setRevokeResult(null); setConfirmingAgentId(agent.agentId); }}
                        type="button"
                      >Revoke…</button>}
                </div>
              </article>;
            })}
          </div> : null}
        </section> : null}

        <p className="panel-footnote">{fleet.disclaimer}</p>
      </> : null}
    </>
  );
}

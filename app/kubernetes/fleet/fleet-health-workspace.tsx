"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { FleetHealthSummary } from "../../../lib/kubernetes-fleet-health";
import { formatTimestamp, usePilotState } from "../../components/use-pilot-state";

const CLUSTER_STATE_LABEL: Readonly<Record<string, string>> = {
  online: "Online",
  degraded: "Degraded",
  offline: "Offline",
  not_enrolled: "Not enrolled",
};

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
              </div>
            </article>)}
          </div> : <div className="empty-state"><strong>No registered clusters</strong><span>Onboard an EKS cluster to begin fleet health monitoring.</span></div>}
        </section>
        <p className="panel-footnote">{fleet.disclaimer}</p>
      </> : null}
    </>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { HubbleWorkspace } from "../../../db/hubble-flow-repository";
import type { HubbleEndpointIdentity } from "../../../lib/hubble-flow-evidence";
import { formatTimestamp, usePilotState } from "../../components/use-pilot-state";
import { useKubernetesEvidence } from "../use-kubernetes-evidence";

interface Body extends HubbleWorkspace {
  readonly schemaVersion: "sutra.hubble-workspace.v1";
  readonly clusterId: string;
  readonly error?: { readonly message?: string };
}

function endpoint(identity: HubbleEndpointIdentity): string {
  if (identity.world) return "World";
  const name = identity.serviceName ?? identity.workloadName ?? "Unknown identity";
  return `${identity.namespace ?? "cluster"}/${name}`;
}

export function NetworkVisibility() {
  const { state, loading: stateLoading, error: stateError } = usePilotState();
  const kubernetes = useKubernetesEvidence(state);
  const cluster = kubernetes.clusters.find((item) => item.status === "active") ?? null;
  const connectionId = state?.connection?.id ?? null;
  const [body, setBody] = useState<Body | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (connectionId === null || cluster === null) { setBody(null); return }
    setLoading(true);
    try {
      const response = await fetch(`/api/v1/kubernetes/network-flows?connectionId=${encodeURIComponent(connectionId)}&clusterId=${encodeURIComponent(cluster.id)}&limit=500`, { cache: "no-store" });
      const payload = await response.json().catch(() => null) as Body | null;
      if (!response.ok || payload?.schemaVersion !== "sutra.hubble-workspace.v1") throw new Error(payload?.error?.message ?? "Network visibility could not be loaded");
      setBody(payload); setError(null);
    } catch (caught) { setBody(null); setError(caught instanceof Error ? caught.message : "Network visibility could not be loaded") }
    finally { setLoading(false) }
  }, [cluster, connectionId]);
  useEffect(() => { const task = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(task) }, [refresh]);
  const serviceMap = useMemo(() => {
    const edges = new Map<string, { source: string; destination: string; observations: number; drops: number }>();
    for (const flow of body?.flows ?? []) {
      const source = endpoint(flow.source); const destination = endpoint(flow.destination);
      const key = `${source}\0${destination}\0${flow.protocol}\0${flow.destinationPort ?? ""}`;
      const current = edges.get(key) ?? { source, destination, observations: 0, drops: 0 };
      current.observations += flow.observations;
      if (flow.verdict === "dropped") current.drops += flow.observations;
      edges.set(key, current);
    }
    return [...edges.values()].sort((a, b) => b.observations - a.observations);
  }, [body?.flows]);
  const dropped = (body?.flows ?? []).filter((flow) => flow.verdict === "dropped").reduce((sum, flow) => sum + flow.observations, 0);
  const busy = stateLoading || kubernetes.loading || loading;
  return <>
    <section className="page-heading"><div><p className="eyebrow">Kubernetes · Network visibility</p><h1>Cilium & Hubble service map</h1><p className="page-subtitle">Observed L3/L4 metadata from the enrolled cluster agent. Displayed edges represent reported flows only—not inferred reachability.</p></div><div className="heading-actions"><Link className="button button-secondary" href="/kubernetes/coverage">Coverage</Link><button className="button button-primary" onClick={() => void refresh()} type="button">Refresh evidence</button></div></section>
    <div className="trust-strip"><span className="trust-icon">N</span><span><strong>Metadata-only evidence.</strong> Source/destination workload or service identity, direction, verdict, protocol, port and time are retained. Packet payloads, DNS query contents and HTTP headers are rejected by the upload boundary.</span></div>
    {stateError || kubernetes.error || error ? <div className="page-alert page-alert-error"><strong>Network evidence unavailable</strong><span>{stateError ?? kubernetes.error ?? error}</span></div> : null}
    {busy ? <div className="loading-state"><span className="loading-spinner" />Loading Hubble evidence…</div> : null}
    {!busy ? <>
      <section className="inventory-stats"><article><small>Coverage</small><strong>{body?.coverage === "current" ? "Current" : body?.coverage === "stale" ? "Stale" : "Not configured"}</strong><span>{body?.lastBatchAt ? formatTimestamp(body.lastBatchAt) : "No cluster upload"}</span></article><article><small>Observed edges</small><strong>{serviceMap.length || "—"}</strong><span>No inferred connections</span></article><article><small>Dropped observations</small><strong>{body ? dropped : "—"}</strong><span>Reported verdict only</span></article><article><small>Hubble version</small><strong>{body?.hubbleVersion ?? "—"}</strong><span>{cluster?.name ?? "No active cluster"}</span></article></section>
      {body?.coverage === "stale" ? <div className="page-alert page-alert-warning"><strong>Hubble coverage is stale</strong><span>The last cluster-bound upload is older than {body.staleAfterSeconds / 60} minutes. Do not interpret missing recent flows as absence.</span></div> : null}
      <section className="panel hubble-panel"><div className="panel-heading"><div><p className="eyebrow">Observed service map</p><h2>Source → destination</h2></div><span className="status-pill">{body?.coverage ?? "not_configured"}</span></div>
        {serviceMap.length ? <div className="hubble-map">{serviceMap.map((edge) => <article key={`${edge.source}:${edge.destination}`}><strong>{edge.source}</strong><span>→</span><strong>{edge.destination}</strong><small>{edge.observations} observations · {edge.drops} dropped</small></article>)}</div> : <section className="empty-workspace compact-empty"><span className="empty-workspace-icon">HB</span><h2>Hubble visibility is not configured</h2><p>No bounded flow metadata is available in this authorized tenant and cluster scope. Sutra does not infer a service map from Kubernetes inventory or NetworkPolicy objects.</p></section>}
        {body?.flows.length ? <div className="hubble-flow-list">{body.flows.slice(0, 100).map((flow) => <article key={flow.evidenceSha256}><span className={`status-pill hubble-${flow.verdict}`}>{flow.verdict}</span><div><strong>{endpoint(flow.source)} → {endpoint(flow.destination)}</strong><small>{flow.direction} · {flow.protocol}{flow.destinationPort ? `/${flow.destinationPort}` : ""} · {flow.observations} observations</small></div><time>{formatTimestamp(flow.observedAt)}</time><code>{flow.evidenceSha256.slice(0, 12)}</code></article>)}</div> : null}
      </section>
    </> : null}
  </>;
}

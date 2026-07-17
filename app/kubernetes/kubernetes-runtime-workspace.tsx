"use client";

import { useEffect, useState } from "react";
import type {
  FalcoInvestigationTimelineItem,
  FalcoRuntimeCoverage,
} from "../../lib/falco-runtime-types";
import { formatTimestamp } from "../components/use-pilot-state";

interface FalcoRuntimeWorkspaceResponse {
  readonly coverage: FalcoRuntimeCoverage;
  readonly timeline: readonly (FalcoInvestigationTimelineItem & {
    readonly caseId: string | null;
    readonly caseNumber: string | null;
  })[];
}

function priorityTone(priority: FalcoInvestigationTimelineItem["priority"]): string {
  if (priority === "emergency" || priority === "alert" || priority === "critical") return "critical";
  if (priority === "error") return "high";
  if (priority === "warning") return "medium";
  return "low";
}

export function KubernetesRuntimeWorkspace({
  connectionId,
  clusterId,
}: {
  readonly connectionId: string | null;
  readonly clusterId: string | null;
}) {
  const [workspace, setWorkspace] = useState<FalcoRuntimeWorkspaceResponse | null>(null);
  const [loading, setLoading] = useState(connectionId !== null && clusterId !== null);
  const [error, setError] = useState<string | null>(null);
  const [caseBusy, setCaseBusy] = useState<string | null>(null);
  const [caseNotice, setCaseNotice] = useState<string | null>(null);

  useEffect(() => {
    if (connectionId === null || clusterId === null) {
      return;
    }
    const controller = new AbortController();
    void fetch(
      `/api/v1/kubernetes/runtime-events?connectionId=${encodeURIComponent(connectionId)}&clusterId=${encodeURIComponent(clusterId)}&limit=100`,
      { credentials: "same-origin", signal: controller.signal },
    ).then(async (response) => {
      const body = await response.json() as FalcoRuntimeWorkspaceResponse | { message?: string };
      if (!response.ok) throw new Error("message" in body && typeof body.message === "string" ? body.message : "Runtime evidence is unavailable");
      setError(null);
      setWorkspace(body as FalcoRuntimeWorkspaceResponse);
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "Runtime evidence is unavailable");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [clusterId, connectionId]);

  if (connectionId === null || clusterId === null) {
    return <section className="empty-workspace compact-empty"><span className="empty-workspace-icon">RT</span><h2>No registered cluster</h2><p>Register a customer-scoped Kubernetes cluster before configuring runtime evidence.</p></section>;
  }
  if (loading) return <div className="loading-state" role="status"><span className="loading-spinner" />Reading Falco runtime evidence…</div>;
  if (error !== null) return <div className="page-alert page-alert-error" role="alert"><strong>Runtime evidence unavailable</strong><span>{error}</span></div>;
  if (workspace === null || workspace.coverage.status === "not_configured") {
    return <section className="empty-workspace compact-empty"><span className="empty-workspace-icon">RT</span><h2>Falco is not configured</h2><p>No signed heartbeat or runtime event has been received for this cluster. Sutra does not infer runtime coverage from inventory.</p></section>;
  }

  async function createCase(item: FalcoRuntimeWorkspaceResponse["timeline"][number]): Promise<void> {
    if (!window.confirm(`Create a human-approved remediation case for “${item.title}”? This does not contain or modify the workload.`)) return;
    setCaseBusy(item.id);
    setError(null);
    setCaseNotice(null);
    try {
      const response = await fetch("/api/v1/kubernetes/runtime-events", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "create_case",
          connectionId,
          clusterId,
          eventId: item.id,
          evidenceSha256: item.evidenceSha256,
          priority: priorityTone(item.priority),
        }),
      });
      const body = await response.json() as {
        case?: { id: string; caseNumber: string };
        notificationRouting?: { queued: number };
        error?: { message?: string };
      };
      if (!response.ok || body.case === undefined) {
        throw new Error(body.error?.message ?? "Sutra could not create the runtime case");
      }
      setWorkspace((current) => current === null ? current : {
        ...current,
        timeline: current.timeline.map((candidate) => candidate.id === item.id
          ? { ...candidate, caseId: body.case?.id ?? null, caseNumber: body.case?.caseNumber ?? null }
          : candidate),
      });
      setCaseNotice(`${body.case.caseNumber} created. ${body.notificationRouting?.queued ?? 0} configured notification job(s) queued; no provider call occurred in this request.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not create the runtime case");
    } finally {
      setCaseBusy(null);
    }
  }

  return <>
    <div className="kubernetes-verification-grid">
      <article><span className={workspace.coverage.status === "active" ? "positive" : "unknown"}>{workspace.coverage.status === "active" ? "✓" : "!"}</span><div><strong>Falco sensor {workspace.coverage.status}</strong><small>{workspace.coverage.falcoVersion ?? "Version not reported"}</small></div></article>
      <article><span className={workspace.timeline.length > 0 ? "positive" : "unknown"}>{workspace.timeline.length}</span><div><strong>Normalized runtime events</strong><small>Bounded to the latest 100 records</small></div></article>
      <article><span className="positive">✓</span><div><strong>Signed ingestion</strong><small>Cluster-bound HMAC and replay protection</small></div></article>
      <article><span className="unknown">H</span><div><strong>Human-approved response</strong><small>No automatic containment is enabled</small></div></article>
    </div>
    {caseNotice !== null ? <div className="page-alert" role="status"><strong>Runtime case created</strong><span>{caseNotice}</span></div> : null}
    <div className="trust-strip" role="note"><span className="trust-icon">R</span><span><strong>Runtime evidence boundary.</strong> Sutra retains normalized Falco rule and workload context, not raw output, environment values, command lines, file contents or arbitrary event fields.</span></div>
    <div className="kubernetes-finding-rows">
      {workspace.timeline.map((item) => <article key={item.id}>
        <span className={`severity-badge severity-${priorityTone(item.priority)}`}>{item.priority}</span>
        <div><strong>{item.title}</strong><small>{item.subject} · {formatTimestamp(item.occurredAt)}</small></div>
        <p>Evidence {item.evidenceSha256}</p>
        {item.caseId === null
          ? <button className="button button-secondary button-small" disabled={caseBusy !== null} onClick={() => void createCase(item)} type="button">{caseBusy === item.id ? "Creating…" : "Create case"}</button>
          : <span className="status-pill status-positive">{item.caseNumber ?? "Case created"}</span>}
      </article>)}
      {workspace.timeline.length === 0 ? <div className="empty-state"><strong>Sensor active; no runtime event retained</strong><span>This statement is bounded to the signed ingestion window and does not prove threats are absent.</span></div> : null}
    </div>
  </>;
}

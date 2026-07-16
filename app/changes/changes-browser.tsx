"use client";

import { useEffect, useMemo, useState } from "react";
import type { CmdbChangeHistoryEvent } from "../../db/pilot-repository";
import type { PilotConnection } from "../../lib/pilot-types";
import { usePortfolio } from "../components/use-portfolio";
import { formatTimestamp } from "../components/use-pilot-state";

interface ChangeResponse {
  readonly connection: PilotConnection;
  readonly changes: readonly CmdbChangeHistoryEvent[];
}

function resourceLabel(event: CmdbChangeHistoryEvent): string {
  return event.after?.name ?? event.before?.name ?? event.after?.nativeId ?? event.before?.nativeId ?? event.resourceKey;
}

export function ChangesBrowser() {
  const portfolio = usePortfolio();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [result, setResult] = useState<ChangeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connections = useMemo(
    () => (portfolio.portfolio?.customers ?? []).flatMap((customer) =>
      customer.connections.map((connection) => ({ customerName: customer.name, ...connection }))),
    [portfolio.portfolio],
  );
  const connectionId = selectedId ?? connections[0]?.id ?? null;

  useEffect(() => {
    if (connectionId === null) return;
    let current = true;
    void fetch(`/api/v1/changes?connectionId=${encodeURIComponent(connectionId)}&limit=200`, {
      cache: "no-store",
      credentials: "same-origin",
    }).then(async (response) => {
      const body = await response.json().catch(() => null) as (ChangeResponse & { error?: { message?: string } }) | null;
      if (!response.ok || body === null || !Array.isArray(body.changes)) {
        throw new Error(body?.error?.message ?? "Sutra could not load CMDB changes");
      }
      return body;
    }).then((body) => {
      if (!current) return;
      setResult(body);
      setError(null);
    }).catch((caught: unknown) => {
      if (current) setError(caught instanceof Error ? caught.message : "Sutra could not load CMDB changes");
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => {
      current = false;
    };
  }, [connectionId]);

  const counts = {
    added: result?.changes.filter((event) => event.changeType === "added").length ?? 0,
    changed: result?.changes.filter((event) => event.changeType === "changed").length ?? 0,
    removed: result?.changes.filter((event) => event.changeType === "removed").length ?? 0,
  };

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Inventory timeline</p><h1>CMDB change history</h1><p className="page-subtitle">Immutable added, changed, and removed resource events generated only when a complete snapshot replaces the prior complete projection.</p></div>
        {connections.length > 0 ? <label className="change-connection-picker"><span>Cloud account</span><select value={connectionId ?? ""} onChange={(event) => { setLoading(true); setResult(null); setSelectedId(event.target.value); }}>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.customerName} · {connection.awsAccountId}</option>)}</select></label> : null}
      </section>

      <div className="trust-strip" role="note"><span className="trust-icon">✓</span><span><strong>Complete-snapshot boundary.</strong> Partial or failed collection never emits removal events and never advances this history. Every query is scoped to the authenticated organization, customer grant, and connection.</span><a href="/controls#architecture">Integrity model</a></div>

      {portfolio.error || error ? <div className="page-alert page-alert-error" role="alert"><strong>Change history is unavailable</strong><span>{error ?? portfolio.error}</span><button type="button" onClick={() => window.location.reload()}>Retry</button></div> : null}
      {portfolio.loading || loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading immutable change events…</div> : null}

      {!portfolio.loading && connections.length === 0 ? <section className="panel empty-workspace"><span className="empty-workspace-icon">Δ</span><h2>No cloud connection in your scope</h2><p>Change history appears after an authorized connection publishes complete inventory snapshots.</p></section> : null}

      {result ? (
        <>
          <section className="summary-band">
            <div><small>Recorded events</small><strong>{result.changes.length}</strong><span>Latest 200 scoped events</span></div>
            <div><small>Added</small><strong>{counts.added}</strong><span>New logical resource identities</span></div>
            <div><small>Changed</small><strong>{counts.changed}</strong><span>Semantic field differences</span></div>
            <div><small>Removed</small><strong>{counts.removed}</strong><span>Absent from a complete rescan</span></div>
          </section>

          <section className="panel table-panel change-history-panel">
            <div className="panel-heading"><div><p className="eyebrow">Scoped account</p><h2>{result.connection.customerName} · {result.connection.awsAccountId}</h2></div><span className="status-pill status-positive">Immutable evidence</span></div>
            <div className="change-event-list">
              {result.changes.map((event) => (
                <details className="change-event" key={event.id}>
                  <summary>
                    <span className={`change-kind change-kind-${event.changeType}`}>{event.changeType}</span>
                    <span className="primary-cell"><strong>{resourceLabel(event)}</strong><small>{event.after?.resourceType ?? event.before?.resourceType ?? "resource"}</small></span>
                    <span>{event.changedPaths.length > 0 ? `${event.changedPaths.length} fields` : "identity event"}</span>
                    <span className="muted-cell">{formatTimestamp(event.occurredAt)}</span>
                    <b aria-hidden="true">⌄</b>
                  </summary>
                  <div className="change-detail">
                    <div><small>Resource key</small><code>{event.resourceKey}</code></div>
                    <div><small>Changed paths</small><p>{event.changedPaths.length ? event.changedPaths.join(", ") : "Not applicable"}</p></div>
                    <div><small>Snapshot transition</small><p>{event.fromSnapshotId ?? "Initial inventory"} → {event.toSnapshotId}</p></div>
                  </div>
                </details>
              ))}
              {result.changes.length === 0 ? <div className="empty-state"><strong>No differences recorded yet</strong><span>Run a later complete fixture version or complete inventory scan to produce a deterministic comparison.</span></div> : null}
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}

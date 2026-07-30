"use client";

import { useEffect, useMemo, useState } from "react";
import type { CmdbChangeHistoryEvent } from "../../../db/pilot-repository";
import type { JsonValue, PilotResource } from "../../../lib/pilot-types";
import { compactIdentifier, formatTimestamp, snapshotOriginLabel, usePilotState } from "../../components/use-pilot-state";

interface ChangeResponse {
  readonly changes?: readonly CmdbChangeHistoryEvent[];
  readonly error?: { readonly message?: string };
}

function resourceLabel(resource: PilotResource): string {
  return resource.name?.trim() || resource.tags.Name || resource.nativeId;
}

function configurationValue(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

export function ResourceBrowser() {
  const { state, loading, error } = usePilotState();
  const [resourceKey] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("key") ?? "");
  const [changes, setChanges] = useState<readonly CmdbChangeHistoryEvent[]>([]);
  const [changeError, setChangeError] = useState<string | null>(null);
  const connection = state?.connection ?? null;
  const resources = useMemo(() => state?.resources ?? [], [state?.resources]);
  const resource = resources.find((item) => item.resourceKey === resourceKey) ?? null;
  const resourceMap = useMemo(() => new Map(resources.map((item) => [item.resourceKey, item])), [resources]);
  const edges = useMemo(() => (state?.relationships ?? []).filter((edge) => edge.fromResourceKey === resourceKey || edge.toResourceKey === resourceKey), [resourceKey, state?.relationships]);
  const findings = useMemo(() => (state?.findings ?? []).filter((finding) => finding.resourceKey === resourceKey), [resourceKey, state?.findings]);
  const configuration = useMemo(() => resource ? Object.entries(resource.configuration).sort(([left], [right]) => left.localeCompare(right)) : [], [resource]);
  const tags = useMemo(() => resource ? Object.entries(resource.tags).sort(([left], [right]) => left.localeCompare(right)) : [], [resource]);

  useEffect(() => {
    if (!connection || !resourceKey) return;
    let current = true;
    const query = new URLSearchParams({ connectionId: connection.id, limit: "500" });
    void fetch(`/api/v1/changes?${query.toString()}`, { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as ChangeResponse | null;
        if (!response.ok) throw new Error(body?.error?.message ?? "Change evidence is unavailable");
        return body?.changes ?? [];
      })
      .then((events) => {
        if (!current) return;
        setChanges(events.filter((event) => event.resourceKey === resourceKey));
        setChangeError(null);
      })
      .catch((caught: unknown) => {
        if (current) setChangeError(caught instanceof Error ? caught.message : "Change evidence is unavailable");
      });
    return () => { current = false; };
  }, [connection, resourceKey]);

  if (loading) return <div className="loading-state" role="status"><span className="loading-spinner" />Loading Resource 360…</div>;

  if (error) return <div className="page-alert page-alert-error" role="alert"><strong>Resource 360 is unavailable</strong><span>{error}</span></div>;

  if (!connection || !state?.activeSnapshot) return <section className="panel empty-workspace"><span className="empty-workspace-icon">360</span><h2>No active CMDB snapshot</h2><p>Connect and collect an AWS account before opening a resource record.</p><a className="button button-primary" href="/onboard">Onboard AWS</a></section>;

  if (!resource) return <section className="panel empty-workspace"><span className="empty-workspace-icon">404</span><h2>Resource not found in the active snapshot</h2><p>The link may reference an older snapshot or a resource outside your authorized customer scope.</p><a className="button button-primary" href={`/cmdb?connectionId=${encodeURIComponent(connection.id)}`}>Return to CMDB</a></section>;

  const openFindings = findings.filter((finding) => finding.status === "open" || finding.status === "acknowledged");
  return <>
    <section className="page-heading resource-heading">
      <div><p className="eyebrow">Resource 360 · {resource.service.toUpperCase()}</p><h1>{resourceLabel(resource)}</h1><p className="page-subtitle">Identity, configuration, relationships, security workload, changes, and collection provenance in one evidence-backed record.</p></div>
      <div className="heading-actions"><a className="button button-secondary" href={`/cmdb?connectionId=${encodeURIComponent(connection.id)}`}>Back to inventory</a><a className="button button-primary" href={`/findings?resource=${encodeURIComponent(resource.resourceKey)}`}>Review findings</a></div>
    </section>

    <div className="trust-strip" role="note"><span className="trust-icon">✓</span><span><strong>{snapshotOriginLabel(state.activeSnapshot.origin)}.</strong> {resource.lifecycleState === "retirement_pending" ? <>This resource was not present in the latest complete run and remains visible during its retirement grace period. Its evidence belongs to immutable snapshot <code>{compactIdentifier(resource.evidenceSnapshot?.id ?? state.activeSnapshot.id, 14)}</code>.</> : <>This record belongs to immutable snapshot <code>{compactIdentifier(resource.evidenceSnapshot?.id ?? state.activeSnapshot.id, 14)}</code> collected {formatTimestamp(resource.source.collectedAt)}.</>}</span></div>

    <section className="resource-identity-grid">
      <article className="panel resource-identity-card"><span className="service-chip">{resource.service.toUpperCase()}</span><h2>{resource.resourceType}</h2><p>{resource.nativeId}</p><dl><div><dt>Account</dt><dd>{connection.awsAccountId}</dd></div><div><dt>Region</dt><dd>{resource.region}</dd></div><div><dt>State</dt><dd>{resource.state || "observed"}</dd></div><div><dt>Lifecycle</dt><dd>{resource.lifecycleState === "retirement_pending" ? `Retirement pending (${resource.consecutiveCompleteMisses ?? 1} complete miss)` : resource.lifecycleState ?? "active"}</dd></div><div><dt>ARN</dt><dd title={resource.arn ?? "Not supplied"}>{resource.arn ? compactIdentifier(resource.arn, 34) : "Not supplied"}</dd></div></dl></article>
      <article className="panel resource-risk-card"><p className="eyebrow">Current workload</p><strong>{openFindings.length}</strong><h2>active finding{openFindings.length === 1 ? "" : "s"}</h2><p>{openFindings.filter((finding) => finding.severity === "critical" || finding.severity === "high").length} critical or high · {edges.length} relationship{edges.length === 1 ? "" : "s"} · {changes.length} recorded change{changes.length === 1 ? "" : "s"}</p></article>
      <article className="panel resource-provenance-card"><p className="eyebrow">Evidence provenance</p><h2>{resource.source.api}</h2><dl><div><dt>Observed</dt><dd>{formatTimestamp(resource.source.collectedAt)}</dd></div><div><dt>Evidence snapshot</dt><dd title={resource.evidenceSnapshot?.id ?? state.activeSnapshot.id}>{compactIdentifier(resource.evidenceSnapshot?.id ?? state.activeSnapshot.id, 18)}</dd></div><div><dt>Content hash</dt><dd title={resource.contentSha256}>{compactIdentifier(resource.contentSha256, 18)}</dd></div><div><dt>Snapshot hash</dt><dd title={resource.evidenceSnapshot?.snapshotSha256 ?? state.activeSnapshot.snapshotSha256}>{compactIdentifier(resource.evidenceSnapshot?.snapshotSha256 ?? state.activeSnapshot.snapshotSha256, 18)}</dd></div></dl></article>
    </section>

    <section className="resource-detail-grid">
      <article className="panel resource-relations"><div className="panel-heading"><div><p className="eyebrow">Asset graph</p><h2>Relationships</h2></div><span className="result-count">{edges.length} edges</span></div>{edges.length ? <div className="relation-list">{edges.map((edge, index) => { const outgoing = edge.fromResourceKey === resource.resourceKey; const otherKey = outgoing ? edge.toResourceKey : edge.fromResourceKey; const other = resourceMap.get(otherKey); return <a href={`/cmdb/resource?key=${encodeURIComponent(otherKey)}`} key={`${edge.fromResourceKey}:${edge.toResourceKey}:${edge.relationType}:${index}`}><span>{outgoing ? "OUT" : "IN"}</span><div><strong>{edge.relationType}</strong><small>{other ? `${resourceLabel(other)} · ${other.service.toUpperCase()} · ${other.region}` : compactIdentifier(otherKey, 28)}</small></div><b>→</b></a>; })}</div> : <div className="empty-state"><strong>No explicit relationships</strong><span>The current collectors did not publish an edge for this resource.</span></div>}</article>
      <article className="panel resource-findings"><div className="panel-heading"><div><p className="eyebrow">Security posture</p><h2>Related findings</h2></div><span className="result-count">{findings.length} total</span></div>{findings.length ? <div className="resource-finding-list">{findings.map((finding) => <div key={finding.fingerprint}><span className={`severity-badge severity-${finding.severity}`}>{finding.severity}</span><p><strong>{finding.title}</strong><small>{finding.status} · {finding.controlKey}</small></p></div>)}</div> : <div className="empty-state"><strong>No related finding in this snapshot</strong><span>This is limited to implemented controls and successful collector coverage.</span></div>}</article>
    </section>

    <section className="panel resource-configuration"><div className="panel-heading"><div><p className="eyebrow">Normalized evidence</p><h2>Configuration</h2></div><span className="result-count">{configuration.length} fields</span></div><div className="configuration-grid">{configuration.map(([key, value]) => <div key={key}><dt>{key}</dt><dd><pre>{configurationValue(value)}</pre></dd></div>)}</div></section>

    <section className="resource-detail-grid"><article className="panel"><div className="panel-heading"><div><p className="eyebrow">Ownership context</p><h2>Tags</h2></div></div>{tags.length ? <div className="tag-list">{tags.map(([key, value]) => <span key={key}><strong>{key}</strong>{value}</span>)}</div> : <div className="empty-state"><strong>No tags observed</strong><span>The source API returned no tags for this resource.</span></div>}</article><article className="panel"><div className="panel-heading"><div><p className="eyebrow">Immutable history</p><h2>Recent changes</h2></div></div>{changeError ? <div className="page-alert page-alert-error"><span>{changeError}</span></div> : changes.length ? <div className="resource-change-list">{changes.slice(0, 8).map((event) => <div key={event.id}><span className={`change-pill change-${event.changeType}`}>{event.changeType}</span><p><strong>{event.changedPaths.length ? event.changedPaths.join(", ") : "Resource record"}</strong><small>{formatTimestamp(event.occurredAt)}</small></p></div>)}</div> : <div className="empty-state"><strong>No change event in retained history</strong><span>The resource may have been stable since its first observed snapshot.</span></div>}</article></section>
  </>;
}

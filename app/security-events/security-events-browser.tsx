"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PilotConnection } from "../../lib/pilot-types";
import type {
  SecurityEventsWorkspace,
  StoredSecurityDetection,
} from "../../lib/security-event-types";
import { compactIdentifier, formatTimestamp, usePilotState } from "../components/use-pilot-state";
import styles from "./security-events.module.css";

interface WorkspaceResponse {
  readonly connection: PilotConnection;
  readonly workspace: SecurityEventsWorkspace;
}

interface ApiErrorBody {
  readonly error?: { readonly message?: string };
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as (T & ApiErrorBody) | null;
  if (!response.ok || body === null) throw new Error(body?.error?.message ?? "Sutra could not load security events");
  return body;
}

function statusTone(status: string): string {
  if (status === "COMPLETE") return "status-positive";
  if (status === "UNAVAILABLE") return "status-risk";
  return "status-medium";
}

function severityTone(severity: string): string {
  return `severity-badge severity-${severity}`;
}

export function SecurityEventsBrowser() {
  const { state, loading: pilotLoading } = usePilotState();
  const connection = state?.connection ?? null;
  const [workspace, setWorkspace] = useState<SecurityEventsWorkspace | null>(null);
  const [loading, setLoading] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [region, setRegion] = useState("");
  const [eventName, setEventName] = useState("");

  const load = useCallback(async (filters?: { query?: string; region?: string; eventName?: string }) => {
    if (connection === null) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ connectionId: connection.id, limit: "150" });
      const search = filters?.query?.trim();
      if (search) params.set("q", search);
      if (filters?.region) params.set("region", filters.region);
      if (filters?.eventName) params.set("eventName", filters.eventName);
      const body = await readJson<WorkspaceResponse>(await fetch(`/api/v1/security-events?${params}`, {
        cache: "no-store",
        credentials: "same-origin",
      }));
      setWorkspace(body.workspace);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not load security events");
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    if (connection === null) return;
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [connection, load]);

  const regions = useMemo(() => [...new Set(workspace?.events.map((event) => event.region) ?? [])].sort(), [workspace?.events]);
  const eventNames = useMemo(() => [...new Set(workspace?.events.map((event) => event.eventName) ?? [])].sort(), [workspace?.events]);
  const displayedOpenDetections = workspace?.detections.filter((detection) => detection.status === "open") ?? [];
  const failedEvents = workspace?.events.filter((event) => event.errorCode !== null).length ?? 0;

  async function collect(): Promise<void> {
    if (connection === null) return;
    setCollecting(true);
    setError(null);
    try {
      const body = await readJson<{ readonly workspace: SecurityEventsWorkspace }>(await fetch("/api/v1/security-events", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId: connection.id }),
      }));
      setWorkspace(body.workspace);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not collect CloudTrail events");
    } finally {
      setCollecting(false);
    }
  }

  async function updateDetection(detection: StoredSecurityDetection): Promise<void> {
    if (connection === null) return;
    const nextStatus = detection.status === "open" ? "acknowledged" : "open";
    setUpdating(detection.detectionId);
    setError(null);
    try {
      const body = await readJson<{ readonly detection: StoredSecurityDetection }>(await fetch("/api/v1/security-events", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId: connection.id,
          detectionId: detection.detectionId,
          status: nextStatus,
          note: nextStatus === "acknowledged" ? "Acknowledged by the local Sutra operator" : "Reopened for investigation",
        }),
      }));
      setWorkspace((current) => current === null ? current : {
        ...current,
        counts: {
          ...current.counts,
          openDetections: Math.max(
            0,
            current.counts.openDetections + (body.detection.status === "open" ? 1 : -1),
          ),
        },
        detections: current.detections.map((item) => item.detectionId === body.detection.detectionId ? body.detection : item),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not update the detection");
    } finally {
      setUpdating(null);
    }
  }

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Security Events Lite</p>
          <h1>CloudTrail event detection</h1>
          <p className="page-subtitle">Bounded AWS management-event history, normalized evidence, and explainable local detections—without a fabricated log stream.</p>
        </div>
        <div className="heading-actions">
          <a className="button button-secondary" href="/findings">Security findings</a>
          <button
            className="button button-primary"
            type="button"
            disabled={connection === null || connection.sourceKind !== "aws_trust_role" || connection.status !== "active" || collecting}
            onClick={() => void collect()}
          >{collecting ? "Collecting…" : "Collect live events"}</button>
        </div>
      </section>

      <div className="trust-strip" role="note">
        <span className="trust-icon">i</span>
        <span><strong>AWS CloudTrail LookupEvents only.</strong> Sutra stores a bounded normalized subset, never the raw CloudTrailEvent payload. This is management-event history, not a full SIEM, data-event lake, or behavioral threat engine.</span>
        <a href="#source-health">Source health</a>
      </div>

      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Security Events needs attention</strong><span>{error}</span><button type="button" onClick={() => void load({ query, region, eventName })}>Retry</button></div> : null}
      {(pilotLoading || loading) ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading normalized CloudTrail evidence…</div> : null}

      {!pilotLoading && connection === null ? <section className="panel empty-workspace"><span className="empty-workspace-icon">SOC</span><h2>Connect a live AWS account first</h2><p>Security Events Lite never generates fixture events. It requires a validated customer trust role and the optional CloudTrail LookupEvents permission.</p><a className="button button-primary" href="/onboard">Open AWS onboarding</a></section> : null}

      {connection !== null && workspace?.source === null && !loading ? <section className={`panel ${styles.firstRun}`}>
        <div className={styles.firstRunIcon}>CT</div>
        <div><p className="eyebrow">No event source collected</p><h2>Start a real, bounded CloudTrail lookup</h2><p>The first run examines the preceding hour in each selected Region. Later runs overlap the prior checkpoint by five minutes and deduplicate by the provider event ID.</p></div>
        <button className="button button-primary" type="button" disabled={connection.sourceKind !== "aws_trust_role" || collecting} onClick={() => void collect()}>Collect live evidence</button>
      </section> : null}

      {connection !== null && workspace !== null && workspace.source !== null ? (
        <>
          <section className={styles.kpis}>
            <article className="panel"><small>Source state</small><strong>{workspace.source.status}</strong><span>{workspace.latestRun?.coverage.filter((item) => item.status === "SUCCEEDED").length ?? 0} Regions succeeded</span></article>
            <article className="panel"><small>Stored events</small><strong>{workspace.counts.totalEvents}</strong><span>{workspace.events.length} displayed · {failedEvents} error events displayed</span></article>
            <article className="panel"><small>Open detections</small><strong>{workspace.counts.openDetections}</strong><span>{displayedOpenDetections.length} open displayed · {workspace.counts.totalDetections} total</span></article>
            <article className="panel"><small>Retention</small><strong>{workspace.source.retentionDays} days</strong><span>Purged on successful persistence cycles</span></article>
          </section>

          <section className={styles.grid}>
            <article className="panel">
              <div className="panel-heading"><div><p className="eyebrow">Detection queue</p><h2>Evidence-backed alerts</h2></div><span className="result-count">{workspace.detections.length} displayed · {workspace.counts.totalDetections} total</span></div>
              {workspace.detections.length === 0 ? <div className="empty-state"><strong>No rule matched this evidence window</strong><span>This does not prove the account is free of threats; only ingested management events were evaluated.</span></div> : <div className={styles.detections}>{workspace.detections.map((detection) => (
                <article key={detection.detectionId}>
                  <span className={severityTone(detection.severity)}>{detection.severity}</span>
                  <div><h3>{detection.title}</h3><p>{detection.summary}</p><small>{detection.ruleKey} · {detection.eventIds.length} event{detection.eventIds.length === 1 ? "" : "s"} · {formatTimestamp(detection.lastEventAt)}</small><em>{detection.limitation}</em></div>
                  <button className="button button-secondary button-small" disabled={updating === detection.detectionId} type="button" onClick={() => void updateDetection(detection)}>{updating === detection.detectionId ? "Saving…" : detection.status === "open" ? "Acknowledge" : "Reopen"}</button>
                </article>
              ))}</div>}
            </article>

            <article className="panel" id="source-health">
              <div className="panel-heading"><div><p className="eyebrow">Collection provenance</p><h2>Source health</h2></div><span className={`status-pill ${statusTone(workspace.source.status)}`}>{workspace.source.status}</span></div>
              <dl className={styles.provenance}>
                <div><dt>AWS account</dt><dd>{connection.awsAccountId}</dd></div>
                <div><dt>Source</dt><dd>CloudTrail LookupEvents</dd></div>
                <div><dt>Last complete checkpoint start</dt><dd>{formatTimestamp(workspace.source.lastWindowStart)}</dd></div>
                <div><dt>Last complete checkpoint end</dt><dd>{formatTimestamp(workspace.source.lastWindowEnd)}</dd></div>
                <div><dt>Latest attempt start</dt><dd>{formatTimestamp(workspace.latestRun?.windowStart ?? null)}</dd></div>
                <div><dt>Latest attempt end</dt><dd>{formatTimestamp(workspace.latestRun?.windowEnd ?? null)}</dd></div>
                <div><dt>Last attempted</dt><dd>{formatTimestamp(workspace.source.lastCollectedAt)}</dd></div>
                <div><dt>Checkpoint overlap</dt><dd>{workspace.source.overlapMinutes} minutes</dd></div>
                <div><dt>Continuity status</dt><dd>{workspace.source.lastErrorCode ?? "No reported gap"}</dd></div>
                <div><dt>Latest run</dt><dd title={workspace.source.lastRunId ?? ""}>{workspace.source.lastRunId ? compactIdentifier(workspace.source.lastRunId, 18) : "Not yet"}</dd></div>
                <div><dt>Payload hash</dt><dd title={workspace.latestRun?.payloadSha256 ?? ""}>{workspace.latestRun ? compactIdentifier(workspace.latestRun.payloadSha256, 18) : "Not yet"}</dd></div>
              </dl>
              {workspace.latestRun ? <div className={styles.coverage}>{workspace.latestRun.coverage.map((item) => <div key={item.region}><span className={`coverage-state coverage-${item.status === "SUCCEEDED" ? "succeeded" : item.status === "FAILED" ? "failed" : "partial"}`} /><strong>{item.region}</strong><small>{item.eventsObserved} events · {item.pagesObserved} pages</small><b>{item.errorCode ?? item.status}</b></div>)}</div> : null}
            </article>
          </section>

          <section className="panel">
            <div className="panel-heading"><div><p className="eyebrow">Normalized evidence</p><h2>Management-event timeline</h2></div><span className="result-count">{workspace.events.length} displayed · {workspace.counts.matchingEvents} matching · {workspace.counts.totalEvents} stored</span></div>
            <form className={styles.filters} onSubmit={(event) => { event.preventDefault(); void load({ query, region, eventName }); }}>
              <input className="filter-control" aria-label="Search events" placeholder="Search event, principal, source IP, or error" value={query} onChange={(event) => setQuery(event.target.value)} />
              <select className="filter-control" aria-label="Region" value={region} onChange={(event) => setRegion(event.target.value)}><option value="">All Regions</option>{regions.map((item) => <option value={item} key={item}>{item}</option>)}</select>
              <select className="filter-control" aria-label="Event name" value={eventName} onChange={(event) => setEventName(event.target.value)}><option value="">All event names</option>{eventNames.map((item) => <option value={item} key={item}>{item}</option>)}</select>
              <button className="button button-secondary" type="submit">Apply filters</button>
            </form>
            <div className={styles.eventTable} role="table" aria-label="Normalized CloudTrail events">
              <div className={styles.eventHeader} role="row"><span>Time</span><span>Event</span><span>Principal</span><span>Region</span><span>Outcome</span></div>
              {workspace.events.map((event) => <details className={styles.eventRow} key={event.providerEventId}>
                <summary role="row"><span>{formatTimestamp(event.eventTime)}</span><span><strong>{event.eventName}</strong><small>{event.eventSource}</small></span><span title={event.principalArn ?? event.username ?? ""}>{compactIdentifier(event.principalArn ?? event.username ?? "Unknown", 24)}</span><span>{event.region}</span><span className={event.errorCode ? styles.denied : styles.allowed}>{event.errorCode ?? "Observed"}</span></summary>
                <div><dl><div><dt>Event ID</dt><dd>{event.providerEventId}</dd></div><div><dt>Source IP</dt><dd>{event.sourceIp ?? "Not emitted"}</dd></div><div><dt>Identity type</dt><dd>{event.identityType ?? "Not emitted"}</dd></div><div><dt>Read only</dt><dd>{event.readOnly === null ? "Unknown" : event.readOnly ? "Yes" : "No"}</dd></div><div><dt>MFA used</dt><dd>{event.mfaUsed === null ? "Not emitted" : event.mfaUsed ? "Yes" : "No"}</dd></div><div><dt>Detail parsing</dt><dd>{event.detailStatus}</dd></div></dl><p>Raw CloudTrailEvent JSON is intentionally not persisted.</p></div>
              </details>)}
              {workspace.events.length === 0 ? <div className="empty-state"><strong>No events matched this view</strong><span>Change filters or collect another live evidence window. An empty result is not a claim of zero activity outside the bounded source.</span></div> : null}
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}

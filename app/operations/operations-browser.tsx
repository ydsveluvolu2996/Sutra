import { isCollectableAwsSourceKind } from "../../lib/aws-connection-source";
"use client";

import { useMemo, useState } from "react";
import type { PilotCoverageEntry, PilotSyncRun } from "../../lib/pilot-types";
import {
  formatTimestamp,
  postPilot,
  snapshotOriginLabel,
  usePilotState,
} from "../components/use-pilot-state";

function runTone(status: PilotSyncRun["status"]): string {
  if (status === "succeeded") return "status-positive";
  if (status === "failed" || status === "cancelled") return "status-high";
  return "status-medium";
}

function coverageTone(status: PilotCoverageEntry["status"]): string {
  if (status === "succeeded") return "status-positive";
  if (status === "failed") return "status-high";
  return "status-medium";
}

function elapsed(run: PilotSyncRun): string {
  if (run.startedAt === null || run.finishedAt === null) return "—";
  const milliseconds = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function LiveOperationsBrowser() {
  const { state, health, loading, refreshing, error, refresh } = usePilotState();
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const connection = state?.connection ?? null;
  const runs = useMemo(() => state?.syncRuns ?? [], [state?.syncRuns]);
  const latestCoverage = state?.latestRunCoverage?.entries ?? [];
  const counts = useMemo(() => ({
    succeeded: runs.filter((run) => run.status === "succeeded").length,
    partial: runs.filter((run) => run.status === "partial").length,
    failed: runs.filter((run) => run.status === "failed" || run.status === "cancelled").length,
    running: runs.filter((run) => run.status === "queued" || run.status === "running").length,
  }), [runs]);

  async function runCollection(): Promise<void> {
    if (connection === null) return;
    setSyncing(true);
    setActionError(null);
    try {
      await postPilot("/api/pilot/connections/sync", { connectionId: connection.id });
      await refresh();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Sutra could not run AWS collection");
      await refresh();
    } finally {
      setSyncing(false);
    }
  }

  const visibleError = actionError ?? error;
  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Live AWS operations</p>
          <h1>Collection runs</h1>
          <p className="page-subtitle">Run and review read-only AWS inventory collections, immutable snapshot promotion, and collector coverage for the selected customer account.</p>
        </div>
        <div className="heading-actions">
          <button className="button button-secondary" disabled={refreshing} onClick={() => void refresh()} type="button">{refreshing ? "Refreshing…" : "Refresh"}</button>
          {connection !== null ? (
            <button
              className="button button-primary"
              disabled={syncing || refreshing || connection.status !== "active" || !isCollectableAwsSourceKind(connection.sourceKind)}
              onClick={() => void runCollection()}
              type="button"
            >
              {syncing ? "Collecting from AWS…" : "Run collection"}
            </button>
          ) : null}
        </div>
      </section>

      <div className="trust-strip" role="note">
        <span className="trust-icon">✓</span>
        <span><strong>Live, read-only evidence.</strong> Every row below comes from persisted AWS collection state. Failed or partial attempts remain visible and never replace the last complete CMDB snapshot.</span>
        <a href="/controls#architecture">Review boundaries</a>
      </div>

      {visibleError ? <div className="page-alert page-alert-error" role="alert"><strong>Collection operations need attention</strong><span>{visibleError}</span><button onClick={() => void refresh()} type="button">Retry</button></div> : null}
      {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading live collection history…</div> : null}

      {!loading && connection === null ? (
        <section className="panel empty-workspace">
          <span className="empty-workspace-icon">AWS</span>
          <h2>No AWS account is connected</h2>
          <p>Onboard and validate a customer-owned read-only role before running a collection.</p>
          <a className="button button-primary" href="/onboard">Onboard AWS account</a>
        </section>
      ) : null}

      {connection !== null ? (
        <>
          <section className="summary-band" aria-label="Collection summary">
            <div><small>AWS account</small><strong>{connection.awsAccountId}</strong><span>{connection.customerName}</span></div>
            <div><small>Successful runs</small><strong>{counts.succeeded}</strong><span>{counts.running} currently queued or running</span></div>
            <div><small>Partial runs</small><strong>{counts.partial}</strong><span>Retained for coverage review</span></div>
            <div><small>Failed runs</small><strong>{counts.failed}</strong><span>Never promoted to active CMDB</span></div>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div><p className="eyebrow">Current evidence</p><h2>Active snapshot</h2></div>
              <span className={`status-pill ${state?.activeSnapshot ? "status-positive" : "status-medium"}`}>{state?.activeSnapshot ? "Published" : "Not collected"}</span>
            </div>
            {state?.activeSnapshot ? (
              <dl className="detail-list">
                <div><dt>Collected</dt><dd>{formatTimestamp(state.activeSnapshot.collectedAt)}</dd></div>
                <div><dt>Evidence source</dt><dd>{snapshotOriginLabel(state.activeSnapshot.origin)}</dd></div>
                <div><dt>Coverage state</dt><dd>{state.activeSnapshot.coverageState}</dd></div>
                <div><dt>Resources</dt><dd>{state.resources.length.toLocaleString()}</dd></div>
                <div><dt>Findings</dt><dd>{state.findings.length.toLocaleString()}</dd></div>
                <div><dt>Collector</dt><dd>{health?.ok === true ? health.message : "Status unavailable"}</dd></div>
              </dl>
            ) : <div className="empty-state"><strong>No complete snapshot has been published</strong><span>Run the first collection after the AWS trust role is active.</span></div>}
          </section>

          <section className="panel table-panel">
            <div className="panel-heading"><div><p className="eyebrow">Persisted execution state</p><h2>Run history</h2></div><span className="result-count">{runs.length} recorded</span></div>
            <div className="data-table" role="table" aria-label="AWS inventory collection history">
              <div className="data-row data-header" role="row"><span>Status</span><span>Started</span><span>Finished</span><span>Duration</span><span>Coverage</span></div>
              {runs.map((run) => (
                <div className="data-row" role="row" key={run.id}>
                  <span><span className={`status-pill ${runTone(run.status)}`}>{run.status}</span></span>
                  <span>{formatTimestamp(run.startedAt ?? run.createdAt)}</span>
                  <span>{formatTimestamp(run.finishedAt)}</span>
                  <span>{elapsed(run)}</span>
                  <span>{run.coverageState}</span>
                </div>
              ))}
              {runs.length === 0 ? <div className="empty-state"><strong>No collection runs yet</strong><span>Run the first collection when the connection is active.</span></div> : null}
            </div>
          </section>

          <section className="panel table-panel">
            <div className="panel-heading"><div><p className="eyebrow">Newest attempt</p><h2>Collector coverage</h2></div><span className="result-count">{latestCoverage.length} checks</span></div>
            <div className="data-table" role="table" aria-label="Latest AWS collector coverage">
              <div className="data-row data-header" role="row"><span>Collector</span><span>Region</span><span>Status</span><span>Items</span><span>Pages</span></div>
              {latestCoverage.map((entry) => (
                <div className="data-row" role="row" key={`${entry.collectorKey}:${entry.region}`}>
                  <span className="primary-cell"><strong>{entry.collectorKey}</strong>{entry.message ? <small>{entry.message}</small> : null}</span>
                  <span>{entry.region}</span>
                  <span><span className={`status-pill ${coverageTone(entry.status)}`}>{entry.status}</span></span>
                  <span>{entry.itemsObserved.toLocaleString()}</span>
                  <span>{entry.pagesObserved.toLocaleString()}</span>
                </div>
              ))}
              {latestCoverage.length === 0 ? <div className="empty-state"><strong>No run coverage recorded</strong><span>Coverage appears after the first AWS collection attempt.</span></div> : null}
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}

export function OperationsBrowser() {
  return <LiveOperationsBrowser />;
}

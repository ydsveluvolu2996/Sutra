"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  LocalFixtureDescriptor,
  LocalFixtureJobSummary,
  LocalFixtureVersion,
} from "../../lib/local-ops-types";
import { formatTimestamp } from "../components/use-pilot-state";

interface LocalPublication {
  readonly jobId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly syncRunId: string;
  readonly snapshotId: string;
  readonly fixtureId: string;
  readonly fixtureVersion: LocalFixtureVersion;
  readonly publishedAt: string;
}

interface PublishedJob extends LocalFixtureJobSummary {
  readonly publication: LocalPublication | null;
}

interface ApiErrorBody {
  readonly error?: {
    readonly message?: string;
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as (T & ApiErrorBody) | null;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? "Sutra could not complete the local operation");
  }
  if (body === null) {
    throw new Error("Sutra received an empty local operations response");
  }
  return body;
}

function statusTone(status: LocalFixtureJobSummary["status"]): string {
  if (status === "succeeded") return "status-positive";
  if (status === "dead_letter") return "status-high";
  return "status-medium";
}

function statusLabel(status: LocalFixtureJobSummary["status"]): string {
  if (status === "dead_letter") return "failed";
  if (status === "leased") return "running";
  return status;
}

function versionLabel(version: LocalFixtureVersion): string {
  return version === "2026.07.0" ? `${version} · baseline` : `${version} · evolved`;
}

function newestFirst(left: PublishedJob, right: PublishedJob): number {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt);
}

export function OperationsBrowser() {
  const [fixtures, setFixtures] = useState<readonly LocalFixtureDescriptor[]>([]);
  const [jobs, setJobs] = useState<readonly PublishedJob[]>([]);
  const [versions, setVersions] = useState<Readonly<Record<string, LocalFixtureVersion>>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [enqueuing, setEnqueuing] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadJobs = useCallback(async (showRefreshing = false): Promise<void> => {
    if (showRefreshing) setRefreshing(true);
    try {
      const body = await readJson<{ jobs: readonly PublishedJob[] }>(await fetch("/api/local/jobs?limit=30", {
        cache: "no-store",
        credentials: "same-origin",
      }));
      if (!Array.isArray(body.jobs)) throw new Error("Sutra received an invalid local job list");
      setJobs([...body.jobs].sort(newestFirst));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not load simulated inventory jobs");
    } finally {
      if (showRefreshing) setRefreshing(false);
    }
  }, []);

  const loadWorkspace = useCallback(async (): Promise<void> => {
    try {
      const [fixtureBody, jobBody] = await Promise.all([
        readJson<{ fixtures: readonly LocalFixtureDescriptor[] }>(await fetch("/api/local/fixtures", {
          cache: "no-store",
          credentials: "same-origin",
        })),
        readJson<{ jobs: readonly PublishedJob[] }>(await fetch("/api/local/jobs?limit=30", {
          cache: "no-store",
          credentials: "same-origin",
        })),
      ]);
      if (!Array.isArray(fixtureBody.fixtures) || !Array.isArray(jobBody.jobs)) {
        throw new Error("Sutra received invalid local operations data");
      }
      setFixtures(fixtureBody.fixtures);
      setJobs([...jobBody.jobs].sort(newestFirst));
      setVersions((current) => Object.fromEntries(fixtureBody.fixtures.map((fixture) => {
        const selected = current[fixture.fixtureId];
        const fallback = fixture.availableVersions[0];
        return [fixture.fixtureId, selected && fixture.availableVersions.includes(selected) ? selected : fallback];
      }).filter((entry): entry is [string, LocalFixtureVersion] => entry[1] !== undefined)));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not load local operations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void loadWorkspace(), 0);
    return () => clearTimeout(timer);
  }, [loadWorkspace]);

  const hasActiveJobs = jobs.some((job) => job.status === "pending" || job.status === "leased");

  useEffect(() => {
    if (!hasActiveJobs) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      if (document.visibilityState === "visible") await loadJobs();
      if (current) timer = setTimeout(() => void poll(), 2_500);
    };
    timer = setTimeout(() => void poll(), 2_500);

    const onVisibility = () => {
      if (document.visibilityState === "visible") void loadJobs();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      current = false;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [hasActiveJobs, loadJobs]);

  const fixtureById = useMemo(() => new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture])), [fixtures]);
  const activeFixtureIds = useMemo(() => new Set(jobs
    .filter((job) => job.status === "pending" || job.status === "leased")
    .map((job) => job.fixtureId)), [jobs]);
  const counts = useMemo(() => ({
    pending: jobs.filter((job) => job.status === "pending" || job.status === "leased").length,
    published: jobs.filter((job) => job.publication !== null).length,
    failed: jobs.filter((job) => job.status === "dead_letter").length,
  }), [jobs]);

  async function enqueue(fixture: LocalFixtureDescriptor): Promise<void> {
    const version = versions[fixture.fixtureId];
    if (version === undefined) return;
    setEnqueuing(fixture.fixtureId);
    setError(null);
    setNotice(null);
    try {
      const body = await readJson<{ created: boolean; job: LocalFixtureJobSummary }>(await fetch("/api/local/jobs/simulated-sync", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ fixtureId: fixture.fixtureId, version }),
      }));
      const queued: PublishedJob = { ...body.job, publication: null };
      setJobs((current) => [queued, ...current.filter((job) => job.jobId !== queued.jobId)].sort(newestFirst));
      setNotice(body.created
        ? `${fixture.customerName} ${version} was queued for deterministic collection.`
        : `The existing ${fixture.customerName} ${version} job was returned without creating a duplicate.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not enqueue the simulated collection");
    } finally {
      setEnqueuing(null);
    }
  }

  async function publish(job: PublishedJob): Promise<void> {
    setPublishing(job.jobId);
    setError(null);
    setNotice(null);
    try {
      const body = await readJson<{ publication: LocalPublication }>(await fetch("/api/local/jobs/publish", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: job.jobId }),
      }));
      setJobs((current) => current.map((candidate) => candidate.jobId === job.jobId
        ? { ...candidate, publication: body.publication }
        : candidate));
      window.dispatchEvent(new Event("sutra:state-changed"));
      setNotice(`Snapshot ${body.publication.snapshotId} was published to the scoped CMDB.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not publish the simulated snapshot");
    } finally {
      setPublishing(null);
    }
  }

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Local operations</p><h1>Simulated inventory runs</h1><p className="page-subtitle">Run deterministic account fixtures through the durable local queue, then explicitly publish completed evidence to the CMDB.</p></div>
        <div className="heading-actions"><button className="button button-secondary" disabled={loading || refreshing} onClick={() => void loadJobs(true)} type="button">{refreshing ? "Refreshing…" : "Refresh jobs"}</button></div>
      </section>

      <div className="simulation-trust-strip" role="note">
        <span className="simulation-badge">SIMULATED FIXTURE</span>
        <span><strong>No customer AWS account is contacted.</strong> Names, account IDs, resources, changes, and findings on this page are deterministic local test evidence.</span>
      </div>

      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Local operation needs attention</strong><span>{error}</span><button type="button" onClick={() => { setLoading(true); void loadWorkspace(); }}>Retry</button></div> : null}
      {notice ? <div className="page-alert operations-notice" role="status"><strong>Operation recorded</strong><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Dismiss</button></div> : null}
      {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading signed fixture catalog and durable jobs…</div> : null}

      {!loading ? (
        <>
          <section className="summary-band operations-summary" aria-label="Local job summary">
            <div><small>Simulated accounts</small><strong>{fixtures.length}</strong><span>Collector-owned fixture catalog</span></div>
            <div><small>In progress</small><strong>{counts.pending}</strong><span>Pending or leased jobs</span></div>
            <div><small>Published snapshots</small><strong>{counts.published}</strong><span>Persisted to the scoped CMDB</span></div>
            <div><small>Failed jobs</small><strong>{counts.failed}</strong><span>Exhausted bounded retries</span></div>
          </section>

          <section className="panel operations-fixture-panel">
            <div className="panel-heading"><div><p className="eyebrow">Deterministic sources</p><h2>Fixture account catalog</h2></div><span className="result-count">{fixtures.length} simulated accounts</span></div>
            <div className="operations-fixture-grid">
              {fixtures.map((fixture) => {
                const selectedVersion = versions[fixture.fixtureId];
                const active = activeFixtureIds.has(fixture.fixtureId);
                return <article className="operations-fixture-card" key={fixture.fixtureId}>
                  <div className="operations-fixture-top"><span className="simulation-badge compact">SIMULATED</span><code>{fixture.accountId}</code></div>
                  <h3>{fixture.customerName}</h3>
                  <p>{fixture.enabledRegions.join(" · ")}</p>
                  <dl><div><dt>Connection</dt><dd>{fixture.connectionId.slice(0, 15)}…</dd></div><div><dt>Versions</dt><dd>{fixture.availableVersions.length}</dd></div></dl>
                  <label><span>Snapshot version</span><select value={selectedVersion ?? ""} onChange={(event) => setVersions((current) => ({ ...current, [fixture.fixtureId]: event.target.value as LocalFixtureVersion }))}>{fixture.availableVersions.map((version) => <option key={version} value={version}>{versionLabel(version)}</option>)}</select></label>
                  <button className="button button-primary" disabled={selectedVersion === undefined || active || enqueuing !== null} onClick={() => void enqueue(fixture)} type="button">{enqueuing === fixture.fixtureId ? "Queueing collection…" : active ? "Collection in progress" : "Run simulated collection"}</button>
                </article>;
              })}
            </div>
            {fixtures.length === 0 ? <div className="empty-state"><strong>No fixture accounts are available</strong><span>The collector returned an empty signed fixture catalog.</span></div> : null}
          </section>

          <section className="panel table-panel operations-job-panel">
            <div className="panel-heading"><div><p className="eyebrow">Durable execution</p><h2>Recent fixture jobs</h2></div><span className="result-count">Latest {jobs.length} of 30</span></div>
            <div className="operations-job-table" role="table" aria-label="Recent simulated collection jobs">
              <div className="operations-job-row operations-job-header" role="row"><span>Status</span><span>Simulated account</span><span>Version</span><span>Attempts</span><span>Updated</span><span>Result</span></div>
              {jobs.map((job) => {
                const fixture = fixtureById.get(job.fixtureId);
                return <div className="operations-job-row" role="row" key={job.jobId}>
                  <span><span className={`status-pill ${statusTone(job.status)}`}>{statusLabel(job.status)}</span></span>
                  <span className="primary-cell"><strong>{fixture?.customerName ?? job.fixtureId}</strong><small>SIMULATED · {job.jobId.slice(0, 15)}…</small></span>
                  <span><code className="region-code">{job.version}</code></span>
                  <span className="muted-cell">{job.attempts} / {job.maxAttempts}</span>
                  <span className="muted-cell">{formatTimestamp(job.updatedAt)}</span>
                  <span className="operations-job-action">
                    {job.publication ? <><a className="text-link" href={`/cmdb?connectionId=${encodeURIComponent(job.publication.connectionId)}`}>Open snapshot →</a><small title={job.publication.snapshotId}>{job.publication.snapshotId.slice(0, 14)}… · {formatTimestamp(job.publication.publishedAt)}</small></> : null}
                    {!job.publication && job.status === "succeeded" ? <button className="button button-secondary button-small" disabled={publishing !== null} onClick={() => void publish(job)} type="button">{publishing === job.jobId ? "Publishing…" : "Publish to CMDB"}</button> : null}
                    {job.status === "pending" ? <small>Waiting for a worker lease</small> : null}
                    {job.status === "leased" ? <small>Collector worker is executing</small> : null}
                    {job.status === "dead_letter" ? <small title={job.lastFailure?.message}>{job.lastFailure?.message ?? "Bounded retries exhausted"}</small> : null}
                  </span>
                </div>;
              })}
              {jobs.length === 0 ? <div className="empty-state"><strong>No simulated collections yet</strong><span>Choose a fixture version above and enqueue the first durable collection.</span></div> : null}
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}

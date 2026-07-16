"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LocalFixtureDescriptor,
  LocalFixtureJobSummary,
  LocalFixtureSchedule,
  LocalFixtureVersion,
} from "../../lib/local-ops-types";
import { formatTimestamp } from "../components/use-pilot-state";

interface VisibleLocalFixtureDescriptor extends LocalFixtureDescriptor {
  readonly canRun: boolean;
  readonly canManageSchedule: boolean;
  readonly canPauseSchedule: boolean;
  readonly canPublish: boolean;
}

interface LocalPublication {
  readonly jobId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly syncRunId: string;
  readonly snapshotId: string;
  readonly fixtureId: string;
  readonly fixtureVersion: LocalFixtureVersion;
  readonly scheduleId: string | null;
  readonly publishedAt: string;
}

interface PublishedJob extends LocalFixtureJobSummary {
  readonly publication: LocalPublication | null;
}

interface ApiErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
}

class LocalOperationsApiError extends Error {
  public readonly status: number;
  public readonly code: string | null;

  public constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "LocalOperationsApiError";
    this.status = status;
    this.code = code;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as (T & ApiErrorBody) | null;
  if (!response.ok) {
    throw new LocalOperationsApiError(
      response.status,
      typeof body?.error?.code === "string" ? body.error.code : null,
      body?.error?.message ?? "Sutra could not complete the local operation",
    );
  }
  if (body === null) {
    throw new Error("Sutra received an empty local operations response");
  }
  return body;
}

function isDefinitiveScheduleFailure(error: unknown): boolean {
  return error instanceof LocalOperationsApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 425 &&
    error.status !== 429;
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

const SCHEDULE_INTERVALS = [300_000, 900_000, 3_600_000, 21_600_000, 86_400_000] as const;

function intervalLabel(everyMs: number): string {
  if (everyMs === 300_000) return "Every 5 minutes";
  if (everyMs === 900_000) return "Every 15 minutes";
  if (everyMs === 3_600_000) return "Every hour";
  if (everyMs === 21_600_000) return "Every 6 hours";
  if (everyMs === 86_400_000) return "Every day";
  return `Every ${Math.round(everyMs / 60_000)} minutes`;
}

function newestFirst(left: PublishedJob, right: PublishedJob): number {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt);
}

export function OperationsBrowser() {
  const [fixtures, setFixtures] = useState<readonly VisibleLocalFixtureDescriptor[]>([]);
  const [jobs, setJobs] = useState<readonly PublishedJob[]>([]);
  const [schedules, setSchedules] = useState<readonly LocalFixtureSchedule[]>([]);
  const [versions, setVersions] = useState<Readonly<Record<string, LocalFixtureVersion>>>({});
  const [scheduleVersions, setScheduleVersions] = useState<Readonly<Record<string, LocalFixtureVersion>>>({});
  const [scheduleIntervals, setScheduleIntervals] = useState<Readonly<Record<string, number>>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [enqueuing, setEnqueuing] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [savingSchedule, setSavingSchedule] = useState<string | null>(null);
  const [togglingSchedule, setTogglingSchedule] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [schedulesError, setSchedulesError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const scheduleMutationKeys = useRef(new Map<string, {
    readonly fingerprint: string;
    readonly idempotencyKey: string;
  }>());

  function scheduleMutationKey(slot: string, fingerprint: string): string {
    const storageKey = `sutra.local-operation.${encodeURIComponent(slot)}`;
    let pending = scheduleMutationKeys.current.get(slot);
    if (pending === undefined) {
      try {
        const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as {
          readonly fingerprint?: unknown;
          readonly idempotencyKey?: unknown;
        } | null;
        if (
          typeof stored?.fingerprint === "string" &&
          typeof stored.idempotencyKey === "string" &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
            .test(stored.idempotencyKey)
        ) {
          pending = {
            fingerprint: stored.fingerprint,
            idempotencyKey: stored.idempotencyKey,
          };
          scheduleMutationKeys.current.set(slot, pending);
        }
      } catch {
        sessionStorage.removeItem(storageKey);
      }
    }
    if (pending?.fingerprint === fingerprint) return pending.idempotencyKey;
    const idempotencyKey = crypto.randomUUID();
    const retained = { fingerprint, idempotencyKey };
    scheduleMutationKeys.current.set(slot, retained);
    sessionStorage.setItem(storageKey, JSON.stringify(retained));
    return idempotencyKey;
  }

  function finishScheduleMutation(slot: string, fingerprint: string): void {
    if (scheduleMutationKeys.current.get(slot)?.fingerprint === fingerprint) {
      scheduleMutationKeys.current.delete(slot);
      sessionStorage.removeItem(`sutra.local-operation.${encodeURIComponent(slot)}`);
    }
  }

  const loadJobs = useCallback(async (showRefreshing = false): Promise<void> => {
    if (showRefreshing) setRefreshing(true);
    try {
      const body = await readJson<{ jobs: readonly PublishedJob[] }>(await fetch("/api/local/jobs?limit=30", {
        cache: "no-store",
        credentials: "same-origin",
      }));
      if (!Array.isArray(body.jobs)) throw new Error("Sutra received an invalid local job list");
      setJobs([...body.jobs].sort(newestFirst));
      setJobsError(null);
    } catch (caught) {
      setJobsError(caught instanceof Error ? caught.message : "Sutra could not load simulated inventory jobs");
    } finally {
      if (showRefreshing) setRefreshing(false);
    }
  }, []);

  const loadSchedules = useCallback(async (): Promise<void> => {
    try {
      const body = await readJson<{ schedules: readonly LocalFixtureSchedule[] }>(await fetch("/api/local/schedules", {
        cache: "no-store",
        credentials: "same-origin",
      }));
      if (!Array.isArray(body.schedules)) throw new Error("Sutra received an invalid local schedule list");
      setSchedules(body.schedules);
      setSchedulesError(null);
    } catch (caught) {
      setSchedulesError(caught instanceof Error ? caught.message : "Sutra could not load simulated schedules");
    }
  }, []);

  const loadWorkspace = useCallback(async (): Promise<void> => {
    try {
      const [fixtureBody, jobBody, scheduleBody] = await Promise.all([
        readJson<{ fixtures: readonly VisibleLocalFixtureDescriptor[] }>(await fetch("/api/local/fixtures", {
          cache: "no-store",
          credentials: "same-origin",
        })),
        readJson<{ jobs: readonly PublishedJob[] }>(await fetch("/api/local/jobs?limit=30", {
          cache: "no-store",
          credentials: "same-origin",
        })),
        readJson<{ schedules: readonly LocalFixtureSchedule[] }>(await fetch("/api/local/schedules", {
          cache: "no-store",
          credentials: "same-origin",
        })),
      ]);
      if (
        !Array.isArray(fixtureBody.fixtures) ||
        fixtureBody.fixtures.some((fixture) =>
          typeof fixture.canRun !== "boolean" ||
          typeof fixture.canManageSchedule !== "boolean" ||
          typeof fixture.canPauseSchedule !== "boolean" ||
          typeof fixture.canPublish !== "boolean") ||
        !Array.isArray(jobBody.jobs) ||
        !Array.isArray(scheduleBody.schedules)
      ) {
        throw new Error("Sutra received invalid local operations data");
      }
      setFixtures(fixtureBody.fixtures);
      setJobs([...jobBody.jobs].sort(newestFirst));
      setSchedules(scheduleBody.schedules);
      const scheduleByFixture = new Map(scheduleBody.schedules.map((schedule) => [schedule.fixtureId, schedule]));
      setVersions((current) => Object.fromEntries(fixtureBody.fixtures.map((fixture) => {
        const selected = current[fixture.fixtureId];
        const fallback = fixture.availableVersions[0];
        return [fixture.fixtureId, selected && fixture.availableVersions.includes(selected) ? selected : fallback];
      }).filter((entry): entry is [string, LocalFixtureVersion] => entry[1] !== undefined)));
      setScheduleVersions((current) => Object.fromEntries(fixtureBody.fixtures.map((fixture) => {
        const scheduled = scheduleByFixture.get(fixture.fixtureId)?.version;
        const selected = current[fixture.fixtureId];
        const fallback = scheduled ?? fixture.availableVersions[0];
        return [fixture.fixtureId, selected && fixture.availableVersions.includes(selected) ? selected : fallback];
      }).filter((entry): entry is [string, LocalFixtureVersion] => entry[1] !== undefined)));
      setScheduleIntervals((current) => Object.fromEntries(fixtureBody.fixtures.map((fixture) => [
        fixture.fixtureId,
        current[fixture.fixtureId] ?? scheduleByFixture.get(fixture.fixtureId)?.everyMs ?? 3_600_000,
      ])));
      setError(null);
      setJobsError(null);
      setSchedulesError(null);
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

  const hasEnabledSchedules = schedules.some((schedule) => schedule.enabled);

  useEffect(() => {
    if (!hasEnabledSchedules) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void Promise.all([loadJobs(), loadSchedules()]);
      }
    }, 15_000);
    return () => clearInterval(timer);
  }, [hasEnabledSchedules, loadJobs, loadSchedules]);

  const fixtureById = useMemo(() => new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture])), [fixtures]);
  const scheduleByFixtureId = useMemo(
    () => new Map(schedules.map((schedule) => [schedule.fixtureId, schedule])),
    [schedules],
  );
  const activeFixtureIds = useMemo(() => new Set(jobs
    .filter((job) => job.status === "pending" || job.status === "leased")
    .map((job) => job.fixtureId)), [jobs]);
  const counts = useMemo(() => ({
    pending: jobs.filter((job) => job.status === "pending" || job.status === "leased").length,
    published: jobs.filter((job) => job.publication !== null).length,
    failed: jobs.filter((job) => job.status === "dead_letter").length,
    schedules: schedules.filter((schedule) => schedule.enabled).length,
  }), [jobs, schedules]);
  const visibleError = error ?? jobsError ?? schedulesError;

  async function refreshOperations(): Promise<void> {
    setRefreshing(true);
    await Promise.all([loadJobs(), loadSchedules()]);
    setRefreshing(false);
  }

  async function enqueue(fixture: VisibleLocalFixtureDescriptor): Promise<void> {
    const version = versions[fixture.fixtureId];
    if (version === undefined) return;
    setEnqueuing(fixture.fixtureId);
    setError(null);
    setNotice(null);
    const mutationSlot = `manual:${fixture.fixtureId}`;
    const mutationFingerprint = `${fixture.fixtureId}\u0000${version}`;
    const idempotencyKey = scheduleMutationKey(mutationSlot, mutationFingerprint);
    try {
      const body = await readJson<{ created: boolean; job: LocalFixtureJobSummary }>(await fetch("/api/local/jobs/simulated-sync", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ fixtureId: fixture.fixtureId, version }),
      }));
      const queued: PublishedJob = { ...body.job, publication: null };
      setJobs((current) => [queued, ...current.filter((job) => job.jobId !== queued.jobId)].sort(newestFirst));
      setNotice(body.created
        ? `${fixture.customerName} ${version} was queued for deterministic collection.`
        : `The existing ${fixture.customerName} ${version} job was returned without creating a duplicate.`);
      finishScheduleMutation(mutationSlot, mutationFingerprint);
    } catch (caught) {
      if (isDefinitiveScheduleFailure(caught)) {
        finishScheduleMutation(mutationSlot, mutationFingerprint);
      }
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

  async function saveFixtureSchedule(fixture: VisibleLocalFixtureDescriptor): Promise<void> {
    const version = scheduleVersions[fixture.fixtureId];
    const everyMs = scheduleIntervals[fixture.fixtureId];
    if (version === undefined || everyMs === undefined) return;
    setSavingSchedule(fixture.fixtureId);
    setError(null);
    setNotice(null);
    const mutationSlot = `upsert:${fixture.fixtureId}`;
    const mutationFingerprint = `${fixture.fixtureId}\u0000${version}\u0000${everyMs}\u0000enabled`;
    const idempotencyKey = scheduleMutationKey(mutationSlot, mutationFingerprint);
    try {
      const body = await readJson<{ schedule: LocalFixtureSchedule }>(await fetch("/api/local/schedules", {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ fixtureId: fixture.fixtureId, version, everyMs, enabled: true }),
      }));
      setSchedules((current) => [
        body.schedule,
        ...current.filter((schedule) => schedule.scheduleId !== body.schedule.scheduleId),
      ]);
      finishScheduleMutation(mutationSlot, mutationFingerprint);
      setNotice(`${fixture.customerName} automation is enabled. The first ${version} collection was scheduled immediately.`);
      setTimeout(() => void loadJobs(), 700);
    } catch (caught) {
      if (isDefinitiveScheduleFailure(caught)) {
        finishScheduleMutation(mutationSlot, mutationFingerprint);
      }
      setError(caught instanceof Error ? caught.message : "Sutra could not save the simulated schedule");
    } finally {
      setSavingSchedule(null);
    }
  }

  async function toggleFixtureSchedule(
    fixture: VisibleLocalFixtureDescriptor,
    enabled: boolean,
  ): Promise<void> {
    setTogglingSchedule(fixture.fixtureId);
    setError(null);
    setNotice(null);
    const mutationSlot = `toggle:${fixture.fixtureId}`;
    const mutationFingerprint = `${fixture.fixtureId}\u0000${enabled ? "enabled" : "disabled"}`;
    const idempotencyKey = scheduleMutationKey(mutationSlot, mutationFingerprint);
    try {
      const body = await readJson<{ schedule: LocalFixtureSchedule }>(await fetch("/api/local/schedules/enabled", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ fixtureId: fixture.fixtureId, enabled }),
      }));
      setSchedules((current) => current.map((schedule) =>
        schedule.scheduleId === body.schedule.scheduleId ? body.schedule : schedule));
      finishScheduleMutation(mutationSlot, mutationFingerprint);
      setNotice(`${fixture.customerName} automation was ${enabled ? "enabled" : "paused"}.`);
      if (enabled) setTimeout(() => void loadJobs(), 700);
    } catch (caught) {
      if (isDefinitiveScheduleFailure(caught)) {
        finishScheduleMutation(mutationSlot, mutationFingerprint);
      }
      setError(caught instanceof Error ? caught.message : "Sutra could not change the simulated schedule");
    } finally {
      setTogglingSchedule(null);
    }
  }

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Local operations</p><h1>Simulated inventory runs</h1><p className="page-subtitle">Run deterministic account fixtures through the durable local queue, then explicitly publish completed evidence to the CMDB.</p></div>
        <div className="heading-actions"><button className="button button-secondary" disabled={loading || refreshing} onClick={() => void refreshOperations()} type="button">{refreshing ? "Refreshing…" : "Refresh operations"}</button></div>
      </section>

      <div className="simulation-trust-strip" role="note">
        <span className="simulation-badge">SIMULATED FIXTURE</span>
        <span><strong>No customer AWS account is contacted.</strong> Names, account IDs, resources, changes, and findings on this page are deterministic local test evidence.</span>
      </div>

      {visibleError ? <div className="page-alert page-alert-error" role="alert"><strong>Local operation needs attention</strong><span>{visibleError}</span><button type="button" onClick={() => { setError(null); setJobsError(null); setSchedulesError(null); setLoading(true); void loadWorkspace(); }}>Retry</button></div> : null}
      {notice ? <div className="page-alert operations-notice" role="status"><strong>Operation recorded</strong><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Dismiss</button></div> : null}
      {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading signed fixture catalog and durable jobs…</div> : null}

      {!loading ? (
        <>
          <section className="summary-band operations-summary" aria-label="Latest local job page summary">
            <div><small>Simulated accounts</small><strong>{fixtures.length}</strong><span>{counts.schedules} automated schedules enabled</span></div>
            <div><small>In progress · review queue</small><strong>{counts.pending}</strong><span>Visible pending or leased work</span></div>
            <div><small>Published · visible window</small><strong>{counts.published}</strong><span>CMDB publications in this view</span></div>
            <div><small>Failed · visible window</small><strong>{counts.failed}</strong><span>Dead letters in this view</span></div>
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
                  <label><span>Snapshot version</span><select disabled={!fixture.canRun} value={selectedVersion ?? ""} onChange={(event) => setVersions((current) => ({ ...current, [fixture.fixtureId]: event.target.value as LocalFixtureVersion }))}>{fixture.availableVersions.map((version) => <option key={version} value={version}>{versionLabel(version)}</option>)}</select></label>
                  <button className="button button-primary" disabled={!fixture.canRun || selectedVersion === undefined || active || enqueuing !== null} onClick={() => void enqueue(fixture)} type="button">{!fixture.canRun ? "Read-only account" : enqueuing === fixture.fixtureId ? "Queueing collection…" : active ? "Collection in progress" : "Run simulated collection"}</button>
                </article>;
              })}
            </div>
            {fixtures.length === 0 ? <div className="empty-state"><strong>No fixture accounts are available</strong><span>The collector returned an empty signed fixture catalog.</span></div> : null}
          </section>

          <section className="panel operations-schedule-panel">
            <div className="panel-heading"><div><p className="eyebrow">Local automation</p><h2>Scheduled fixture collections</h2></div><span className="result-count">{counts.schedules} enabled · {schedules.length} configured</span></div>
            <div className="simulation-trust-strip schedule-review-note" role="note">
              <span className="simulation-badge compact">REVIEW GATE</span>
              <span>Schedules execute signed deterministic collection jobs. Completed evidence still requires an authorized operator to publish it to the CMDB.</span>
            </div>
            <div className="operations-schedule-grid">
              {fixtures.map((fixture) => {
                const schedule = scheduleByFixtureId.get(fixture.fixtureId);
                const selectedVersion = scheduleVersions[fixture.fixtureId];
                const selectedInterval = scheduleIntervals[fixture.fixtureId] ?? 3_600_000;
                const busy = savingSchedule !== null || togglingSchedule !== null;
                const capacityDegraded = schedule?.capacityState === "degraded";
                const hasMissedOccurrences = (schedule?.missedOccurrences ?? 0) > 0;
                return <article className="operations-schedule-card" key={fixture.fixtureId}>
                  <div className="operations-schedule-head">
                    <div><strong>{fixture.customerName}</strong><small>{fixture.accountId}</small></div>
                    <span className={`status-pill ${capacityDegraded || hasMissedOccurrences ? "status-high" : schedule?.enabled ? "status-positive" : "status-medium"}`}>{capacityDegraded ? "queue capacity" : hasMissedOccurrences ? "collection gap" : schedule ? schedule.enabled ? "enabled" : "paused" : "not configured"}</span>
                  </div>
                  <div className="operations-schedule-fields">
                    <label><span>Evidence version</span><select disabled={!fixture.canManageSchedule || busy} value={selectedVersion ?? ""} onChange={(event) => setScheduleVersions((current) => ({ ...current, [fixture.fixtureId]: event.target.value as LocalFixtureVersion }))}>{fixture.availableVersions.map((version) => <option key={version} value={version}>{versionLabel(version)}</option>)}</select></label>
                    <label><span>Collection interval</span><select disabled={!fixture.canManageSchedule || busy} value={selectedInterval} onChange={(event) => setScheduleIntervals((current) => ({ ...current, [fixture.fixtureId]: Number(event.target.value) }))}>{SCHEDULE_INTERVALS.map((everyMs) => <option key={everyMs} value={everyMs}>{intervalLabel(everyMs)}</option>)}</select></label>
                  </div>
                  <dl>
                    <div><dt>Next durable run</dt><dd>{schedule?.enabled ? formatTimestamp(schedule.nextRunAt) : "—"}</dd></div>
                    <div><dt>Attempts</dt><dd>{schedule ? `Up to ${schedule.maxAttempts}` : "5 per occurrence"}</dd></div>
                    <div><dt>Queue health</dt><dd>{capacityDegraded ? `Blocked · ${schedule.capacitySkippedOccurrences} skipped` : "Healthy"}</dd></div>
                    <div><dt>Missed after downtime</dt><dd>{hasMissedOccurrences ? `${schedule?.missedOccurrences} · last ${formatTimestamp(schedule?.lastMissedAt ?? null)}` : "None"}</dd></div>
                  </dl>
                  {fixture.canManageSchedule || (schedule?.enabled && fixture.canPauseSchedule) ? <div className="operations-schedule-actions">
                    {fixture.canManageSchedule ? <button className="button button-primary button-small" disabled={busy || selectedVersion === undefined} onClick={() => void saveFixtureSchedule(fixture)} type="button">{savingSchedule === fixture.fixtureId ? "Saving…" : schedule ? "Save & run now" : "Enable & run now"}</button> : null}
                    {schedule && (schedule.enabled ? fixture.canPauseSchedule : fixture.canManageSchedule) ? <button className="button button-secondary button-small" disabled={busy} onClick={() => void toggleFixtureSchedule(fixture, !schedule.enabled)} type="button">{togglingSchedule === fixture.fixtureId ? "Updating…" : schedule.enabled ? "Pause" : "Resume now"}</button> : null}
                  </div> : <p className="operations-schedule-readonly">Read-only schedule view. An active connection and customer-scoped management permission are required to change automation.</p>}
                </article>;
              })}
            </div>
          </section>

          <section className="panel table-panel operations-job-panel">
            <div className="panel-heading"><div><p className="eyebrow">Durable execution</p><h2>Recent fixture jobs</h2></div><span className="result-count">All visible review-required jobs + latest 30</span></div>
            <div className="operations-job-table" role="table" aria-label="Recent simulated collection jobs">
              <div className="operations-job-row operations-job-header" role="row"><span>Status</span><span>Simulated account</span><span>Version</span><span>Attempts</span><span>Updated</span><span>Result</span></div>
              {jobs.map((job) => {
                const fixture = fixtureById.get(job.fixtureId);
                return <div className="operations-job-row" role="row" key={job.jobId}>
                  <span><span className={`status-pill ${statusTone(job.status)}`}>{statusLabel(job.status)}</span></span>
                  <span className="primary-cell"><strong>{fixture?.customerName ?? job.fixtureId}</strong><small>{job.triggerKind === "scheduled" ? "SCHEDULED" : "MANUAL"} · {job.jobId.slice(0, 15)}…</small></span>
                  <span><code className="region-code">{job.version}</code></span>
                  <span className="muted-cell">{job.attempts} / {job.maxAttempts}</span>
                  <span className="muted-cell">{formatTimestamp(job.updatedAt)}</span>
                  <span className="operations-job-action">
                    {job.publication ? <><a className="text-link" href={`/cmdb?connectionId=${encodeURIComponent(job.publication.connectionId)}`}>Open snapshot →</a><small title={job.publication.snapshotId}>{job.publication.snapshotId.slice(0, 14)}… · {formatTimestamp(job.publication.publishedAt)}</small></> : null}
                    {!job.publication && job.status === "succeeded" && fixture?.canPublish ? <button className="button button-secondary button-small" disabled={publishing !== null} onClick={() => void publish(job)} type="button">{publishing === job.jobId ? "Publishing…" : "Publish to CMDB"}</button> : null}
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

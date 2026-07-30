"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Agentless snapshot scanning.
 *
 * The single most important thing this panel does is refuse to imply a clean
 * bill of health. Execution is offered only when the server reports its exact
 * production configuration and operator attestation; an empty findings table
 * still means "nothing has looked" until a run reaches a persisted terminal
 * result.
 *
 * The second thing it does is show outstanding snapshots as cost. Sutra creates
 * them and holds an explicit IAM deny on deleting them, so cleanup belongs to
 * the customer's own lifecycle policy. If that policy is missing, the snapshots
 * bill forever — so they are surfaced as a liability rather than hidden behind a
 * detail view nobody opens.
 */

interface ReadinessGap {
  readonly id: string;
  readonly summary: string;
  readonly owner: "engineering" | "operator";
}

interface Readiness {
  readonly canExecute: boolean;
  readonly canPlan: boolean;
  readonly gaps: readonly ReadinessGap[];
  readonly summary: string;
}

interface ScanRun {
  readonly id: string;
  readonly status: "planned" | "running" | "completed" | "failed";
  readonly scanAccountId: string;
  readonly scanners: readonly string[];
  readonly volumesInScope: number;
  readonly volumesSkipped: number;
  readonly volumesScanned: number;
  readonly volumesFailed: number;
  readonly findingsCount: number;
  readonly teardownFailures: number;
  readonly createdAt: string;
  readonly error: string | null;
}

interface Outstanding {
  readonly id: string;
  readonly resourceKind: "snapshot" | "volume" | "instance";
  readonly resourceId: string;
  readonly region: string;
  readonly accountScope: string;
  readonly attempts: number;
  readonly firstSeenAt: string;
}

interface ScanListResponse {
  readonly connectionId: string | null;
  readonly customerName?: string;
  readonly runs: readonly ScanRun[];
  readonly outstanding?: readonly Outstanding[];
  readonly readiness: Readiness;
  readonly neverScanned?: boolean;
  readonly available?: boolean;
  readonly reason?: string;
}

function shortDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 16).replace("T", " ");
}

export function AgentlessScansPanel(): React.JSX.Element {
  const [data, setData] = useState<ScanListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState<string | null>(null);
  const [applyOutcome, setApplyOutcome] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const response = await fetch("/api/v1/agentless-scans", { credentials: "same-origin" });
      if (!response.ok) {
        setError(`The agentless scan list could not be loaded (${response.status}).`);
        setData(null);
        return;
      }
      setData((await response.json()) as ScanListResponse);
      setError(null);
    } catch {
      setError("The agentless scan list could not be loaded.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Deliberately NOT `void load()`: load() calls setLoading(true) synchronously,
  // which react-hooks/set-state-in-effect correctly flags as a cascading render.
  // `loading` already initialises to true, so the first fetch needs no spinner
  // prelude. The cancelled guard also stops a state write after unmount — a
  // latent bug the lint rule happened to surface.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/v1/agentless-scans", { credentials: "same-origin" });
        if (cancelled) return;
        if (!response.ok) {
          setError(`The agentless scan list could not be loaded (${response.status}).`);
          return;
        }
        const payload = (await response.json()) as ScanListResponse;
        if (cancelled) return;
        setData(payload);
        setError(null);
      } catch {
        if (!cancelled) setError("The agentless scan list could not be loaded.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const connectionId = data?.connectionId ?? null;
    const running = data?.runs.filter((run) => run.status === "running") ?? [];
    if (connectionId === null || running.length === 0) return;
    let cancelled = false;
    const reconcile = async (): Promise<void> => {
      await Promise.all(running.map(async (run) => {
        await fetch(`/api/v1/agentless-scans/${encodeURIComponent(run.id)}/reconcile`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ connectionId }),
        });
      }));
      if (!cancelled) await load();
    };
    const timer = window.setInterval(() => { void reconcile(); }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [data, load]);

  const readiness = data?.readiness;
  const outstanding = data?.outstanding ?? [];

  /**
   * Applies a planned run.
   *
   * Today this is expected to return 409 with the readiness and configuration gaps,
   * and that outcome is surfaced verbatim rather than flattened into a generic
   * error. "Here is exactly which settings are unset" is the message that lets an
   * operator close a gap; "could not apply" is the message that makes them guess.
   * The response's own `interpretation` is shown too, because the one reading that
   * must never happen is treating a refused apply as a completed clean scan.
   */
  async function apply(runId: string, connectionId: string | null): Promise<void> {
    if (connectionId === null) return;
    setApplying(runId);
    setApplyOutcome(null);
    try {
      const response = await fetch(`/api/v1/agentless-scans/${encodeURIComponent(runId)}/execute`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });
      const payload = await response.json() as {
        applied?: boolean;
        configuration?: { available?: boolean; summary?: string };
        interpretation?: string;
        error?: { code?: string; message?: string };
      };
      if (payload.applied === true) {
        setApplyOutcome("Scan applied.");
        await load();
        return;
      }
      setApplyOutcome([
        payload.configuration?.summary,
        payload.interpretation,
        payload.error?.message,
      ].filter((part): part is string => typeof part === "string" && part.length > 0).join(" "));
    } catch (cause) {
      setApplyOutcome(cause instanceof Error ? cause.message : "The apply request failed.");
    } finally {
      setApplying(null);
    }
  }

  return (
    <div className="stack-lg">
      <header className="panel-head">
        <p className="eyebrow">AGENTLESS · NO WORKLOAD AGENT</p>
        <h1>Snapshot scanning</h1>
        <p className="muted">
          Scan an EBS volume&apos;s contents for vulnerabilities, secrets and malware without
          installing anything on the workload. Sutra creates a point-in-time snapshot, reads it in
          an isolated scanner, and holds an explicit IAM deny on deleting anything in your account.
        </p>
      </header>

      {/* Not dismissible on purpose: an empty findings table below must never be
          mistaken for a clean result while this is true. */}
      {readiness !== undefined && !readiness.canExecute ? (
        <article className="panel" aria-labelledby="agentless-readiness">
          <h2 id="agentless-readiness">Scanning is not yet executable</h2>
          <p><strong>{readiness.summary}</strong></p>
          <ul>
            {readiness.gaps.map((gap) => (
              <li key={gap.id}>
                <code>{gap.id}</code> — {gap.summary}{" "}
                <em>({gap.owner === "operator" ? "needs an operator with AWS access" : "engineering"})</em>
              </li>
            ))}
          </ul>
        </article>
      ) : null}

      {error !== null ? <article className="panel"><p role="alert">{error}</p></article> : null}

      {data?.available === false ? (
        <article className="panel">
          <h2>No readable AWS connection</h2>
          <p className="muted">{data.reason}</p>
        </article>
      ) : null}

      <article className="panel">
        <div className="panel-title-row">
          <h2>Scan runs {data !== null ? <span className="count">{data.runs.length}</span> : null}</h2>
          <button type="button" onClick={() => { void load(); }} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>

        {loading && data === null ? <p className="muted">Loading…</p> : null}

        {data !== null && data.runs.length === 0 ? (
          <p className="muted">
            <strong>No scan has ever run.</strong> This is not a clean result — nothing has looked at
            these volumes. A plan can be computed and reviewed today at no cost; it creates no
            snapshot and calls no AWS API.
          </p>
        ) : null}

        {/* The apply outcome, stated in full. While execution is gated this is the
            403/409 explanation naming the unset settings — the most useful thing on
            the page for whoever has to close those gaps. role="status" so it is
            announced rather than silently appearing below the fold. */}
        {applyOutcome !== null ? (
          <p className="inline-warning" role="status">
            <strong>Apply result</strong>
            <span>{applyOutcome}</span>
          </p>
        ) : null}

        {data !== null && data.runs.length > 0 ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Created</th>
                  <th scope="col">Status</th>
                  <th scope="col">In scope</th>
                  <th scope="col">Skipped</th>
                  <th scope="col">Scanned</th>
                  <th scope="col">Findings</th>
                  <th scope="col">Scanners</th>
                  <th scope="col">Apply</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((run) => (
                  <tr key={run.id}>
                    <td>{shortDate(run.createdAt)}</td>
                    <td>
                      {run.status}
                      {run.error !== null ? <><br /><small className="muted">{run.error}</small></> : null}
                    </td>
                    <td>{run.volumesInScope}</td>
                    {/* Skipped volumes are shown, never dropped: an out-of-scope
                        volume is a disclosure, not an absence. */}
                    <td>{run.volumesSkipped}</td>
                    <td>{run.volumesScanned}</td>
                    <td>{run.findingsCount}</td>
                    <td>{run.scanners.join(", ")}</td>
                    <td>
                      {run.status === "planned" ? (
                        <button className="button button-secondary" type="button"
                          disabled={
                            applying !== null ||
                            data.connectionId === null ||
                            readiness?.canExecute !== true
                          }
                          onClick={() => { void apply(run.id, data.connectionId); }}>
                          {applying === run.id ? "Applying…" : "Apply"}
                        </button>
                      ) : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </article>

      {/* Cost, not a footnote. */}
      <article className="panel">
        <h2>
          Scan resources awaiting cleanup{" "}
          {outstanding.length > 0 ? <span className="count">{outstanding.length}</span> : null}
        </h2>
        {outstanding.length === 0 ? (
          <p className="muted">Nothing outstanding. No scan-created resource is currently billing.</p>
        ) : (
          <>
            <p>
              Customer snapshots are reaped by your Data Lifecycle Manager policy because Sutra has
              an explicit delete deny. Any Sutra-account instance, volume, or snapshot shown here is
              retained as teardown debt until recovery proves it gone.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Resource</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Region</th>
                    <th scope="col">Whose account</th>
                    <th scope="col">First seen</th>
                    <th scope="col">Sweep attempts</th>
                  </tr>
                </thead>
                <tbody>
                  {outstanding.map((entry) => (
                    <tr key={entry.id}>
                      <td><code>{entry.resourceId}</code></td>
                      <td>{entry.resourceKind}</td>
                      <td>{entry.region}</td>
                      <td>{entry.accountScope === "customer" ? "yours — Sutra cannot delete" : "Sutra scan account"}</td>
                      <td>{shortDate(entry.firstSeenAt)}</td>
                      <td>{entry.attempts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </article>
    </div>
  );
}

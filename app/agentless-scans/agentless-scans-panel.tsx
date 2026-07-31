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

type Scanner = "vuln" | "secret" | "sbom" | "malware";

const SCANNERS: readonly Scanner[] = ["vuln", "secret", "sbom", "malware"];

interface ScanPlanResponse {
  readonly run?: ScanRun;
  readonly plan?: {
    readonly scanners: readonly string[];
    readonly summary: {
      readonly inScope: number;
      readonly skipped: number;
      readonly snapshots: number;
    };
  };
  readonly readiness?: Readiness;
  readonly volumesConsidered?: number;
  readonly error?: { readonly message?: string };
}

function shortDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 16).replace("T", " ");
}

export function AgentlessScansPanel(): React.JSX.Element {
  const [data, setData] = useState<ScanListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const [planOutcome, setPlanOutcome] = useState<string | null>(null);
  const [applyOutcome, setApplyOutcome] = useState<string | null>(null);
  const [requiredTagKey, setRequiredTagKey] = useState("");
  const [requiredTagValue, setRequiredTagValue] = useState("");
  const [includeUnattached, setIncludeUnattached] = useState(false);
  const [maxConcurrentScans, setMaxConcurrentScans] = useState("4");
  const [snapshotTtlHours, setSnapshotTtlHours] = useState("24");
  const [scanners, setScanners] = useState<readonly Scanner[]>(["vuln", "secret", "sbom"]);

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
   * Execution is available only when authenticated broker readiness says it is.
   * Any refusal is surfaced verbatim rather than flattened into a generic error:
   * the exact configuration gap lets an operator fix it, and the response's own
   * interpretation prevents a refused apply being mistaken for a clean scan.
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

  async function createPlan(): Promise<void> {
    const connectionId = data?.connectionId ?? null;
    const concurrency = Number(maxConcurrentScans);
    const ttlHours = Number(snapshotTtlHours);
    if (connectionId === null) return;
    if (scanners.length === 0) {
      setPlanOutcome("Select at least one scanner before creating a plan.");
      return;
    }
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
      setPlanOutcome("Concurrent scans must be a whole number from 1 to 64.");
      return;
    }
    if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 168) {
      setPlanOutcome("Snapshot retention must be a whole number from 1 to 168 hours.");
      return;
    }
    const tagKey = requiredTagKey.trim();
    const tagValue = requiredTagValue.trim();
    if (tagKey.length === 0 && tagValue.length > 0) {
      setPlanOutcome("Set a required tag key before setting its value.");
      return;
    }

    setPlanning(true);
    setPlanOutcome(null);
    try {
      const response = await fetch("/api/v1/agentless-scans", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId,
          ...(tagKey.length > 0 ? {
            requiredTagKey: tagKey,
            ...(tagValue.length > 0 ? { requiredTagValue: tagValue } : {}),
          } : {}),
          includeUnattached,
          maxConcurrentScans: concurrency,
          snapshotTtlHours: ttlHours,
          scanners,
        }),
      });
      const payload = await response.json() as ScanPlanResponse;
      if (!response.ok || payload.run === undefined || payload.plan === undefined) {
        throw new Error(payload.error?.message ?? `The scan plan could not be created (${response.status}).`);
      }
      setPlanOutcome(
        `Plan ${payload.run.id} created for ${payload.plan.summary.inScope} in-scope volume(s); `
        + `${payload.plan.summary.skipped} skipped and ${payload.plan.summary.snapshots} snapshot(s) proposed. `
        + "No AWS resource was created.",
      );
      await load();
    } catch (cause) {
      setPlanOutcome(cause instanceof Error ? cause.message : "The scan plan could not be created.");
    } finally {
      setPlanning(false);
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
          <h2 id="agentless-readiness">Execution requirements are incomplete</h2>
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

      {data !== null && data.available !== false ? <article className="panel" aria-labelledby="agentless-plan-heading">
        <div className="panel-title-row">
          <div>
            <p className="eyebrow">PLAN · NO AWS WRITE</p>
            <h2 id="agentless-plan-heading">Create a reviewable scan plan</h2>
          </div>
        </div>
        <p className="muted">
          Scope the collected EBS inventory and record the exact scanners, concurrency, snapshot
          retention and skipped volumes before any AWS resource is created.
        </p>
        <div className="agentless-plan-form">
          <div className="agentless-plan-fields">
            <label>
              <span>Required tag key <small>(optional)</small></span>
              <input maxLength={128} placeholder="sutra-agentless" value={requiredTagKey} onChange={(event) => setRequiredTagKey(event.target.value)} />
            </label>
            <label>
              <span>Required tag value <small>(defaults to true)</small></span>
              <input maxLength={128} placeholder="true" value={requiredTagValue} onChange={(event) => setRequiredTagValue(event.target.value)} />
            </label>
            <label>
              <span>Maximum concurrent scans</span>
              <input inputMode="numeric" max={64} min={1} type="number" value={maxConcurrentScans} onChange={(event) => setMaxConcurrentScans(event.target.value)} />
            </label>
            <label>
              <span>Snapshot retention (hours)</span>
              <input inputMode="numeric" max={168} min={1} type="number" value={snapshotTtlHours} onChange={(event) => setSnapshotTtlHours(event.target.value)} />
            </label>
          </div>
          <fieldset className="agentless-plan-options">
            <legend>Scanners</legend>
            {SCANNERS.map((scanner) => (
              <label className="agentless-plan-option" key={scanner}>
                <input
                  checked={scanners.includes(scanner)}
                  onChange={(event) => setScanners((current) => event.target.checked
                    ? [...current, scanner]
                    : current.filter((entry) => entry !== scanner))}
                  type="checkbox"
                />
                <span>{scanner}</span>
              </label>
            ))}
          </fieldset>
          <label className="agentless-plan-option">
            <input checked={includeUnattached} onChange={(event) => setIncludeUnattached(event.target.checked)} type="checkbox" />
            <span>Include unattached EBS volumes</span>
          </label>
          <div className="agentless-plan-actions">
            <button
              className="button button-primary"
              disabled={
                planning ||
                loading ||
                data?.connectionId == null ||
                readiness?.canPlan !== true ||
                scanners.length === 0
              }
              onClick={() => { void createPlan(); }}
              type="button"
            >
              {planning ? "Creating plan…" : "Create plan"}
            </button>
            <span className="muted">Planning reads the latest collected CMDB snapshot only.</span>
          </div>
          {planOutcome !== null ? <p className="inline-warning" role="status"><strong>Plan result</strong><span>{planOutcome}</span></p> : null}
        </div>
      </article> : null}

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

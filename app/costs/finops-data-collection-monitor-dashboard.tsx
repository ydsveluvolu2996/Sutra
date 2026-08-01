"use client";

import { useEffect, useState } from "react";

type DcfDashboard = ReturnType<
  typeof import("../../lib/finops-dcf-execution-history").buildDcfDashboard
>;
type DcfDashboardEnvelope = DcfDashboard & { connectionId: string };
type DcfUnavailableEnvelope = {
  connectionId: string;
  dashboard: null;
  collection: { available: false; reason: string };
};
type DcfApiState = DcfDashboardEnvelope | DcfUnavailableEnvelope | null;

export function DataCollectionMonitorView({
  report,
}: {
  report: DcfDashboardEnvelope;
}) {
  return (
    <section aria-label="Data Collection Monitor">
      <div role="status">
        <strong>Execution telemetry, not source truth.</strong> Real scheduler and
        Step Functions bindings must be active for current evidence.
      </div>
      <h3>DCF module health</h3>
      <div>
        {Object.entries(report.summary).map(([key, value]) => (
          <article key={key}>
            <span>{key.replaceAll("Count", "")}</span>
            <strong>{String(value)}</strong>
          </article>
        ))}
      </div>
      <h3>Modules, retries, latency &amp; coverage</h3>
      <table>
        <thead>
          <tr>
            <th>Module</th>
            <th>State</th>
            <th>Executions</th>
            <th>Errors</th>
            <th>Retries</th>
            <th>Latency</th>
            <th>Coverage</th>
          </tr>
        </thead>
        <tbody>
          {report.modules.map((moduleEntry) => (
            <tr key={moduleEntry.moduleId}>
              <td>{moduleEntry.moduleName}</td>
              <td>{moduleEntry.latestStatus}</td>
              <td>{moduleEntry.executionCount}</td>
              <td>{moduleEntry.failureCount}</td>
              <td>{moduleEntry.retryCount}</td>
              <td>{moduleEntry.latencyMs.join(", ") || "running"}</td>
              <td>
                {moduleEntry.coverage.accepted}/
                {moduleEntry.coverage.expected ?? "unknown"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Execution history</h3>
      {report.executions.map((row) => (
        <details key={row.execution.executionArn}>
          <summary>
            {row.moduleName} · {row.execution.status} · attempt{" "}
            {row.execution.attempt}
          </summary>
          <p>Error: {row.execution.errorCode ?? "none"}</p>
          <a
            href={row.consoleUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open validated Step Functions execution
          </a>
        </details>
      ))}
    </section>
  );
}

export function FinopsDataCollectionMonitorDashboard({
  connectionId,
}: {
  connectionId: string | null;
}) {
  const [state, setState] = useState<DcfApiState>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!connectionId) return;
    const controller = new AbortController();
    void fetch(
      `/api/v1/finops/data-collection-monitor?connectionId=${encodeURIComponent(connectionId)}`,
      { signal: controller.signal, credentials: "same-origin" },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("Data Collection Monitor request failed");
        return response.json() as Promise<Exclude<DcfApiState, null>>;
      })
      .then((value) => {
        setState(value);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "Data Collection Monitor request failed");
        }
      });
    return () => controller.abort();
  }, [connectionId]);
  if (connectionId === null) {
    return <div role="status">Connect an active AWS trust-role account.</div>;
  }
  if (error !== null) return <div role="alert">{error}</div>;
  if (state !== null && state.connectionId !== connectionId) {
    return <div role="status">Loading DCF execution history…</div>;
  }
  if (state && "dashboard" in state) {
    return <div role="status">DCF instrumentation is not registered.</div>;
  }
  return state ? (
    <DataCollectionMonitorView report={state} />
  ) : (
    <div role="status">Loading DCF execution history…</div>
  );
}

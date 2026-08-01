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

function matchesStatusCategory(status: string, category: string): boolean {
  if (category === "") return true;
  if (category === "SUCCESS") return status === "SUCCEEDED";
  if (category === "RUNNING") return status === "RUNNING";
  return category === "ERROR"
    && ["FAILED", "TIMED_OUT", "ABORTED"].includes(status);
}

export function DataCollectionMonitorView({
  report,
}: {
  report: DcfDashboardEnvelope;
}) {
  const [moduleId, setModuleId] = useState("");
  const [statusCategory, setStatusCategory] = useState("");
  const [daysBack, setDaysBack] = useState("30");
  const [logLinksMode, setLogLinksMode] = useState("ERRORS");
  const cutoff = Date.parse(report.generatedAtIso) - Number(daysBack) * 86_400_000;
  const visibleExecutions = report.executions.filter((row) =>
    (moduleId === "" || row.moduleId === moduleId)
    && Date.parse(row.execution.startedAt) >= cutoff
    && matchesStatusCategory(row.execution.status, statusCategory));
  const visibleModules = report.modules.filter((row) =>
    (moduleId === "" || row.moduleId === moduleId)
    && matchesStatusCategory(row.latestStatus, statusCategory));
  const statusCounts = {
    success: visibleExecutions.filter((row) => row.execution.status === "SUCCEEDED").length,
    errors: visibleExecutions.filter((row) => ["FAILED", "TIMED_OUT", "ABORTED"].includes(row.execution.status)).length,
    running: visibleExecutions.filter((row) => row.execution.status === "RUNNING").length,
  };
  return (
    <section aria-label="Data Collection Monitor">
      <div role="status">
        <strong>Execution telemetry, not source truth.</strong> Real scheduler and
        Step Functions bindings must be active for current evidence.
      </div>
      <div aria-label="Official Data Collection Monitor controls">
        <label>Module<select value={moduleId} onChange={(event) => setModuleId(event.target.value)}><option value="">All modules</option>{report.modules.map((item) => <option key={item.moduleId} value={item.moduleId}>{item.moduleName}</option>)}</select></label>
        <label>Status Category<select value={statusCategory} onChange={(event) => setStatusCategory(event.target.value)}><option value="">All status categories</option><option value="SUCCESS">Success</option><option value="ERROR">Error</option><option value="RUNNING">Running</option></select></label>
        <label>Days back<select value={daysBack} onChange={(event) => setDaysBack(event.target.value)}><option value="1">1</option><option value="7">7</option><option value="30">30</option><option value="90">90</option></select></label>
        <label>Log Links Mode<select value={logLinksMode} onChange={(event) => setLogLinksMode(event.target.value)}><option value="ERRORS">Errors only</option><option value="ALL">All executions</option><option value="NONE">Hidden</option></select></label>
      </div>
      <div aria-label="Execution status categories"><article><span>Success</span><strong>{statusCounts.success}</strong></article><article><span>Errors</span><strong>{statusCounts.errors}</strong></article><article><span>Running</span><strong>{statusCounts.running}</strong></article></div>
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
          {visibleModules.map((moduleEntry) => (
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
      {visibleExecutions.length === 0
        ? <p role="status">No execution evidence matches the selected controls.</p>
        : null}
      {visibleExecutions.map((row) => (
        <details key={row.execution.executionArn}>
          <summary>
            {row.moduleName} · {row.execution.status} · attempt{" "}
            {row.execution.attempt}
          </summary>
          <p>Error: {row.execution.errorCode ?? "none"}</p>
          {logLinksMode !== "NONE" && (logLinksMode === "ALL" || ["FAILED", "TIMED_OUT", "ABORTED"].includes(row.execution.status)) ? <a
            href={row.consoleUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open validated Step Functions execution
          </a> : <span>Execution link hidden by Log Links Mode</span>}
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

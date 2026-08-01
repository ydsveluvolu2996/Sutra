"use client";

import { useEffect, useState } from "react";
import {
  DATA_COLLECTION_MONITOR_OFFICIAL_DEFINITION,
  type DataCollectionMonitorOfficialDefinition,
} from "../../lib/finops-data-collection-monitor-official-definition";
import styles from "./finops-data-collection-monitor-dashboard.module.css";

type DcfDashboard = ReturnType<
  typeof import("../../lib/finops-dcf-execution-history").buildDcfDashboard
>;
type DcfDashboardEnvelope = DcfDashboard & {
  connectionId: string;
  officialDefinition: DataCollectionMonitorOfficialDefinition;
};
type DcfUnavailableEnvelope = {
  connectionId: string;
  officialDefinition: DataCollectionMonitorOfficialDefinition;
  dashboard: null;
  collection: { available: false; reason: string };
};
type DcfApiState = DcfDashboardEnvelope | DcfUnavailableEnvelope | null;

function hasPinnedOfficialDefinition(
  definition: DataCollectionMonitorOfficialDefinition,
): boolean {
  return definition.sourceCommit === DATA_COLLECTION_MONITOR_OFFICIAL_DEFINITION.sourceCommit
    && definition.manifestSha256 === DATA_COLLECTION_MONITOR_OFFICIAL_DEFINITION.manifestSha256
    && definition.artifacts[1]?.sha256 === DATA_COLLECTION_MONITOR_OFFICIAL_DEFINITION.artifacts[1]?.sha256
    && definition.completeDefinitionPublished === true
    && definition.totals.sheets === 2
    && definition.totals.visuals === 10;
}

function OfficialDefinitionPanel({
  definition,
}: {
  definition: DataCollectionMonitorOfficialDefinition;
}) {
  const [selectedId, setSelectedId] = useState(definition.sheets[0]?.id ?? "");
  const selected = definition.sheets.find((sheet) => sheet.id === selectedId)
    ?? definition.sheets[0];
  return <section className={styles.official} aria-label="Official Data Collection Monitor definition coverage">
    <header><div><small>AWS CID {definition.version} · complete embedded definition</small>
      <h3>{definition.totals.sheets} sheets · {definition.totals.visuals} upstream visuals mapped</h3>
      <p>Manifest <code>{definition.manifestSha256.slice(0, 12)}…</code> · embedded definition <code>{definition.artifacts[1]?.sha256.slice(0, 12)}…</code>. The complete QuickSight definition, dataset template, and SQL view query are published inside one manifest; no screenshot geometry is inferred.</p></div>
      <dl><div><dt>Controls</dt><dd>{definition.totals.parameterControls + definition.totals.filterControls}</dd></div>
        <div><dt>Parameters</dt><dd>{definition.totals.parameterDeclarations}</dd></div>
        <div><dt>Calculated fields</dt><dd>{definition.totals.calculatedFields}</dd></div>
        <div><dt>Filter groups</dt><dd>{definition.totals.filterGroups}</dd></div></dl></header>
    <div className={styles.artifacts} aria-label="Published Data Collection Monitor artifacts">{definition.artifacts.map((artifact) => <article key={artifact.kind}><strong>{artifact.kind.replaceAll("_", " ")}</strong><code>{artifact.sha256.slice(0, 16)}…</code><small>{artifact.hashBasis}</small></article>)}</div>
    <nav aria-label="Official Data Collection Monitor sheets">{definition.sheets.map((sheet) => <button key={sheet.id} aria-current={selected?.id === sheet.id ? "page" : undefined} onClick={() => setSelectedId(sheet.id)} type="button"><strong>{sheet.name}</strong><small>{sheet.visualCount} visual{sheet.visualCount === 1 ? "" : "s"}</small></button>)}</nav>
    {selected === undefined ? null : <article className={styles.sheetEvidence}><div><small>Selected official sheet</small><h4>{selected.name}</h4><p>{selected.evidenceNote}</p><p className={styles.gap}><strong>Remaining:</strong> {selected.remainingGap}</p></div>
      <dl><div><dt>Visual types</dt><dd>{Object.entries(selected.visualTypes).map(([type, count]) => `${count} ${type.replace("Visual", "")}`).join(" · ") || "None"}</dd></div>
        <div><dt>Native areas</dt><dd>{selected.nativeAreas.join(" · ")}</dd></div>
        <div><dt>Official controls</dt><dd>{selected.controls.length === 0 ? "None" : selected.controls.map((control) => <span key={`${control.placement}:${control.title}`} data-state={control.nativeState}>{control.title} · {control.placement} · {control.nativeState.toLocaleLowerCase().replace("_", " ")}</span>)}</dd></div></dl></article>}
  </section>;
}

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
    <section className={styles.root} aria-label="Data Collection Monitor">
      <OfficialDefinitionPanel definition={report.officialDefinition} />
      <div className={styles.notice} role="status">
        <strong>Execution telemetry, not source truth.</strong> Real scheduler and
        Step Functions bindings must be active for current evidence.
      </div>
      <div className={styles.controls} aria-label="Official Data Collection Monitor controls">
        <label>Module<select value={moduleId} onChange={(event) => setModuleId(event.target.value)}><option value="">All modules</option>{report.modules.map((item) => <option key={item.moduleId} value={item.moduleId}>{item.moduleName}</option>)}</select></label>
        <label>Status Category<select value={statusCategory} onChange={(event) => setStatusCategory(event.target.value)}><option value="">All status categories</option><option value="SUCCESS">Success</option><option value="ERROR">Error</option><option value="RUNNING">Running</option></select></label>
        <label>Days back<select value={daysBack} onChange={(event) => setDaysBack(event.target.value)}><option value="1">1</option><option value="7">7</option><option value="30">30</option><option value="90">90</option></select></label>
        <label>Log Links Mode<select value={logLinksMode} onChange={(event) => setLogLinksMode(event.target.value)}><option value="ERRORS">Errors only</option><option value="ALL">All executions</option><option value="NONE">Hidden</option></select></label>
      </div>
      <div className={styles.statusCards} aria-label="Execution status categories"><article><span>Success</span><strong>{statusCounts.success}</strong></article><article><span>Errors</span><strong>{statusCounts.errors}</strong></article><article><span>Running</span><strong>{statusCounts.running}</strong></article></div>
      <h3>DCF module health</h3>
      <div className={styles.summaryCards}>
        {Object.entries(report.summary).map(([key, value]) => (
          <article key={key}>
            <span>{key.replaceAll("Count", "")}</span>
            <strong>{String(value)}</strong>
          </article>
        ))}
      </div>
      <h3>Modules, retries, latency &amp; coverage</h3>
      <div className={styles.tableWrap}><table>
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
      </table></div>
      <h3>Execution history</h3>
      {visibleExecutions.length === 0
        ? <p role="status">No execution evidence matches the selected controls.</p>
        : null}
      <div className={styles.executions}>{visibleExecutions.map((row) => (
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
      ))}</div>
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
        if (!hasPinnedOfficialDefinition(value.officialDefinition)) {
          throw new Error("Sutra returned an unrecognized Data Collection Monitor definition");
        }
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
    return <section className={styles.root}>
      <OfficialDefinitionPanel definition={state.officialDefinition} />
      <div className={styles.notice} role="status">DCF instrumentation is not registered. The official source inventory remains available above; no execution state is synthesized.</div>
    </section>;
  }
  return state ? (
    <DataCollectionMonitorView report={state} />
  ) : (
    <div role="status">Loading DCF execution history…</div>
  );
}

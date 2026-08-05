"use client";

import { useEffect, useState } from "react";
import type {
  EndUserComputingCostBreakdown,
  EndUserComputingDashboard,
  EndUserComputingDimensionCount,
  EndUserComputingService,
} from "../../lib/finops-end-user-computing";
import { END_USER_COMPUTING_OFFICIAL_DEFINITION } from "../../lib/finops-end-user-computing-official-definition";
import type { END_USER_COMPUTING_RUNTIME_BINDING } from "../../lib/finops-end-user-computing-runtime-binding";
import styles from "./finops-end-user-computing-dashboard.module.css";

type SourceState = "complete" | "partial" | "stale" | "empty" | "failed" | "configuration_required";
interface HistoryItem { readonly generationId: string; readonly sourceState: string; readonly observedAtIso: string; readonly workspaceCount: number; readonly fleetCount: number; readonly metricCount: number; readonly costLineCount: number }
export interface EndUserComputingDashboardEnvelope {
  readonly schema: "sutra.finops-end-user-computing-dashboard.v1";
  readonly connectionId: string;
  readonly sourceState: SourceState;
  readonly runtimeState: "unavailable" | "collecting" | "failed" | "ready";
  readonly dashboard: EndUserComputingDashboard;
  readonly history: readonly HistoryItem[];
  readonly freshness: { readonly dataThroughAt: string | null; readonly ageHours: number | null; readonly staleAfterHours: number };
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly collection: typeof END_USER_COMPUTING_RUNTIME_BINDING;
  readonly officialDefinition: typeof END_USER_COMPUTING_OFFICIAL_DEFINITION;
  readonly filterOptions: {
    readonly services: readonly EndUserComputingService[];
    readonly accountIds: readonly string[];
    readonly regions: readonly string[];
  };
  readonly privacy: Readonly<Record<string, boolean>>;
  readonly unsupportedOfficialViews: readonly string[];
}

interface EndUserComputingConfigurationEnvelope {
  readonly dashboard: null;
  readonly runtimeState: "unavailable" | "collecting";
  readonly collection: typeof END_USER_COMPUTING_RUNTIME_BINDING;
  readonly officialDefinition: typeof END_USER_COMPUTING_OFFICIAL_DEFINITION;
}

function hasPinnedOfficialDefinition(value: unknown): value is typeof END_USER_COMPUTING_OFFICIAL_DEFINITION { if (typeof value !== "object" || value === null) return false; const definition = value as Readonly<Record<string, unknown>>; return definition.schemaVersion === END_USER_COMPUTING_OFFICIAL_DEFINITION.schemaVersion && definition.commit === END_USER_COMPUTING_OFFICIAL_DEFINITION.commit && definition.artifactSha256 === END_USER_COMPUTING_OFFICIAL_DEFINITION.artifactSha256 && definition.sheetCount === 7 && definition.visualCount === 82 && definition.controlCount === 24 && Array.isArray(definition.sheets) && definition.sheets.length === 7; }

function integerMoney(micros: string | null, currency: string): string {
  if (micros === null) return "Unknown";
  const negative = micros.startsWith("-");
  const digits = negative ? micros.slice(1) : micros;
  const padded = digits.padStart(7, "0");
  return `${negative ? "-" : ""}${currency} ${padded.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/gu, ",")}.${padded.slice(-6, -4)}`;
}

function DimensionBars({ title, rows, empty }: {
  readonly title: string;
  readonly rows: readonly EndUserComputingDimensionCount[];
  readonly empty: string;
}) {
  const maximum = Math.max(0, ...rows.map((item) => item.count));
  return <article className={styles.breakdown}><h4>{title}</h4>{rows.length === 0 ? <p className={styles.muted}>{empty}</p> : <ol>{rows.map((item) => <li key={item.value}><span title={item.value}>{item.value.replaceAll("_", " ")}</span><div className={styles.barTrack} aria-hidden="true"><i style={{ width: `${maximum === 0 ? 0 : Math.max(4, (item.count / maximum) * 100)}%` }} /></div><strong>{item.count}</strong></li>)}</ol>}</article>;
}

function CostBreakdownTable({ title, rows }: { readonly title: string; readonly rows: readonly EndUserComputingCostBreakdown[] }) {
  return <article className={styles.breakdown}><h4>{title}</h4>{rows.length === 0 ? <p className={styles.muted}>Canonical CUR2 cost evidence is unavailable for this selection.</p> : <div className={styles.scroll}><table className={styles.table}><thead><tr><th>Service</th><th>Dimension</th><th>Canonical cost</th><th>Basis / coverage</th><th>Lines</th></tr></thead><tbody>{rows.map((item) => <tr key={`${item.service}:${item.currency}:${item.value}`}><td>{item.service}</td><td>{item.value}</td><td>{integerMoney(item.displayTotal?.totalMicros ?? null, item.currency)}</td><td>{item.displayTotal === null ? "UNAVAILABLE" : `${item.displayTotal.basis} · ${item.displayTotal.coverage}`}</td><td>{item.lineCount}</td></tr>)}</tbody></table></div>}</article>;
}

function stateText(state: SourceState): string | null {
  if (state === "complete") return null;
  if (state === "configuration_required") return "End User Computing evidence is not configured for this connection.";
  if (state === "partial") return "Coverage is partial. A newer incomplete capture has not replaced the accepted complete head.";
  if (state === "stale") return "The latest evidence is older than the 48-hour dashboard objective.";
  if (state === "empty") return "Collection completed but no WorkSpaces or AppStream fleets were observed in this scope.";
  return "The latest collection is unavailable. Failed evidence cannot replace an accepted complete head.";
}

export function EndUserComputingOfficialDefinitionPanel({ definition }: { readonly definition: typeof END_USER_COMPUTING_OFFICIAL_DEFINITION }) { return <section className={styles.panel} aria-label="Pinned AWS CID definition coverage"><h3>Pinned AWS CID definition coverage</h3><div className={styles.grid}><article className={styles.card}><small>Official sheets</small><strong>{definition.sheetCount}</strong><span>pinned definition {definition.dashboardVersion}</span></article><article className={styles.card}><small>Official visuals</small><strong>{definition.visualCount}</strong><span>audited, not claimed as pixel parity</span></article><article className={styles.card}><small>Official controls</small><strong>{definition.controlCount}</strong><span>source controls mapped without synthetic provider evidence</span></article></div><div className={styles.scroll}><table className={styles.table}><thead><tr><th>Official sheet</th><th>Visuals</th><th>Controls</th><th>Sutra area</th><th>Coverage</th></tr></thead><tbody>{definition.sheets.map((sheet) => <tr key={sheet.name}><td>{sheet.name}</td><td>{sheet.visualCount}</td><td>{sheet.controlCount}</td><td>{sheet.localArea}</td><td><span className={styles.pill}>{sheet.coverage.replaceAll("_", " ")}</span></td></tr>)}</tbody></table></div><p className={styles.muted}>Source: <a href={definition.sourceUrl} target="_blank" rel="noopener noreferrer">AWS CID commit {definition.commit}</a> · artifact SHA-256 <code>{definition.artifactSha256}</code>. Frozen source coverage remains visible without a provider report; native views do not claim QuickSight pixel parity.</p></section>; }

export function FinopsEndUserComputingReportView({ report, service, onServiceChange, accountId = "ALL", region = "ALL", onAccountIdChange = () => undefined, onRegionChange = () => undefined }: {
  readonly report: EndUserComputingDashboardEnvelope;
  readonly service: EndUserComputingService | "ALL";
  readonly onServiceChange: (service: EndUserComputingService | "ALL") => void;
  readonly accountId?: string | "ALL";
  readonly region?: string | "ALL";
  readonly onAccountIdChange?: (accountId: string | "ALL") => void;
  readonly onRegionChange?: (region: string | "ALL") => void;
}) {
  const dashboard = report.dashboard;
  const alwaysOn = dashboard.dimensionViews.workspacesByRunningMode.find((item) => item.value === "ALWAYS_ON")?.count ?? 0;
  const disconnected = dashboard.activity.workspaceConnections.disconnected;
  const status = stateText(report.sourceState);
  return <section className={styles.root} aria-label="AWS End User Computing dashboard">
    <div className={styles.notice}><strong>Privacy-safe operational evidence.</strong> User names, per-user logons, session/instance identifiers, IP addresses, and raw provider messages are neither persisted nor returned. Costs never imply usage or performance.</div>
    {status ? <div role="status" className={`${styles.state} ${report.sourceState === "failed" ? styles.error : styles.warning}`}>{status}</div> : null}
    <div className={styles.filters} aria-label="End User Computing filters"><label>Service<select value={service} onChange={(event) => onServiceChange(event.target.value as EndUserComputingService | "ALL")}><option value="ALL">All EUC services</option><option value="WORKSPACES">Amazon WorkSpaces</option><option value="APPSTREAM">WorkSpaces Applications</option></select></label><label>Linked account ID<select value={accountId} onChange={(event) => onAccountIdChange(event.target.value)}><option value="ALL">All linked accounts</option>{report.filterOptions.accountIds.map((value) => <option value={value} key={value}>{value}</option>)}</select></label><label>Region<select value={region} onChange={(event) => onRegionChange(event.target.value)}><option value="ALL">All Regions</option>{report.filterOptions.regions.map((value) => <option value={value} key={value}>{value}</option>)}</select></label><label>Billing period<output>{dashboard.sourceEvidence.billingPeriod ?? "Canonical CUR2 unavailable"}</output></label></div>

    <EndUserComputingOfficialDefinitionPanel definition={report.officialDefinition} />

    <section className={styles.panel} aria-label="Three month service and cost summary"><h3>Service and cost summary</h3>
      <div className={styles.grid}><article className={styles.card}><small>WorkSpaces</small><strong>{dashboard.inventory.workspaceCount}</strong><span>point-in-time resources</span></article><article className={styles.card}><small>AppStream fleets</small><strong>{dashboard.inventory.fleetCount}</strong><span>{dashboard.inventory.runningFleets} running</span></article>{dashboard.costViews.map((view) => <article className={styles.card} key={`${view.service}:${view.currency}`}><small>{view.service} · {view.currency}</small><strong>{integerMoney(view.totals.find((item) => item.basis === "net")?.totalMicros ?? view.totals.find((item) => item.basis === "amortized")?.totalMicros ?? view.totals.find((item) => item.basis === "unblended")?.totalMicros ?? null, view.currency)}</strong><span>{view.lineCount} canonical CUR2 lines · billing period {dashboard.sourceEvidence.billingPeriod ?? "unknown"}</span></article>)}</div>
      <div className={styles.breakdownGrid}><CostBreakdownTable title="Canonical cost by linked account" rows={dashboard.costBreakdowns.byAccount} /><CostBreakdownTable title="Canonical cost by Region" rows={dashboard.costBreakdowns.byRegion} /></div>
      <div className={styles.scroll}><table className={styles.table}><thead><tr><th>Observed month</th><th>Service</th><th>Currency</th><th>Canonical cost</th><th>Lines</th></tr></thead><tbody>{(dashboard.costTrend?.monthly ?? []).map((item) => <tr key={`${item.period}:${item.service}:${item.currency}`}><td>{item.period}</td><td>{item.service}</td><td>{item.currency}</td><td>{integerMoney(item.displayTotal?.totalMicros ?? null, item.currency)}</td><td>{item.lineCount}</td></tr>)}</tbody></table></div>
      <div className={styles.scroll}><table className={styles.table}><thead><tr><th>Privacy-approved usage dimension</th><th>Service</th><th>Unit</th><th>Quantity</th><th>Lines</th></tr></thead><tbody>{dashboard.costViews.flatMap((view) => view.usage.map((item) => <tr key={`${view.service}:${view.currency}:${item.unit ?? "unknown"}`}><td>CUR2 usage unit</td><td>{view.service}</td><td>{item.unit ?? "Unknown"}</td><td>{item.quantityMicros}</td><td>{item.lineCount}</td></tr>))}</tbody></table></div>
      <p className={styles.muted}>The rolling three-month (93-day) daily/monthly projection includes only observed rows from the active reconciled CUR2 generation; absent days or months remain absent and are never synthesized as zero. Account, Region, service, currency, and CUR2 usage unit are privacy-approved dimensions. User and session dimensions remain unavailable.</p></section>

    <section className={styles.panel} aria-label="WorkSpaces insights"><h3>WorkSpaces insights</h3><div className={styles.grid}><article className={styles.card}><small>Available</small><strong>{dashboard.inventory.availableWorkspaces}</strong></article><article className={styles.card}><small>Stopped</small><strong>{dashboard.inventory.stoppedWorkspaces}</strong></article><article className={styles.card}><small>Connected now</small><strong>{dashboard.activity.workspaceConnections.connected}</strong></article><article className={styles.card}><small>Bundles observed</small><strong>{dashboard.inventory.bundleCount}</strong></article></div><div className={styles.breakdownGrid}><DimensionBars title="WorkSpaces by running mode" rows={dashboard.dimensionViews.workspacesByRunningMode} empty="No WorkSpaces running-mode evidence for this selection." /><DimensionBars title="WorkSpaces by Region" rows={dashboard.dimensionViews.workspacesByRegion} empty="No WorkSpaces Region evidence for this selection." /><DimensionBars title="WorkSpaces by linked account" rows={dashboard.dimensionViews.workspacesByAccount} empty="No WorkSpaces account evidence for this selection." /><DimensionBars title="WorkSpaces by bundle" rows={dashboard.dimensionViews.workspacesByBundle.map((item) => ({ value: item.bundleName === null ? item.value : `${item.bundleName} (${item.value})`, count: item.count }))} empty="No WorkSpaces bundle evidence for this selection." /></div><p className={`${styles.muted} ${styles.unknown}`}>Protocol and operating-system dimensions are unavailable in the current accepted source contract; they are not guessed from bundle names.</p></section>

    <section className={styles.panel} aria-label="WorkSpaces usage and logons"><h3>WorkSpaces usage and logons</h3><div className={styles.grid}><article className={styles.card}><small>AlwaysOn mode</small><strong>{alwaysOn}</strong></article><article className={styles.card}><small>Disconnected now</small><strong>{disconnected}</strong></article><article className={styles.card}><small>Connection unknown/missing</small><strong>{dashboard.activity.workspaceConnections.unknown + dashboard.activity.workspaceConnections.missing}</strong></article></div><p className={`${styles.muted} ${styles.unknown}`}>Last logon, low-use, and never-used user classifications are intentionally unavailable: the privacy boundary excludes user identity and last-user timestamps. No zero-use claim is inferred from a disconnected observation.</p></section>

    <section className={styles.panel} aria-label="Optional CloudWatch performance"><h3>Optional CloudWatch performance</h3><div className={styles.scroll}><table className={styles.table}><thead><tr><th>Service</th><th>Metric</th><th>Kind</th><th>Evidence state</th><th>Observations</th></tr></thead><tbody>{dashboard.telemetry.map((metric) => <tr key={`${metric.service}:${metric.metricName}`}><td>{metric.service}</td><td>{metric.metricName.replaceAll("_", " ")}</td><td>{metric.evidenceKind}</td><td><span className={styles.pill}>{metric.evidenceState}</span></td><td>{metric.observations.length}</td></tr>)}</tbody></table></div><p className={styles.muted}>Missing optional metrics remain UNKNOWN and never render as zero. CPU, memory, disk, and uptime require approved metric dimensions if not present in this contract.</p></section>

    <section className={styles.panel} aria-label="WorkSpaces Applications summary"><h3>WorkSpaces Applications summary</h3><p className={styles.muted}>AppStream 2.0 provider evidence</p><div className={styles.grid}><article className={styles.card}><small>Fleets / stacks</small><strong>{dashboard.inventory.fleetCount} / {dashboard.inventory.stackCount}</strong></article><article className={styles.card}><small>Active sessions</small><strong>{dashboard.activity.appStreamSessions.active}</strong></article><article className={styles.card}><small>Pending / expired</small><strong>{dashboard.activity.appStreamSessions.pending} / {dashboard.activity.appStreamSessions.expired}</strong></article><article className={styles.card}><small>Connected / not connected</small><strong>{dashboard.activity.appStreamSessions.connected} / {dashboard.activity.appStreamSessions.notConnected}</strong></article></div><div className={styles.breakdownGrid}><DimensionBars title="Fleets by type" rows={dashboard.dimensionViews.fleetsByType} empty="No fleet-type evidence for this selection." /><DimensionBars title="Fleets by state" rows={dashboard.dimensionViews.fleetsByState} empty="No fleet-state evidence for this selection." /><DimensionBars title="Fleets by Region" rows={dashboard.dimensionViews.fleetsByRegion} empty="No fleet Region evidence for this selection." /><DimensionBars title="Fleets by linked account" rows={dashboard.dimensionViews.fleetsByAccount} empty="No fleet account evidence for this selection." /></div></section>

    <section className={styles.panel} aria-label="Cost optimization review opportunities"><h3>Cost-optimization review candidates</h3><div className={styles.grid}><article className={styles.card}><small>AlwaysOn WorkSpaces to review</small><strong>{alwaysOn}</strong><span>configuration signal only</span></article><article className={styles.card}><small>Disconnected WorkSpaces to review</small><strong>{disconnected}</strong><span>point-in-time signal only</span></article><article className={styles.card}><small>Stopped fleets</small><strong>{dashboard.inventory.stoppedFleets}</strong><span>inventory signal only</span></article></div><p className={styles.muted}>These are review queues, not savings claims. Authoritative opportunity estimates require a separate recommendation source and workload-owner validation.</p></section>

    <section className={styles.panel} aria-label="EUC evidence history"><h3>Accepted evidence history</h3><div className={styles.scroll}><table className={styles.table}><thead><tr><th>Observed</th><th>State</th><th>WorkSpaces</th><th>Fleets</th><th>Metrics</th><th>CUR2 lines</th></tr></thead><tbody>{report.history.map((item) => <tr key={item.generationId}><td>{item.observedAtIso}</td><td>{item.sourceState}</td><td>{item.workspaceCount}</td><td>{item.fleetCount}</td><td>{item.metricCount}</td><td>{item.costLineCount}</td></tr>)}</tbody></table></div></section>
    <details className={`${styles.panel} ${styles.evidence}`}><summary>Evidence, coverage, and unsupported official views</summary><pre>{JSON.stringify({ freshness: report.freshness, evidence: report.evidence, collection: report.collection, privacy: report.privacy, coverage: dashboard.accountRegionCoverage, unsupportedOfficialViews: report.unsupportedOfficialViews, limitations: dashboard.limitations }, null, 2)}</pre></details>
  </section>;
}

export function FinopsEndUserComputingDashboard({ connectionId }: { readonly connectionId: string | null }) {
  const [service, setService] = useState<EndUserComputingService | "ALL">("ALL");
  const [accountId, setAccountId] = useState<string | "ALL">("ALL");
  const [region, setRegion] = useState<string | "ALL">("ALL");
  const [state, setState] = useState<{ report: EndUserComputingDashboardEnvelope | null; error: string | null; configuration: EndUserComputingConfigurationEnvelope | null; officialDefinition: typeof END_USER_COMPUTING_OFFICIAL_DEFINITION }>({ report: null, error: null, configuration: null, officialDefinition: END_USER_COMPUTING_OFFICIAL_DEFINITION });
  useEffect(() => {
    if (connectionId === null) return;
    const controller = new AbortController();
    const parameters = new URLSearchParams({ connectionId });
    if (service !== "ALL") parameters.append("service", service);
    if (accountId !== "ALL") parameters.append("accountId", accountId);
    if (region !== "ALL") parameters.append("region", region);
    fetch(`/api/v1/finops/end-user-computing?${parameters.toString()}`, { signal: controller.signal, headers: { Accept: "application/json" } })
      .then(async (response) => { if (!response.ok) throw new Error("End User Computing dashboard request failed"); return response.json() as Promise<EndUserComputingDashboardEnvelope | EndUserComputingConfigurationEnvelope>; })
      .then((report) => { if (!hasPinnedOfficialDefinition(report.officialDefinition)) throw new Error("Sutra returned an unrecognized End User Computing official definition"); if (report.dashboard === null) setState({ report: null, error: null, configuration: report, officialDefinition: report.officialDefinition }); else setState({ report: report as EndUserComputingDashboardEnvelope, error: null, configuration: null, officialDefinition: report.officialDefinition }); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setState((current) => ({ report: null, error: error instanceof Error ? error.message : "End User Computing dashboard request failed", configuration: null, officialDefinition: current.officialDefinition })); });
    return () => controller.abort();
  }, [accountId, connectionId, region, service]);
  if (state.report !== null && state.report.connectionId === connectionId) return <FinopsEndUserComputingReportView report={state.report} service={service} onServiceChange={setService} accountId={accountId} onAccountIdChange={setAccountId} region={region} onRegionChange={setRegion} />;
  const status = connectionId === null ? <div role="status" className={`${styles.state} ${styles.warning}`}>End User Computing collection is unavailable until an active AWS trust-role account is connected.</div> : state.configuration !== null ? <div role="status" className={`${styles.state} ${styles.warning}`}>{state.configuration.runtimeState === "collecting" ? "End User Computing evidence is collecting. The first complete capture will appear here without placeholder data." : "End User Computing collection is unavailable until the shared six-hour worker and signed provider route are activated."}</div> : state.error !== null ? <div role="alert" className={`${styles.state} ${styles.error}`}>End User Computing collection failed. {state.error}</div> : <div role="status" className={styles.state}>End User Computing evidence is collecting…</div>;
  return <section className={styles.root}>{status}<EndUserComputingOfficialDefinitionPanel definition={state.officialDefinition} /></section>;
}

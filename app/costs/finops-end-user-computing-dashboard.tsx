"use client";

import { useEffect, useState } from "react";
import type {
  EndUserComputingDashboard,
  EndUserComputingService,
  EndUserComputingWorkspace,
} from "../../lib/finops-end-user-computing";
import styles from "./finops-end-user-computing-dashboard.module.css";

type SourceState = "complete" | "partial" | "stale" | "empty" | "failed" | "configuration_required";
interface HistoryItem { readonly generationId: string; readonly sourceState: string; readonly observedAtIso: string; readonly workspaceCount: number; readonly fleetCount: number; readonly metricCount: number; readonly costLineCount: number }
export interface EndUserComputingDashboardEnvelope {
  readonly schema: "sutra.finops-end-user-computing-dashboard.v1";
  readonly connectionId: string;
  readonly sourceState: SourceState;
  readonly dashboard: EndUserComputingDashboard;
  readonly history: readonly HistoryItem[];
  readonly freshness: { readonly dataThroughAt: string | null; readonly ageHours: number | null; readonly staleAfterHours: number };
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly collection: { readonly jobContractAvailable: boolean; readonly providerAdapterAvailable: boolean; readonly reason: string };
  readonly privacy: Readonly<Record<string, boolean>>;
  readonly unsupportedOfficialViews: readonly string[];
}

function integerMoney(micros: string | null, currency: string): string {
  if (micros === null) return "Unknown";
  const negative = micros.startsWith("-");
  const digits = negative ? micros.slice(1) : micros;
  const padded = digits.padStart(7, "0");
  return `${negative ? "-" : ""}${currency} ${padded.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/gu, ",")}.${padded.slice(-6, -4)}`;
}

function isWorkspace(value: EndUserComputingDashboard["resources"][number]): value is EndUserComputingWorkspace {
  return "workspaceId" in value;
}

function stateText(state: SourceState): string | null {
  if (state === "complete") return null;
  if (state === "configuration_required") return "End User Computing evidence is not configured for this connection.";
  if (state === "partial") return "Coverage is partial. A newer incomplete capture has not replaced the accepted complete head.";
  if (state === "stale") return "The latest evidence is older than the 48-hour dashboard objective.";
  if (state === "empty") return "Collection completed but no WorkSpaces or AppStream fleets were observed in this scope.";
  return "The latest collection is unavailable. Failed evidence cannot replace an accepted complete head.";
}

export function FinopsEndUserComputingReportView({ report, service, onServiceChange }: {
  readonly report: EndUserComputingDashboardEnvelope;
  readonly service: EndUserComputingService | "ALL";
  readonly onServiceChange: (service: EndUserComputingService | "ALL") => void;
}) {
  const dashboard = report.dashboard;
  const workspaces = dashboard.resources.filter(isWorkspace);
  const alwaysOn = workspaces.filter((item) => item.runningMode === "ALWAYS_ON").length;
  const disconnected = workspaces.filter((item) => item.connection?.state === "DISCONNECTED").length;
  const status = stateText(report.sourceState);
  return <section className={styles.root} aria-label="AWS End User Computing dashboard">
    <div className={styles.notice}><strong>Privacy-safe operational evidence.</strong> User names, per-user logons, session/instance identifiers, IP addresses, and raw provider messages are neither persisted nor returned. Costs never imply usage or performance.</div>
    {status ? <div role="status" className={`${styles.state} ${report.sourceState === "failed" ? styles.error : styles.warning}`}>{status}</div> : null}
    <div className={styles.filters} aria-label="End User Computing filters"><label>Service<select value={service} onChange={(event) => onServiceChange(event.target.value as EndUserComputingService | "ALL")}><option value="ALL">All EUC services</option><option value="WORKSPACES">Amazon WorkSpaces</option><option value="APPSTREAM">AppStream 2.0</option></select></label></div>

    <section className={styles.panel} aria-label="Three month service and cost summary"><h3>Service and cost summary</h3>
      <div className={styles.grid}><article className={styles.card}><small>WorkSpaces</small><strong>{dashboard.inventory.workspaceCount}</strong><span>point-in-time resources</span></article><article className={styles.card}><small>AppStream fleets</small><strong>{dashboard.inventory.fleetCount}</strong><span>{dashboard.inventory.runningFleets} running</span></article>{dashboard.costViews.map((view) => <article className={styles.card} key={`${view.service}:${view.currency}`}><small>{view.service} · {view.currency}</small><strong>{integerMoney(view.totals.find((item) => item.basis === "net")?.totalMicros ?? view.totals.find((item) => item.basis === "amortized")?.totalMicros ?? view.totals.find((item) => item.basis === "unblended")?.totalMicros ?? null, view.currency)}</strong><span>{view.lineCount} canonical CUR2 lines · billing period {dashboard.sourceEvidence.billingPeriod ?? "unknown"}</span></article>)}</div>
      <p className={styles.muted}>A true rolling three-month daily/monthly series and cost-ranked accounts are withheld until the server materializes that history from accepted CUR2 generations. Snapshot evidence history appears below.</p></section>

    <section className={styles.panel} aria-label="WorkSpaces insights"><h3>WorkSpaces insights</h3><div className={styles.grid}><article className={styles.card}><small>Available</small><strong>{dashboard.inventory.availableWorkspaces}</strong></article><article className={styles.card}><small>Stopped</small><strong>{dashboard.inventory.stoppedWorkspaces}</strong></article><article className={styles.card}><small>Connected now</small><strong>{dashboard.activity.workspaceConnections.connected}</strong></article><article className={styles.card}><small>Bundles observed</small><strong>{dashboard.inventory.bundleCount}</strong></article></div><p className={`${styles.muted} ${styles.unknown}`}>Protocol and operating-system dimensions are unavailable in the current accepted source contract; they are not guessed from bundle names.</p></section>

    <section className={styles.panel} aria-label="WorkSpaces usage and logons"><h3>WorkSpaces usage and logons</h3><div className={styles.grid}><article className={styles.card}><small>AlwaysOn mode</small><strong>{alwaysOn}</strong></article><article className={styles.card}><small>Disconnected now</small><strong>{disconnected}</strong></article><article className={styles.card}><small>Connection unknown/missing</small><strong>{dashboard.activity.workspaceConnections.unknown + dashboard.activity.workspaceConnections.missing}</strong></article></div><p className={`${styles.muted} ${styles.unknown}`}>Last logon, low-use, and never-used user classifications are intentionally unavailable: the privacy boundary excludes user identity and last-user timestamps. No zero-use claim is inferred from a disconnected observation.</p></section>

    <section className={styles.panel} aria-label="Optional CloudWatch performance"><h3>Optional CloudWatch performance</h3><div className={styles.scroll}><table className={styles.table}><thead><tr><th>Service</th><th>Metric</th><th>Kind</th><th>Evidence state</th><th>Observations</th></tr></thead><tbody>{dashboard.telemetry.map((metric) => <tr key={`${metric.service}:${metric.metricName}`}><td>{metric.service}</td><td>{metric.metricName.replaceAll("_", " ")}</td><td>{metric.evidenceKind}</td><td><span className={styles.pill}>{metric.evidenceState}</span></td><td>{metric.observations.length}</td></tr>)}</tbody></table></div><p className={styles.muted}>Missing optional metrics remain UNKNOWN and never render as zero. CPU, memory, disk, and uptime require approved metric dimensions if not present in this contract.</p></section>

    <section className={styles.panel} aria-label="AppStream 2.0 overview"><h3>AppStream 2.0 overview</h3><div className={styles.grid}><article className={styles.card}><small>Fleets / stacks</small><strong>{dashboard.inventory.fleetCount} / {dashboard.inventory.stackCount}</strong></article><article className={styles.card}><small>Active sessions</small><strong>{dashboard.activity.appStreamSessions.active}</strong></article><article className={styles.card}><small>Pending / expired</small><strong>{dashboard.activity.appStreamSessions.pending} / {dashboard.activity.appStreamSessions.expired}</strong></article><article className={styles.card}><small>Connected / not connected</small><strong>{dashboard.activity.appStreamSessions.connected} / {dashboard.activity.appStreamSessions.notConnected}</strong></article></div></section>

    <section className={styles.panel} aria-label="Cost optimization review opportunities"><h3>Cost-optimization review candidates</h3><div className={styles.grid}><article className={styles.card}><small>AlwaysOn WorkSpaces to review</small><strong>{alwaysOn}</strong><span>configuration signal only</span></article><article className={styles.card}><small>Disconnected WorkSpaces to review</small><strong>{disconnected}</strong><span>point-in-time signal only</span></article><article className={styles.card}><small>Stopped fleets</small><strong>{dashboard.inventory.stoppedFleets}</strong><span>inventory signal only</span></article></div><p className={styles.muted}>These are review queues, not savings claims. Authoritative opportunity estimates require a separate recommendation source and workload-owner validation.</p></section>

    <section className={styles.panel} aria-label="EUC evidence history"><h3>Accepted evidence history</h3><div className={styles.scroll}><table className={styles.table}><thead><tr><th>Observed</th><th>State</th><th>WorkSpaces</th><th>Fleets</th><th>Metrics</th><th>CUR2 lines</th></tr></thead><tbody>{report.history.map((item) => <tr key={item.generationId}><td>{item.observedAtIso}</td><td>{item.sourceState}</td><td>{item.workspaceCount}</td><td>{item.fleetCount}</td><td>{item.metricCount}</td><td>{item.costLineCount}</td></tr>)}</tbody></table></div></section>
    <details className={`${styles.panel} ${styles.evidence}`}><summary>Evidence, coverage, and unsupported official views</summary><pre>{JSON.stringify({ freshness: report.freshness, evidence: report.evidence, collection: report.collection, privacy: report.privacy, coverage: dashboard.accountRegionCoverage, unsupportedOfficialViews: report.unsupportedOfficialViews, limitations: dashboard.limitations }, null, 2)}</pre></details>
  </section>;
}

export function FinopsEndUserComputingDashboard({ connectionId }: { readonly connectionId: string | null }) {
  const [service, setService] = useState<EndUserComputingService | "ALL">("ALL");
  const [state, setState] = useState<{ report: EndUserComputingDashboardEnvelope | null; error: string | null; configurationRequired: boolean }>({ report: null, error: null, configurationRequired: false });
  useEffect(() => {
    if (connectionId === null) return;
    const controller = new AbortController();
    const parameters = new URLSearchParams({ connectionId });
    if (service !== "ALL") parameters.append("service", service);
    fetch(`/api/v1/finops/end-user-computing?${parameters.toString()}`, { signal: controller.signal, headers: { Accept: "application/json" } })
      .then(async (response) => { if (!response.ok) throw new Error("End User Computing dashboard request failed"); return response.json() as Promise<EndUserComputingDashboardEnvelope | { readonly dashboard: null }>; })
      .then((report) => { if (report.dashboard === null) setState({ report: null, error: null, configurationRequired: true }); else setState({ report: report as EndUserComputingDashboardEnvelope, error: null, configurationRequired: false }); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setState({ report: null, error: error instanceof Error ? error.message : "End User Computing dashboard request failed", configurationRequired: false }); });
    return () => controller.abort();
  }, [connectionId, service]);
  if (connectionId === null) return <div role="status" className={`${styles.state} ${styles.warning}`}>Connect an active AWS trust-role account to collect End User Computing evidence.</div>;
  if (state.configurationRequired) return <div role="status" className={`${styles.state} ${styles.warning}`}>Deploy and schedule the signed EUC broker adapter before provider evidence can render.</div>;
  if (state.error !== null) return <div role="alert" className={`${styles.state} ${styles.error}`}>{state.error}</div>;
  if (state.report === null || state.report.connectionId !== connectionId) return <div role="status" className={styles.state}>Loading End User Computing evidence…</div>;
  return <FinopsEndUserComputingReportView report={state.report} service={service} onServiceChange={setService} />;
}

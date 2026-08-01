"use client";

import { useEffect, useMemo, useState } from "react";
import type { ResilienceAssessment, ResilienceComponentCompliance, ResilienceDrift,
  ResilienceRecommendation, ResilienceResource, ResilienceVueInferredPriority } from "../../lib/finops-resilience-vue";
import styles from "./finops-resilience-vue-dashboard.module.css";

type Filters = { accountId: string | null; region: string | null; application: string | null;
  compliance: string | null; recommendationKind: string | null };
type Application = { appArn: string; name: string; policyName: string | null; latestAssessmentArn: string | null;
  latestAssessmentStatus: string | null; complianceStatus: string | null; driftStatus: string | null;
  resiliencyScore: number | null; rpoInSecs: number | null; rtoInSecs: number | null; observedAssessmentCount: number };
type Target = { accountId: string; partition: string; region: string; generationId: string; contentSha256: string;
  captureId: string; completedAtIso: string; state: string; applications: readonly Application[];
  assessmentHistory: readonly ResilienceAssessment[]; componentPosture: readonly ResilienceComponentCompliance[];
  recommendations: readonly ResilienceRecommendation[]; resources: readonly ResilienceResource[];
  drifts: readonly ResilienceDrift[]; inferredPrioritization: readonly ResilienceVueInferredPriority[]; limitations: readonly string[] };
export interface ResilienceVueReport {
  readonly connectionId: string; readonly sourceState: "complete" | "partial" | "stale" | "empty" | "failed" | "configuration_required";
  readonly freshness: { readonly dataThroughAt: string | null; readonly ageHours: number | null; readonly staleAfterHours: number };
  readonly summary: { readonly targetCount: number; readonly applicationCount: number; readonly policyBreachedApplicationCount: number; readonly driftedApplicationCount: number; readonly openRecommendationCount: number };
  readonly targets: readonly Target[]; readonly history: readonly { generationId: string; accountId: string; region: string; completedAtIso: string; state: string; complete: boolean; applicationCount: number; assessmentCount: number; recommendationCount: number; contentSha256: string }[];
  readonly filterOptions: { readonly accounts: readonly string[]; readonly regions: readonly string[] };
  readonly evidence: unknown; readonly collection: { readonly available: false; readonly reason: string }; readonly limitations: readonly string[];
}
const EMPTY: Filters = { accountId: null, region: null, application: null, compliance: null, recommendationKind: null };
function duration(seconds: number | null): string {
  if (seconds === null) return "Not supplied"; if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`; if (seconds < 86_400) return `${Math.round(seconds / 3_600 * 10) / 10}h`;
  return `${Math.round(seconds / 86_400 * 10) / 10}d`;
}
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
function downloadRecommendations(targets: readonly Target[]): void {
  const rows = targets.flatMap((target) => target.recommendations.map((item) => [target.accountId, target.region,
    item.kind, item.status, item.appComponentName, item.name, item.risk ?? "", item.resourceId ?? ""]));
  const body = [["account", "region", "kind", "status", "component", "recommendation", "risk", "resource"], ...rows]
    .map((row) => row.map(csvCell).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = "sutra-resiliencevue-recommendations.csv"; anchor.click(); URL.revokeObjectURL(url);
}
function Select({ label, value, options, onChange }: { readonly label: string; readonly value: string | null;
  readonly options: readonly string[]; readonly onChange: (value: string | null) => void }) {
  return <label>{label}<select value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}>
    <option value="">All</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}
  </select></label>;
}
function stateMessage(state: ResilienceVueReport["sourceState"]): string | null {
  if (state === "complete") return null;
  if (state === "partial") return "A newer collection is incomplete; accepted complete heads remain active and the coverage gap is disclosed.";
  if (state === "stale") return "One or more accepted target heads are older than the seven-day evidence objective.";
  if (state === "empty") return "No applications match this evidence set and filter selection; this is not evidence of resilience.";
  if (state === "configuration_required") return "Configure AWS Resilience Hub applications and authorize the read-only collector.";
  return "The latest collection failed; failed evidence never replaces an accepted complete head.";
}

export function ResilienceVueReportView({ report, filters, onFiltersChange }: { readonly report: ResilienceVueReport;
  readonly filters: Filters; readonly onFiltersChange: (filters: Filters) => void }) {
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => onFiltersChange({ ...filters, [key]: value });
  const message = stateMessage(report.sourceState);
  const applications = report.targets.flatMap((target) => target.applications.map((app) => ({ ...app, accountId: target.accountId, region: target.region, target })));
  const recommendations = report.targets.flatMap((target) => target.recommendations.map((item) => ({ item, target,
    inferred: target.inferredPrioritization.find((value) => value.assessmentArn === item.assessmentArn && value.recommendationId === item.recommendationId) ?? null })));
  const maximum = Math.max(1, ...report.history.map((point) => point.recommendationCount));
  return <section className={styles.root} aria-label="ResilienceVue AWS Resilience Hub dashboard">
    <div className={styles.notice}><strong>Observed AWS Resilience Hub evidence.</strong> RTO/RPO, posture, breaches, drift, and operational recommendations come from retained assessments. Any Sutra priority is labeled inference, not an AWS finding.</div>
    {message ? <div role="status" className={`${styles.state} ${report.sourceState === "failed" ? styles.error : styles.warning}`}>{message}</div> : null}
    <div className={styles.filters} aria-label="ResilienceVue filters">
      <Select label="Account / payer scope" value={filters.accountId} options={report.filterOptions.accounts} onChange={(value) => set("accountId", value)} />
      <Select label="Region" value={filters.region} options={report.filterOptions.regions} onChange={(value) => set("region", value)} />
      <label>Application search<input value={filters.application ?? ""} maxLength={80} placeholder="Application name" onChange={(event) => set("application", event.target.value || null)} /></label>
      <Select label="Policy posture" value={filters.compliance} options={["PolicyBreached", "PolicyMet", "NotApplicable", "MissingPolicy"]} onChange={(value) => set("compliance", value)} />
      <Select label="Recommendation type" value={filters.recommendationKind} options={["CONFIG", "ALARM", "SOP", "TEST"]} onChange={(value) => set("recommendationKind", value)} />
    </div>
    <div className={styles.cards} aria-label="Resilience posture summary">
      <article><small>Applications</small><strong>{report.summary.applicationCount}</strong><span>{report.summary.targetCount} account/Region targets</span></article>
      <article><small>Policy breaches</small><strong>{report.summary.policyBreachedApplicationCount}</strong><span>Latest retained assessment posture</span></article>
      <article><small>Drift detected</small><strong>{report.summary.driftedApplicationCount}</strong><span>Application assessment drift</span></article>
      <article><small>Operational backlog</small><strong>{report.summary.openRecommendationCount}</strong><span>Unimplemented, non-excluded recommendations</span></article>
    </div>
    <section className={styles.section} aria-label="Assessment and recommendation trends"><header><h3>Daily assessment evidence trend</h3><span>Incremental retained generations</span></header>
      <div className={styles.trend}>{report.history.slice(0, 36).reverse().map((point) => <div className={styles.trendRow} key={point.generationId}>
        <time dateTime={point.completedAtIso}>{point.completedAtIso.slice(0, 10)}</time><span>{point.accountId} · {point.region}</span>
        <div className={styles.track} title={`${point.recommendationCount} recommendations`}><i style={{ width: `${Math.max(2, point.recommendationCount / maximum * 100)}%` }} /></div>
        <b>{point.assessmentCount} assessments / {point.recommendationCount} open</b>
      </div>)}</div>
    </section>
    <section className={styles.section} aria-label="Application resilience posture"><header><h3>Application posture · {applications.length}</h3></header><div className={styles.scroll}><table><thead><tr><th>Account / Region</th><th>Application / policy</th><th>Posture</th><th>Resiliency score</th><th>RPO target</th><th>RTO target</th><th>Assessment evidence</th></tr></thead><tbody>
      {applications.map((app) => <tr key={`${app.accountId}:${app.region}:${app.appArn}`}><td>{app.accountId}<br />{app.region}</td><td><strong>{app.name}</strong><br />{app.policyName ?? "No policy observed"}</td><td><span className={`${styles.pill} ${app.complianceStatus === "PolicyBreached" ? styles.breach : ""}`}>{app.complianceStatus ?? "Unknown"}</span><br />Drift: {app.driftStatus ?? "Unknown"}</td><td>{app.resiliencyScore ?? "Not supplied"}</td><td>{duration(app.rpoInSecs)}</td><td>{duration(app.rtoInSecs)}</td><td><details><summary>Drill down</summary><dl><div><dt>Latest status</dt><dd>{app.latestAssessmentStatus ?? "No assessment"}</dd></div><div><dt>Observed assessments</dt><dd>{app.observedAssessmentCount}</dd></div><div><dt>Application ARN</dt><dd>{app.appArn}</dd></div><div><dt>Accepted generation</dt><dd>{app.target.generationId}</dd></div></dl></details></td></tr>)}
    </tbody></table></div></section>
    <section className={styles.section} aria-label="Unimplemented operational recommendations"><header><h3>Unimplemented operational recommendations · {recommendations.length}</h3><button type="button" onClick={() => downloadRecommendations(report.targets)}>Export visible rows</button></header><div className={styles.scroll}><table><thead><tr><th>Target</th><th>Type / component</th><th>Recommendation</th><th>Expected RPO / RTO</th><th>Provider risk</th><th>Prioritization and provenance</th></tr></thead><tbody>
      {recommendations.map(({ item, target, inferred }) => <tr key={`${target.generationId}:${item.assessmentArn}:${item.recommendationId}`}><td>{target.accountId}<br />{target.region}</td><td><span className={styles.pill}>{item.kind}</span><br />{item.appComponentName}</td><td><strong>{item.name}</strong><br />{item.description}</td><td>{duration(item.expectedRpoInSecs)} / {duration(item.expectedRtoInSecs)}</td><td>{item.risk ?? "Not supplied"}</td><td><details><summary>Evidence</summary><dl><div><dt>Status</dt><dd>{item.status}</dd></div><div><dt>Resource</dt><dd>{item.resourceId ?? "Not linked"}</dd></div><div><dt>Sutra inferred priority</dt><dd>{inferred === null ? "Not scored" : `${inferred.priorityScore}/100 · ${inferred.label}`}</dd></div><div><dt>Reasons</dt><dd>{inferred?.reasons.join("; ") ?? "None"}</dd></div><div><dt>Assessment ARN</dt><dd>{item.assessmentArn}</dd></div></dl></details></td></tr>)}
    </tbody></table></div></section>
    <details className={`${styles.section} ${styles.evidence}`}><summary>Coverage, freshness, provenance, and limitations</summary><pre>{JSON.stringify({ freshness: report.freshness, evidence: report.evidence, collection: report.collection, limitations: report.limitations, targets: report.targets.map((target) => ({ accountId: target.accountId, region: target.region, state: target.state, captureId: target.captureId, generationId: target.generationId, contentSha256: target.contentSha256, limitations: target.limitations })) }, null, 2)}</pre></details>
  </section>;
}

export function FinopsResilienceVueDashboard({ connectionId }: { readonly connectionId: string | null }) {
  const [filters, setFilters] = useState<Filters>(EMPTY); const [report, setReport] = useState<ResilienceVueReport | null>(null);
  const [error, setError] = useState<string | null>(null); const query = useMemo(() => {
    const parameters = new URLSearchParams(); if (connectionId !== null) parameters.set("connectionId", connectionId);
    for (const [key, value] of Object.entries(filters)) if (value !== null) parameters.set(key, value); return parameters.toString();
  }, [connectionId, filters]);
  useEffect(() => {
    if (connectionId === null) return; const controller = new AbortController();
    fetch(`/api/v1/finops/resilience-vue?${query}`, { signal: controller.signal, headers: { Accept: "application/json" } })
      .then(async (response) => { if (!response.ok) throw new Error("ResilienceVue request failed"); return response.json(); })
      .then((value: ResilienceVueReport | { dashboard: null }) => { if ("dashboard" in value) { setReport(null); setError("AWS Resilience Hub evidence is not configured for this selection."); } else { setReport(value); setError(null); } })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "ResilienceVue request failed"); });
    return () => controller.abort();
  }, [connectionId, query]);
  if (connectionId === null) return <div role="status" className={`${styles.state} ${styles.warning}`}>Connect an active AWS trust-role account before configuring ResilienceVue.</div>;
  if (error !== null) return <div role="alert" className={`${styles.state} ${styles.warning}`}>{error}</div>;
  if (report === null || report.connectionId !== connectionId) return <div role="status" className={styles.state}>Loading AWS Resilience Hub evidence…</div>;
  return <ResilienceVueReportView report={report} filters={filters} onFiltersChange={setFilters} />;
}

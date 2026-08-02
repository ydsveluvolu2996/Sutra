"use client";

import { useEffect, useMemo, useState } from "react";
import {
  RESILIENCE_VUE_OFFICIAL_DEFINITION,
  type ResilienceVueOfficialDefinition,
} from "../../lib/finops-resilience-vue-official-definition";
import type { ResilienceAssessment, ResilienceComponentCompliance, ResilienceDrift,
  ResilienceObjectivePosture, ResiliencePolicyObjective, ResilienceRecommendation,
  ResilienceResource, ResilienceVueInferredPriority } from "../../lib/finops-resilience-vue";
import styles from "./finops-resilience-vue-dashboard.module.css";

type Filters = { accountId: string | null; region: string | null; application: string | null;
  compliance: string | null; recommendationKind: string | null; assessmentFrom: string | null; assessmentTo: string | null };
type Application = { appArn: string; name: string; policyName: string | null; latestAssessmentArn: string | null;
  policyTier: string | null; latestAssessmentStatus: string | null; complianceStatus: string | null; driftStatus: string | null;
  resiliencyScore: number | null; rpoInSecs: number | null; rtoInSecs: number | null; lastAssessmentTime: string | null;
  observedAssessmentCount: number; policyObjectives: readonly ResiliencePolicyObjective[];
  latestObjectivePosture: readonly ResilienceObjectivePosture[] };
type Target = { accountId: string; partition: string; region: string; generationId: string; contentSha256: string;
  captureId: string; completedAtIso: string; state: string; applications: readonly Application[];
  assessmentHistory: readonly ResilienceAssessment[]; componentPosture: readonly ResilienceComponentCompliance[];
  recommendationEvidence: readonly ResilienceRecommendation[]; recommendations: readonly ResilienceRecommendation[]; resources: readonly ResilienceResource[];
  drifts: readonly ResilienceDrift[]; inferredPrioritization: readonly ResilienceVueInferredPriority[]; limitations: readonly string[] };
export interface ResilienceVueReport {
  readonly connectionId: string; readonly sourceState: "complete" | "partial" | "stale" | "empty" | "failed" | "configuration_required";
  readonly officialDefinition: ResilienceVueOfficialDefinition;
  readonly freshness: { readonly dataThroughAt: string | null; readonly ageHours: number | null; readonly staleAfterHours: number };
  readonly summary: { readonly targetCount: number; readonly applicationCount: number; readonly assessedApplicationCount: number;
    readonly unassessedApplicationCount: number; readonly policyMetApplicationCount: number;
    readonly policyBreachedApplicationCount: number; readonly driftedApplicationCount: number; readonly openRecommendationCount: number };
  readonly targets: readonly Target[]; readonly history: readonly { generationId: string; accountId: string; region: string; completedAtIso: string; state: string; complete: boolean; applicationCount: number; assessmentCount: number; recommendationCount: number; contentSha256: string }[];
  readonly filterOptions: { readonly accounts: readonly string[]; readonly regions: readonly string[] };
  readonly evidence: unknown; readonly collection: { readonly state: "unavailable" | "collecting" | "failed" | "ready";
    readonly reason: string; readonly lastAttemptAt: string | null }; readonly limitations: readonly string[];
}
const EMPTY: Filters = { accountId: null, region: null, application: null, compliance: null, recommendationKind: null,
  assessmentFrom: null, assessmentTo: null };
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
function objectiveFor(objectives: readonly ResiliencePolicyObjective[], disruptionType: string): ResiliencePolicyObjective | null {
  return objectives.find((item) => item.disruptionType === disruptionType) ?? null;
}
function postureFor(postures: readonly ResilienceObjectivePosture[], disruptionType: string): ResilienceObjectivePosture | null {
  return postures.find((item) => item.disruptionType === disruptionType) ?? null;
}
function RecommendationStatus({ title, kind, recommendations }: { readonly title: string; readonly kind: string;
  readonly recommendations: readonly ResilienceRecommendation[] }) {
  const rows = recommendations.filter((item) => item.kind === kind);
  const statuses = ["NotImplemented", "Implemented", "Inactive", "Excluded"] as const;
  return <article className={styles.statusPanel}><h4>{title}</h4><div>{statuses.map((status) => <span key={status}>
    <b>{rows.filter((item) => item.status === status).length}</b>{status}
  </span>)}</div></article>;
}

function officialCoverageLabel(value: string): string {
  if (value === "NATIVE_EVIDENCE_PARTIAL") return "Native evidence · partial parity";
  if (value === "VERSIONED_SCHEMA_REQUIRED") return "Versioned schema required";
  return "Definition and provenance";
}

function OfficialDefinitionPanel({
  definition,
}: {
  readonly definition: ResilienceVueOfficialDefinition;
}) {
  const [selectedId, setSelectedId] = useState(definition.sheets[0]?.id ?? "");
  const selected = definition.sheets.find((sheet) => sheet.id === selectedId)
    ?? definition.sheets[0];
  return <section className={styles.official} aria-label="Official ResilienceVue definition coverage">
    <header><div><small>AWS CID {definition.version} · immutable definition</small>
      <h3>{definition.totals.sheets} sheets · {definition.totals.visuals} upstream visuals mapped</h3>
      <p>Commit <code>{definition.sourceCommit.slice(0, 12)}…</code> · definition SHA-256 <code>{definition.definitionSha256.slice(0, 12)}…</code>. Counts describe the pinned QuickSight source; Sutra does not claim pixel or layout parity.</p></div>
      <dl><div><dt>Controls</dt><dd>{definition.totals.parameterControls + definition.totals.filterControls}</dd></div>
        <div><dt>Parameters</dt><dd>{definition.totals.parameterDeclarations}</dd></div>
        <div><dt>Calculated fields</dt><dd>{definition.totals.calculatedFields}</dd></div>
        <div><dt>Filter groups</dt><dd>{definition.totals.filterGroups}</dd></div>
        <div><dt>Datasets</dt><dd>{definition.totals.datasets}</dd></div></dl></header>
    <nav aria-label="Official ResilienceVue sheets">{definition.sheets.map((sheet) => <button key={sheet.id} aria-current={selected?.id === sheet.id ? "page" : undefined} data-coverage={sheet.coverage} onClick={() => setSelectedId(sheet.id)} type="button"><strong>{sheet.name}</strong><small>{sheet.visualCount} visuals · {officialCoverageLabel(sheet.coverage)}</small></button>)}</nav>
    {selected === undefined ? null : <article data-coverage={selected.coverage}><div><small>Selected official sheet</small><h4>{selected.name}</h4><p>{selected.evidenceNote}</p><p className={styles.officialGap}><strong>Remaining:</strong> {selected.remainingGap}</p></div>
      <dl><div><dt>Visual types</dt><dd>{Object.entries(selected.visualTypes).map(([type, count]) => `${count} ${type.replace("Visual", "")}`).join(" · ") || "None"}</dd></div>
        <div><dt>Native areas</dt><dd>{selected.nativeAreas.join(" · ")}</dd></div>
        <div><dt>Official controls</dt><dd>{selected.controls.length === 0 ? "None" : selected.controls.map((control) => <span key={`${control.placement}:${control.type}:${control.title}`} data-state={control.nativeState}>{control.title} · {control.placement} · {control.nativeState.toLocaleLowerCase()}</span>)}</dd></div></dl></article>}
  </section>;
}

function hasPinnedOfficialDefinition(definition: ResilienceVueOfficialDefinition): boolean {
  return definition.sourceCommit === RESILIENCE_VUE_OFFICIAL_DEFINITION.sourceCommit
    && definition.manifestSha256 === RESILIENCE_VUE_OFFICIAL_DEFINITION.manifestSha256
    && definition.definitionSha256 === RESILIENCE_VUE_OFFICIAL_DEFINITION.definitionSha256
    && definition.totals.sheets === 4
    && definition.totals.visuals === 47;
}

export function ResilienceVueReportView({ report, filters, onFiltersChange }: { readonly report: ResilienceVueReport;
  readonly filters: Filters; readonly onFiltersChange: (filters: Filters) => void }) {
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => onFiltersChange({ ...filters, [key]: value });
  const message = stateMessage(report.sourceState);
  const applications = report.targets.flatMap((target) => target.applications.map((app) => ({ ...app, accountId: target.accountId, region: target.region, target })));
  const recommendations = report.targets.flatMap((target) => target.recommendations.map((item) => ({ item, target,
    inferred: target.inferredPrioritization.find((value) => value.assessmentArn === item.assessmentArn && value.recommendationId === item.recommendationId) ?? null })));
  const recommendationEvidence = report.targets.flatMap((target) => target.recommendationEvidence);
  const assessmentRows = report.targets.flatMap((target) => target.assessmentHistory.map((assessment) => ({ assessment, target,
    application: target.applications.find((app) => app.appArn === assessment.appArn) ?? null })))
    .sort((left, right) => right.assessment.startTime.localeCompare(left.assessment.startTime));
  const maximum = Math.max(1, ...report.history.map((point) => point.recommendationCount));
  return <section className={styles.root} aria-label="ResilienceVue AWS Resilience Hub dashboard">
    <OfficialDefinitionPanel definition={report.officialDefinition} />
    <div className={styles.notice}><strong>Observed AWS Resilience Hub evidence.</strong> RTO/RPO, posture, breaches, drift, and operational recommendations come from retained assessments. Any Sutra priority is labeled inference, not an AWS finding.</div>
    {report.collection.state === "ready" ? null : <div role="status" className={`${styles.state} ${report.collection.state === "failed" ? styles.error : styles.warning}`}>
      Collection {report.collection.state}: {report.collection.reason}{report.collection.lastAttemptAt === null ? "" : ` · ${report.collection.lastAttemptAt}`}
    </div>}
    {message ? <div role="status" className={`${styles.state} ${report.sourceState === "failed" ? styles.error : styles.warning}`}>{message}</div> : null}
    <div className={styles.filters} aria-label="ResilienceVue filters">
      <Select label="Account / payer scope" value={filters.accountId} options={report.filterOptions.accounts} onChange={(value) => set("accountId", value)} />
      <Select label="Region" value={filters.region} options={report.filterOptions.regions} onChange={(value) => set("region", value)} />
      <label>Application search<input value={filters.application ?? ""} maxLength={80} placeholder="Application name" onChange={(event) => set("application", event.target.value || null)} /></label>
      <Select label="Policy posture" value={filters.compliance} options={["PolicyBreached", "PolicyMet", "NotApplicable", "MissingPolicy"]} onChange={(value) => set("compliance", value)} />
      <Select label="Recommendation type" value={filters.recommendationKind} options={["CONFIG", "ALARM", "SOP", "TEST"]} onChange={(value) => set("recommendationKind", value)} />
      <label>Last assessment from<input type="date" value={filters.assessmentFrom ?? ""} onChange={(event) => set("assessmentFrom", event.target.value || null)} /></label>
      <label>Last assessment to<input type="date" value={filters.assessmentTo ?? ""} onChange={(event) => set("assessmentTo", event.target.value || null)} /></label>
    </div>
    <div className={styles.cards} aria-label="Resilience posture summary">
      <article><small>Applications</small><strong>{report.summary.applicationCount}</strong><span>{report.summary.targetCount} account/Region targets</span></article>
      <article><small>Applications assessed</small><strong>{report.summary.assessedApplicationCount}</strong><span>{report.summary.unassessedApplicationCount} not assessed</span></article>
      <article><small>Applications in policy</small><strong>{report.summary.policyMetApplicationCount}</strong><span>AWS latest assessment status</span></article>
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
    <section className={styles.section} aria-label="Latest assessment score trend"><header><h3>Summary of 10 latest assessments</h3><span>Provider assessment evidence · Resiliency score trend</span></header>
      <div className={styles.trend}>{assessmentRows.slice(0, 10).map(({ assessment, target, application }) => <div className={styles.trendRow} key={`${target.generationId}:${assessment.assessmentArn}`}>
        <time dateTime={assessment.startTime}>{assessment.startTime.slice(0, 10)}</time><span>{application?.name ?? "Application not in current filter"} · {target.region}</span>
        <div className={styles.track} title={assessment.resiliencyScore === null ? "Score not supplied" : `Resiliency score ${assessment.resiliencyScore}`}><i style={{ width: `${assessment.resiliencyScore ?? 0}%` }} /></div>
        <b>{assessment.resiliencyScore ?? "No score"} · {assessment.assessmentStatus} · {assessment.complianceStatus ?? "Unknown"}</b>
      </div>)}</div>
    </section>
    <section className={styles.section} aria-label="Application resilience posture"><header><h3>Application posture · {applications.length}</h3></header><div className={styles.scroll}><table><thead><tr><th>Account / Region</th><th>Application / policy</th><th>Posture</th><th>Resiliency score</th><th>RPO target</th><th>RTO target</th><th>Assessment evidence</th></tr></thead><tbody>
      {applications.map((app) => <tr key={`${app.accountId}:${app.region}:${app.appArn}`}><td>{app.accountId}<br />{app.region}</td><td><strong>{app.name}</strong><br />{app.policyName ?? "No policy observed"}<br />Tier: {app.policyTier ?? "Not supplied"}</td><td><span className={`${styles.pill} ${app.complianceStatus === "PolicyBreached" ? styles.breach : ""}`}>{app.complianceStatus ?? "Unknown"}</span><br />Drift: {app.driftStatus ?? "Unknown"}</td><td>{app.resiliencyScore ?? "Not supplied"}</td><td>{duration(app.rpoInSecs)}</td><td>{duration(app.rtoInSecs)}</td><td><details><summary>RPO/RTO dimensions</summary><div className={styles.objectives}>{["AZ", "Software", "Hardware", "Region"].map((dimension) => {
        const target = objectiveFor(app.policyObjectives, dimension); const current = postureFor(app.latestObjectivePosture, dimension);
        return <div key={dimension}><b>{dimension === "Software" ? "Application" : dimension === "Hardware" ? "Infrastructure" : dimension}</b><span>{current?.complianceStatus ?? "Not observed"}</span><small>Current RPO / RTO: {duration(current?.currentRpoInSecs ?? null)} / {duration(current?.currentRtoInSecs ?? null)}</small><small>Achievable RPO / RTO: {duration(current?.achievableRpoInSecs ?? null)} / {duration(current?.achievableRtoInSecs ?? null)}</small><small>Target RPO / RTO: {duration(target?.rpoInSecs ?? null)} / {duration(target?.rtoInSecs ?? null)}</small></div>;
      })}</div><dl><div><dt>Latest status</dt><dd>{app.latestAssessmentStatus ?? "No assessment"}</dd></div><div><dt>Last assessed</dt><dd>{app.lastAssessmentTime ?? "No assessment"}</dd></div><div><dt>Observed assessments</dt><dd>{app.observedAssessmentCount}</dd></div><div><dt>Application ARN</dt><dd>{app.appArn}</dd></div><div><dt>Accepted generation</dt><dd>{app.target.generationId}</dd></div></dl></details></td></tr>)}
    </tbody></table></div></section>
    <section className={styles.section} aria-label="Operational recommendation status"><header><h3>Outstanding operational recommendations</h3><span>All retained statuses, not only backlog rows</span></header><div className={styles.statusGrid}>
      <RecommendationStatus title="Suggested Standard Operating Procedures (SOP) · SOP Recommendations by status" kind="SOP" recommendations={recommendationEvidence} />
      <RecommendationStatus title="Suggested Alarm Recommendations · Alarm Recommendations by status" kind="ALARM" recommendations={recommendationEvidence} />
      <RecommendationStatus title="Suggested Fault Injection Experiments · Experiment Recommendations by status" kind="TEST" recommendations={recommendationEvidence} />
    </div></section>
    <section className={styles.section} aria-label="Unimplemented operational recommendations"><header><h3>Unimplemented operational recommendations · {recommendations.length}</h3><button type="button" onClick={() => downloadRecommendations(report.targets)}>Export visible rows</button></header><div className={styles.scroll}><table><thead><tr><th>Target</th><th>Type / component</th><th>Recommendation</th><th>Expected RPO / RTO</th><th>Provider risk</th><th>Prioritization and provenance</th></tr></thead><tbody>
      {recommendations.map(({ item, target, inferred }) => <tr key={`${target.generationId}:${item.assessmentArn}:${item.recommendationId}`}><td>{target.accountId}<br />{target.region}</td><td><span className={styles.pill}>{item.kind}</span><br />{item.appComponentName}</td><td><strong>{item.name}</strong><br />{item.description}</td><td>{duration(item.expectedRpoInSecs)} / {duration(item.expectedRtoInSecs)}</td><td>{item.risk ?? "Not supplied"}</td><td><details><summary>Evidence</summary><dl><div><dt>Status</dt><dd>{item.status}</dd></div><div><dt>Resource</dt><dd>{item.resourceId ?? "Not linked"}</dd></div><div><dt>Sutra inferred priority</dt><dd>{inferred === null ? "Not scored" : `${inferred.priorityScore}/100 · ${inferred.label}`}</dd></div><div><dt>Reasons</dt><dd>{inferred?.reasons.join("; ") ?? "None"}</dd></div><div><dt>Assessment ARN</dt><dd>{item.assessmentArn}</dd></div></dl></details></td></tr>)}
    </tbody></table></div><div className={styles.schemaGap}><strong>Official recommendation dimensions not present in immutable v1 evidence:</strong> estimated cost, optimization type, and availability architecture remain unavailable until a versioned provider-schema migration is implemented and live-validated.</div></section>
    <details className={`${styles.section} ${styles.evidence}`}><summary>Coverage, freshness, provenance, and limitations</summary><pre>{JSON.stringify({ freshness: report.freshness, evidence: report.evidence, collection: report.collection, limitations: report.limitations, targets: report.targets.map((target) => ({ accountId: target.accountId, region: target.region, state: target.state, captureId: target.captureId, generationId: target.generationId, contentSha256: target.contentSha256, limitations: target.limitations })) }, null, 2)}</pre></details>
  </section>;
}

export function FinopsResilienceVueDashboard({ connectionId }: { readonly connectionId: string | null }) {
  const [filters, setFilters] = useState<Filters>(EMPTY); const [report, setReport] = useState<ResilienceVueReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configurationDefinition, setConfigurationDefinition] = useState<ResilienceVueOfficialDefinition | null>(null);
  const query = useMemo(() => {
    const parameters = new URLSearchParams(); if (connectionId !== null) parameters.set("connectionId", connectionId);
    for (const [key, value] of Object.entries(filters)) if (value !== null) parameters.set(key, value); return parameters.toString();
  }, [connectionId, filters]);
  useEffect(() => {
    if (connectionId === null) return; const controller = new AbortController();
    fetch(`/api/v1/finops/resilience-vue?${query}`, { signal: controller.signal, headers: { Accept: "application/json" } })
      .then(async (response) => { if (!response.ok) throw new Error("ResilienceVue request failed"); return response.json(); })
      .then((value: ResilienceVueReport | { dashboard: null; officialDefinition: ResilienceVueOfficialDefinition;
        collection?: ResilienceVueReport["collection"] }) => {
        if (!hasPinnedOfficialDefinition(value.officialDefinition)) throw new Error("Sutra returned an unrecognized ResilienceVue definition");
        if ("dashboard" in value) {
          setReport(null); setConfigurationDefinition(value.officialDefinition);
          const runtime = value.collection;
          setError(runtime === undefined
            ? "AWS Resilience Hub evidence is not configured for this selection. No posture, recommendation, or estimated-cost value is synthesized."
            : `ResilienceVue collection ${runtime.state}: ${runtime.reason}. No posture, recommendation, or estimated-cost value is synthesized.`);
        } else {
          setReport(value); setConfigurationDefinition(null); setError(null);
        }
      })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "ResilienceVue request failed"); });
    return () => controller.abort();
  }, [connectionId, query]);
  if (connectionId === null) return <div role="status" className={`${styles.state} ${styles.warning}`}>Connect an active AWS trust-role account before configuring ResilienceVue.</div>;
  if (error !== null) return <section className={styles.root}>
    {configurationDefinition === null ? null : <OfficialDefinitionPanel definition={configurationDefinition} />}
    <div role="alert" className={`${styles.state} ${styles.warning}`}>{error}</div>
  </section>;
  if (report === null || report.connectionId !== connectionId) return <div role="status" className={styles.state}>Loading AWS Resilience Hub evidence…</div>;
  return <ResilienceVueReportView report={report} filters={filters} onFiltersChange={setFilters} />;
}

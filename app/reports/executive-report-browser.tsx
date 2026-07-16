"use client";

import { useEffect, useMemo, useState } from "react";
import type { ComplianceAssessment } from "../../lib/compliance-engine";
import { compactIdentifier, formatTimestamp, snapshotOriginLabel, usePilotState } from "../components/use-pilot-state";

interface ComplianceReportResponse {
  readonly assessment?: ComplianceAssessment;
  readonly reportSha256?: string;
  readonly error?: { readonly message?: string };
}

function today(): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "long" }).format(new Date());
}

export function ExecutiveReportBrowser() {
  const { state, loading, error } = usePilotState();
  const [compliance, setCompliance] = useState<ComplianceReportResponse | null>(null);
  const [complianceError, setComplianceError] = useState<string | null>(null);
  const connection = state?.connection ?? null;
  const connectionId = connection?.id ?? null;

  useEffect(() => {
    let current = true;
    const query = connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : "";
    void fetch(`/api/v1/compliance${query}`, { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as ComplianceReportResponse | null;
        if (!response.ok || !body?.assessment) throw new Error(body?.error?.message ?? "Compliance evidence is unavailable");
        return body;
      })
      .then((body) => { if (current) { setCompliance(body); setComplianceError(null); } })
      .catch((caught: unknown) => { if (current) setComplianceError(caught instanceof Error ? caught.message : "Compliance evidence is unavailable"); });
    return () => { current = false; };
  }, [connectionId, state?.activeSnapshot?.id]);

  const resources = useMemo(() => state?.resources ?? [], [state?.resources]);
  const findings = useMemo(() => state?.findings ?? [], [state?.findings]);
  const openFindings = findings.filter((finding) => finding.status === "open" || finding.status === "acknowledged");
  const serviceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const resource of resources) counts.set(resource.service, (counts.get(resource.service) ?? 0) + 1);
    return [...counts.entries()].sort((left, right) => right[1] - left[1]);
  }, [resources]);
  const priority = openFindings
    .slice()
    .sort((left, right) => ["critical", "high", "medium", "low", "informational"].indexOf(left.severity) - ["critical", "high", "medium", "low", "informational"].indexOf(right.severity))
    .slice(0, 6);
  const assessment = compliance?.assessment ?? null;

  if (loading) return <div className="loading-state" role="status"><span className="loading-spinner" />Preparing executive evidence report…</div>;
  if (error) return <div className="page-alert page-alert-error" role="alert"><strong>Report is unavailable</strong><span>{error}</span></div>;
  if (!connection || !state?.activeSnapshot) return <section className="panel empty-workspace"><span className="empty-workspace-icon">PDF</span><h2>No reportable snapshot</h2><p>Complete an AWS collection before generating a customer report.</p><a className="button button-primary" href="/onboard">Connect AWS</a></section>;

  const successfulCoverage = state.coverage.filter((entry) => entry.status === "succeeded").length;
  const coveragePercent = state.coverage.length ? Math.round(successfulCoverage / state.coverage.length * 100) : 0;
  return <>
    <section className="page-heading no-print"><div><p className="eyebrow">Customer communication</p><h1>Executive evidence report</h1><p className="page-subtitle">A print-ready summary generated from the current immutable CMDB and compliance evidence.</p></div><div className="heading-actions"><a className="button button-secondary" href={`/api/v1/compliance?connectionId=${encodeURIComponent(connection.id)}&format=json`}>Evidence JSON</a><a className="button button-secondary" href={`/api/v1/compliance?connectionId=${encodeURIComponent(connection.id)}&format=csv`}>Evidence CSV</a><button className="button button-primary" type="button" onClick={() => window.print()}>Print / Save PDF</button></div></section>

    <article className="executive-report">
      <header className="report-cover"><div><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><strong>Sutra</strong></div><p>Cloud assurance report</p><h1>{connection.customerName}</h1><h2>AWS account {connection.awsAccountId}</h2><span>Prepared {today()}</span></header>

      <section className="report-section"><div className="report-section-heading"><div><p className="eyebrow">01 · Executive summary</p><h2>Current cloud assurance posture</h2></div><span className={`report-posture ${openFindings.some((finding) => finding.severity === "critical" || finding.severity === "high") ? "report-posture-risk" : "report-posture-good"}`}>{openFindings.some((finding) => finding.severity === "critical" || finding.severity === "high") ? "Priority action required" : "No priority finding observed"}</span></div><p className="report-lead">Sutra observed {resources.length.toLocaleString()} AWS resources across {serviceCounts.length} services. The active assessment contains {openFindings.length} unresolved finding{openFindings.length === 1 ? "" : "s"}, including {openFindings.filter((finding) => finding.severity === "critical" || finding.severity === "high").length} critical or high-priority item{openFindings.filter((finding) => finding.severity === "critical" || finding.severity === "high").length === 1 ? "" : "s"}.</p><div className="report-metrics"><div><small>Managed assets</small><strong>{resources.length}</strong><span>{serviceCounts.length} AWS services</span></div><div><small>Open findings</small><strong>{openFindings.length}</strong><span>{findings.length - openFindings.length} closed or excepted</span></div><div><small>Collector coverage</small><strong>{coveragePercent}%</strong><span>{successfulCoverage}/{state.coverage.length} checks succeeded</span></div><div><small>Compliance score</small><strong>{assessment?.summary.scorePercent === null || assessment?.summary.scorePercent === undefined ? "—" : `${assessment.summary.scorePercent}%`}</strong><span>{assessment ? `${assessment.summary.scoredControls} controls scored` : "Evidence unavailable"}</span></div></div></section>

      <section className="report-section"><div className="report-section-heading"><div><p className="eyebrow">02 · Priority actions</p><h2>Recommended remediation queue</h2></div></div>{priority.length ? <div className="report-priority-list">{priority.map((finding, index) => <article key={finding.fingerprint}><span>{String(index + 1).padStart(2, "0")}</span><div><p><b className={`severity-badge severity-${finding.severity}`}>{finding.severity}</b> {finding.title}</p><small>{finding.summary}</small><strong>Recommendation: {finding.remediation}</strong></div></article>)}</div> : <div className="empty-state"><strong>No unresolved priority finding</strong><span>This statement is bounded to implemented controls and successful evidence collection.</span></div>}</section>

      <section className="report-two-column"><div className="report-section"><div className="report-section-heading"><div><p className="eyebrow">03 · Asset profile</p><h2>Observed services</h2></div></div><div className="report-service-list">{serviceCounts.map(([service, count]) => <div key={service}><span>{service.toUpperCase()}</span><strong>{count}</strong></div>)}</div></div><div className="report-section"><div className="report-section-heading"><div><p className="eyebrow">04 · Control evidence</p><h2>Assessment outcomes</h2></div></div>{assessment ? <div className="report-control-summary"><div><span>Pass</span><strong>{assessment.summary.pass}</strong></div><div><span>Fail</span><strong>{assessment.summary.fail}</strong></div><div><span>Unknown</span><strong>{assessment.summary.unknown}</strong></div><div><span>Excepted</span><strong>{assessment.summary.excepted}</strong></div><div><span>Not applicable</span><strong>{assessment.summary.notApplicable}</strong></div></div> : <p>{complianceError ?? "Compliance evidence is being prepared."}</p>}</div></section>

      <section className="report-section report-evidence"><div className="report-section-heading"><div><p className="eyebrow">05 · Evidence and limitations</p><h2>Traceable source record</h2></div></div><dl><div><dt>Evidence source</dt><dd>{snapshotOriginLabel(state.activeSnapshot.origin)}</dd></div><div><dt>Snapshot collected</dt><dd>{formatTimestamp(state.activeSnapshot.collectedAt)}</dd></div><div><dt>Snapshot ID</dt><dd>{state.activeSnapshot.id}</dd></div><div><dt>Snapshot SHA-256</dt><dd>{state.activeSnapshot.snapshotSha256}</dd></div>{compliance?.reportSha256 ? <div><dt>Compliance report SHA-256</dt><dd>{compliance.reportSha256}</dd></div> : null}<div><dt>Connection permission pack</dt><dd>{connection.permissionPackVersion}</dd></div></dl><p>This report is a point-in-time interpretation of collected AWS configuration metadata and explicit collector coverage. It is not an audit opinion, certification, penetration test, vulnerability scan, proof of exploitability, or proof that threats are absent. Native GuardDuty, Security Hub, and Inspector findings are imported only when those services are enabled and accessible.</p></section>

      <footer className="report-footer"><span>Sutra · cloud operations and assurance</span><span>Snapshot {compactIdentifier(state.activeSnapshot.snapshotSha256, 18)}</span></footer>
    </article>
  </>;
}

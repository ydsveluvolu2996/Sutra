"use client";

import { useMemo } from "react";
import {
  prioritizeKubernetesPosture,
  type PodSecurityStandard,
  type PostureRiskFactor,
} from "../../lib/kubernetes-posture-priority";
import type { KubernetesControlResult, KubernetesPostureReport } from "../../lib/kubernetes-posture";

const RISK_LABEL: Readonly<Record<PostureRiskFactor, string>> = {
  "internet-exposed": "Internet-exposed",
  privileged: "Privileged",
  "over-permissioned": "Over-permissioned RBAC",
  unhardened: "Unhardened",
  "no-network-isolation": "No network isolation",
};

const PSS_LABEL: Readonly<Record<PodSecurityStandard, string>> = {
  restricted: "Restricted", baseline: "Baseline", privileged: "Privileged", unknown: "Unknown",
};

function severityClass(severity: KubernetesControlResult["severity"]): string {
  return `severity-badge severity-${severity === "CRITICAL" ? "critical" : severity === "HIGH" ? "high" : severity === "MEDIUM" ? "medium" : "low"}`;
}

function pssClass(pss: PodSecurityStandard): string {
  if (pss === "restricted") return "settings-pill is-good";
  if (pss === "privileged") return "settings-pill is-risk";
  return "settings-pill";
}

export function KubernetesPosturePriorityPanel({
  results,
  clusterId,
  collectedAt,
}: {
  readonly results: readonly KubernetesControlResult[];
  readonly clusterId: string;
  readonly collectedAt: string | null;
}) {
  const report = useMemo(() => {
    const input: KubernetesPostureReport = {
      schema: "sutra.kubernetes-posture.v1",
      clusterId,
      collectedAt: collectedAt ?? "",
      summary: { PASS: 0, FAIL: 0, UNKNOWN: 0 },
      results,
      disclaimer: "",
    };
    return prioritizeKubernetesPosture(input);
  }, [results, clusterId, collectedAt]);

  if (results.length === 0) return null;
  const { summary } = report;

  return (
    <section className="kubernetes-subsection">
      <h3>Prioritized posture — what actually matters</h3>
      <p className="page-subtitle">{report.disclaimer}</p>

      <div className="inventory-stats">
        <article><small>Top-risk workloads</small><strong>{summary.topRiskWorkloads}</strong><span>toxic combinations (exposed · privileged · over-permissioned)</span></article>
        <article><small>Failing controls</small><strong>{summary.failing}</strong><span>{summary.unknown} unknown (evidence not collected)</span></article>
        <article><small>Pod Security Standards</small><strong>{summary.podSecurityStandards.restricted}<span className="posture-pss-frac"> / {report.workloads.length}</span></strong><span>restricted · {summary.podSecurityStandards.baseline} baseline · {summary.podSecurityStandards.privileged} privileged</span></article>
        <article><small>Controls evaluated</small><strong>{summary.evaluated}</strong><span>CIS · NSA-CISA · SOC 2 · PSS mapped</span></article>
      </div>

      {report.findings.length > 0 ? <div className="vuln-delta-list">
        {report.findings.slice(0, 25).map((finding) => <article className="posture-priority-row" key={`${finding.subject}:${finding.controlId}`}>
          <span className={severityClass(finding.severity)}>{finding.severity.toLowerCase()}</span>
          <div>
            <strong>{finding.controlId}{finding.state === "UNKNOWN" ? <span className="settings-pill" style={{ marginLeft: 8 }}>unknown</span> : null}</strong>
            <small>{finding.subject}</small>
            <small className="posture-priority-msg">{finding.message}</small>
            {finding.riskFactors.length > 0 ? <div className="posture-risk-factors">{finding.riskFactors.map((factor) => <span className="settings-pill is-risk" key={factor}>{RISK_LABEL[factor]}</span>)}</div> : null}
            <small className="posture-priority-fix">Fix: {finding.remediationHint}</small>
            {(finding.frameworks.cis.length > 0 || finding.frameworks.nsaCisa.length > 0) ? <small className="posture-priority-frameworks">{[...finding.frameworks.cis, ...finding.frameworks.nsaCisa].slice(0, 4).join(" · ")}</small> : null}
          </div>
          <span className="posture-priority-score" title="Context-fused risk rank">#{finding.priorityRank}</span>
        </article>)}
      </div> : <section className="empty-workspace compact-empty"><span className="empty-workspace-icon">OK</span><h2>No failing controls to prioritize</h2><p>Every collected control passed for this scan. This reflects the collected evidence and control coverage only, not a proof the cluster is risk-free.</p></section>}
      {report.findings.length > 25 ? <p className="panel-footnote">Showing the top 25 of {report.findings.length} by fused risk.</p> : null}

      {report.workloads.some((w) => w.priorityScore > 0) ? <div className="posture-workload-list">
        <p className="eyebrow" style={{ marginTop: 6 }}>Workloads by risk</p>
        {report.workloads.filter((w) => w.priorityScore > 0).slice(0, 10).map((workload) => <article className="posture-priority-row" key={workload.subject}>
          <span className={pssClass(workload.podSecurityStandard)}>PSS: {PSS_LABEL[workload.podSecurityStandard]}</span>
          <div><strong>{workload.subject}</strong><small>{workload.failCount} failing{workload.unknownCount > 0 ? ` · ${workload.unknownCount} unknown` : ""}{workload.riskFactors.length > 0 ? ` · ${workload.riskFactors.map((f) => RISK_LABEL[f]).join(", ")}` : ""}</small></div>
          <span className="posture-priority-score">{workload.priorityScore}</span>
        </article>)}
      </div> : null}
    </section>
  );
}

"use client";

import { useState } from "react";
import { parseIacScanInput } from "../../lib/iac-scan-input";
import { normalizeIac } from "../../lib/iac-normalizer";
import { scanIacResources, type IacScanReport, type IacSeverity } from "../../lib/iac-misconfiguration";

const TERRAFORM_EXAMPLE = JSON.stringify(
  {
    planned_values: {
      root_module: {
        resources: [
          { type: "aws_s3_bucket", name: "assets", address: "aws_s3_bucket.assets", values: { acl: "public-read" } },
          { type: "aws_security_group", name: "web", address: "aws_security_group.web", values: { ingress: [{ from_port: 22, to_port: 22, cidr_blocks: ["0.0.0.0/0"] }] } },
        ],
      },
    },
  },
  null,
  2,
);

function severityClass(severity: IacSeverity): string {
  return `severity-badge severity-${severity}`;
}

export function IacScanWorkspace() {
  const [terraformText, setTerraformText] = useState("");
  const [manifestsText, setManifestsText] = useState("");
  const [report, setReport] = useState<IacScanReport | null>(null);
  const [errors, setErrors] = useState<readonly string[]>([]);

  const scan = (): void => {
    const parsed = parseIacScanInput({ terraformText, manifestsText });
    if (parsed.errors.length > 0) { setErrors(parsed.errors); setReport(null); return; }
    if (parsed.input.terraform === null && (parsed.input.manifests?.length ?? 0) === 0) {
      setErrors(["Paste a Terraform plan JSON or one or more Kubernetes manifests to scan."]);
      setReport(null);
      return;
    }
    setErrors([]);
    setReport(scanIacResources(normalizeIac(parsed.input)));
  };

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Shift-left · pre-deploy</p>
          <h1>IaC misconfiguration scan</h1>
          <p className="page-subtitle">Scan a Terraform plan or Kubernetes manifests for misconfigurations before they ship. Everything is evaluated in your browser — the IaC you paste never leaves this page.</p>
        </div>
        <div className="heading-actions">
          <button className="button button-secondary" onClick={() => setTerraformText(TERRAFORM_EXAMPLE)} type="button">Load example</button>
          <button className="button button-primary" onClick={scan} type="button">Scan</button>
        </div>
      </section>

      <div className="trust-strip" role="note"><span className="trust-icon">I</span><span><strong>Bounded rules over normalized JSON, in-browser.</strong> Sutra evaluates a fixed rule set over the resources it can read from the provided JSON — it does not parse raw HCL/YAML and has no visibility into state, modules or provider defaults not in the input. A rule fires only when the specific field it inspects is present and unsafe; a silent field is not a pass.</span></div>

      <section className="iac-input-grid">
        <label><span>Terraform plan JSON <small>(terraform show -json)</small></span><textarea className="iac-textarea" placeholder='{ "planned_values": { "root_module": { "resources": [ … ] } } }' spellCheck={false} value={terraformText} onChange={(event) => setTerraformText(event.target.value)} /></label>
        <label><span>Kubernetes manifests JSON <small>(object or array)</small></span><textarea className="iac-textarea" placeholder='[ { "apiVersion": "apps/v1", "kind": "Deployment", "metadata": { … }, "spec": { … } } ]' spellCheck={false} value={manifestsText} onChange={(event) => setManifestsText(event.target.value)} /></label>
      </section>

      {errors.length > 0 ? <div className="page-alert page-alert-error" role="alert"><strong>Cannot scan</strong><span>{errors.join(" ")}</span></div> : null}

      {report !== null ? <>
        <section className="inventory-stats">
          <article><small>Resources scanned</small><strong>{report.summary.resources}</strong><span>{report.coverage.evaluatedKinds.length} kind{report.coverage.evaluatedKinds.length === 1 ? "" : "s"} with rules</span></article>
          <article><small>Findings</small><strong>{report.summary.findings}</strong><span className={report.summary.critical + report.summary.high > 0 ? "risk-text" : undefined}>{report.summary.critical} critical · {report.summary.high} high</span></article>
          <article><small>Medium / low</small><strong>{report.summary.medium + report.summary.low}</strong><span>{report.summary.medium} medium · {report.summary.low} low</span></article>
          <article><small>Not evaluated</small><strong>{report.summary.notEvaluated}</strong><span>field absent or kind unsupported</span></article>
        </section>

        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">Ordered by severity</p><h2>Misconfiguration findings</h2></div><span className="result-count">{report.findings.length}</span></div>
          {report.findings.length > 0 ? <div className="vuln-delta-list">
            {report.findings.map((finding, index) => <article className="iac-finding-row" key={`${finding.ruleId}:${finding.resourceName}:${index}`}>
              <span className={severityClass(finding.severity)}>{finding.severity}</span>
              <div>
                <strong>{finding.ruleId} · {finding.resourceName}</strong>
                <small>{finding.kind} · <code>{finding.evidencePath}</code></small>
                <small className="iac-finding-message">{finding.message}</small>
                <small className="iac-finding-fix">Fix: {finding.remediationHint}</small>
              </div>
            </article>)}
          </div> : <section className="empty-workspace compact-empty"><span className="empty-workspace-icon">OK</span><h2>No misconfigurations found</h2><p>No rule fired on the provided resources. This reflects the bounded rule set over what was in the input — not proof the infrastructure is fully secure.</p></section>}
        </section>

        {report.coverage.notEvaluated.length > 0 ? <p className="panel-footnote">{report.coverage.notEvaluated.length} resource/rule pair{report.coverage.notEvaluated.length === 1 ? "" : "s"} were not evaluated (the inspected field was absent, or the kind has no rule). Absence of a finding for them is not a pass.</p> : null}
        <p className="panel-footnote">{report.disclaimer}</p>
      </> : null}
    </>
  );
}

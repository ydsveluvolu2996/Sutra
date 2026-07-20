"use client";

import { useMemo, useState } from "react";
import { usePortfolio } from "../components/use-portfolio";
import { parseIacScanInput } from "../../lib/iac-scan-input";
import { normalizeIac } from "../../lib/iac-normalizer";
import { scanIacResources, type IacScanReport, type IacSeverity } from "../../lib/iac-misconfiguration";
import type { CollectedIacCoverage } from "../../lib/iac-collected-inputs";

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

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

interface CollectedScanResponse {
  readonly report: IacScanReport;
  readonly coverage: CollectedIacCoverage;
  readonly error?: { readonly message?: string };
}

function severityClass(severity: IacSeverity): string {
  return `severity-badge severity-${severity}`;
}

function ReportView({ report }: { readonly report: IacScanReport }) {
  return (
    <>
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
    </>
  );
}

export function IacScanWorkspace() {
  const portfolio = usePortfolio();
  const [terraformText, setTerraformText] = useState("");
  const [manifestsText, setManifestsText] = useState("");
  const [report, setReport] = useState<IacScanReport | null>(null);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [source, setSource] = useState<"paste" | "collected" | null>(null);
  const [collectedCoverage, setCollectedCoverage] = useState<CollectedIacCoverage | null>(null);
  const [collectedLoading, setCollectedLoading] = useState(false);

  // The active cloud connection to scan collected Kubernetes resources for: an
  // explicit ?connectionId= selection when valid, else the first connection in
  // the tenant-scoped portfolio. Tenant scope itself is enforced server-side.
  const connectionId = useMemo(() => {
    const requested = typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("connectionId");
    if (requested !== null && CONNECTION_ID.test(requested)) return requested;
    const connections = (portfolio.portfolio?.customers ?? []).flatMap((customer) => customer.connections);
    return connections[0]?.id ?? null;
  }, [portfolio.portfolio]);

  const scan = (): void => {
    const parsed = parseIacScanInput({ terraformText, manifestsText });
    if (parsed.errors.length > 0) { setErrors(parsed.errors); setReport(null); setSource(null); setCollectedCoverage(null); return; }
    if (parsed.input.terraform === null && (parsed.input.manifests?.length ?? 0) === 0) {
      setErrors(["Paste a Terraform plan JSON or one or more Kubernetes manifests to scan."]);
      setReport(null);
      setSource(null);
      setCollectedCoverage(null);
      return;
    }
    setErrors([]);
    setCollectedCoverage(null);
    setSource("paste");
    setReport(scanIacResources(normalizeIac(parsed.input)));
  };

  const scanCollected = async (): Promise<void> => {
    if (connectionId === null) {
      setErrors(["Connect a cloud account with a collected Kubernetes cluster to scan its resources."]);
      setReport(null);
      setSource(null);
      setCollectedCoverage(null);
      return;
    }
    setCollectedLoading(true);
    try {
      const response = await fetch(
        `/api/v1/iac-scan/collected?connectionId=${encodeURIComponent(connectionId)}`,
        { cache: "no-store", credentials: "same-origin" },
      );
      const body = await response.json().catch(() => null) as CollectedScanResponse | null;
      if (!response.ok || body === null || typeof body.report !== "object") {
        throw new Error(body?.error?.message ?? "Sutra could not scan the collected Kubernetes resources");
      }
      setErrors([]);
      setReport(body.report);
      setCollectedCoverage(body.coverage);
      setSource("collected");
    } catch (caught) {
      setErrors([caught instanceof Error ? caught.message : "Sutra could not scan the collected Kubernetes resources"]);
      setReport(null);
      setSource(null);
      setCollectedCoverage(null);
    } finally {
      setCollectedLoading(false);
    }
  };

  const zeroCoverage = source === "collected" && (collectedCoverage?.workloads ?? 0) === 0;

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Shift-left · pre-deploy</p>
          <h1>IaC misconfiguration scan</h1>
          <p className="page-subtitle">Scan a Terraform plan or Kubernetes manifests for misconfigurations before they ship — paste the IaC, or scan the Kubernetes workload specs Sutra has already collected from your clusters.</p>
        </div>
        <div className="heading-actions">
          <button className="button button-secondary" onClick={() => setTerraformText(TERRAFORM_EXAMPLE)} type="button">Load example</button>
          <button className="button button-secondary" disabled={collectedLoading} onClick={() => void scanCollected()} type="button">{collectedLoading ? "Scanning…" : "Scan collected Kubernetes resources"}</button>
          <button className="button button-primary" onClick={scan} type="button">Scan pasted IaC</button>
        </div>
      </section>

      <div className="trust-strip" role="note"><span className="trust-icon">I</span><span><strong>Bounded rules over normalized evidence.</strong> Sutra evaluates a fixed rule set over the resources it can read — pasted JSON (evaluated in your browser; it never leaves this page) or the Kubernetes workload specs already collected from your clusters. It does not parse raw HCL/YAML and has no visibility into state, modules or provider defaults not in the input. A rule fires only when the specific field it inspects is present and unsafe; a silent field is not a pass.</span></div>

      <section className="iac-input-grid">
        <label><span>Terraform plan JSON <small>(terraform show -json)</small></span><textarea className="iac-textarea" placeholder='{ "planned_values": { "root_module": { "resources": [ … ] } } }' spellCheck={false} value={terraformText} onChange={(event) => setTerraformText(event.target.value)} /></label>
        <label><span>Kubernetes manifests JSON <small>(object or array)</small></span><textarea className="iac-textarea" placeholder='[ { "apiVersion": "apps/v1", "kind": "Deployment", "metadata": { … }, "spec": { … } } ]' spellCheck={false} value={manifestsText} onChange={(event) => setManifestsText(event.target.value)} /></label>
      </section>

      {errors.length > 0 ? <div className="page-alert page-alert-error" role="alert"><strong>Cannot scan</strong><span>{errors.join(" ")}</span></div> : null}

      {source === "collected" && collectedCoverage !== null ? <div className="trust-strip" role="note"><span className="trust-icon">K</span><span><strong>Collected Kubernetes evidence.</strong> Scanned {collectedCoverage.workloads} workload spec{collectedCoverage.workloads === 1 ? "" : "s"} from {collectedCoverage.clustersWithScan} of {collectedCoverage.clusters} cluster{collectedCoverage.clusters === 1 ? "" : "s"} with a completed collection. Only the fields the collector actually observed are evaluated; an unobserved field is reported as not-evaluated, never assumed secure.</span></div> : null}

      {zeroCoverage ? <section className="empty-workspace"><span className="empty-workspace-icon">K</span><h2>No collected Kubernetes workload specs</h2><p>{(collectedCoverage?.clusters ?? 0) === 0 ? "No Kubernetes clusters are enrolled for this connection yet." : "The enrolled cluster(s) have no completed collection with workload specs to scan yet."} This is a zero-coverage result — not a clean pass. Enroll a cluster and let a collection complete, or paste Kubernetes manifests above.</p></section> : null}

      {report !== null && !zeroCoverage ? <ReportView report={report} /> : null}
    </>
  );
}

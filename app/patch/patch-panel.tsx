"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  PatchComplianceStatus,
  PatchInstancePosture,
  PatchPostureReport,
} from "../../lib/patch-posture";
import { compactIdentifier, formatTimestamp, usePilotState } from "../components/use-pilot-state";

interface PatchResponse {
  readonly connectionId: string;
  readonly report: PatchPostureReport;
  readonly error?: { readonly message?: string };
}

const STATUS_LABEL: Readonly<Record<PatchComplianceStatus, string>> = {
  compliant: "Compliant",
  "non-compliant": "Non-compliant",
  "not-assessed": "Not assessed",
};

const STATUS_CLASS: Readonly<Record<PatchComplianceStatus, string>> = {
  compliant: "compliance-status compliance-status-pass",
  "non-compliant": "compliance-status compliance-status-fail",
  "not-assessed": "compliance-status compliance-status-unknown",
};

function count(value: number | null): string {
  return value === null ? "—" : String(value);
}

function notAssessedReason(instance: PatchInstancePosture): string {
  return instance.managed
    ? "SSM-managed but no patch scan reported — run a patch scan to assess."
    : "No SSM patch data (agent not installed or not SSM-managed) — not assessed.";
}

export function PatchPanel() {
  const { state, loading, error, refresh } = usePilotState();
  const connection = state?.connection ?? null;
  const connectionId = connection?.id ?? null;
  const [data, setData] = useState<PatchResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (connectionId === null) { setData(null); setLoadError(null); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/patch?connectionId=${encodeURIComponent(connectionId)}`, { cache: "no-store", credentials: "same-origin" });
      const body = await response.json() as PatchResponse;
      if (!response.ok || body.report === undefined) throw new Error(body.error?.message ?? "Patch posture is unavailable");
      setData(body);
      setLoadError(null);
    } catch (caught) {
      setData(null);
      setLoadError(caught instanceof Error ? caught.message : "Patch posture is unavailable");
    } finally {
      setBusy(false);
    }
  }, [connectionId]);
  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const copy = useCallback(async (key: string, command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
    } catch { /* clipboard unavailable; the command is still shown for manual copy */ }
  }, []);

  const report = data?.report ?? null;
  const summary = report?.summary ?? null;

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">OS patch management</p>
          <h1>Patch management</h1>
          <p className="page-subtitle">Read-only patch-compliance posture for SSM-managed EC2 instances, derived from the AWS Systems Manager patch state Sutra collects. Sutra makes no changes in your account: it reports which hosts are missing patches and <strong>generates</strong> a remediation runbook for you to run yourself — it never installs a patch.</p>
        </div>
        <div className="heading-actions">
          <button className="button button-primary" disabled={busy} onClick={() => { void refresh(); void load(); }} type="button">{busy ? "Refreshing…" : "Refresh"}</button>
        </div>
      </section>

      <div className="trust-strip" role="note">
        <span className="trust-icon">i</span>
        <span><strong>Read-only &amp; generate-only.</strong> Sutra collects patch state with three read-only SSM Describe APIs and never runs a command in your environment. Instances with no collected SSM patch data are shown as <em>not assessed</em> — never assumed compliant.</span>
      </div>

      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Evidence unavailable</strong><span>{error}</span><button onClick={() => void refresh()} type="button">Retry</button></div> : null}
      {loadError ? <div className="page-alert page-alert-error" role="alert"><strong>Patch posture unavailable</strong><span>{loadError}</span><button onClick={() => void load()} type="button">Retry</button></div> : null}
      {(loading || busy) && data === null ? <div className="loading-state" role="status"><span className="loading-spinner" />Computing patch-compliance posture from collected SSM state…</div> : null}

      {!loading && connection === null ? (
        <section className="panel empty-workspace"><span className="empty-workspace-icon">PM</span><h2>No AWS account is connected</h2><p>Connect and validate a customer account so Sutra can collect read-only SSM patch state and compute patch-compliance posture.</p><a className="button button-primary" href="/onboard">Connect AWS account</a></section>
      ) : null}

      {report !== null && summary !== null ? (
        summary.fleetSize === 0 ? (
          <section className="panel empty-workspace">
            <span className="empty-workspace-icon">0</span>
            <h2>No EC2 instances collected</h2>
            <p>No EC2 instances have been collected for this connection yet, so there is no patch posture to assess. This is not a finding of &ldquo;fully patched&rdquo;: an empty inventory cannot prove the fleet is compliant.</p>
          </section>
        ) : (
          <>
            <section className="metric-row">
              <div className="metric-card"><span className="metric-label">Instances</span><span className="metric-value">{summary.fleetSize}</span></div>
              <div className="metric-card"><span className="metric-label">Compliant</span><span className="metric-value">{summary.compliant}</span></div>
              <div className="metric-card"><span className="metric-label">Non-compliant</span><span className="metric-value">{summary.nonCompliant}</span></div>
              <div className="metric-card"><span className="metric-label">Not assessed</span><span className="metric-value">{summary.notAssessed}</span></div>
              <div className="metric-card"><span className="metric-label">Critical patches missing</span><span className="metric-value">{summary.criticalMissingTotal}</span></div>
              <div className="metric-card"><span className="metric-label">Assessment coverage</span><span className="metric-value">{summary.assessmentCoveragePercent === null ? "—" : `${summary.assessmentCoveragePercent}%`}</span></div>
            </section>

            <section className="panel">
              <h2>Instance patch compliance</h2>
              <p className="page-footnote">{summary.assessed} of {summary.fleetSize} instance{summary.fleetSize === 1 ? "" : "s"} were assessed from collected SSM patch state. {summary.unmanaged} had no SSM patch data and {summary.managedNotScanned} are SSM-managed but not yet scanned — both are reported as not assessed, never compliant.</p>
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>Instance</th><th>Region</th><th>State</th><th>Missing (critical)</th><th>Missing (security)</th><th>Missing (total)</th><th>Status</th><th>Last scan</th></tr></thead>
                  <tbody>
                    {report.instances.map((instance) => (
                      <tr key={instance.resourceKey}>
                        <td><strong>{instance.name ?? instance.instanceId}</strong><small><code>{compactIdentifier(instance.instanceId, 24)}</code>{instance.platform !== null ? ` · ${instance.platform}` : ""}</small></td>
                        <td>{instance.region ?? "—"}</td>
                        <td>{instance.instanceState ?? "—"}</td>
                        <td>{count(instance.criticalMissingCount)}</td>
                        <td>{count(instance.securityMissingCount)}</td>
                        <td>{count(instance.missingCount)}</td>
                        <td><span className={STATUS_CLASS[instance.complianceStatus]}>{STATUS_LABEL[instance.complianceStatus]}</span>{instance.complianceStatus === "not-assessed" ? <small className="cell-detail">{notAssessedReason(instance)}</small> : null}</td>
                        <td>{instance.lastScanAt !== null ? formatTimestamp(instance.lastScanAt) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel">
              <h2>Generated remediation runbooks</h2>
              <p className="panel-footnote">One runbook per non-compliant instance. Each is the exact command <strong>you</strong> run in your own change process — <strong>Sutra generates this; it does not run it.</strong> Back up the instance and run in a maintenance window; some patches require a reboot.</p>
              {report.runbooks.length === 0 ? (
                <div className="empty-state"><strong>No remediation runbook generated</strong><span>No instance is currently non-compliant from the collected SSM patch state. Not-assessed instances are intentionally excluded — assess them (install the SSM agent and run a patch scan) before a runbook can be generated.</span></div>
              ) : (
                <div className="networkpolicy-list">
                  {report.runbooks.map((runbook) => {
                    const key = runbook.instanceId;
                    return (
                      <article className="networkpolicy-row" key={key}>
                        <div className="networkpolicy-head">
                          <div><strong>{runbook.name ?? runbook.instanceId}</strong><small><code>{compactIdentifier(runbook.instanceId, 24)}</code> · {count(runbook.criticalMissingCount)} critical · {count(runbook.missingCount)} missing</small></div>
                          <div className="heading-actions">
                            <button className="button button-secondary button-small" onClick={() => void copy(key, runbook.command)} type="button">{copied === key ? "Copied" : "Copy command"}</button>
                          </div>
                        </div>
                        <pre className="networkpolicy-yaml"><code>{runbook.command}</code></pre>
                        <p className="page-footnote">Verify afterwards (read-only): <code>{runbook.verifyCommand}</code></p>
                        <ol className="page-footnote">
                          {runbook.steps.map((step) => <li key={step}>{step}</li>)}
                        </ol>
                        <p className="page-footnote"><strong>{runbook.generatedNotExecutedNotice}</strong></p>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>

            <p className="page-footnote">{report.disclaimer}</p>
          </>
        )
      ) : null}
    </>
  );
}

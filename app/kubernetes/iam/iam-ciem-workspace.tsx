"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { AwsIamCiemPrincipalResult, AwsIamCiemReport, IamEffectiveFlags } from "../../../lib/aws-iam-ciem";
import { usePilotState } from "../../components/use-pilot-state";

// The effective-permission engine runs server-side in /api/v1/kubernetes/iam,
// which assembles the identical evidence set (authorized CMDB resources plus
// the projected latest workspace of the first active cluster) inside the
// authenticated tenant scope. Only the report *type* is imported here, so the
// engine and its IAM action corpus no longer ship to the browser and there is
// a single implementation to keep correct.
interface IamCiemBody extends AwsIamCiemReport {
  readonly connectionId: string;
  readonly clusterId: string | null;
  readonly error?: { readonly message?: string };
}

const FLAGS: readonly { readonly key: keyof IamEffectiveFlags; readonly label: string; readonly cls: string }[] = [
  { key: "adminLike", label: "Admin-like", cls: "compliance-status-fail" },
  { key: "privilegeEscalation", label: "Privilege escalation", cls: "compliance-status-fail" },
  { key: "dataAccess", label: "Data access", cls: "compliance-status-unknown" },
  { key: "wildcardAction", label: "Wildcard action", cls: "compliance-status-unknown" },
];

function activeFlags(result: AwsIamCiemPrincipalResult) {
  return FLAGS.filter((flag) => result.flags[flag.key] === true);
}

export function IamCiemWorkspace() {
  const { state, loading, error, refresh } = usePilotState();
  const connectionId = state?.connection?.id ?? null;
  const [report, setReport] = useState<AwsIamCiemReport | null>(null);
  const [ciemLoading, setCiemLoading] = useState(false);
  const [ciemError, setCiemError] = useState<string | null>(null);
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  const refreshCiem = useCallback(async () => {
    if (connectionId === null) {
      setReport(null);
      setCiemError(null);
      return;
    }
    setCiemLoading(true);
    try {
      const response = await fetch(
        `/api/v1/kubernetes/iam?connectionId=${encodeURIComponent(connectionId)}`,
        { cache: "no-store", credentials: "same-origin" },
      );
      const body = await response.json().catch(() => null) as IamCiemBody | null;
      if (!response.ok || body === null || body.schema !== "sutra.aws-iam-ciem.v1") {
        throw new Error(body?.error?.message ?? "Sutra could not resolve IAM effective permissions");
      }
      setReport(body);
      setCiemError(null);
    } catch (caught) {
      setReport(null);
      setCiemError(caught instanceof Error ? caught.message : "Sutra could not resolve IAM effective permissions");
    } finally {
      setCiemLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void refreshCiem(), 0);
    const listener = () => void refreshCiem();
    window.addEventListener("sutra:kubernetes-changed", listener);
    return () => {
      window.clearTimeout(initialLoad);
      window.removeEventListener("sutra:kubernetes-changed", listener);
    };
  }, [refreshCiem]);

  const principals = report === null
    ? []
    : onlyFlagged
      ? report.principals.filter((result) => activeFlags(result).length > 0)
      : report.principals;

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Cloud · Identity &amp; entitlements</p>
          <h1>AWS IAM CIEM</h1>
          <p className="page-subtitle">Effective permissions of each IAM principal — the collected Allow action patterns minus the Deny patterns that cover them — with dangerous grants flagged (admin, privilege escalation, data access) and right-sizing where last-use evidence shows an allowed service is unused.</p>
        </div>
        <div className="heading-actions">
          <Link className="button button-secondary" href="/kubernetes/permissions">Kubernetes CIEM</Link>
          <button className="button button-primary" onClick={() => { void refresh(); void refreshCiem(); }} type="button">Refresh</button>
        </div>
      </section>
      {report !== null ? <div className="trust-strip" role="note"><span className="trust-icon">IAM</span><span>{report.disclaimer}</span></div> : null}

      {error || ciemError ? <div className="page-alert page-alert-error" role="alert"><strong>IAM evidence unavailable</strong><span>{error ?? ciemError}</span><button onClick={() => { void refresh(); void refreshCiem(); }} type="button">Retry</button></div> : null}
      {loading || ciemLoading ? <div className="loading-state" role="status"><span className="loading-spinner" />Resolving IAM effective permissions…</div> : null}

      {!loading && !ciemLoading ? (
        <>
          {report !== null ? (
            <section className="inventory-stats">
              <article><small>IAM principals</small><strong>{report.totals.principals}</strong><span>{report.totals.resolved} resolved · {report.totals.unresolved} unresolved</span></article>
              <article><small>Admin-like</small><strong>{report.totals.adminLike}</strong><span>Effective * on *</span></article>
              <article><small>Privilege escalation</small><strong>{report.totals.privilegeEscalation}</strong><span>Can widen its own access</span></article>
              <article><small>Right-size candidates</small><strong>{report.totals.rightSizeCandidates}</strong><span>{report.totals.rightSizeUnknown} usage unknown</span></article>
            </section>
          ) : null}

          <section className="panel">
            <div className="panel-heading">
              <div><p className="eyebrow">Ranked by entitlement risk</p><h2>IAM principals</h2></div>
              <label className="filter-toggle"><input checked={onlyFlagged} onChange={(event) => setOnlyFlagged(event.target.checked)} type="checkbox" /> Only flagged principals</label>
            </div>
            {principals.length > 0 ? (
              <div className="ciem-list">
                {principals.map((result) => (
                  <article className="ciem-card" key={result.ref}>
                    <div className="ciem-head">
                      <div>
                        <strong>{result.ref}</strong>
                        <small>{result.kind}{result.resolution === "resolved" && result.effectiveAllowed ? ` · ${result.effectiveAllowed.length} effective action pattern${result.effectiveAllowed.length === 1 ? "" : "s"}` : " · unresolved"}</small>
                      </div>
                      <div className="ciem-risk"><strong>{result.riskScore ?? "—"}</strong><small>risk</small></div>
                    </div>
                    {result.resolution === "resolved" ? (
                      <>
                        {activeFlags(result).length > 0 ? <div className="ciem-flags">{activeFlags(result).map((flag) => <span className={`compliance-status ${flag.cls}`} key={flag.key}>{flag.label}</span>)}</div> : <p className="panel-footnote">No high-risk entitlement flag.</p>}
                        {result.matchedEscalationActions.length > 0 ? <div className="ciem-aws"><p className="eyebrow">Privilege-escalation actions</p><p><code>{result.matchedEscalationActions.join(", ")}</code></p></div> : null}
                        {result.matchedDataActions.length > 0 ? <div className="ciem-aws"><p className="eyebrow">Data-plane actions</p><p><code>{result.matchedDataActions.slice(0, 10).join(", ")}{result.matchedDataActions.length > 10 ? ` +${result.matchedDataActions.length - 10} more` : ""}</code></p></div> : null}
                        {result.conditions === "conditions not evaluated" ? <p className="panel-footnote">{result.conditionalStatementCount} conditional statement{result.conditionalStatementCount === 1 ? "" : "s"} — surfaced but not evaluated.</p> : null}
                        <p className="panel-footnote">{result.rightSize.note}</p>
                        <details className="ciem-perms"><summary>{result.effectiveAllowed?.length ?? 0} effective action pattern{(result.effectiveAllowed?.length ?? 0) === 1 ? "" : "s"}</summary><ul>{(result.effectiveAllowed ?? []).slice(0, 60).map((action, index) => <li key={`${result.ref}:${index}`}><code>{action}</code></li>)}</ul>{(result.effectiveAllowed?.length ?? 0) > 60 ? <p className="panel-footnote">Showing 60 of {result.effectiveAllowed?.length}.</p> : null}</details>
                      </>
                    ) : <p className="panel-footnote">{result.unresolvedReason}. Effective permissions are unresolved, not assumed empty.</p>}
                  </article>
                ))}
              </div>
            ) : (
              <section className="empty-workspace compact-empty"><span className="empty-workspace-icon">IAM</span><h2>No IAM principals</h2><p>No IAM role or user resources are present in the current authorized snapshot. This reflects collector coverage, not proof of least privilege.</p></section>
            )}
          </section>
        </>
      ) : null}
    </>
  );
}

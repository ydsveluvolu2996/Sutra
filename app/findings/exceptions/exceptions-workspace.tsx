"use client";

import { useCallback, useEffect, useState } from "react";
import { usePilotState } from "../../components/use-pilot-state";
import type { StoredFindingException } from "../../../db/finding-exception-repository";
import type { FindingExceptionReport } from "../../../lib/finding-exceptions";

interface ExceptionsResponse {
  readonly rules: readonly StoredFindingException[];
  readonly report: FindingExceptionReport;
  readonly findingCount: number;
  readonly permissions: { readonly canManage: boolean };
  readonly error?: { readonly message?: string };
}

function scopeLabel(rule: StoredFindingException): string {
  return [
    rule.ruleId ? `rule:${rule.ruleId}` : null,
    rule.resourceRef ? `resource:${rule.resourceRef}` : null,
  ].filter(Boolean).join(" · ") || "—";
}

function expiryLabel(rule: StoredFindingException, now: number): { readonly text: string; readonly expired: boolean } {
  if (rule.expiresAtMs === null) return { text: "no expiry", expired: false };
  const expired = rule.expiresAtMs <= now;
  return { text: `${expired ? "expired " : "expires "}${new Date(rule.expiresAtMs).toISOString().slice(0, 10)}`, expired };
}

export function FindingExceptionsWorkspace() {
  const { state, loading, error } = usePilotState();
  const connectionId = state?.connection?.id ?? null;
  const [data, setData] = useState<ExceptionsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [ruleId, setRuleId] = useState("");
  const [resourceRef, setResourceRef] = useState("");
  const [justification, setJustification] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  // Read the clock once at mount so render stays pure; expiry display only needs a
  // stable reference point, and the authoritative expiry decision is the server's.
  const [now] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (connectionId === null) { setData(null); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/findings/exceptions?connectionId=${encodeURIComponent(connectionId)}`, { cache: "no-store", credentials: "same-origin" });
      const body = await response.json() as ExceptionsResponse;
      if (!response.ok || body.rules === undefined) throw new Error(body.error?.message ?? "Finding exceptions are unavailable");
      setData(body);
      setLoadError(null);
    } catch (caught) {
      setData(null);
      setLoadError(caught instanceof Error ? caught.message : "Finding exceptions are unavailable");
    } finally {
      setBusy(false);
    }
  }, [connectionId]);
  useEffect(() => { const task = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(task); }, [load]);

  const createRule = useCallback(async () => {
    if (connectionId === null) return;
    if (ruleId.trim() === "" && resourceRef.trim() === "") { setFormError("Scope the exception to a rule id, a resource reference, or both — a blank scope would suppress everything."); return; }
    if (justification.trim().length < 10) { setFormError("A justification of at least 10 characters is required."); return; }
    setSubmitting(true);
    setFormError(null);
    try {
      const response = await fetch("/api/v1/findings/exceptions", {
        method: "POST", cache: "no-store", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId,
          ruleId: ruleId.trim() || null,
          resourceRef: resourceRef.trim() || null,
          justification: justification.trim(),
          expiresAt: expiresAt.trim() === "" ? null : new Date(`${expiresAt.trim()}T23:59:59Z`).toISOString(),
        }),
      });
      const result = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? "The exception could not be created");
      setRuleId(""); setResourceRef(""); setJustification(""); setExpiresAt("");
      await load();
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "The exception could not be created");
    } finally {
      setSubmitting(false);
    }
  }, [connectionId, expiresAt, justification, load, resourceRef, ruleId]);

  const revokeRule = useCallback(async (id: string) => {
    if (connectionId === null) return;
    setSubmitting(true);
    try {
      await fetch(`/api/v1/findings/exceptions?connectionId=${encodeURIComponent(connectionId)}&ruleId=${encodeURIComponent(id)}`, { method: "DELETE", cache: "no-store", credentials: "same-origin" });
      await load();
    } finally { setSubmitting(false); }
  }, [connectionId, load]);

  const summary = data?.report.summary ?? null;
  const canManage = data?.permissions.canManage ?? false;

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">GA hardening · accepted-risk suppression</p><h1>Finding exceptions</h1><p className="page-subtitle">Suppress posture findings by control rule and/or resource with an accepted-risk exception. A finding is suppressed only by a scope-matching exception that carries a justification and approver and has not expired &mdash; suppression is a recorded acceptance of risk, never evidence the finding was fixed.</p></div>
        <div className="heading-actions"><a className="button button-secondary" href="/findings">Posture findings</a><button className="button button-primary" disabled={busy} onClick={() => void load()} type="button">{busy ? "Refreshing…" : "Refresh"}</button></div>
      </section>

      {error ? <div className="page-alert page-alert-error" role="alert"><span>{error}</span></div> : null}
      {loadError ? <div className="page-alert page-alert-error" role="alert"><strong>Finding exceptions unavailable</strong><span>{loadError}</span><button onClick={() => void load()} type="button">Retry</button></div> : null}
      {!loading && connectionId === null ? <section className="panel empty-workspace"><span className="empty-workspace-icon">FE</span><h2>No AWS account is connected</h2><p>Connect a customer account to record and apply finding exceptions.</p><a className="button button-primary" href="/onboard">Connect AWS account</a></section> : null}

      {data !== null && summary !== null ? <>
        <section className="inventory-stats">
          <article><small>Exception rules</small><strong>{data.rules.length}</strong><span>{summary.activeExceptions} active · {summary.expiredExceptions} expired</span></article>
          <article><small>Live findings</small><strong>{data.findingCount}</strong><span>after resolved excluded</span></article>
          <article><small>Active</small><strong>{summary.active}</strong><span>not suppressed</span></article>
          <article><small>Suppressed</small><strong>{summary.suppressed}</strong><span>{summary.appliedExceptions} exceptions applied</span></article>
        </section>

        {canManage ? <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">Record an acceptance of risk</p><h2>New finding exception</h2></div></div>
          {formError ? <div className="page-alert page-alert-error" role="alert"><span>{formError}</span></div> : null}
          <div className="case-routing-form">
            <label><span>Rule id (control key)</span><input placeholder="e.g. aws.s3.block-public-access" value={ruleId} onChange={(event) => setRuleId(event.target.value)} /></label>
            <label><span>Resource reference</span><input placeholder="e.g. aws:s3:bucket:acme-logs" value={resourceRef} onChange={(event) => setResourceRef(event.target.value)} /></label>
            <label><span>Justification (required)</span><input placeholder="Why this risk is accepted" value={justification} onChange={(event) => setJustification(event.target.value)} /></label>
            <label><span>Expires (optional)</span><input type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label>
            <div className="case-routing-actions"><button className="button button-primary" disabled={submitting} onClick={() => void createRule()} type="button">{submitting ? "Saving…" : "Add exception"}</button></div>
          </div>
        </section> : null}

        {data.rules.length > 0 ? <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">Newest first</p><h2>Exception rules</h2></div><span className="result-count">{data.rules.length}</span></div>
          <div className="vuln-delta-list">{data.rules.map((rule) => {
            const expiry = expiryLabel(rule, now);
            return <article className="case-routing-rule-row" key={rule.id}>
              <span className={expiry.expired ? "settings-pill" : "settings-pill is-good"}>{expiry.expired ? "inactive" : "active"}</span>
              <div><strong>{scopeLabel(rule)}</strong><small>{rule.justification} · by {rule.approvedBy} · {expiry.text}</small></div>
              {canManage ? <button className="button button-secondary button-small" disabled={submitting} onClick={() => void revokeRule(rule.id)} type="button">Revoke</button> : null}
            </article>;
          })}</div>
        </section> : <section className="panel empty-workspace"><span className="empty-workspace-icon">FE</span><h2>No finding exceptions</h2><p>No accepted-risk exceptions are recorded for this account. Every finding below is active.</p></section>}

        {summary.invalidExceptions > 0 ? <div className="page-alert page-alert-error" role="alert"><strong>{summary.invalidExceptions} exception(s) are structurally invalid</strong><span>An invalid exception suppresses nothing and leaves its finding active. {data.report.invalidExceptions.map((entry) => `${entry.id}: ${entry.reason}`).join("; ")}</span></div> : null}

        {data.report.suppressed.length > 0 ? <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">Suppressed by an accepted-risk exception</p><h2>Suppressed findings</h2></div><span className="result-count">{data.report.suppressed.length}</span></div>
          <div className="vuln-delta-list">{data.report.suppressed.map((entry) => <article className="case-routing-rule-row" key={entry.finding.id}>
            <span className="settings-pill">{entry.finding.severity}</span>
            <div><strong>{entry.finding.ruleId}{entry.finding.resourceRef ? ` · ${entry.finding.resourceRef}` : ""}</strong><small>{entry.justification} · {entry.expiresInDays === null ? "no expiry" : `${entry.expiresInDays} day(s) until expiry`}</small></div>
          </article>)}</div>
        </section> : null}

        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">Not suppressed</p><h2>Active findings</h2></div><span className="result-count">{data.report.active.length}</span></div>
          {data.report.active.length > 0 ? <div className="vuln-delta-list">{data.report.active.map((finding) => <article className="case-routing-rule-row" key={finding.id}>
            <span className="settings-pill">{finding.severity}</span>
            <div><strong>{finding.ruleId}{finding.resourceRef ? ` · ${finding.resourceRef}` : ""}</strong></div>
          </article>)}</div> : <p className="panel-footnote">No live findings on the active snapshot.</p>}
          <p className="panel-footnote">{data.report.disclaimer}</p>
        </section>
      </> : null}
    </>
  );
}

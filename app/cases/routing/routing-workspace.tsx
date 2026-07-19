"use client";

import { useCallback, useEffect, useState } from "react";
import { usePilotState } from "../../components/use-pilot-state";
import type { StoredCaseRoutingRule } from "../../../db/case-routing-repository";
import type { CaseRoutingResult } from "../../../lib/case-routing";

const SEVERITIES = ["critical", "high", "medium", "low"] as const;

interface RoutingResponse {
  readonly rules: readonly StoredCaseRoutingRule[];
  readonly preview: CaseRoutingResult;
  readonly openCases: number;
  readonly error?: { readonly message?: string };
}

function targetLabel(route: { assignee: string | null; team: string | null; destination: string | null } | null): string {
  if (route === null) return "—";
  return [route.assignee && `@${route.assignee}`, route.team && `team:${route.team}`, route.destination].filter(Boolean).join(" · ") || "—";
}

export function CaseRoutingWorkspace() {
  const { state, loading, error } = usePilotState();
  const connectionId = state?.connection?.id ?? null;
  const [data, setData] = useState<RoutingResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [priority, setPriority] = useState("10");
  const [severities, setSeverities] = useState<readonly string[]>([]);
  const [assignee, setAssignee] = useState("");
  const [team, setTeam] = useState("");
  const [destination, setDestination] = useState("");

  const load = useCallback(async () => {
    if (connectionId === null) { setData(null); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/cases/routing?connectionId=${encodeURIComponent(connectionId)}`, { cache: "no-store", credentials: "same-origin" });
      const body = await response.json() as RoutingResponse;
      if (!response.ok || body.rules === undefined) throw new Error(body.error?.message ?? "Case routing is unavailable");
      setData(body);
      setLoadError(null);
    } catch (caught) {
      setData(null);
      setLoadError(caught instanceof Error ? caught.message : "Case routing is unavailable");
    } finally {
      setBusy(false);
    }
  }, [connectionId]);
  useEffect(() => { const task = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(task); }, [load]);

  const createRule = useCallback(async () => {
    if (connectionId === null) return;
    if (assignee.trim() === "" && team.trim() === "" && destination.trim() === "") { setFormError("Set at least one route target (assignee, team, or destination)."); return; }
    setSubmitting(true);
    setFormError(null);
    try {
      const response = await fetch("/api/v1/cases/routing", {
        method: "POST", cache: "no-store", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId, priority: Number(priority) || 0, matchSeverity: severities, routeAssignee: assignee.trim() || null, routeTeam: team.trim() || null, routeDestination: destination.trim() || null }),
      });
      const result = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? "The rule could not be created");
      setSeverities([]); setAssignee(""); setTeam(""); setDestination("");
      await load();
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "The rule could not be created");
    } finally {
      setSubmitting(false);
    }
  }, [assignee, connectionId, destination, load, priority, severities, team]);

  const removeRule = useCallback(async (ruleId: string) => {
    if (connectionId === null) return;
    setSubmitting(true);
    try {
      await fetch(`/api/v1/cases/routing?connectionId=${encodeURIComponent(connectionId)}&ruleId=${encodeURIComponent(ruleId)}`, { method: "DELETE", cache: "no-store", credentials: "same-origin" });
      await load();
    } finally { setSubmitting(false); }
  }, [connectionId, load]);

  const summary = data?.preview.summary ?? null;

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">GA hardening · triage automation</p><h1>Case routing rules</h1><p className="page-subtitle">Route remediation cases to an owner, team, or external destination by severity and customer. Rules drive a live preview only — they never change a case&rsquo;s real assignee, so a misconfigured rule can&rsquo;t silently reassign work.</p></div>
        <div className="heading-actions"><a className="button button-secondary" href="/cases">Cases</a><button className="button button-primary" disabled={busy} onClick={() => void load()} type="button">{busy ? "Refreshing…" : "Refresh"}</button></div>
      </section>

      {error ? <div className="page-alert page-alert-error" role="alert"><span>{error}</span></div> : null}
      {loadError ? <div className="page-alert page-alert-error" role="alert"><strong>Case routing unavailable</strong><span>{loadError}</span><button onClick={() => void load()} type="button">Retry</button></div> : null}
      {!loading && connectionId === null ? <section className="panel empty-workspace"><span className="empty-workspace-icon">CR</span><h2>No AWS account is connected</h2><p>Connect a customer account to define and preview case routing.</p><a className="button button-primary" href="/onboard">Connect AWS account</a></section> : null}

      {data !== null && summary !== null ? <>
        <section className="inventory-stats">
          <article><small>Routing rules</small><strong>{data.rules.length}</strong><span>evaluated by priority</span></article>
          <article><small>Open cases</small><strong>{data.openCases}</strong><span>previewed</span></article>
          <article><small>Routed</small><strong>{summary.routed}</strong><span>{summary.matchedByRule} by rule</span></article>
          <article><small>Unrouted</small><strong>{summary.unrouted}</strong><span>no matching rule</span></article>
        </section>

        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">Add a rule</p><h2>New routing rule</h2></div></div>
          {formError ? <div className="page-alert page-alert-error" role="alert"><span>{formError}</span></div> : null}
          <div className="case-routing-form">
            <label><span>Priority (lower wins)</span><input inputMode="numeric" value={priority} onChange={(event) => setPriority(event.target.value.replace(/\D/gu, ""))} /></label>
            <fieldset className="case-routing-severities"><legend>Match severity (any if none)</legend>{SEVERITIES.map((severity) => <label key={severity} className="case-routing-checkbox"><input type="checkbox" checked={severities.includes(severity)} onChange={(event) => setSeverities((current) => event.target.checked ? [...current, severity] : current.filter((value) => value !== severity))} />{severity}</label>)}</fieldset>
            <label><span>Route to assignee</span><input placeholder="membership id or name" value={assignee} onChange={(event) => setAssignee(event.target.value)} /></label>
            <label><span>Route to team</span><input placeholder="e.g. soc" value={team} onChange={(event) => setTeam(event.target.value)} /></label>
            <label><span>External destination</span><input placeholder="e.g. jira://SEC" value={destination} onChange={(event) => setDestination(event.target.value)} /></label>
            <div className="case-routing-actions"><button className="button button-primary" disabled={submitting} onClick={() => void createRule()} type="button">{submitting ? "Saving…" : "Add rule"}</button></div>
          </div>
        </section>

        {data.rules.length > 0 ? <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">Ordered by priority</p><h2>Active rules</h2></div><span className="result-count">{data.rules.length}</span></div>
          <div className="vuln-delta-list">{data.rules.map((rule) => <article className="case-routing-rule-row" key={rule.id}>
            <span className="settings-pill">P{rule.priority}</span>
            <div><strong>{rule.matchSeverity.length > 0 ? rule.matchSeverity.join(", ") : "any severity"}{rule.matchCustomerId ? ` · ${rule.matchCustomerId}` : ""}</strong><small>→ {targetLabel({ assignee: rule.routeAssignee, team: rule.routeTeam, destination: rule.routeDestination })}</small></div>
            <button className="button button-secondary button-small" disabled={submitting} onClick={() => void removeRule(rule.id)} type="button">Remove</button>
          </article>)}</div>
        </section> : null}

        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">Preview (no changes applied)</p><h2>How open cases would route</h2></div><span className="result-count">{data.preview.decisions.length}</span></div>
          {data.preview.decisions.length > 0 ? <div className="vuln-delta-list">{data.preview.decisions.map((decision) => <article className="case-routing-rule-row" key={decision.caseId}>
            <span className={decision.route ? "settings-pill is-good" : "settings-pill"}>{decision.route ? "routed" : "unrouted"}</span>
            <div><strong>{decision.caseId}</strong><small>{targetLabel(decision.route)} · {decision.reason}</small></div>
          </article>)}</div> : <p className="panel-footnote">No open cases to preview. Rules apply to open cases once they exist.</p>}
          <p className="panel-footnote">{data.preview.disclaimer}</p>
        </section>
      </> : null}
    </>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import type { CaseAssignee, CasePriority, CaseStatus, FindingCase } from "../../lib/case-management";
import { formatTimestamp, usePilotState } from "../components/use-pilot-state";
import styles from "./cases.module.css";

interface CasesResponse {
  readonly cases: readonly FindingCase[];
  readonly assignees: readonly CaseAssignee[];
  readonly case?: FindingCase;
  readonly error?: { readonly message?: string };
}

const priorities: readonly CasePriority[] = ["critical", "high", "medium", "low"];

function message(value: unknown): string {
  return value instanceof Error ? value.message : "Sutra could not update the case";
}

async function responseJson(response: Response): Promise<CasesResponse> {
  const body = await response.json().catch(() => null) as CasesResponse | null;
  if (!response.ok || body === null) throw new Error(body?.error?.message ?? "Sutra could not update the case");
  return body;
}

function dateInput(iso: string): string {
  const value = new Date(iso);
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function lifecycleActions(status: CaseStatus): readonly CaseStatus[] {
  if (status === "open") return ["investigating", "resolved", "closed"];
  if (status === "investigating") return ["open", "resolved", "closed"];
  if (status === "resolved") return ["open", "closed"];
  return ["open"];
}

function activityText(activity: FindingCase["activities"][number]): string {
  if (activity.kind === "created") return "created this case from current finding evidence";
  if (activity.kind === "note_added") return activity.detail.note ?? "added a note";
  if (activity.kind === "status_changed") return `changed status from ${activity.detail.from} to ${activity.detail.to}`;
  if (activity.kind === "assignment_changed") return "changed the assignee";
  if (activity.kind === "priority_changed") return `changed priority from ${activity.detail.from} to ${activity.detail.to}`;
  return `changed due date to ${activity.detail.to ?? "not available"}`;
}

export function CasesBrowser() {
  const { state, loading: stateLoading, error: stateError } = usePilotState();
  const connection = state?.connection ?? null;
  const connectionId = connection?.id ?? null;
  const findings = state?.findings ?? [];
  const [cases, setCases] = useState<readonly FindingCase[]>([]);
  const [assignees, setAssignees] = useState<readonly CaseAssignee[]>([]);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<CaseStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [createPriority, setCreatePriority] = useState<CasePriority>("high");
  const [createAssignee, setCreateAssignee] = useState("");
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    if (connectionId === null) return;
    let current = true;
    void fetch(`/api/v1/cases?connectionId=${encodeURIComponent(connectionId)}`, {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(responseJson)
      .then((body) => {
        if (!current) return;
        setCases(body.cases);
        setAssignees(body.assignees);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (current) setError(message(caught));
      });
    return () => { current = false; };
  }, [connectionId]);

  const activeFingerprints = useMemo(
    () => new Set(cases.filter((item) => item.status !== "closed").map((item) => item.findingFingerprint)),
    [cases],
  );
  const eligibleFindings = findings.filter((finding) => !activeFingerprints.has(finding.fingerprint));
  const filtered = cases.filter((item) => {
    const haystack = `${item.caseNumber} ${item.title} ${item.priority} ${item.assignee?.displayName ?? ""}`.toLocaleLowerCase("en-US");
    return (statusFilter === "all" || item.status === statusFilter) && haystack.includes(query.trim().toLocaleLowerCase("en-US"));
  });
  const totals = {
    active: cases.filter((item) => item.status === "open" || item.status === "investigating").length,
    overdue: cases.filter((item) => item.slaState === "overdue" || item.slaState === "missed").length,
    unassigned: cases.filter((item) => item.assignee === null && item.status !== "closed").length,
    resolved: cases.filter((item) => item.status === "resolved" || item.status === "closed").length,
  };

  async function mutate(operation: string, values: Readonly<Record<string, unknown>>, key: string): Promise<void> {
    if (connectionId === null) return;
    setWorking(key);
    setError(null);
    try {
      const response = await fetch("/api/v1/cases", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation, connectionId, ...values }),
      });
      const body = await responseJson(response);
      if (body.case !== undefined) {
        setCases((current) => {
          const exists = current.some((item) => item.id === body.case?.id);
          return exists ? current.map((item) => item.id === body.case?.id ? body.case! : item) : [body.case!, ...current];
        });
      }
    } catch (caught) {
      setError(message(caught));
    } finally {
      setWorking(null);
    }
  }

  async function createCase(): Promise<void> {
    if (!fingerprint) return;
    await mutate("create", {
      fingerprint,
      priority: createPriority,
      assigneeMembershipId: createAssignee || null,
    }, "create");
    setFingerprint("");
  }

  const overallError = stateError ?? error;

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Remediation operations</p><h1>Finding cases</h1><p className="page-subtitle">Durable ownership, SLA tracking, notes, and an immutable activity history linked to current AWS finding evidence.</p></div>
        <div className="heading-actions"><a className="button button-secondary" href="/findings">Review findings</a></div>
      </section>

      <div className="trust-strip" role="note"><span className="trust-icon">✓</span><span><strong>No synthetic work items.</strong> Every case originates from a fingerprint in the active immutable finding snapshot. Activity is actor-attributed, hash-linked, and database-protected against update or deletion.</span><a href="/controls#architecture">Review controls</a></div>

      {overallError ? <div className="page-alert page-alert-error" role="alert"><strong>Case workflow needs attention</strong><span>{overallError}</span></div> : null}
      {stateLoading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading scoped case workflow…</div> : null}

      {!stateLoading && connection === null ? <section className="panel empty-workspace"><span className="empty-workspace-icon">CASE</span><h2>No AWS account is connected</h2><p>Connect a customer account and publish finding evidence before creating cases.</p><a className="button button-primary" href="/onboard">Connect AWS account</a></section> : null}

      {connection !== null ? (
        <>
          <section className={styles.kpis} aria-label="Case management summary">
            <article><small>Active cases</small><strong>{totals.active}</strong><span>open or investigating</span></article>
            <article><small>SLA attention</small><strong>{totals.overdue}</strong><span>overdue or missed</span></article>
            <article><small>Unassigned</small><strong>{totals.unassigned}</strong><span>requires an owner</span></article>
            <article><small>Completed</small><strong>{totals.resolved}</strong><span>resolved or closed</span></article>
          </section>

          <section className={`panel ${styles.createPanel}`}>
            <div><p className="eyebrow">Create from live evidence</p><h2>Open a remediation case</h2><p>The title and source snapshot are copied from the selected current finding and remain traceable after later assessments.</p></div>
            <label><span>Current finding</span><select value={fingerprint} onChange={(event) => setFingerprint(event.target.value)}><option value="">Select a finding…</option>{eligibleFindings.map((finding) => <option key={finding.fingerprint} value={finding.fingerprint}>{finding.severity.toUpperCase()} · {finding.title}</option>)}</select></label>
            <label><span>Priority</span><select value={createPriority} onChange={(event) => setCreatePriority(event.target.value as CasePriority)}>{priorities.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
            <label><span>Assignee</span><select value={createAssignee} onChange={(event) => setCreateAssignee(event.target.value)}><option value="">Unassigned</option>{assignees.map((item) => <option key={item.membershipId} value={item.membershipId}>{item.displayName} · {item.role}</option>)}</select></label>
            <button className="button button-primary" disabled={!fingerprint || working === "create"} onClick={() => void createCase()} type="button">{working === "create" ? "Creating…" : "Create case"}</button>
          </section>

          <section className="panel">
            <div className="panel-heading"><div><p className="eyebrow">Scoped work queue</p><h2>Customer remediation cases</h2></div><span className="result-count">{filtered.length} of {cases.length}</span></div>
            <div className="filter-bar"><label className="search-field"><span className="sr-only">Search cases</span><input className="filter-control" placeholder="Search case, title or assignee" value={query} onChange={(event) => setQuery(event.target.value)} /></label><label><span className="sr-only">Filter cases by status</span><select className="filter-control" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as CaseStatus | "all")}><option value="all">All case states</option><option value="open">Open</option><option value="investigating">Investigating</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select></label></div>
            {filtered.length === 0 ? <div className="empty-state"><strong>{cases.length === 0 ? "No cases yet" : "No matching cases"}</strong><span>{cases.length === 0 ? "Select a current finding above to create the first real case." : "Adjust the queue filters."}</span></div> : (
              <div className={styles.caseList}>
                {filtered.map((item) => (
                  <details className={styles.caseCard} key={item.id}>
                    <summary>
                      <span className={`${styles.priority} ${styles[item.priority]}`}>{item.priority}</span>
                      <span className={styles.caseTitle}><small>{item.caseNumber}</small><strong>{item.title}</strong></span>
                      <span><small>Owner</small><strong>{item.assignee?.displayName ?? "Unassigned"}</strong></span>
                      <span><small>Due</small><strong>{new Date(item.dueAt).toLocaleDateString()}</strong></span>
                      <span className={`${styles.sla} ${styles[item.slaState]}`}>{item.slaState.replaceAll("_", " ")}</span>
                      <span className={styles.status}>{item.status}</span>
                    </summary>
                    <div className={styles.caseBody}>
                      <section className={styles.controls}>
                        <div><p className="eyebrow">Ownership and SLA</p><h3>Case controls</h3></div>
                        <label><span>Assignee</span><select value={item.assignee?.membershipId ?? ""} disabled={working === item.id} onChange={(event) => void mutate("assign", { caseId: item.id, assigneeMembershipId: event.target.value || null }, item.id)}><option value="">Unassigned</option>{assignees.map((assignee) => <option key={assignee.membershipId} value={assignee.membershipId}>{assignee.displayName}</option>)}</select></label>
                        <label><span>Priority</span><select value={item.priority} disabled={working === item.id} onChange={(event) => void mutate("prioritize", { caseId: item.id, priority: event.target.value }, item.id)}>{priorities.map((priority) => <option key={priority}>{priority}</option>)}</select></label>
                        <label><span>Due date</span><input type="datetime-local" value={dateInput(item.dueAt)} disabled={working === item.id} onChange={(event) => { if (event.target.value) void mutate("reschedule", { caseId: item.id, dueAt: new Date(event.target.value).toISOString() }, item.id); }} /></label>
                        <div className={styles.lifecycle}>{lifecycleActions(item.status).map((status) => <button className={status === "resolved" ? "button button-primary button-small" : "button button-secondary button-small"} disabled={working === item.id} key={status} onClick={() => void mutate("transition", { caseId: item.id, status }, item.id)} type="button">{status === "open" ? "Reopen" : status}</button>)}</div>
                        <div className={styles.evidence}><span>Finding</span><code>{item.findingFingerprint}</code><span>Snapshot</span><code>{item.findingSnapshotId}</code></div>
                      </section>
                      <section className={styles.timeline}>
                        <div><p className="eyebrow">Immutable history</p><h3>Activity timeline</h3></div>
                        <div className={styles.noteComposer}><textarea aria-label={`Add note to ${item.caseNumber}`} placeholder="Add investigation note…" value={notes[item.id] ?? ""} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} /><button className="button button-primary button-small" disabled={working === item.id || !(notes[item.id]?.trim())} onClick={() => { const note = notes[item.id]?.trim(); if (note) { void mutate("note", { caseId: item.id, note }, item.id); setNotes((current) => ({ ...current, [item.id]: "" })); } }} type="button">Add note</button></div>
                        <ol>{[...item.activities].reverse().map((activity) => <li key={activity.id}><i /><div><strong>{activity.actorName}</strong><p>{activityText(activity)}</p><small>{formatTimestamp(activity.occurredAt)} · hash {activity.eventHash.slice(0, 12)}</small></div></li>)}</ol>
                      </section>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}
    </>
  );
}

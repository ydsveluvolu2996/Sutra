"use client";

import { useCallback, useEffect, useState } from "react";

/* Compliance workspace panels: operator-defined custom frameworks, control
 * ownership, readiness trend, and auditor sign-off. Everything shown here is
 * labeled for what it is — custom mappings are operator assertions and the
 * trend reflects only evaluations that actually ran. */

interface CustomFrameworkEntry {
  readonly id: string;
  readonly updatedAt: string;
  readonly definition: { readonly name: string; readonly title: string; readonly controls: readonly unknown[] };
  readonly readiness: {
    readonly summary: Readonly<Record<"PASS" | "FAIL" | "UNKNOWN" | "NOT_COLLECTED", number>>;
    readonly disclaimer: string;
  };
}

interface Assignment {
  readonly controlId: string;
  readonly ownerTeam: string | null;
  readonly ownerEmail: string | null;
}

interface Signoff {
  readonly id: string;
  readonly decision: "approved" | "needs-work";
  readonly note: string | null;
  readonly signedBy: string;
  readonly reportSha256: string;
  readonly mfaVerified: boolean;
  readonly createdAt: string;
}

interface TrendSummary {
  readonly frameworkId: string;
  readonly direction: string;
  readonly delta: number | null;
  readonly currentScore: number | null;
  readonly pointCount: number;
}

const FRAMEWORK_IDS = ["pci-dss-v4", "hipaa-security-rule", "iso-27001-2022-annex-a", "nist-csf-2.0", "soc-2-tsc"];

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { cache: "no-store", credentials: "same-origin", ...init });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "error" in payload
      ? String((payload as { error: { message?: string } }).error?.message ?? "Request rejected")
      : "Request rejected";
    throw new Error(message);
  }
  return payload as T;
}

export function ComplianceWorkspacePanels({ connectionId, reportSha256 }: { connectionId: string | null; reportSha256: string | null }) {
  const [custom, setCustom] = useState<CustomFrameworkEntry[]>([]);
  const [customError, setCustomError] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftControls, setDraftControls] = useState('[\n  { "controlId": "A-1", "title": "Encrypt data at rest", "sutraControlIds": ["SUTRA.AWS.EBS.1"] }\n]');
  const [saving, setSaving] = useState(false);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [assignDraft, setAssignDraft] = useState({ controlId: "", ownerTeam: "", ownerEmail: "" });
  const [assignError, setAssignError] = useState<string | null>(null);
  const [signoffs, setSignoffs] = useState<Signoff[]>([]);
  const [signoffNote, setSignoffNote] = useState("");
  const [signoffError, setSignoffError] = useState<string | null>(null);
  const [trends, setTrends] = useState<TrendSummary[]>([]);

  const loadAll = useCallback(async () => {
    if (!connectionId) return;
    const results = await Promise.allSettled([
      requestJson<{ frameworks: CustomFrameworkEntry[] }>(`/api/v1/compliance/custom-frameworks?connectionId=${encodeURIComponent(connectionId)}`),
      requestJson<{ assignments: Assignment[] }>("/api/v1/compliance/control-assignments"),
      requestJson<{ signoffs: Signoff[] }>(`/api/v1/compliance/signoffs?connectionId=${encodeURIComponent(connectionId)}`),
      Promise.all(FRAMEWORK_IDS.map(async (frameworkId) => {
        const payload = await requestJson<{ trend: { direction: string; delta: number | null; current: { score: number | null } | null; series: readonly unknown[] } }>(
          `/api/v1/compliance/trend?connectionId=${encodeURIComponent(connectionId)}&framework=${encodeURIComponent(frameworkId)}`,
        );
        return {
          frameworkId,
          direction: payload.trend.direction,
          delta: payload.trend.delta,
          currentScore: payload.trend.current?.score ?? null,
          pointCount: payload.trend.series.length,
        };
      })),
    ]);
    if (results[0].status === "fulfilled") setCustom(results[0].value.frameworks);
    if (results[1].status === "fulfilled") setAssignments(results[1].value.assignments);
    if (results[2].status === "fulfilled") setSignoffs(results[2].value.signoffs);
    if (results[3].status === "fulfilled") setTrends(results[3].value);
  }, [connectionId]);

  useEffect(() => {
    void (async () => {
      await loadAll();
    })();
  }, [loadAll]);

  async function saveCustom() {
    if (!connectionId) return;
    setSaving(true);
    setCustomError(null);
    try {
      let controls: unknown;
      try {
        controls = JSON.parse(draftControls);
      } catch {
        throw new Error("Controls must be valid JSON (an array of { controlId, title, sutraControlIds })");
      }
      await requestJson("/api/v1/compliance/custom-frameworks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId, definition: { name: draftName.trim(), title: draftTitle.trim(), controls } }),
      });
      setDraftName("");
      setDraftTitle("");
      await loadAll();
    } catch (caught) {
      setCustomError(caught instanceof Error ? caught.message : "Save rejected");
    } finally {
      setSaving(false);
    }
  }

  async function deleteCustom(id: string) {
    if (!connectionId) return;
    try {
      await requestJson(`/api/v1/compliance/custom-frameworks?connectionId=${encodeURIComponent(connectionId)}&id=${encodeURIComponent(id)}`, { method: "DELETE" });
    } finally {
      await loadAll();
    }
  }

  async function saveAssignment() {
    setAssignError(null);
    try {
      await requestJson("/api/v1/compliance/control-assignments", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          controlId: assignDraft.controlId.trim(),
          ownerTeam: assignDraft.ownerTeam.trim() || null,
          ownerEmail: assignDraft.ownerEmail.trim() || null,
        }),
      });
      setAssignDraft({ controlId: "", ownerTeam: "", ownerEmail: "" });
      await loadAll();
    } catch (caught) {
      setAssignError(caught instanceof Error ? caught.message : "Assignment rejected");
    }
  }

  async function recordSignoff(decision: "approved" | "needs-work") {
    if (!connectionId || !reportSha256) return;
    setSignoffError(null);
    try {
      await requestJson("/api/v1/compliance/signoffs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId, reportSha256, decision, note: signoffNote.trim() || null }),
      });
      setSignoffNote("");
      await loadAll();
    } catch (caught) {
      setSignoffError(caught instanceof Error ? caught.message : "Sign-off rejected");
    }
  }

  if (!connectionId) return null;

  return (
    <>
      <section className="panel" aria-label="Readiness trend">
        <div className="panel-heading"><div><h2>Readiness trend</h2><p>Recorded each time framework readiness is evaluated against a published snapshot — gaps are gaps, never interpolated.</p></div></div>
        {trends.length === 0 ? <p className="panel-footnote">Trend points appear after readiness has been evaluated for at least one snapshot.</p> : (
          <table><thead><tr><th>Framework</th><th>Score</th><th>Direction</th><th>Δ</th><th>Points</th></tr></thead>
            <tbody>{trends.map((trend) => (
              <tr key={trend.frameworkId}>
                <td>{trend.frameworkId}</td>
                <td>{trend.currentScore ?? "—"}</td>
                <td>{trend.direction}</td>
                <td>{trend.delta === null ? "—" : trend.delta > 0 ? `+${trend.delta}` : trend.delta}</td>
                <td>{trend.pointCount}</td>
              </tr>
            ))}</tbody></table>
        )}
      </section>

      <section className="panel" aria-label="Custom frameworks">
        <div className="panel-heading"><div><h2>Custom frameworks</h2><p>Map your own control catalog onto collected Sutra control ids. A custom mapping is your assertion — evaluated with the same evidence-honest engine, never presented as licensed content.</p></div></div>
        <div className="cmdbq-row">
          <input aria-label="Name" placeholder="name (e.g. acme-baseline)" value={draftName} onChange={(event) => setDraftName(event.target.value)} />
          <input aria-label="Title" placeholder="title" value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} />
          <button type="button" className="button button-primary" disabled={saving || draftName.trim().length === 0 || draftTitle.trim().length === 0} onClick={() => void saveCustom()}>{saving ? "Saving…" : "Save framework"}</button>
        </div>
        <textarea className="cmpw-controls" aria-label="Controls JSON" rows={5} value={draftControls} onChange={(event) => setDraftControls(event.target.value)} />
        {customError ? <p className="cmdbq-error" role="alert">{customError}</p> : null}
        {custom.length > 0 ? (
          <table><thead><tr><th>Framework</th><th>Controls</th><th>PASS</th><th>FAIL</th><th>UNKNOWN</th><th>NOT_COLLECTED</th><th /></tr></thead>
            <tbody>{custom.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.definition.title} <code>({entry.definition.name})</code></td>
                <td>{entry.definition.controls.length}</td>
                <td>{entry.readiness.summary.PASS}</td>
                <td>{entry.readiness.summary.FAIL}</td>
                <td>{entry.readiness.summary.UNKNOWN}</td>
                <td>{entry.readiness.summary.NOT_COLLECTED}</td>
                <td><button type="button" className="button button-secondary" onClick={() => void deleteCustom(entry.id)}>Delete</button></td>
              </tr>
            ))}</tbody></table>
        ) : <p className="panel-footnote">No custom frameworks yet.</p>}
      </section>

      <section className="panel" aria-label="Control ownership">
        <div className="panel-heading"><div><h2>Control ownership</h2><p>Assign a responsible team per Sutra control id — operator-entered routing metadata, separate from evidence.</p></div></div>
        <div className="cmdbq-row">
          <input aria-label="Control id" placeholder="control id (e.g. SUTRA.AWS.EBS.1)" value={assignDraft.controlId} onChange={(event) => setAssignDraft((draft) => ({ ...draft, controlId: event.target.value }))} />
          <input aria-label="Owner team" placeholder="owner team" value={assignDraft.ownerTeam} onChange={(event) => setAssignDraft((draft) => ({ ...draft, ownerTeam: event.target.value }))} />
          <input aria-label="Owner email" placeholder="owner email" value={assignDraft.ownerEmail} onChange={(event) => setAssignDraft((draft) => ({ ...draft, ownerEmail: event.target.value }))} />
          <button type="button" className="button button-primary" disabled={assignDraft.controlId.trim().length === 0} onClick={() => void saveAssignment()}>Assign</button>
        </div>
        {assignError ? <p className="cmdbq-error" role="alert">{assignError}</p> : null}
        {assignments.length > 0 ? (
          <table><thead><tr><th>Control</th><th>Owner team</th><th>Owner email</th></tr></thead>
            <tbody>{assignments.map((assignment) => (
              <tr key={assignment.controlId}><td>{assignment.controlId}</td><td>{assignment.ownerTeam ?? "—"}</td><td>{assignment.ownerEmail ?? "—"}</td></tr>
            ))}</tbody></table>
        ) : <p className="panel-footnote">No control owners assigned yet.</p>}
      </section>

      <section className="panel" aria-label="Auditor sign-off">
        <div className="panel-heading"><div><h2>Auditor sign-off</h2><p>Record a reviewed decision against the current report hash. Sign-offs are append-only facts and never alter the hashed report itself.</p></div></div>
        <div className="cmdbq-row">
          <input aria-label="Note" placeholder="review note (optional)" value={signoffNote} onChange={(event) => setSignoffNote(event.target.value)} />
          <button type="button" className="button button-primary" disabled={!reportSha256} onClick={() => void recordSignoff("approved")}>Approve</button>
          <button type="button" className="button button-secondary" disabled={!reportSha256} onClick={() => void recordSignoff("needs-work")}>Needs work</button>
        </div>
        {reportSha256 ? <p className="panel-footnote">Signing report <code>{reportSha256.slice(0, 16)}…</code></p> : <p className="panel-footnote">Load the readiness report before signing.</p>}
        {signoffError ? <p className="cmdbq-error" role="alert">{signoffError}</p> : null}
        {signoffs.length > 0 ? (
          <table><thead><tr><th>Decision</th><th>By</th><th>Report</th><th>Note</th><th>When</th><th>MFA</th></tr></thead>
            <tbody>{signoffs.map((signoff) => (
              <tr key={signoff.id}>
                <td><span className={`cmdbq-chip ${signoff.decision === "approved" ? "cmdbq-added" : "cmdbq-changed"}`}>{signoff.decision}</span></td>
                <td>{signoff.signedBy}</td>
                <td><code>{signoff.reportSha256.slice(0, 12)}…</code></td>
                <td>{signoff.note ?? "—"}</td>
                <td>{signoff.createdAt}</td>
                <td>{signoff.mfaVerified ? "verified" : "not verified"}</td>
              </tr>
            ))}</tbody></table>
        ) : <p className="panel-footnote">No sign-offs recorded yet.</p>}
      </section>
    </>
  );
}

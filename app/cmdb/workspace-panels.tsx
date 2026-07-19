"use client";

import { useCallback, useEffect, useState } from "react";

/* CMDB workspace panels: structured query builder with saved queries,
 * snapshot change history, and resource ownership/custom-field annotations.
 * All data comes from the tenant-scoped /api/v1/cmdb/* and /api/v1/changes
 * routes; nothing here fabricates state — empty and error responses are
 * rendered as such. */

type PredicateKind = "field" | "tag" | "config";

interface PredicateDraft {
  kind: PredicateKind;
  field: string;
  key: string;
  op: string;
  value: string;
}

interface QueryMatch {
  readonly resourceKey: string;
  readonly service: string;
  readonly resourceType: string;
  readonly regionKey: string;
  readonly name: string | null;
  readonly nativeId: string;
}

interface SavedQuery {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly query: { readonly combine: "and" | "or"; readonly predicates: readonly unknown[] };
}

interface ChangeEvent {
  readonly resourceKey: string;
  readonly changeType: string;
  readonly changedPaths?: readonly string[];
  readonly toSnapshotId?: string;
}

interface ChangeHints {
  readonly hints: readonly { readonly resourceKey: string; readonly eventName: string; readonly eventSource: string; readonly eventTimeMs: number }[];
  readonly possibleNew: readonly { readonly resourceName: string; readonly eventName: string }[];
  readonly unmapped: readonly { readonly eventName: string; readonly count: number }[];
  readonly unassessedCount: number;
  readonly disclaimer: string;
}

interface Annotation {
  readonly resourceKey: string;
  readonly ownerTeam: string | null;
  readonly ownerEmail: string | null;
  readonly customFields: Readonly<Record<string, string>>;
  readonly updatedBy: string;
}

const FIELD_OPTIONS = ["service", "resourceType", "regionKey", "state", "name", "resourceKey", "arn", "nativeId"];
const OPS: Record<PredicateKind, readonly string[]> = {
  field: ["eq", "neq", "contains", "prefix"],
  tag: ["eq", "neq", "contains", "prefix", "exists", "missing"],
  config: ["eq", "neq", "contains", "exists", "missing", "gt", "lt"],
};

function emptyPredicate(): PredicateDraft {
  return { kind: "field", field: "service", key: "", op: "eq", value: "" };
}

function toEnginePredicate(draft: PredicateDraft): Record<string, unknown> {
  if (draft.kind === "field") return { kind: "field", field: draft.field, op: draft.op, value: draft.value };
  if (draft.kind === "tag") {
    const base: Record<string, unknown> = { kind: "tag", key: draft.key, op: draft.op };
    if (draft.op !== "exists" && draft.op !== "missing") base.value = draft.value;
    return base;
  }
  const base: Record<string, unknown> = { kind: "config", path: draft.key, op: draft.op };
  if (draft.op !== "exists" && draft.op !== "missing") {
    const numeric = Number(draft.value);
    base.value = draft.op === "gt" || draft.op === "lt"
      ? numeric
      : draft.value === "true" ? true : draft.value === "false" ? false : draft.value;
  }
  return base;
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { cache: "no-store", ...init });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "error" in payload
      ? String((payload as { error: { message?: string } }).error?.message ?? "Request rejected")
      : "Request rejected";
    throw new Error(message);
  }
  return payload as T;
}

export function CmdbWorkspacePanels({ connectionId }: { connectionId: string | null }) {
  const [predicates, setPredicates] = useState<PredicateDraft[]>([emptyPredicate()]);
  const [combine, setCombine] = useState<"and" | "or">("and");
  const [running, setRunning] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [result, setResult] = useState<{ matched: QueryMatch[]; totalMatched: number; evaluated: number; truncated: boolean } | null>(null);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [saveName, setSaveName] = useState("");
  const [changes, setChanges] = useState<ChangeEvent[] | null>(null);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [hints, setHints] = useState<ChangeHints | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationDraft, setAnnotationDraft] = useState({ resourceKey: "", ownerTeam: "", ownerEmail: "", fieldKey: "", fieldValue: "" });
  const [annotationError, setAnnotationError] = useState<string | null>(null);
  const [savingAnnotation, setSavingAnnotation] = useState(false);

  const loadSaved = useCallback(async () => {
    try {
      const payload = await requestJson<{ queries: SavedQuery[] }>("/api/v1/cmdb/saved-queries");
      setSaved(payload.queries);
    } catch {
      setSaved([]);
    }
  }, []);

  const loadAnnotations = useCallback(async () => {
    if (!connectionId) return;
    try {
      const payload = await requestJson<{ annotations: Annotation[] }>(`/api/v1/cmdb/annotations?connectionId=${encodeURIComponent(connectionId)}`);
      setAnnotations(payload.annotations);
    } catch {
      setAnnotations([]);
    }
  }, [connectionId]);

  useEffect(() => {
    void (async () => {
      await loadSaved();
      await loadAnnotations();
    })();
  }, [loadSaved, loadAnnotations]);

  useEffect(() => {
    if (!connectionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const payload = await requestJson<{ changes: ChangeEvent[] }>(`/api/v1/changes?connectionId=${encodeURIComponent(connectionId)}&limit=100`);
        if (!cancelled) { setChanges(payload.changes); setChangesError(null); }
        const hintPayload = await requestJson<{ status: string; hints: ChangeHints | null }>(`/api/v1/cmdb/change-hints?connectionId=${encodeURIComponent(connectionId)}`);
        if (!cancelled) setHints(hintPayload.status === "ok" ? hintPayload.hints : null);
      } catch (caught) {
        if (!cancelled) { setChanges([]); setChangesError(caught instanceof Error ? caught.message : "Change history unavailable"); }
      }
    })();
    return () => { cancelled = true; };
  }, [connectionId]);

  async function runQuery(overridePredicates?: readonly unknown[], overrideCombine?: "and" | "or") {
    if (!connectionId) return;
    setRunning(true);
    setQueryError(null);
    try {
      const body = {
        connectionId,
        query: {
          combine: overrideCombine ?? combine,
          predicates: overridePredicates ?? predicates.map(toEnginePredicate),
        },
      };
      const payload = await requestJson<{ result: { matched: QueryMatch[]; totalMatched: number; evaluated: number; truncated: boolean } }>(
        "/api/v1/cmdb/query",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      );
      setResult(payload.result);
    } catch (caught) {
      setResult(null);
      setQueryError(caught instanceof Error ? caught.message : "Query rejected");
    } finally {
      setRunning(false);
    }
  }

  async function saveCurrentQuery() {
    if (saveName.trim().length === 0) return;
    try {
      await requestJson("/api/v1/cmdb/saved-queries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: saveName.trim(), description: null, query: { combine, predicates: predicates.map(toEnginePredicate) } }),
      });
      setSaveName("");
      await loadSaved();
    } catch (caught) {
      setQueryError(caught instanceof Error ? caught.message : "Save rejected");
    }
  }

  async function deleteSaved(id: string) {
    try {
      await requestJson(`/api/v1/cmdb/saved-queries?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadSaved();
    } catch {
      /* listing refresh below will show the truth */
      await loadSaved();
    }
  }

  async function saveAnnotation() {
    if (!connectionId || annotationDraft.resourceKey.trim().length === 0) return;
    setSavingAnnotation(true);
    setAnnotationError(null);
    try {
      const customFields: Record<string, string> = {};
      if (annotationDraft.fieldKey.trim().length > 0) customFields[annotationDraft.fieldKey.trim()] = annotationDraft.fieldValue;
      await requestJson("/api/v1/cmdb/annotations", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId,
          annotation: {
            resourceKey: annotationDraft.resourceKey.trim(),
            ownerTeam: annotationDraft.ownerTeam.trim() || null,
            ownerEmail: annotationDraft.ownerEmail.trim() || null,
            customFields,
          },
        }),
      });
      setAnnotationDraft({ resourceKey: "", ownerTeam: "", ownerEmail: "", fieldKey: "", fieldValue: "" });
      await loadAnnotations();
    } catch (caught) {
      setAnnotationError(caught instanceof Error ? caught.message : "Annotation rejected");
    } finally {
      setSavingAnnotation(false);
    }
  }

  function updatePredicate(index: number, patch: Partial<PredicateDraft>) {
    setPredicates((current) => current.map((predicate, i) => (i === index ? { ...predicate, ...patch } : predicate)));
  }

  if (!connectionId) return null;

  return (
    <>
      <section className="panel" aria-label="CMDB query">
        <div className="panel-heading"><div><h2>Query the inventory</h2><p>Structured predicates over the published snapshot — fields, tags, and configuration paths. Deterministic, no free-text expressions.</p></div></div>
        <div className="cmdbq-rows">
          {predicates.map((predicate, index) => (
            <div key={index} className="cmdbq-row">
              <select aria-label="Predicate kind" value={predicate.kind} onChange={(event) => updatePredicate(index, { kind: event.target.value as PredicateKind, op: "eq" })}>
                <option value="field">Field</option><option value="tag">Tag</option><option value="config">Config path</option>
              </select>
              {predicate.kind === "field" ? (
                <select aria-label="Field" value={predicate.field} onChange={(event) => updatePredicate(index, { field: event.target.value })}>
                  {FIELD_OPTIONS.map((field) => <option key={field} value={field}>{field}</option>)}
                </select>
              ) : (
                <input aria-label={predicate.kind === "tag" ? "Tag key" : "Config path"} placeholder={predicate.kind === "tag" ? "tag key (e.g. env)" : "path (e.g. encrypted or ports.0.port)"} value={predicate.key} onChange={(event) => updatePredicate(index, { key: event.target.value })} />
              )}
              <select aria-label="Operator" value={predicate.op} onChange={(event) => updatePredicate(index, { op: event.target.value })}>
                {OPS[predicate.kind].map((op) => <option key={op} value={op}>{op}</option>)}
              </select>
              {predicate.op !== "exists" && predicate.op !== "missing" ? (
                <input aria-label="Value" placeholder="value" value={predicate.value} onChange={(event) => updatePredicate(index, { value: event.target.value })} />
              ) : <span className="cmdbq-novalue">—</span>}
              <button type="button" className="button button-secondary" onClick={() => setPredicates((current) => current.filter((_, i) => i !== index))} disabled={predicates.length === 1}>Remove</button>
            </div>
          ))}
        </div>
        <div className="cmdbq-actions">
          <button type="button" className="button button-secondary" onClick={() => setPredicates((current) => [...current, emptyPredicate()])}>Add predicate</button>
          <select aria-label="Combine" value={combine} onChange={(event) => setCombine(event.target.value as "and" | "or")}>
            <option value="and">Match all (AND)</option><option value="or">Match any (OR)</option>
          </select>
          <button type="button" className="button button-primary" disabled={running} onClick={() => void runQuery()}>{running ? "Running…" : "Run query"}</button>
          <input aria-label="Save as" placeholder="Save as…" value={saveName} onChange={(event) => setSaveName(event.target.value)} />
          <button type="button" className="button button-secondary" disabled={saveName.trim().length === 0} onClick={() => void saveCurrentQuery()}>Save query</button>
        </div>
        {queryError ? <p className="cmdbq-error" role="alert">{queryError}</p> : null}
        {result ? (
          <div className="cmdbq-results">
            <p className="cmdbq-summary">{result.totalMatched} matched of {result.evaluated} evaluated{result.truncated ? ` — showing the first ${result.matched.length}` : ""}</p>
            <table><thead><tr><th>Resource</th><th>Type</th><th>Region</th><th>Native ID</th></tr></thead>
              <tbody>{result.matched.map((match) => (
                <tr key={match.resourceKey}><td>{match.name ?? match.resourceKey}</td><td>{match.resourceType}</td><td>{match.regionKey}</td><td>{match.nativeId}</td></tr>
              ))}</tbody></table>
          </div>
        ) : null}
        {saved.length > 0 ? (
          <div className="cmdbq-saved">
            <h3>Saved queries</h3>
            {saved.map((entry) => (
              <div key={entry.id} className="cmdbq-saved-row">
                <span>{entry.name}</span>
                <button type="button" className="button button-secondary" onClick={() => void runQuery(entry.query.predicates, entry.query.combine)}>Run</button>
                <button type="button" className="button button-secondary" onClick={() => void deleteSaved(entry.id)}>Delete</button>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="panel" aria-label="Change history">
        <div className="panel-heading"><div><h2>Change history</h2><p>Immutable per-resource deltas between published snapshots — added, changed (with the exact paths), and removed.</p></div></div>
        {changesError ? <p className="cmdbq-error" role="alert">{changesError}</p> : null}
        {changes === null ? <p className="panel-footnote">Loading change history…</p> : changes.length === 0 ? (
          <p className="panel-footnote">No changes recorded yet — history appears after the second published snapshot.</p>
        ) : (
          <table><thead><tr><th>Change</th><th>Resource</th><th>Paths</th></tr></thead>
            <tbody>{changes.map((change, index) => (
              <tr key={`${change.resourceKey}-${index}`}>
                <td><span className={`cmdbq-chip cmdbq-${change.changeType}`}>{change.changeType}</span></td>
                <td>{change.resourceKey}</td>
                <td>{(change.changedPaths ?? []).slice(0, 6).join(", ") || "—"}</td>
              </tr>
            ))}</tbody></table>
        )}
      </section>

      <section className="panel" aria-label="Event-observed change hints">
        <div className="panel-heading"><div><h2>Changed since the snapshot (event-observed)</h2><p>CloudTrail management events that likely modified resources after the published snapshot. Hints only — the CMDB projection changes exclusively through a complete collection.</p></div></div>
        {hints === null ? <p className="panel-footnote">No event window available — hints appear once security events are collected after a published snapshot.</p> : (
          <>
            {hints.hints.length === 0 ? <p className="panel-footnote">No mutating events name a snapshot resource in the current window.</p> : (
              <table><thead><tr><th>Resource</th><th>Event</th><th>Source</th><th>When</th></tr></thead>
                <tbody>{hints.hints.slice(0, 50).map((hint, index) => (
                  <tr key={`${hint.resourceKey}-${index}`}><td>{hint.resourceKey}</td><td>{hint.eventName}</td><td>{hint.eventSource}</td><td>{new Date(hint.eventTimeMs).toISOString()}</td></tr>
                ))}</tbody></table>
            )}
            {hints.possibleNew.length > 0 ? <p className="panel-footnote">Possible new resources (not in the snapshot): {hints.possibleNew.slice(0, 8).map((entry) => `${entry.resourceName} (${entry.eventName})`).join(" · ")}</p> : null}
            {hints.unmapped.length > 0 ? <p className="panel-footnote">Mutating events naming no resource: {hints.unmapped.slice(0, 6).map((entry) => `${entry.eventName} ×${entry.count}`).join(" · ")}</p> : null}
            {hints.unassessedCount > 0 ? <p className="panel-footnote">{hints.unassessedCount} events had unknown mutability and were not assessed.</p> : null}
            <p className="panel-footnote">{hints.disclaimer}</p>
          </>
        )}
      </section>

      <section className="panel" aria-label="Ownership and custom fields">
        <div className="panel-heading"><div><h2>Ownership &amp; custom fields</h2><p>Operator-entered metadata — kept separate from collected evidence, never presented as an observation.</p></div></div>
        <div className="cmdbq-row cmdbq-annotation">
          <input aria-label="Resource key" list="cmdbq-resource-keys" placeholder="resource key" value={annotationDraft.resourceKey} onChange={(event) => setAnnotationDraft((d) => ({ ...d, resourceKey: event.target.value }))} />
          <datalist id="cmdbq-resource-keys">{(result?.matched ?? []).map((match) => <option key={match.resourceKey} value={match.resourceKey} />)}</datalist>
          <input aria-label="Owner team" placeholder="owner team" value={annotationDraft.ownerTeam} onChange={(event) => setAnnotationDraft((d) => ({ ...d, ownerTeam: event.target.value }))} />
          <input aria-label="Owner email" placeholder="owner email" value={annotationDraft.ownerEmail} onChange={(event) => setAnnotationDraft((d) => ({ ...d, ownerEmail: event.target.value }))} />
          <input aria-label="Custom field key" placeholder="field (e.g. costCenter)" value={annotationDraft.fieldKey} onChange={(event) => setAnnotationDraft((d) => ({ ...d, fieldKey: event.target.value }))} />
          <input aria-label="Custom field value" placeholder="value" value={annotationDraft.fieldValue} onChange={(event) => setAnnotationDraft((d) => ({ ...d, fieldValue: event.target.value }))} />
          <button type="button" className="button button-primary" disabled={savingAnnotation || annotationDraft.resourceKey.trim().length === 0} onClick={() => void saveAnnotation()}>{savingAnnotation ? "Saving…" : "Save"}</button>
        </div>
        {annotationError ? <p className="cmdbq-error" role="alert">{annotationError}</p> : null}
        {annotations.length > 0 ? (
          <table><thead><tr><th>Resource</th><th>Owner team</th><th>Owner email</th><th>Custom fields</th></tr></thead>
            <tbody>{annotations.map((annotation) => (
              <tr key={annotation.resourceKey}>
                <td>{annotation.resourceKey}</td>
                <td>{annotation.ownerTeam ?? "—"}</td>
                <td>{annotation.ownerEmail ?? "—"}</td>
                <td>{Object.entries(annotation.customFields).map(([key, value]) => `${key}=${value}`).join(" · ") || "—"}</td>
              </tr>
            ))}</tbody></table>
        ) : <p className="panel-footnote">No annotations yet.</p>}
      </section>
    </>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/* CMDB dependency graph: pick a resource and view what it depends on, what
 * depends on it, or its blast radius — a typed adjacency list grouped by
 * relationship type. Every edge is labelled derived-from-<field> or
 * manually-asserted; nothing here fabricates a relationship. All data comes from
 * the tenant-scoped /api/v1/cmdb/relationships route; empty and error responses
 * are rendered honestly. */

type Mode = "neighbors" | "dependencies" | "dependents" | "blast-radius";

interface GraphNode {
  readonly key: string;
  readonly present: boolean;
  readonly service: string | null;
  readonly resourceType: string | null;
  readonly region: string | null;
  readonly name: string | null;
}

interface Edge {
  readonly fromKey: string;
  readonly toKey: string;
  readonly type: string;
  readonly source: "derived" | "manual";
  readonly derivedFrom: string | null;
  readonly direction: "depends-on" | "depended-on-by";
  readonly note?: string | null;
}

interface NeighborEdge {
  readonly edge: Edge;
  readonly neighbor: GraphNode;
  readonly role: "from" | "to";
}

interface TraversalReach {
  readonly node: GraphNode;
  readonly depth: number;
  readonly edge: Edge;
}

interface Summary {
  readonly resourceCount: number;
  readonly derivedEdgeCount: number;
  readonly manualEdgeCount: number;
  readonly externalNodeCount: number;
}

interface PickerNode {
  readonly key: string;
  readonly service: string | null;
  readonly resourceType: string | null;
  readonly region: string | null;
  readonly name: string | null;
}

interface ManualEdgeRecord {
  readonly id: string;
  readonly fromKey: string;
  readonly toKey: string;
  readonly relType: string;
  readonly note: string | null;
  readonly createdBy: string;
}

interface Overview {
  readonly connection: { readonly id: string; readonly customerName: string };
  readonly hasSnapshot: boolean;
  readonly summary: Summary;
  readonly nodes: readonly PickerNode[];
  readonly nodesTruncated: boolean;
  readonly manualEdges: readonly ManualEdgeRecord[];
}

interface TraversalResponse {
  readonly resourceKey: string;
  readonly found: boolean;
  readonly summary: Summary;
  readonly mode?: Mode;
  readonly root?: GraphNode | null;
  readonly dependencies?: readonly NeighborEdge[];
  readonly dependents?: readonly NeighborEdge[];
  readonly reached?: readonly TraversalReach[];
  readonly maxDepth?: number;
  readonly truncated?: boolean;
}

const MODES: readonly { readonly value: Mode; readonly label: string }[] = [
  { value: "neighbors", label: "Direct neighbors" },
  { value: "dependencies", label: "Dependencies (what it needs)" },
  { value: "dependents", label: "Dependents (what needs it)" },
  { value: "blast-radius", label: "Blast radius (impact if it fails)" },
];

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { cache: "no-store", ...init });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String((payload as { error: { message?: string } }).error?.message ?? "Request rejected")
        : "Request rejected";
    throw new Error(message);
  }
  return payload as T;
}

function shortKey(key: string): string {
  return key.length <= 44 ? key : `…${key.slice(-42)}`;
}

function nodeLabel(node: GraphNode): string {
  return node.name?.trim() || (node.present ? shortKey(node.key) : node.key);
}

function pickerLabel(node: PickerNode): string {
  return node.name?.trim() || shortKey(node.key);
}

function ProvenanceChip({ edge }: { edge: Edge }) {
  if (edge.source === "manual") {
    return (
      <span className="cmdbq-chip cmdbq-manual" title={edge.note ?? undefined}>
        manually-asserted{edge.note ? " · noted" : ""}
      </span>
    );
  }
  return (
    <span className="cmdbq-chip cmdbq-derived" title={`Derived from configuration field: ${edge.derivedFrom ?? "unknown"}`}>
      derived-from {edge.derivedFrom ?? "config"}
    </span>
  );
}

function EdgeRow({ neighbor, edge, depth }: { neighbor: GraphNode; edge: Edge; depth?: number }) {
  return (
    <tr>
      <td>
        <strong>{nodeLabel(neighbor)}</strong>
        {neighbor.present ? (
          <small>
            {neighbor.resourceType ?? "resource"}
            {neighbor.region ? ` · ${neighbor.region}` : ""}
          </small>
        ) : (
          <small className="cmdbq-chip cmdbq-external" title="Referenced by configuration but not in the collected snapshot">
            external / unresolved
          </small>
        )}
      </td>
      <td>
        <code>{edge.type}</code>
      </td>
      <td>
        <ProvenanceChip edge={edge} />
      </td>
      {depth === undefined ? null : <td>{depth}</td>}
    </tr>
  );
}

function groupByType<T extends { edge: Edge }>(items: readonly T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const bucket = groups.get(item.edge.type);
    if (bucket === undefined) groups.set(item.edge.type, [item]);
    else bucket.push(item);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], "en-US"));
}

function AdjacencyList({
  title,
  items,
  emptyMessage,
  withDepth,
}: {
  title: string;
  items: readonly { edge: Edge; neighbor: GraphNode; depth?: number }[];
  emptyMessage: string;
  withDepth?: boolean;
}) {
  if (items.length === 0) {
    return (
      <div className="cmdbq-results">
        <h3>{title}</h3>
        <p className="panel-footnote">{emptyMessage}</p>
      </div>
    );
  }
  return (
    <div className="cmdbq-results">
      <h3>
        {title} <span className="result-count">{items.length}</span>
      </h3>
      {groupByType(items).map(([type, group]) => (
        <div key={type} className="cmdbq-saved">
          <table>
            <thead>
              <tr>
                <th>Resource</th>
                <th>Relationship</th>
                <th>Evidence</th>
                {withDepth ? <th>Depth</th> : null}
              </tr>
            </thead>
            <tbody>
              {group.map((item, index) => (
                <EdgeRow key={`${item.neighbor.key}-${index}`} neighbor={item.neighbor} edge={item.edge} depth={withDepth ? item.depth : undefined} />
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

export function DependenciesPanel() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("neighbors");
  const [depth, setDepth] = useState(3);
  const [traversal, setTraversal] = useState<TraversalResponse | null>(null);
  const [traversalError, setTraversalError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const [draftType, setDraftType] = useState("depends-on");
  const [draftNote, setDraftNote] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [savingManual, setSavingManual] = useState(false);

  const loadOverview = useCallback(async () => {
    try {
      const payload = await requestJson<Overview>("/api/v1/cmdb/relationships");
      setOverview(payload);
      setOverviewError(null);
    } catch (caught) {
      setOverview(null);
      setOverviewError(caught instanceof Error ? caught.message : "The dependency graph is unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadOverview();
    })();
  }, [loadOverview]);

  const runTraversal = useCallback(async (key: string, activeMode: Mode, activeDepth: number) => {
    setRunning(true);
    setTraversalError(null);
    try {
      const params = new URLSearchParams({ resourceKey: key, mode: activeMode });
      if (activeMode === "blast-radius") params.set("depth", String(activeDepth));
      const payload = await requestJson<TraversalResponse>(`/api/v1/cmdb/relationships?${params.toString()}`);
      setTraversal(payload);
    } catch (caught) {
      setTraversal(null);
      setTraversalError(caught instanceof Error ? caught.message : "Traversal rejected");
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (selectedKey === null) {
        if (!cancelled) setTraversal(null);
        return;
      }
      await runTraversal(selectedKey, mode, depth);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedKey, mode, depth, runTraversal]);

  const filteredNodes = useMemo(() => {
    const nodes = overview?.nodes ?? [];
    const needle = search.trim().toLowerCase();
    const matches = needle.length === 0
      ? nodes
      : nodes.filter((node) => `${node.name ?? ""} ${node.key} ${node.resourceType ?? ""} ${node.region ?? ""} ${node.service ?? ""}`.toLowerCase().includes(needle));
    return matches.slice(0, 100);
  }, [overview?.nodes, search]);

  const selectResource = useCallback((key: string) => {
    setSelectedKey(key);
    setDraftFrom(key);
  }, []);

  async function saveManualEdge() {
    if (draftFrom.trim().length === 0 || draftTo.trim().length === 0) return;
    setSavingManual(true);
    setManualError(null);
    try {
      await requestJson("/api/v1/cmdb/relationships", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromKey: draftFrom.trim(),
          toKey: draftTo.trim(),
          relType: draftType.trim(),
          note: draftNote.trim() || null,
        }),
      });
      setDraftTo("");
      setDraftNote("");
      await loadOverview();
      if (selectedKey !== null) await runTraversal(selectedKey, mode, depth);
    } catch (caught) {
      setManualError(caught instanceof Error ? caught.message : "The manual relationship was rejected");
    } finally {
      setSavingManual(false);
    }
  }

  async function deleteManualEdge(id: string) {
    try {
      await requestJson(`/api/v1/cmdb/relationships?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    } finally {
      await loadOverview();
      if (selectedKey !== null) await runTraversal(selectedKey, mode, depth);
    }
  }

  const summary = overview?.summary ?? traversal?.summary ?? null;
  const selectedNode = useMemo(
    () => (overview?.nodes ?? []).find((node) => node.key === selectedKey) ?? null,
    [overview?.nodes, selectedKey],
  );

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Configuration management database</p>
          <h1>Dependency &amp; blast-radius graph</h1>
          <p className="page-subtitle">
            Typed relationships derived from collected configuration, plus your manually asserted edges. Trace what a
            resource depends on, what depends on it, and its blast radius — every edge labelled by its evidence.
          </p>
        </div>
        <div className="heading-actions">
          <a className="button button-secondary" href="/cmdb">
            Back to inventory
          </a>
        </div>
      </section>

      <div className="trust-strip" role="note">
        <span className="trust-icon">i</span>
        <span>
          <strong>Read-only.</strong> Derived edges come only from configuration fields that are actually present; a key
          a field references but that is not in the snapshot is shown as <em>external / unresolved</em>, never invented.
          Manual edges are always labelled <em>manually-asserted</em>.
        </span>
      </div>

      {overviewError ? (
        <div className="page-alert page-alert-error" role="alert">
          <strong>The dependency graph is unavailable</strong>
          <span>{overviewError}</span>
          <button type="button" onClick={() => void loadOverview()}>
            Retry
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="loading-state" role="status">
          <span className="loading-spinner" />
          Loading the dependency graph…
        </div>
      ) : null}

      {!loading && overview !== null && !overview.hasSnapshot ? (
        <section className="panel empty-workspace compact-empty">
          <h2>No complete snapshot has been published</h2>
          <p>Run or simulate an inventory collection first — the dependency graph is derived from the active snapshot.</p>
          <a className="button button-primary" href="/cmdb">
            Open inventory
          </a>
        </section>
      ) : null}

      {!loading && overview !== null && overview.hasSnapshot ? (
        <>
          {summary ? (
            <section className="inventory-stats">
              <article>
                <small>Resources</small>
                <strong>{summary.resourceCount.toLocaleString()}</strong>
                <span>Nodes in the graph</span>
              </article>
              <article>
                <small>Derived edges</small>
                <strong>{summary.derivedEdgeCount.toLocaleString()}</strong>
                <span>From collected configuration</span>
              </article>
              <article>
                <small>Manual edges</small>
                <strong>{summary.manualEdgeCount.toLocaleString()}</strong>
                <span>Operator-asserted</span>
              </article>
              <article>
                <small>External nodes</small>
                <strong>{summary.externalNodeCount.toLocaleString()}</strong>
                <span>Referenced but not collected</span>
              </article>
            </section>
          ) : null}

          <section className="panel" aria-label="Select a resource">
            <div className="panel-heading">
              <div>
                <h2>Pick a resource</h2>
                <p>Search the collected resources, then choose a traversal.</p>
              </div>
            </div>
            <div className="filter-bar">
              <label className="search-field">
                <span className="sr-only">Search resources</span>
                <input
                  className="filter-control"
                  placeholder="Search name, key, type or region"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <label>
                <span className="sr-only">Traversal mode</span>
                <select className="filter-control" value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
                  {MODES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {mode === "blast-radius" ? (
                <label>
                  <span className="sr-only">Max depth</span>
                  <select className="filter-control" value={depth} onChange={(event) => setDepth(Number(event.target.value))}>
                    {[1, 2, 3, 4, 5, 6].map((value) => (
                      <option key={value} value={value}>
                        Depth {value}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            <div className="cmdbq-saved">
              {filteredNodes.length === 0 ? (
                <p className="panel-footnote">No resources match the current search.</p>
              ) : (
                filteredNodes.map((node) => (
                  <div key={node.key} className="cmdbq-saved-row">
                    <span>
                      <strong>{pickerLabel(node)}</strong>{" "}
                      <small>
                        {node.resourceType ?? node.service ?? "resource"}
                        {node.region ? ` · ${node.region}` : ""}
                      </small>
                    </span>
                    <button
                      type="button"
                      className={selectedKey === node.key ? "button button-primary" : "button button-secondary"}
                      onClick={() => selectResource(node.key)}
                    >
                      {selectedKey === node.key ? "Selected" : "Select"}
                    </button>
                  </div>
                ))
              )}
              {overview.nodesTruncated ? (
                <p className="panel-footnote">Only the first resources are listed — refine your search to narrow the picker.</p>
              ) : null}
            </div>
          </section>

          <section className="panel" aria-label="Relationships">
            <div className="panel-heading">
              <div>
                <h2>{selectedNode ? pickerLabel(selectedNode) : "Relationships"}</h2>
                <p>{selectedKey ? MODES.find((option) => option.value === mode)?.label : "Select a resource to trace its relationships."}</p>
              </div>
              {running ? <span className="status-pill status-medium">Tracing…</span> : null}
            </div>
            {traversalError ? (
              <p className="cmdbq-error" role="alert">
                {traversalError}
              </p>
            ) : null}
            {selectedKey === null ? (
              <p className="panel-footnote">No resource selected.</p>
            ) : traversal !== null && traversal.found === false ? (
              <p className="panel-footnote">
                This resource key is not in the current graph — it may have been removed since the snapshot was published.
              </p>
            ) : traversal !== null && traversal.mode === "neighbors" ? (
              <>
                <AdjacencyList
                  title="Depends on"
                  items={(traversal.dependencies ?? []).map((item) => ({ edge: item.edge, neighbor: item.neighbor }))}
                  emptyMessage="No dependencies are derived from configuration or asserted for this resource."
                />
                <AdjacencyList
                  title="Depended on by"
                  items={(traversal.dependents ?? []).map((item) => ({ edge: item.edge, neighbor: item.neighbor }))}
                  emptyMessage="No other collected resource depends on this one."
                />
              </>
            ) : traversal !== null ? (
              <>
                <AdjacencyList
                  title={
                    traversal.mode === "dependencies"
                      ? "Everything it depends on"
                      : traversal.mode === "blast-radius"
                        ? "Blast radius"
                        : "Everything that depends on it"
                  }
                  items={(traversal.reached ?? []).map((item) => ({ edge: item.edge, neighbor: item.node, depth: item.depth }))}
                  emptyMessage="Nothing reachable through the graph in this direction."
                  withDepth
                />
                {traversal.truncated ? (
                  <p className="panel-footnote">Stopped at depth {traversal.maxDepth} — increase the depth to trace further.</p>
                ) : null}
              </>
            ) : null}
          </section>

          <section className="panel" aria-label="Manual relationships">
            <div className="panel-heading">
              <div>
                <h2>Assert a manual relationship</h2>
                <p>Operator-declared edges between two collected resources — kept separate from derived evidence and always labelled manually-asserted.</p>
              </div>
            </div>
            <div className="cmdbq-row cmdbq-annotation">
              <input
                aria-label="From resource key"
                list="cmdbq-dependency-keys"
                placeholder="from resource key"
                value={draftFrom}
                onChange={(event) => setDraftFrom(event.target.value)}
              />
              <input
                aria-label="To resource key"
                list="cmdbq-dependency-keys"
                placeholder="to resource key"
                value={draftTo}
                onChange={(event) => setDraftTo(event.target.value)}
              />
              <datalist id="cmdbq-dependency-keys">
                {(overview.nodes ?? []).map((node) => (
                  <option key={node.key} value={node.key}>
                    {pickerLabel(node)}
                  </option>
                ))}
              </datalist>
              <input
                aria-label="Relationship type"
                placeholder="type (e.g. depends-on)"
                value={draftType}
                onChange={(event) => setDraftType(event.target.value)}
              />
              <input
                aria-label="Note"
                placeholder="note (optional)"
                value={draftNote}
                onChange={(event) => setDraftNote(event.target.value)}
              />
              <button
                type="button"
                className="button button-primary"
                disabled={savingManual || draftFrom.trim().length === 0 || draftTo.trim().length === 0}
                onClick={() => void saveManualEdge()}
              >
                {savingManual ? "Saving…" : "Assert edge"}
              </button>
            </div>
            {manualError ? (
              <p className="cmdbq-error" role="alert">
                {manualError}
              </p>
            ) : null}
            {overview.manualEdges.length > 0 ? (
              <table>
                <thead>
                  <tr>
                    <th>From</th>
                    <th>To</th>
                    <th>Type</th>
                    <th>Note</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {overview.manualEdges.map((edge) => (
                    <tr key={edge.id}>
                      <td title={edge.fromKey}>{shortKey(edge.fromKey)}</td>
                      <td title={edge.toKey}>{shortKey(edge.toKey)}</td>
                      <td>
                        <code>{edge.relType}</code>
                      </td>
                      <td>{edge.note ?? "—"}</td>
                      <td>
                        <button type="button" className="button button-secondary" onClick={() => void deleteManualEdge(edge.id)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="panel-footnote">No manual relationships asserted yet.</p>
            )}
          </section>
        </>
      ) : null}
    </>
  );
}

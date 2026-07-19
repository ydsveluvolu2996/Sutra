"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { KubernetesAttackPath } from "../../../lib/kubernetes-attack-paths";
import type { PilotFinding } from "../../../lib/pilot-types";
import {
  buildSecurityGraphLayout,
  type SecurityGraphEdge,
} from "../../../lib/kubernetes-security-graph";
import { formatTimestamp } from "../../components/use-pilot-state";

// Severity → colour and rank. A node that carries findings is badged and its
// ring tinted by its worst finding, the way Wiz conveys risk on the node.
const SEVERITY_COLOR: Readonly<Record<string, string>> = {
  critical: "#e0435a", high: "#e0952a", medium: "#eab308", low: "#3f83f8",
};
const SEVERITY_RANK: Readonly<Record<string, number>> = { critical: 4, high: 3, medium: 2, low: 1 };

function worstSeverity(findings: readonly PilotFinding[]): string | null {
  let worst: string | null = null;
  for (const finding of findings) {
    if (worst === null || (SEVERITY_RANK[finding.severity] ?? 0) > (SEVERITY_RANK[worst] ?? 0)) worst = finding.severity;
  }
  return worst;
}

// Node colors and glyphs by evidence kind. White canvas + colored ring +
// type icon, the readable Wiz-style treatment, over Sutra's cited edges.
const KIND_COLOR: Readonly<Record<string, string>> = {
  internet: "#e0435a",
  load_balancer: "#e0952a",
  security_group: "#e0952a",
  kubernetes_exposure: "#ef7834",
  kubernetes_workload: "#3f83f8",
  container_image: "#6d6ff2",
  runtime_event: "#e0435a",
  service_account: "#b45cd8",
  rbac_binding: "#b45cd8",
  rbac_role: "#b45cd8",
  iam_role: "#29ac74",
  aws_resource: "#29ac74",
  other: "#8399a2",
};

const KIND_GLYPH: Readonly<Record<string, ReactNode>> = {
  internet: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17" /><path d="M12 3.5a14 14 0 0 1 0 17 14 14 0 0 1 0-17Z" /></>,
  load_balancer: <><circle cx="17.5" cy="6" r="2.2" /><circle cx="6.5" cy="12" r="2.2" /><circle cx="17.5" cy="18" r="2.2" /><path d="m8.4 13.2 7 4.3M15.4 7 8.4 10.9" /></>,
  security_group: <><path d="M12 21s7-3.5 7-8.7V5.4L12 3 5 5.4v6.9C5 17.5 12 21 12 21Z" /><path d="m9 12 2 2 4-4" /></>,
  kubernetes_exposure: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17" /><path d="M12 3.5a14 14 0 0 1 0 17 14 14 0 0 1 0-17Z" /></>,
  kubernetes_workload: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.2" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.2" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.2" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.2" /></>,
  container_image: <><path d="m12 3 8 4.2-8 4.2-8-4.2z" /><path d="m4 12 8 4.2 8-4.2" /><path d="m4 16.5 8 4.2 8-4.2" /></>,
  runtime_event: <><path d="M10.4 4 2.3 17.6a1.8 1.8 0 0 0 1.6 2.7h16.2a1.8 1.8 0 0 0 1.6-2.7L13.6 4a1.8 1.8 0 0 0-3.2 0Z" /><path d="M12 9.5v4M12 16.5h.01" /></>,
  service_account: <><circle cx="12" cy="8" r="3.6" /><path d="M4.5 20.5v-.7a7.5 7.5 0 0 1 15 0v.7" /></>,
  rbac_binding: <><circle cx="7.8" cy="15.2" r="4.3" /><path d="m10.9 12.1 7.6-7.6" /><path d="m15.4 5.6 3 3" /></>,
  rbac_role: <><circle cx="7.8" cy="15.2" r="4.3" /><path d="m10.9 12.1 7.6-7.6" /><path d="m15.4 5.6 3 3" /></>,
  iam_role: <><circle cx="7.8" cy="15.2" r="4.3" /><path d="m10.9 12.1 7.6-7.6" /><path d="m15.4 5.6 3 3" /></>,
  aws_resource: <><path d="M12 3 4 7.2 12 11.4 20 7.2z" /><path d="M4 7.2v9.6L12 21l8-4.2V7.2" /><path d="M12 11.4V21" /></>,
  other: <circle cx="12" cy="12" r="6.5" />,
};

const NODE_RADIUS = 22;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.6;

function edgeCurve(edge: SecurityGraphEdge): string {
  const bend = Math.max(30, Math.abs(edge.toX - edge.fromX) / 2);
  const from = edge.isBackEdge ? edge.fromX - bend : edge.fromX + bend;
  const to = edge.isBackEdge ? edge.toX + bend : edge.toX - bend;
  return `M ${edge.fromX} ${edge.fromY} C ${from} ${edge.fromY}, ${to} ${edge.toY}, ${edge.toX} ${edge.toY}`;
}

function nodeLabel(label: string): string {
  return label.length > 22 ? `${label.slice(0, 21)}…` : label;
}

export function SecurityGraph({
  paths,
  findings = [],
  selectedPathId,
  onSelectPath,
}: {
  readonly paths: readonly KubernetesAttackPath[];
  readonly findings?: readonly PilotFinding[];
  readonly selectedPathId: string | null;
  readonly onSelectPath: (pathId: string | null) => void;
}) {
  const layout = useMemo(() => buildSecurityGraphLayout({ paths }), [paths]);
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [view, setView] = useState({ x: 24, y: 24, z: 1 });
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"graph" | "table">("graph");

  // Active findings grouped by the resource they concern, so each graph node
  // can surface the CVEs / posture findings on its own resource.
  const findingsByResourceKey = useMemo(() => {
    const map = new Map<string, PilotFinding[]>();
    for (const finding of findings) {
      if (finding.resourceKey === null || finding.status === "resolved" || finding.status === "suppressed") continue;
      const list = map.get(finding.resourceKey);
      if (list === undefined) map.set(finding.resourceKey, [finding]);
      else list.push(finding);
    }
    return map;
  }, [findings]);
  const nodeFindings = useCallback(
    (resourceKey: string | null): readonly PilotFinding[] => (resourceKey === null ? [] : findingsByResourceKey.get(resourceKey) ?? []),
    [findingsByResourceKey],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Node centers and adjacency, computed once per layout for fast hover lookups.
  const model = useMemo(() => {
    const centers = new Map<string, { cx: number; cy: number }>();
    for (const entry of layout.nodes) {
      centers.set(entry.node.key, { cx: entry.x + layout.nodeWidth / 2, cy: entry.y + layout.nodeHeight / 2 });
    }
    const neighbors = new Map<string, Set<string>>();
    const edgeKeysByNode = new Map<string, Set<string>>();
    const add = (map: Map<string, Set<string>>, key: string, value: string) => {
      const set = map.get(key) ?? new Set<string>();
      set.add(value);
      map.set(key, set);
    };
    for (const entry of layout.edges) {
      const id = `${entry.edge.from}\n${entry.edge.to}\n${entry.edge.relation}`;
      add(neighbors, entry.edge.from, entry.edge.to);
      add(neighbors, entry.edge.to, entry.edge.from);
      add(edgeKeysByNode, entry.edge.from, id);
      add(edgeKeysByNode, entry.edge.to, id);
    }
    return { centers, neighbors, edgeKeysByNode };
  }, [layout]);

  const selectedNode = layout.nodes.find((entry) => entry.node.key === selectedNodeKey) ?? null;

  const highlightPathIds = useMemo(() => {
    if (selectedPathId !== null) return new Set([selectedPathId]);
    if (selectedNode !== null) return new Set(selectedNode.pathIds);
    return null;
  }, [selectedPathId, selectedNode]);

  // A node is "focused" by hover (itself + neighbors) or by an active path.
  const focusNodeKeys = useMemo(() => {
    if (hoverKey !== null) {
      const set = new Set<string>([hoverKey]);
      for (const neighbor of model.neighbors.get(hoverKey) ?? []) set.add(neighbor);
      return set;
    }
    return null;
  }, [hoverKey, model]);
  const focusEdgeKeys = useMemo(() => {
    if (hoverKey !== null) return model.edgeKeysByNode.get(hoverKey) ?? new Set<string>();
    return null;
  }, [hoverKey, model]);

  const searchQuery = search.trim().toLocaleLowerCase("en-US");
  const matchesSearch = (label: string, kind: string): boolean =>
    searchQuery === "" || label.toLocaleLowerCase("en-US").includes(searchQuery) || kind.replaceAll("_", " ").includes(searchQuery);
  const nodeActive = (key: string, label: string, kind: string, pathIds: readonly string[]): boolean => {
    if (searchQuery !== "") return matchesSearch(label, kind);
    if (focusNodeKeys !== null) return focusNodeKeys.has(key);
    if (highlightPathIds !== null) return pathIds.some((id) => highlightPathIds.has(id));
    return true;
  };
  const edgeActive = (id: string, pathIds: readonly string[]): boolean => {
    if (focusEdgeKeys !== null) return focusEdgeKeys.has(id);
    if (highlightPathIds !== null) return pathIds.some((pid) => highlightPathIds.has(pid));
    return true;
  };

  const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

  // Wheel zoom toward the cursor; non-passive so the page does not scroll.
  useEffect(() => {
    const node = containerRef.current;
    if (node === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      setView((current) => {
        const next = clampZoom(current.z * (event.deltaY < 0 ? 1.12 : 0.89));
        const ratio = next / current.z;
        return { z: next, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
      });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = useCallback((event: React.MouseEvent) => {
    dragRef.current = { sx: event.clientX, sy: event.clientY, ox: view.x, oy: view.y, moved: false };
    setDragging(true);
  }, [view.x, view.y]);
  const onPointerMove = useCallback((event: React.MouseEvent) => {
    const drag = dragRef.current;
    if (drag === null) return;
    const dx = event.clientX - drag.sx;
    const dy = event.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    setView((current) => ({ ...current, x: drag.ox + dx, y: drag.oy + dy }));
  }, []);
  const endDrag = useCallback(() => { dragRef.current = null; setDragging(false); }, []);

  const zoomBy = (factor: number) => setView((current) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const px = rect ? rect.width / 2 : 0;
    const py = rect ? rect.height / 2 : 0;
    const next = clampZoom(current.z * factor);
    const ratio = next / current.z;
    return { z: next, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
  });
  const resetView = () => setView({ x: 24, y: 24, z: 1 });

  const hoverNode = hoverKey === null ? null : layout.nodes.find((entry) => entry.node.key === hoverKey) ?? null;
  const hoverCenter = hoverKey === null ? null : model.centers.get(hoverKey) ?? null;

  if (layout.nodes.length === 0) {
    return (
      <div className="empty-state">
        <strong>No evidence graph to draw</strong>
        <span>The graph renders only complete evidenced attack-path sequences; nothing is synthesized.</span>
      </div>
    );
  }

  return (
    <div className="security-graph">
      <div className="security-graph-toolbar">
        <div className="sg-toolbar-left">
          <div className="sg-search">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search entities…" aria-label="Search graph entities" spellCheck={false} autoComplete="off" />
            {search !== "" ? <button type="button" className="sg-search-clear" aria-label="Clear search" onClick={() => setSearch("")}>×</button> : null}
          </div>
          <span className="result-count">{layout.nodes.length} entities · {layout.edges.length} cited edges</span>
        </div>
        <div className="security-graph-actions">
          <div className="sg-viewtoggle" role="tablist" aria-label="Graph or table view">
            <button type="button" role="tab" aria-selected={viewMode === "graph"} className={viewMode === "graph" ? "is-active" : ""} onClick={() => setViewMode("graph")}>Graph</button>
            <button type="button" role="tab" aria-selected={viewMode === "table"} className={viewMode === "table" ? "is-active" : ""} onClick={() => setViewMode("table")}>Table</button>
          </div>
          {selectedPathId !== null || selectedNodeKey !== null ? (
            <button type="button" className="button button-secondary" onClick={() => { onSelectPath(null); setSelectedNodeKey(null); }}>Clear</button>
          ) : null}
          {viewMode === "graph" ? (
            <>
              <button type="button" className="button button-secondary" aria-label="Zoom out" onClick={() => zoomBy(0.83)}>−</button>
              <button type="button" className="button button-secondary" aria-label="Zoom in" onClick={() => zoomBy(1.2)}>+</button>
              <button type="button" className="button button-secondary" onClick={resetView}>Reset</button>
            </>
          ) : null}
        </div>
      </div>
      {layout.truncatedNodeCount > 0 ? (
        <p className="panel-footnote">{layout.truncatedNodeCount} additional entities exceeded the graph display bound and are omitted from the drawing (never from the evidence).</p>
      ) : null}
      {viewMode === "table" ? (
        <div className="sg-table-wrap">
          <table className="sg-table">
            <thead><tr><th>Entity</th><th>Type</th><th>Findings</th><th>Paths</th><th>Connections</th></tr></thead>
            <tbody>
              {[...layout.nodes]
                .filter((entry) => matchesSearch(entry.node.label, entry.node.kind))
                .sort((a, b) => (SEVERITY_RANK[worstSeverity(nodeFindings(b.node.resourceKey)) ?? ""] ?? 0) - (SEVERITY_RANK[worstSeverity(nodeFindings(a.node.resourceKey)) ?? ""] ?? 0) || a.node.label.localeCompare(b.node.label, "en-US"))
                .map((entry) => {
                  const finds = nodeFindings(entry.node.resourceKey);
                  const sev = worstSeverity(finds);
                  return (
                    <tr key={entry.node.key} className={selectedNodeKey === entry.node.key ? "is-selected" : ""} onClick={() => { onSelectPath(null); setSelectedNodeKey(entry.node.key); }}>
                      <td><span className="sg-td-entity"><i style={{ background: (sev !== null ? SEVERITY_COLOR[sev] : KIND_COLOR[entry.node.kind]) ?? KIND_COLOR.other }} />{entry.node.label}</span></td>
                      <td>{entry.node.kind.replaceAll("_", " ")}</td>
                      <td>{finds.length > 0 ? <span className={`sg-sev-pill sg-sev-${sev}`}>{finds.length} · {sev}</span> : <span className="sg-td-none">—</span>}</td>
                      <td>{entry.pathIds.length}</td>
                      <td>{model.neighbors.get(entry.node.key)?.size ?? 0}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      ) : (
      <div
        className={`security-graph-canvas${dragging ? " is-dragging" : ""}`}
        ref={containerRef}
        onMouseDown={onPointerDown}
        onMouseMove={onPointerMove}
        onMouseUp={endDrag}
        onMouseLeave={() => { endDrag(); setHoverKey(null); }}
        role="application"
        aria-label="Attack-path evidence graph. Drag to pan, scroll to zoom, hover a node to trace its connectivity."
      >
        <svg className="security-graph-svg" width="100%" height="100%" role="img" aria-label="Attack-path evidence graph">
          <defs>
            <marker id="sg-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M 0 0 L 7 3.5 L 0 7 z" fill="currentColor" />
            </marker>
          </defs>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.z})`}>
            {layout.edges.map((entry) => {
              const id = `${entry.edge.from}\n${entry.edge.to}\n${entry.edge.relation}`;
              const active = edgeActive(id, entry.pathIds);
              return (
                <g key={id} className={`sg-edge${entry.isBackEdge ? " sg-edge-back" : ""}${active ? "" : " sg-dim"}`}>
                  <path d={edgeCurve(entry)} fill="none" markerEnd="url(#sg-arrow)">
                    <title>{`${entry.edge.relation}${entry.isBackEdge ? " (cycle)" : ""} — evidence: ${entry.edge.evidence.source}`}</title>
                  </path>
                </g>
              );
            })}
            {layout.nodes.map((entry) => {
              const center = model.centers.get(entry.node.key);
              if (center === undefined) return null;
              const color = KIND_COLOR[entry.node.kind] ?? KIND_COLOR.other;
              const nodeFinds = nodeFindings(entry.node.resourceKey);
              const sev = worstSeverity(nodeFinds);
              const ringColor = sev !== null ? SEVERITY_COLOR[sev] ?? color : color;
              const active = nodeActive(entry.node.key, entry.node.label, entry.node.kind, entry.pathIds);
              const selected = selectedNodeKey === entry.node.key;
              return (
                <g
                  key={entry.node.key}
                  className={`sg-node${active ? "" : " sg-dim"}${selected ? " sg-selected" : ""}`}
                  transform={`translate(${center.cx} ${center.cy})`}
                  tabIndex={0}
                  role="button"
                  aria-label={`${entry.node.kind.replaceAll("_", " ")}: ${entry.node.label}`}
                  onMouseEnter={() => setHoverKey(entry.node.key)}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (dragRef.current?.moved) return;
                    onSelectPath(null);
                    setSelectedNodeKey((current) => current === entry.node.key ? null : entry.node.key);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelectPath(null);
                      setSelectedNodeKey((current) => current === entry.node.key ? null : entry.node.key);
                    }
                  }}
                >
                  <circle className="sg-node-ring" r={NODE_RADIUS} style={{ stroke: ringColor }} />
                  {sev !== null ? <circle className="sg-node-halo" r={NODE_RADIUS + 3} style={{ stroke: ringColor }} /> : null}
                  <g className="sg-node-glyph" style={{ color }} transform="translate(-11 -11) scale(0.92)">
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      {KIND_GLYPH[entry.node.kind] ?? KIND_GLYPH.other}
                    </svg>
                  </g>
                  {nodeFinds.length > 0 ? (
                    <g className="sg-node-badge" transform={`translate(${NODE_RADIUS - 3} ${-NODE_RADIUS + 3})`}>
                      <circle r="9" style={{ fill: ringColor }} />
                      <text textAnchor="middle" dy="3.2">{nodeFinds.length > 9 ? "9+" : nodeFinds.length}</text>
                    </g>
                  ) : null}
                  <text className="sg-node-label" y={NODE_RADIUS + 14} textAnchor="middle">{nodeLabel(entry.node.label)}</text>
                  <text className="sg-node-kind" y={NODE_RADIUS + 26} textAnchor="middle">{entry.node.kind.replaceAll("_", " ")}</text>
                </g>
              );
            })}
          </g>
        </svg>
        {hoverNode !== null && hoverCenter !== null ? (
          <div
            className="sg-tooltip"
            style={{ left: hoverCenter.cx * view.z + view.x, top: hoverCenter.cy * view.z + view.y - NODE_RADIUS * view.z - 8 }}
          >
            <strong>{hoverNode.node.label}</strong>
            <span className="sg-tooltip-kind">{hoverNode.node.kind.replaceAll("_", " ")}</span>
            <small>{(model.neighbors.get(hoverNode.node.key)?.size ?? 0)} direct connection{(model.neighbors.get(hoverNode.node.key)?.size ?? 0) === 1 ? "" : "s"} · {hoverNode.pathIds.length} evidenced path{hoverNode.pathIds.length === 1 ? "" : "s"}</small>
            {hoverNode.node.resourceKey !== null ? <small className="sg-tooltip-key">{hoverNode.node.resourceKey}</small> : <small className="sg-tooltip-key">Evidence-derived boundary</small>}
          </div>
        ) : null}
      </div>
      )}
      {selectedNode !== null ? (
        <aside className="security-graph-detail">
          <header>
            <div>
              <p className="eyebrow">{selectedNode.node.kind.replaceAll("_", " ")}</p>
              <h3>{selectedNode.node.label}</h3>
            </div>
            {selectedNode.node.resourceKey !== null
              ? <Link className="text-link" href={`/cmdb/resource?key=${encodeURIComponent(selectedNode.node.resourceKey)}`}>Source record →</Link>
              : <small>Evidence-derived boundary</small>}
          </header>
          <p className="panel-footnote">Appears in {selectedNode.pathIds.length} evidenced path{selectedNode.pathIds.length === 1 ? "" : "s"} · {model.neighbors.get(selectedNode.node.key)?.size ?? 0} direct connections.</p>
          {(() => {
            const finds = nodeFindings(selectedNode.node.resourceKey);
            if (finds.length === 0) return null;
            const sorted = [...finds].sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
            return (
              <div className="sg-detail-findings">
                <div className="sg-detail-findings-head"><strong>Findings on this entity</strong><span>{finds.length}</span></div>
                {sorted.map((finding) => (
                  <article key={finding.fingerprint} className="sg-finding">
                    <div className="sg-finding-top">
                      <span className={`sg-sev-pill sg-sev-${finding.severity}`}>{finding.severity}</span>
                      <code>{finding.controlKey}</code>
                    </div>
                    <strong>{finding.title}</strong>
                    <p>{finding.summary}</p>
                    <div className="sg-finding-actions">
                      <Link className="button button-secondary" href={`/findings?highlight=${encodeURIComponent(finding.fingerprint)}`}>View details →</Link>
                      <small>Evaluated {formatTimestamp(finding.evaluatedAt)}</small>
                    </div>
                  </article>
                ))}
              </div>
            );
          })()}
          <div className="security-graph-evidence">
            <p className="sg-evidence-label">Cited relationships</p>
            {layout.edges
              .filter((entry) => entry.edge.from === selectedNode.node.key || entry.edge.to === selectedNode.node.key)
              .map((entry, index) => (
                <article key={`${entry.edge.from}:${entry.edge.to}:${index}`}>
                  <strong>{entry.edge.relation}</strong>
                  <small>{entry.edge.from === selectedNode.node.key ? `→ ${entry.edge.to}` : `← ${entry.edge.from}`}</small>
                  <code>{entry.edge.evidence.source === "relationship" ? `relationship:${entry.edge.evidence.relationType}` : (entry.edge.evidence.fieldPath ?? entry.edge.evidence.relationType)}</code>
                  {entry.edge.evidence.observedAt !== null ? <small>Observed {formatTimestamp(entry.edge.evidence.observedAt)}</small> : <small>Snapshot-bound configuration edge</small>}
                </article>
              ))}
          </div>
        </aside>
      ) : null}
    </div>
  );
}

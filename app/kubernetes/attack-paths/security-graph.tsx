"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { KubernetesAttackPath } from "../../../lib/kubernetes-attack-paths";
import {
  buildSecurityGraphLayout,
  type SecurityGraphEdge,
  type SecurityGraphNode,
} from "../../../lib/kubernetes-security-graph";
import { formatTimestamp } from "../../components/use-pilot-state";

const KIND_COLOR: Readonly<Record<string, string>> = {
  internet: "#a83b3b",
  load_balancer: "#9a692e",
  security_group: "#9a692e",
  kubernetes_exposure: "#8a6e25",
  kubernetes_workload: "#2f6f8f",
  container_image: "#5d7079",
  runtime_event: "#a83b3b",
  service_account: "#8a3769",
  rbac_binding: "#8a3769",
  rbac_role: "#8a3769",
  iam_role: "#317a55",
  aws_resource: "#317a55",
  other: "#5d7079",
};

function edgeCurve(edge: SecurityGraphEdge): string {
  const bend = Math.max(32, (edge.toX - edge.fromX) / 2);
  return `M ${edge.fromX} ${edge.fromY} C ${edge.fromX + bend} ${edge.fromY}, ${edge.toX - bend} ${edge.toY}, ${edge.toX} ${edge.toY}`;
}

function nodeLabel(label: string): string {
  return label.length > 24 ? `${label.slice(0, 23)}…` : label;
}

export function SecurityGraph({
  paths,
  selectedPathId,
  onSelectPath,
}: {
  readonly paths: readonly KubernetesAttackPath[];
  readonly selectedPathId: string | null;
  readonly onSelectPath: (pathId: string | null) => void;
}) {
  const layout = useMemo(() => buildSecurityGraphLayout({ paths }), [paths]);
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  const selectedNode = layout.nodes.find((entry) => entry.node.key === selectedNodeKey) ?? null;
  const highlightedPathIds = useMemo(() => {
    if (selectedPathId !== null) return new Set([selectedPathId]);
    if (selectedNode !== null) return new Set(selectedNode.pathIds);
    return null;
  }, [selectedPathId, selectedNode]);

  const isNodeActive = (node: SecurityGraphNode): boolean =>
    highlightedPathIds === null || node.pathIds.some((id) => highlightedPathIds.has(id));
  const isEdgeActive = (edge: SecurityGraphEdge): boolean =>
    highlightedPathIds === null || edge.pathIds.some((id) => highlightedPathIds.has(id));

  const selectedEdges = selectedNode === null
    ? []
    : layout.edges.filter((entry) =>
      entry.edge.from === selectedNode.node.key || entry.edge.to === selectedNode.node.key);

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
        <span className="result-count">{layout.nodes.length} entities · {layout.edges.length} cited edges</span>
        <div className="security-graph-actions">
          {selectedPathId !== null || selectedNodeKey !== null ? (
            <button type="button" className="button button-secondary" onClick={() => { onSelectPath(null); setSelectedNodeKey(null); }}>
              Clear highlight
            </button>
          ) : null}
          <button type="button" className="button button-secondary" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(0.5, Math.round((value - 0.25) * 100) / 100))}>−</button>
          <button type="button" className="button button-secondary" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(2, Math.round((value + 0.25) * 100) / 100))}>+</button>
        </div>
      </div>
      {layout.truncatedNodeCount > 0 ? (
        <p className="panel-footnote">{layout.truncatedNodeCount} additional entities exceeded the graph display bound and are omitted from the drawing (never from the evidence).</p>
      ) : null}
      <div className="security-graph-scroll">
        <svg
          role="img"
          aria-label="Attack-path evidence graph"
          width={layout.width * zoom}
          height={layout.height * zoom}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
        >
          <defs>
            <marker id="security-graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
            </marker>
          </defs>
          {layout.edges.map((entry) => (
            <g
              key={`${entry.edge.from}:${entry.edge.to}:${entry.edge.relation}`}
              className={`security-graph-edge${entry.isBackEdge ? " security-graph-backedge" : ""}${isEdgeActive(entry) ? "" : " security-graph-dimmed"}`}
            >
              <path d={edgeCurve(entry)} fill="none" markerEnd="url(#security-graph-arrow)">
                <title>{`${entry.edge.relation}${entry.isBackEdge ? " (cycle / back-reference)" : ""} — evidence: ${entry.edge.evidence.source}${entry.edge.evidence.observedAt ? ` @ ${entry.edge.evidence.observedAt}` : ""}`}</title>
              </path>
              <text x={(entry.fromX + entry.toX) / 2} y={(entry.fromY + entry.toY) / 2 - 6} textAnchor="middle">
                {entry.edge.relation}
              </text>
            </g>
          ))}
          {layout.nodes.map((entry) => (
            <g
              key={entry.node.key}
              className={`security-graph-node${isNodeActive(entry) ? "" : " security-graph-dimmed"}${selectedNodeKey === entry.node.key ? " security-graph-selected" : ""}`}
              transform={`translate(${entry.x}, ${entry.y})`}
              onClick={() => {
                onSelectPath(null);
                setSelectedNodeKey((current) => current === entry.node.key ? null : entry.node.key);
              }}
              tabIndex={0}
              role="button"
              aria-label={`${entry.node.kind.replaceAll("_", " ")}: ${entry.node.label}`}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectPath(null);
                  setSelectedNodeKey((current) => current === entry.node.key ? null : entry.node.key);
                }
              }}
            >
              <rect width={layout.nodeWidth} height={layout.nodeHeight} rx={10} stroke={KIND_COLOR[entry.node.kind] ?? KIND_COLOR.other} />
              <circle cx={16} cy={layout.nodeHeight / 2} r={5} fill={KIND_COLOR[entry.node.kind] ?? KIND_COLOR.other} />
              <text x={30} y={24} className="security-graph-kind">{entry.node.kind.replaceAll("_", " ")}</text>
              <text x={30} y={42} className="security-graph-label">
                {nodeLabel(entry.node.label)}
                <title>{entry.node.label}</title>
              </text>
            </g>
          ))}
        </svg>
      </div>
      {selectedNode !== null ? (
        <aside className="security-graph-detail">
          <header>
            <div>
              <p className="eyebrow">{selectedNode.node.kind.replaceAll("_", " ")}</p>
              <h3>{selectedNode.node.label}</h3>
            </div>
            {selectedNode.node.resourceKey !== null ? (
              <Link className="text-link" href={`/cmdb/resource?key=${encodeURIComponent(selectedNode.node.resourceKey)}`}>Source record →</Link>
            ) : (
              <small>Evidence-derived boundary</small>
            )}
          </header>
          <p className="panel-footnote">Appears in {selectedNode.pathIds.length} evidenced path{selectedNode.pathIds.length === 1 ? "" : "s"}.</p>
          <div className="security-graph-evidence">
            {selectedEdges.map((entry, index) => (
              <article key={`${entry.edge.from}:${entry.edge.to}:${index}`}>
                <strong>{entry.edge.relation}</strong>
                <small>{entry.edge.from === selectedNode.node.key ? `→ ${entry.edge.to}` : `← ${entry.edge.from}`}</small>
                <code>{entry.edge.evidence.source === "relationship"
                  ? `relationship:${entry.edge.evidence.relationType}`
                  : `${entry.edge.evidence.fieldPath ?? entry.edge.evidence.relationType}`}</code>
                {entry.edge.evidence.observedAt !== null ? <small>Observed {formatTimestamp(entry.edge.evidence.observedAt)}</small> : <small>Snapshot-bound configuration edge</small>}
              </article>
            ))}
          </div>
        </aside>
      ) : null}
    </div>
  );
}

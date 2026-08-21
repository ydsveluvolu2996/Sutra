// CMDB RELATIONSHIP / DEPENDENCY GRAPH — pure, deterministic, read-only.
//
// This module turns already-collected AWS resource configuration (PilotResource
// [].configuration) into a typed relationship graph and answers dependency /
// blast-radius questions over it. It performs NO AWS calls and invents NO edges:
//
//   * A DERIVED edge is produced only from a configuration field that is
//     ACTUALLY present on a collected resource, and every edge carries the exact
//     field it came from (`derivedFrom`).
//   * A key that a config field references but that is NOT in the collected
//     resource set is disclosed as an EXTERNAL / unresolved node — its raw id is
//     shown, never a fabricated service/region/type.
//   * MANUAL edges are user-asserted (source "manual") and always labelled as
//     such, never mixed into the derived provenance.
//
// Determinism: every output list is sorted by a stable key, edges are
// de-duplicated, and traversals visit neighbours in sorted order with a visited
// set so cycles terminate.
import type { JsonValue, PilotResource } from "./pilot-types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The typed derived relationships. Each is oriented `from -> to` where `from`
 * is the resource whose collected configuration carried the reference. The
 * per-type dependency orientation is captured separately in `direction`.
 */
export type DerivedRelationshipType =
  | "contained-in-vpc"
  | "contained-in-subnet"
  | "contained-in-route-table"
  | "contained-in-network-acl"
  | "contained-in-internet-gateway"
  | "spans-subnet"
  | "uses-security-group"
  | "allows-from-security-group"
  | "attached-to-instance"
  | "attached-to-vpc"
  | "associated-with"
  | "snapshot-of-volume"
  | "associates-subnet"
  | "routes-through-gateway"
  | "attached-to-load-balancer"
  | "load-balances-to"
  | "uses-iam-role"
  | "uses-instance-profile"
  | "encrypted-with-kms-key";

export type RelationshipType = DerivedRelationshipType | string;

export type RelationshipSource = "derived" | "manual";

/**
 * `depends-on`      : `from` depends on `to` (if `to` breaks, `from` is affected).
 * `depended-on-by`  : `to` depends on `from` (`from` provides a service to `to`).
 *
 * The evidence field always lives on `from`; `direction` records which endpoint
 * is the dependent for dependency / blast-radius traversal, so an edge can stay
 * evidence-honest without lying about which side actually depends on which.
 */
export type RelationshipDirection = "depends-on" | "depended-on-by";

export interface Relationship {
  readonly fromKey: string;
  readonly toKey: string;
  readonly type: RelationshipType;
  readonly source: RelationshipSource;
  /** The exact config field a derived edge came from; null for manual edges. */
  readonly derivedFrom: string | null;
  readonly direction: RelationshipDirection;
  /** Free-text note for a manual edge; null otherwise. */
  readonly note?: string | null;
}

/** An input describing a user-asserted manual edge (from the repository). */
export interface ManualRelationshipInput {
  readonly fromKey: string;
  readonly toKey: string;
  readonly type: RelationshipType;
  readonly note?: string | null;
  readonly direction?: RelationshipDirection;
}

export interface GraphNode {
  readonly key: string;
  /** True when the key is a collected resource; false for external/unresolved. */
  readonly present: boolean;
  readonly service: string | null;
  readonly resourceType: string | null;
  readonly region: string | null;
  readonly name: string | null;
}

/** One hop reached during a traversal, with the edge that led to it. */
export interface TraversalReach {
  readonly node: GraphNode;
  readonly depth: number;
  readonly edge: Relationship;
}

export interface TraversalResult {
  readonly root: GraphNode | null;
  readonly reached: readonly TraversalReach[];
  readonly maxDepth: number;
  /** True when traversal stopped at `maxDepth` with more graph beyond it. */
  readonly truncated: boolean;
}

/** A direct edge touching a node, with the resolved neighbour. */
export interface NeighborEdge {
  readonly edge: Relationship;
  readonly neighbor: GraphNode;
  /** Whether the queried node is the `from` or the `to` side of `edge`. */
  readonly role: "from" | "to";
}

export interface NeighborResult {
  readonly root: GraphNode | null;
  readonly dependencies: readonly NeighborEdge[];
  readonly dependents: readonly NeighborEdge[];
}

export interface PathStep {
  readonly node: GraphNode;
  /** The edge from the previous step to this node; null for the first step. */
  readonly edge: Relationship | null;
}

export interface ShortestPathResult {
  readonly found: boolean;
  readonly path: readonly PathStep[];
}

const MAX_TRAVERSAL_DEPTH = 64;
const DEFAULT_BLAST_DEPTH = 3;

// ---------------------------------------------------------------------------
// Small typed readers over untyped collected configuration
// ---------------------------------------------------------------------------

function str(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strArray(value: JsonValue | undefined): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function records(value: JsonValue | undefined): readonly Readonly<Record<string, JsonValue>>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Readonly<Record<string, JsonValue>> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}

// The live collector prefixes types ("aws.ec2.instance"); fixtures may use bare
// kinds. Normalize the service.resource tail so both are recognized.
function normalizedType(resourceType: string): string {
  return resourceType.replace(/^aws\./u, "");
}

// ---------------------------------------------------------------------------
// deriveRelationships
// ---------------------------------------------------------------------------

interface Resolver {
  /** Resolve a native id or ARN to a collected resource key, or null. */
  readonly byRef: (ref: string) => string | null;
  /** Resolve a private IP to the collected ENI that carries it, or null. */
  readonly byPrivateIp: (ip: string) => string | null;
}

function buildResolver(resources: readonly PilotResource[]): Resolver {
  const byNativeId = new Map<string, string>();
  const byArn = new Map<string, string>();
  const byPrivateIp = new Map<string, string>();
  // Deterministic: iterate resources sorted by key so a duplicate id resolves to
  // a stable winner.
  const sorted = [...resources].sort((a, b) => a.resourceKey.localeCompare(b.resourceKey, "en-US"));
  for (const resource of sorted) {
    if (!byNativeId.has(resource.nativeId)) byNativeId.set(resource.nativeId, resource.resourceKey);
    if (resource.arn !== null && !byArn.has(resource.arn)) byArn.set(resource.arn, resource.resourceKey);
    if (normalizedType(resource.resourceType) === "ec2.network-interface") {
      const primary = str(resource.configuration.privateIpAddress);
      if (primary !== null && !byPrivateIp.has(primary)) byPrivateIp.set(primary, resource.resourceKey);
      for (const ip of strArray(resource.configuration.privateIpAddresses)) {
        if (!byPrivateIp.has(ip)) byPrivateIp.set(ip, resource.resourceKey);
      }
    }
  }
  return {
    byRef: (ref) => byNativeId.get(ref) ?? byArn.get(ref) ?? null,
    byPrivateIp: (ip) => byPrivateIp.get(ip) ?? null,
  };
}

/**
 * Derive typed relationships from collected resource configuration. Pure and
 * deterministic. Only fields that are actually present produce edges; a
 * reference that resolves to no collected resource yields an edge to the raw id
 * (an external node), never an invented resource.
 */
export function deriveRelationships(resources: readonly PilotResource[]): Relationship[] {
  const resolver = buildResolver(resources);
  const edges: Relationship[] = [];

  const push = (
    fromKey: string,
    ref: string | null,
    type: DerivedRelationshipType,
    derivedFrom: string,
    direction: RelationshipDirection,
    resolve: (ref: string) => string | null = resolver.byRef,
  ): void => {
    if (ref === null || ref.length === 0) return;
    const toKey = resolve(ref) ?? ref; // unresolved -> external node keyed by the raw ref
    if (toKey === fromKey) return; // never a self-loop
    edges.push({ fromKey, toKey, type, source: "derived", derivedFrom, direction });
  };

  for (const resource of resources) {
    const key = resource.resourceKey;
    const config = resource.configuration;
    const type = normalizedType(resource.resourceType);

    // Every VPC-scoped resource records its containing VPC.
    push(key, str(config.vpcId), "contained-in-vpc", "vpcId", "depends-on");

    switch (type) {
      case "ec2.instance": {
        push(key, str(config.subnetId), "contained-in-subnet", "subnetId", "depends-on");
        for (const sg of strArray(config.securityGroupIds)) {
          push(key, sg, "uses-security-group", "securityGroupIds", "depends-on");
        }
        push(
          key,
          str(config.iamInstanceProfileArn),
          "uses-instance-profile",
          "iamInstanceProfileArn",
          "depends-on",
        );
        break;
      }
      case "ec2.network-interface": {
        push(key, str(config.subnetId), "contained-in-subnet", "subnetId", "depends-on");
        for (const sg of strArray(config.securityGroupIds)) {
          push(key, sg, "uses-security-group", "securityGroupIds", "depends-on");
        }
        push(key, str(config.instanceId), "attached-to-instance", "instanceId", "depends-on");
        break;
      }
      case "ec2.volume": {
        push(key, str(config.kmsKeyId), "encrypted-with-kms-key", "kmsKeyId", "depends-on");
        // Attachment records are the authoritative instance link; instanceIds is a
        // flattened convenience mirror of the same evidence.
        const attached = new Set<string>();
        for (const attachment of records(config.attachments)) {
          const instanceId = str(attachment.instanceId);
          if (instanceId !== null) attached.add(instanceId);
        }
        for (const instanceId of strArray(config.instanceIds)) attached.add(instanceId);
        for (const instanceId of [...attached].sort((a, b) => a.localeCompare(b, "en-US"))) {
          push(key, instanceId, "attached-to-instance", "attachments.instanceId", "depends-on");
        }
        break;
      }
      case "ec2.snapshot": {
        push(key, str(config.volumeId), "snapshot-of-volume", "volumeId", "depends-on");
        break;
      }
      case "ec2.elastic-ip": {
        push(key, str(config.instanceId), "associated-with", "instanceId", "depends-on");
        push(key, str(config.networkInterfaceId), "associated-with", "networkInterfaceId", "depends-on");
        break;
      }
      case "ec2.subnet": {
        // vpc containment already emitted above.
        break;
      }
      case "ec2.security-group": {
        for (const permission of records(config.ingress)) {
          for (const sourceSg of strArray(permission.referencedSecurityGroupIds)) {
            push(
              key,
              sourceSg,
              "allows-from-security-group",
              "ingress.referencedSecurityGroupIds",
              "depends-on",
            );
          }
        }
        break;
      }
      case "ec2.route-table": {
        // A subnet DEPENDS ON its route table for routing (direction reversed).
        for (const subnetId of strArray(config.associatedSubnetIds)) {
          push(key, subnetId, "associates-subnet", "associatedSubnetIds", "depended-on-by");
        }
        // A route's target gateway is a dependency of the route table.
        const targets = new Set<string>();
        for (const route of records(config.routes)) {
          const target = str(route.target);
          if (target !== null) targets.add(target);
        }
        for (const target of [...targets].sort((a, b) => a.localeCompare(b, "en-US"))) {
          push(key, target, "routes-through-gateway", "routes.target", "depends-on");
        }
        break;
      }
      case "ec2.route": {
        push(key, str(config.routeTableId), "contained-in-route-table", "routeTableId", "depends-on");
        push(key, str(config.target), "routes-through-gateway", "target", "depends-on");
        break;
      }
      case "ec2.route-table-association": {
        push(key, str(config.routeTableId), "contained-in-route-table", "routeTableId", "depends-on");
        push(key, str(config.subnetId), "associates-subnet", "subnetId", "depends-on");
        push(key, str(config.gatewayId), "associated-with", "gatewayId", "depends-on");
        break;
      }
      case "ec2.network-acl": {
        for (const subnetId of strArray(config.associatedSubnetIds)) {
          push(key, subnetId, "associates-subnet", "associatedSubnetIds", "depended-on-by");
        }
        break;
      }
      case "ec2.network-acl-entry": {
        push(key, str(config.networkAclId), "contained-in-network-acl", "networkAclId", "depends-on");
        break;
      }
      case "ec2.network-acl-association": {
        push(key, str(config.networkAclId), "contained-in-network-acl", "networkAclId", "depends-on");
        push(key, str(config.subnetId), "associates-subnet", "subnetId", "depends-on");
        break;
      }
      case "ec2.internet-gateway": {
        for (const vpcId of strArray(config.attachedVpcIds)) {
          push(key, vpcId, "attached-to-vpc", "attachedVpcIds", "depends-on");
        }
        break;
      }
      case "ec2.internet-gateway-attachment": {
        push(
          key,
          str(config.internetGatewayId),
          "contained-in-internet-gateway",
          "internetGatewayId",
          "depends-on",
        );
        break;
      }
      case "rds.db-instance": {
        for (const sg of strArray(config.securityGroupIds)) {
          push(key, sg, "uses-security-group", "securityGroupIds", "depends-on");
        }
        push(key, str(config.kmsKeyId), "encrypted-with-kms-key", "kmsKeyId", "depends-on");
        break;
      }
      case "eks.cluster": {
        for (const subnetId of strArray(config.subnetIds)) {
          push(key, subnetId, "spans-subnet", "subnetIds", "depends-on");
        }
        for (const sg of strArray(config.securityGroupIds)) {
          push(key, sg, "uses-security-group", "securityGroupIds", "depends-on");
        }
        push(key, str(config.clusterSecurityGroupId), "uses-security-group", "clusterSecurityGroupId", "depends-on");
        push(key, str(config.roleArn), "uses-iam-role", "roleArn", "depends-on");
        break;
      }
      case "elasticloadbalancingv2.load-balancer": {
        for (const subnetId of strArray(config.subnetIds)) {
          push(key, subnetId, "spans-subnet", "subnetIds", "depends-on");
        }
        for (const sg of strArray(config.securityGroupIds)) {
          push(key, sg, "uses-security-group", "securityGroupIds", "depends-on");
        }
        break;
      }
      case "elasticloadbalancingv2.listener": {
        push(key, str(config.loadBalancerArn), "attached-to-load-balancer", "loadBalancerArn", "depends-on");
        break;
      }
      case "elasticloadbalancingv2.target-group": {
        for (const lbArn of strArray(config.loadBalancerArns)) {
          push(key, lbArn, "attached-to-load-balancer", "loadBalancerArns", "depended-on-by");
        }
        const targetType = str(config.targetType);
        const ids = new Set<string>();
        for (const target of records(config.targets)) {
          const id = str(target.id);
          if (id !== null) ids.add(id);
        }
        for (const id of [...ids].sort((a, b) => a.localeCompare(b, "en-US"))) {
          if (targetType === "ip") {
            // An ip target resolves to the ENI carrying that private address.
            push(key, id, "load-balances-to", "targets.id", "depends-on", resolver.byPrivateIp);
          } else {
            // instance (the default) targets resolve to the EC2 instance id.
            push(key, id, "load-balances-to", "targets.id", "depends-on");
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return sortRelationships(dedupeRelationships(edges));
}

function relationshipKey(edge: Relationship): string {
  return `${edge.fromKey} ${edge.toKey} ${edge.type} ${edge.source}`;
}

function dedupeRelationships(edges: readonly Relationship[]): Relationship[] {
  const byKey = new Map<string, Relationship>();
  for (const edge of edges) {
    // First writer wins so the earliest (deterministic) derivedFrom is kept.
    if (!byKey.has(relationshipKey(edge))) byKey.set(relationshipKey(edge), edge);
  }
  return [...byKey.values()];
}

function sortRelationships(edges: readonly Relationship[]): Relationship[] {
  return [...edges].sort(
    (a, b) =>
      a.fromKey.localeCompare(b.fromKey, "en-US") ||
      a.toKey.localeCompare(b.toKey, "en-US") ||
      a.type.localeCompare(b.type, "en-US") ||
      a.source.localeCompare(b.source, "en-US"),
  );
}

// ---------------------------------------------------------------------------
// buildDependencyGraph + traversal
// ---------------------------------------------------------------------------

interface Adjacency {
  /** Edges where this node is the DEPENDENT (traverse toward dependencies). */
  readonly dependencyEdges: Relationship[];
  /** Edges where this node is the DEPENDENCY (traverse toward dependents). */
  readonly dependentEdges: Relationship[];
}

/** Which endpoint of an edge is the dependent / the dependency. */
function dependentOf(edge: Relationship): string {
  return edge.direction === "depends-on" ? edge.fromKey : edge.toKey;
}

function dependencyOf(edge: Relationship): string {
  return edge.direction === "depends-on" ? edge.toKey : edge.fromKey;
}

/**
 * A pure, immutable dependency graph. Nodes are collected resources plus any
 * external/unresolved keys referenced by edges. All traversals are cycle-safe
 * (visited set) and deterministic (sorted neighbour iteration).
 */
export class DependencyGraph {
  private readonly nodes: ReadonlyMap<string, GraphNode>;
  private readonly edges: readonly Relationship[];
  private readonly adjacency: ReadonlyMap<string, Adjacency>;

  public constructor(nodes: ReadonlyMap<string, GraphNode>, edges: readonly Relationship[]) {
    this.nodes = nodes;
    this.edges = edges;
    const adjacency = new Map<string, Adjacency>();
    const ensure = (key: string): Adjacency => {
      const existing = adjacency.get(key);
      if (existing !== undefined) return existing;
      const created: Adjacency = { dependencyEdges: [], dependentEdges: [] };
      adjacency.set(key, created);
      return created;
    };
    for (const edge of edges) {
      // The dependent walks toward its dependency, and vice-versa.
      ensure(dependentOf(edge)).dependencyEdges.push(edge);
      ensure(dependencyOf(edge)).dependentEdges.push(edge);
    }
    this.adjacency = adjacency;
  }

  public get allNodes(): readonly GraphNode[] {
    return [...this.nodes.values()].sort((a, b) => a.key.localeCompare(b.key, "en-US"));
  }

  public get allEdges(): readonly Relationship[] {
    return this.edges;
  }

  public get externalNodeKeys(): readonly string[] {
    return this.allNodes.filter((node) => !node.present).map((node) => node.key);
  }

  public hasNode(key: string): boolean {
    return this.nodes.has(key);
  }

  public node(key: string): GraphNode | null {
    return this.nodes.get(key) ?? null;
  }

  /** Direct dependency and dependent edges touching `key`, deterministically ordered. */
  public neighbors(key: string): NeighborResult {
    const adjacency = this.adjacency.get(key);
    const toNeighbor = (edge: Relationship, otherKey: string): NeighborEdge => ({
      edge,
      neighbor: this.nodeOrExternal(otherKey),
      role: edge.fromKey === key ? "from" : "to",
    });
    const dependencies = (adjacency?.dependencyEdges ?? [])
      .map((edge) => toNeighbor(edge, dependencyOf(edge)))
      .sort(compareNeighbor);
    const dependents = (adjacency?.dependentEdges ?? [])
      .map((edge) => toNeighbor(edge, dependentOf(edge)))
      .sort(compareNeighbor);
    return { root: this.node(key), dependencies, dependents };
  }

  /** Transitive set of nodes `key` depends on (things it needs to function). */
  public dependencies(key: string, maxDepth: number = MAX_TRAVERSAL_DEPTH): TraversalResult {
    return this.traverse(key, "dependencies", maxDepth);
  }

  /** Transitive set of nodes that depend on `key`. */
  public dependents(key: string, maxDepth: number = MAX_TRAVERSAL_DEPTH): TraversalResult {
    return this.traverse(key, "dependents", maxDepth);
  }

  /**
   * The blast radius of `key`: everything (transitively, bounded by `maxDepth`)
   * that is impacted if `key` fails — i.e. its dependents.
   */
  public blastRadius(key: string, maxDepth: number = DEFAULT_BLAST_DEPTH): TraversalResult {
    return this.traverse(key, "dependents", maxDepth);
  }

  private nodeOrExternal(key: string): GraphNode {
    return (
      this.nodes.get(key) ?? {
        key,
        present: false,
        service: null,
        resourceType: null,
        region: null,
        name: null,
      }
    );
  }

  private traverse(
    key: string,
    mode: "dependencies" | "dependents",
    requestedDepth: number,
  ): TraversalResult {
    const maxDepth = clampDepth(requestedDepth);
    const root = this.node(key);
    if (!this.nodes.has(key)) {
      return { root, reached: [], maxDepth, truncated: false };
    }
    const reached: TraversalReach[] = [];
    const visited = new Set<string>([key]);
    let frontier: readonly string[] = [key];
    let truncated = false;
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      // Deterministic frontier order.
      for (const current of [...frontier].sort((a, b) => a.localeCompare(b, "en-US"))) {
        const adjacency = this.adjacency.get(current);
        const stepEdges =
          mode === "dependencies" ? adjacency?.dependencyEdges ?? [] : adjacency?.dependentEdges ?? [];
        const step = stepEdges
          .map((edge) => ({
            edge,
            neighbor: mode === "dependencies" ? dependencyOf(edge) : dependentOf(edge),
          }))
          .sort(
            (a, b) =>
              a.neighbor.localeCompare(b.neighbor, "en-US") ||
              a.edge.type.localeCompare(b.edge.type, "en-US"),
          );
        for (const { edge, neighbor } of step) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          reached.push({ node: this.nodeOrExternal(neighbor), depth, edge });
          next.push(neighbor);
        }
      }
      frontier = next;
      if (depth === maxDepth && next.length > 0) truncated = true;
    }
    return { root, reached, maxDepth, truncated };
  }

  /**
   * Shortest dependency path from `a` to `b` (a depends on ... depends on b),
   * following dependent -> dependency edges. Deterministic BFS; empty when no
   * such path exists or either endpoint is unknown.
   */
  public shortestPath(a: string, b: string): ShortestPathResult {
    if (!this.nodes.has(a) || !this.nodes.has(b)) return { found: false, path: [] };
    if (a === b) return { found: true, path: [{ node: this.nodeOrExternal(a), edge: null }] };
    const cameFrom = new Map<string, { prev: string; edge: Relationship }>();
    const visited = new Set<string>([a]);
    let frontier: readonly string[] = [a];
    for (let depth = 0; depth < MAX_TRAVERSAL_DEPTH && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const current of [...frontier].sort((x, y) => x.localeCompare(y, "en-US"))) {
        const stepEdges = this.adjacency.get(current)?.dependencyEdges ?? [];
        const step = stepEdges
          .map((edge) => ({ edge, neighbor: dependencyOf(edge) }))
          .sort(
            (x, y) =>
              x.neighbor.localeCompare(y.neighbor, "en-US") ||
              x.edge.type.localeCompare(y.edge.type, "en-US"),
          );
        for (const { edge, neighbor } of step) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          cameFrom.set(neighbor, { prev: current, edge });
          if (neighbor === b) return { found: true, path: this.reconstruct(a, b, cameFrom) };
          next.push(neighbor);
        }
      }
      frontier = next;
    }
    return { found: false, path: [] };
  }

  private reconstruct(
    a: string,
    b: string,
    cameFrom: ReadonlyMap<string, { prev: string; edge: Relationship }>,
  ): PathStep[] {
    const reverse: PathStep[] = [];
    let cursor = b;
    while (cursor !== a) {
      const link = cameFrom.get(cursor);
      if (link === undefined) break;
      reverse.push({ node: this.nodeOrExternal(cursor), edge: link.edge });
      cursor = link.prev;
    }
    reverse.push({ node: this.nodeOrExternal(a), edge: null });
    return reverse.reverse();
  }
}

function compareNeighbor(a: NeighborEdge, b: NeighborEdge): number {
  return (
    a.neighbor.key.localeCompare(b.neighbor.key, "en-US") ||
    a.edge.type.localeCompare(b.edge.type, "en-US") ||
    a.edge.source.localeCompare(b.edge.source, "en-US")
  );
}

function clampDepth(depth: number): number {
  if (!Number.isFinite(depth)) return DEFAULT_BLAST_DEPTH;
  const rounded = Math.floor(depth);
  if (rounded < 1) return 1;
  if (rounded > MAX_TRAVERSAL_DEPTH) return MAX_TRAVERSAL_DEPTH;
  return rounded;
}

function resourceNode(resource: PilotResource): GraphNode {
  return {
    key: resource.resourceKey,
    present: true,
    service: resource.service,
    resourceType: resource.resourceType,
    region: resource.region.length > 0 ? resource.region : null,
    name: resource.name,
  };
}

function externalNode(key: string): GraphNode {
  return { key, present: false, service: null, resourceType: null, region: null, name: null };
}

function normalizeManualEdge(input: ManualRelationshipInput): Relationship {
  return {
    fromKey: input.fromKey,
    toKey: input.toKey,
    type: input.type,
    source: "manual",
    derivedFrom: null,
    direction: input.direction ?? "depends-on",
    note: input.note ?? null,
  };
}

/**
 * Build the dependency graph from collected resources plus already-derived
 * edges and user-asserted manual edges. Nodes are the collected resources; any
 * key referenced by an edge but not collected becomes an external node. Manual
 * edges never overwrite derived provenance — both can coexist on the same pair.
 */
export function buildDependencyGraph(
  resources: readonly PilotResource[],
  derivedEdges: readonly Relationship[],
  manualEdges: readonly ManualRelationshipInput[] = [],
): DependencyGraph {
  const nodes = new Map<string, GraphNode>();
  for (const resource of resources) nodes.set(resource.resourceKey, resourceNode(resource));

  const manual = manualEdges
    .map(normalizeManualEdge)
    .filter((edge) => edge.fromKey !== edge.toKey);
  const combined = sortRelationships(dedupeRelationships([...derivedEdges, ...manual]));

  for (const edge of combined) {
    if (!nodes.has(edge.fromKey)) nodes.set(edge.fromKey, externalNode(edge.fromKey));
    if (!nodes.has(edge.toKey)) nodes.set(edge.toKey, externalNode(edge.toKey));
  }

  return new DependencyGraph(nodes, combined);
}

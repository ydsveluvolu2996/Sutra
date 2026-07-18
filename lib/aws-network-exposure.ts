// Static AWS internet-exposure path analysis: for each collected network
// resource it decides whether a COMPLETE allow-path from the internet exists —
// network reachability (an internet-gateway default route reaching a public IP,
// or membership as a target of an internet-facing load balancer) AND a security
// group ingress permitting the whole internet (0.0.0.0/0 or ::/0). Pure and
// deterministic; no live calls. Two honesty ideas set it apart from a scanner:
//   * Every hop of a reported path must be present in the evidence — a route to
//     an internet gateway that was never collected is not a confirmed hop.
//   * When the evidence needed to decide a resource is missing (its subnet,
//     route table, internet gateway, or a referenced security group), exposure
//     is 'unknown' — never silently defaulted to 'not-exposed'. Absence of a
//     network path or a definitively closed security group, by contrast, is a
//     supported 'not-exposed'. Nothing is inferred; publicIp is never
//     synthesized from a subnet's mapPublicIpOnLaunch.

export type NetworkExposureStatus = "internet-exposed" | "not-exposed" | "unknown";

export interface NetworkResource {
  readonly ref: string;
  readonly subnetId: string;
  readonly securityGroupIds: readonly string[];
  readonly publicIp?: string;
}

export interface SecurityGroupIngressRule {
  readonly protocol: string;
  readonly fromPort: number;
  readonly toPort: number;
  readonly cidr?: string;
  readonly sourceSgId?: string;
}

export interface SubnetEvidence {
  readonly routeTableId: string;
  readonly mapPublicIpOnLaunch: boolean;
}

export interface RouteEvidence {
  readonly destinationCidr: string;
  readonly gatewayId: string;
}

export interface LoadBalancerListener {
  readonly port: number;
}

export interface LoadBalancerEvidence {
  readonly ref: string;
  readonly scheme: "internet-facing" | "internal";
  readonly listeners: readonly LoadBalancerListener[];
  readonly targets: readonly string[];
}

export interface NetworkExposureEvidence {
  readonly resources: readonly NetworkResource[];
  readonly securityGroups: Readonly<Record<string, readonly SecurityGroupIngressRule[]>>;
  readonly subnets: Readonly<Record<string, SubnetEvidence>>;
  readonly routeTables: Readonly<Record<string, readonly RouteEvidence[]>>;
  readonly internetGateways: readonly string[];
  readonly loadBalancers: readonly LoadBalancerEvidence[];
  readonly tenant?: string;
}

export interface ResourceExposure {
  readonly ref: string;
  readonly exposure: NetworkExposureStatus;
  readonly openPorts: readonly number[];
  readonly path: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly missingEvidence: readonly string[];
}

export interface NetworkExposureReport {
  readonly schema: "sutra.aws-network-exposure.v1";
  readonly tenant: string | null;
  readonly resources: readonly ResourceExposure[];
  readonly summary: {
    readonly resources: number;
    readonly internetExposed: number;
    readonly notExposed: number;
    readonly unknown: number;
  };
  readonly disclaimer: string;
}

// Kleene strong tri-state: true = established, false = refuted, null = unknown.
type Tri = boolean | null;

const INTERNET_CIDRS = new Set(["0.0.0.0/0", "::/0"]);
const DEFAULT_ROUTE = "0.0.0.0/0";
const IGW_PREFIX = /^igw-/u;

const NETWORK_EXPOSURE_DISCLAIMER =
  "Internet exposure is a static path analysis over the collected network " +
  "evidence only. A resource is 'internet-exposed' only when every hop of an " +
  "allow-path is present: reachability (an internet-gateway default route with a " +
  "public IP on the resource, or membership as an internet-facing load balancer " +
  "target) AND a security group ingress permitting 0.0.0.0/0 or ::/0. When the " +
  "subnet, route table, internet gateway, or a referenced security group needed " +
  "to decide is missing, exposure is 'unknown', never assumed 'not-exposed'; a " +
  "public IP is never inferred from a subnet's mapPublicIpOnLaunch. This is not " +
  "proof of live reachability.";

function andTri(left: Tri, right: Tri): Tri {
  if (left === false || right === false) return false;
  if (left === true && right === true) return true;
  return null;
}

function orTri(left: Tri, right: Tri): Tri {
  if (left === true || right === true) return true;
  if (left === false && right === false) return false;
  return null;
}

function portLabel(rule: SecurityGroupIngressRule): string {
  return rule.fromPort === rule.toPort ? `${rule.fromPort}` : `${rule.fromPort}-${rule.toPort}`;
}

function sortStrings(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right, "en-US"));
}

interface EvaluationContext {
  readonly securityGroups: Map<string, readonly SecurityGroupIngressRule[]>;
  readonly subnets: Map<string, SubnetEvidence>;
  readonly routeTables: Map<string, readonly RouteEvidence[]>;
  readonly internetGateways: Set<string>;
  readonly internetFacingLbByTarget: Map<string, string[]>;
}

interface InternetRule {
  readonly sgId: string;
  readonly rule: SecurityGroupIngressRule;
  readonly cidr: string;
}

function evaluateSecurityGroups(
  resource: NetworkResource,
  ctx: EvaluationContext,
  evidenceRefs: Set<string>,
  missing: Set<string>,
): { readonly sgOpen: Tri; readonly internetRules: readonly InternetRule[] } {
  const internetRules: InternetRule[] = [];
  let hasUnresolvedSg = false;
  for (const sgId of resource.securityGroupIds) {
    const rules = ctx.securityGroups.get(sgId);
    if (rules === undefined) {
      hasUnresolvedSg = true;
      missing.add(`security group ${sgId}`);
      continue;
    }
    evidenceRefs.add(sgId);
    for (const rule of rules) {
      if (rule.cidr !== undefined && INTERNET_CIDRS.has(rule.cidr)) {
        internetRules.push({ sgId, rule, cidr: rule.cidr });
      }
    }
  }
  if (internetRules.length > 0) return { sgOpen: true, internetRules };
  if (resource.securityGroupIds.length === 0) {
    missing.add("security group membership");
    return { sgOpen: null, internetRules };
  }
  if (hasUnresolvedSg) return { sgOpen: null, internetRules };
  return { sgOpen: false, internetRules };
}

function evaluateInternetGatewayReach(
  resource: NetworkResource,
  ctx: EvaluationContext,
  evidenceRefs: Set<string>,
  missing: Set<string>,
): { readonly igwReach: Tri; readonly hops: readonly string[] } {
  if (resource.publicIp === undefined) return { igwReach: false, hops: [] };

  const subnet = ctx.subnets.get(resource.subnetId);
  if (subnet === undefined) {
    missing.add(`subnet ${resource.subnetId}`);
    return { igwReach: null, hops: [] };
  }
  evidenceRefs.add(resource.subnetId);

  const routes = ctx.routeTables.get(subnet.routeTableId);
  if (routes === undefined) {
    missing.add(`route table ${subnet.routeTableId} for subnet ${resource.subnetId}`);
    return { igwReach: null, hops: [] };
  }
  evidenceRefs.add(subnet.routeTableId);

  let confirmedIgw: string | null = null;
  let unconfirmedIgw = false;
  for (const route of routes) {
    if (route.destinationCidr !== DEFAULT_ROUTE) continue;
    if (ctx.internetGateways.has(route.gatewayId)) {
      confirmedIgw = route.gatewayId;
      break;
    }
    if (IGW_PREFIX.test(route.gatewayId)) unconfirmedIgw = true;
  }
  if (confirmedIgw !== null) {
    evidenceRefs.add(confirmedIgw);
    return { igwReach: true, hops: [confirmedIgw, subnet.routeTableId, resource.subnetId] };
  }
  if (unconfirmedIgw) {
    missing.add(`internet gateway for the default route of route table ${subnet.routeTableId}`);
    return { igwReach: null, hops: [] };
  }
  return { igwReach: false, hops: [] };
}

function evaluateResource(resource: NetworkResource, ctx: EvaluationContext): ResourceExposure {
  const evidenceRefs = new Set<string>([resource.ref]);
  const missing = new Set<string>();

  const { sgOpen, internetRules } = evaluateSecurityGroups(resource, ctx, evidenceRefs, missing);
  const { igwReach, hops: igwHops } = evaluateInternetGatewayReach(resource, ctx, evidenceRefs, missing);

  const lbRefs = ctx.internetFacingLbByTarget.get(resource.ref);
  const lbReach: Tri = lbRefs !== undefined && lbRefs.length > 0 ? true : false;
  const lbHops: string[] = [];
  if (lbReach === true && lbRefs !== undefined) {
    for (const lbRef of sortStrings(lbRefs)) {
      evidenceRefs.add(lbRef);
      lbHops.push(`${lbRef} internet-facing`);
    }
  }

  const netReach = orTri(igwReach, lbReach);
  const verdict = andTri(netReach, sgOpen);
  const exposure: NetworkExposureStatus =
    verdict === true ? "internet-exposed" : verdict === false ? "not-exposed" : "unknown";

  const openPorts = [...new Set(internetRules.map((entry) => entry.rule.fromPort))].sort((a, b) => a - b);
  const sgHops = sortStrings(
    new Set(internetRules.map((entry) => `${entry.sgId} ${entry.cidr}:${portLabel(entry.rule)}`)),
  );

  const path: string[] = [];
  if (exposure === "internet-exposed") {
    if (igwReach === true) path.push(...igwHops);
    path.push(...lbHops);
    path.push(...sgHops);
  }

  return {
    ref: resource.ref,
    exposure,
    openPorts,
    path,
    evidenceRefs: sortStrings(evidenceRefs),
    missingEvidence: exposure === "unknown" ? sortStrings(missing) : [],
  };
}

export function buildNetworkExposure(evidence: NetworkExposureEvidence): NetworkExposureReport {
  const internetFacingLbByTarget = new Map<string, string[]>();
  for (const lb of evidence.loadBalancers) {
    if (lb.scheme !== "internet-facing") continue;
    for (const target of lb.targets) {
      const existing = internetFacingLbByTarget.get(target);
      if (existing === undefined) internetFacingLbByTarget.set(target, [lb.ref]);
      else existing.push(lb.ref);
    }
  }

  const ctx: EvaluationContext = {
    securityGroups: new Map(Object.entries(evidence.securityGroups)),
    subnets: new Map(Object.entries(evidence.subnets)),
    routeTables: new Map(Object.entries(evidence.routeTables)),
    internetGateways: new Set(evidence.internetGateways),
    internetFacingLbByTarget,
  };

  const resources = evidence.resources
    .map((resource) => evaluateResource(resource, ctx))
    .sort((left, right) => left.ref.localeCompare(right.ref, "en-US"));

  const summary = {
    resources: resources.length,
    internetExposed: resources.filter((entry) => entry.exposure === "internet-exposed").length,
    notExposed: resources.filter((entry) => entry.exposure === "not-exposed").length,
    unknown: resources.filter((entry) => entry.exposure === "unknown").length,
  };

  return {
    schema: "sutra.aws-network-exposure.v1",
    tenant: evidence.tenant ?? null,
    resources,
    summary,
    disclaimer: NETWORK_EXPOSURE_DISCLAIMER,
  };
}

// Adapter: collected AWS resources (PilotResource[]) -> NetworkExposureEvidence
// for the internet-exposure engine. Pure and deterministic; it only reshapes
// already-collected evidence and never invents a hop. Missing pieces stay
// missing so the engine can report 'unknown' honestly:
//   * Subnet -> route-table is resolved from route-table associations, falling
//     back to the VPC's main route table (AWS's own default) — never guessed.
//   * Network ACLs are not collected yet, so no NACL evidence is emitted and the
//     engine assumes AWS's default allow-all NACL (documented in its disclaimer).
//   * Load-balancer target membership is not collected yet, so LB targets are
//     empty and LB-based reachability simply does not fire (never fabricated).
//   * Only load-balancer DNS names are available as public DNS entry points;
//     Route53 records are a later collector.
import type { JsonValue, PilotResource } from "./pilot-types.ts";
import type {
  DnsRecordEvidence,
  LoadBalancerEvidence,
  NetworkAclRule,
  NetworkExposureEvidence,
  NetworkResource,
  RouteEvidence,
  SecurityGroupIngressRule,
  SubnetEvidence,
} from "./aws-network-exposure.ts";

// The live collector prefixes types ("aws.ec2.security-group"); other resource
// sources use bare kinds ("security-group"). Normalize both to the bare kind.
function kind(resourceType: string): string {
  return resourceType.replace(/^aws\.(?:ec2|elasticloadbalancingv2|elasticloadbalancing)\./u, "");
}

function str(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function strArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function num(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: JsonValue | undefined): boolean {
  return value === true;
}

function records(value: JsonValue | undefined): Readonly<Record<string, JsonValue>>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Readonly<Record<string, JsonValue>> =>
        typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

// One collected security-group ingress permission fans out to one engine rule
// per source (each IPv4/IPv6 CIDR, each referenced security group). An
// all-traffic rule (protocol "-1", no ports) becomes the full 0..65535 range.
function ingressRules(permission: Readonly<Record<string, JsonValue>>): SecurityGroupIngressRule[] {
  const protocol = str(permission.protocol) ?? "-1";
  const fromPort = num(permission.fromPort) ?? 0;
  const toPort = num(permission.toPort) ?? 65_535;
  const base = { protocol, fromPort, toPort };
  const rules: SecurityGroupIngressRule[] = [];
  for (const cidr of [...strArray(permission.ipv4Cidrs), ...strArray(permission.ipv6Cidrs)]) {
    rules.push({ ...base, cidr });
  }
  for (const sourceSgId of strArray(permission.referencedSecurityGroupIds)) {
    rules.push({ ...base, sourceSgId });
  }
  return rules;
}

export function buildNetworkExposureEvidence(
  resources: readonly PilotResource[],
  options: { readonly tenant?: string } = {},
): NetworkExposureEvidence {
  const byKind = new Map<string, PilotResource[]>();
  for (const resource of resources) {
    const key = kind(resource.resourceType);
    const existing = byKind.get(key);
    if (existing === undefined) byKind.set(key, [resource]);
    else existing.push(resource);
  }
  const of = (key: string): PilotResource[] => byKind.get(key) ?? [];

  // Network interfaces are the attachment points that carry a public IP,
  // security groups, and a subnet — the unit the engine evaluates.
  const networkResources: NetworkResource[] = of("network-interface").map((eni) => {
    const config = eni.configuration;
    const publicIp = str(config.publicIpAddress);
    return {
      ref: eni.nativeId,
      subnetId: str(config.subnetId) ?? "",
      securityGroupIds: strArray(config.securityGroupIds),
      ...(publicIp === undefined ? {} : { publicIp }),
    };
  });

  const securityGroups: Record<string, SecurityGroupIngressRule[]> = {};
  for (const group of of("security-group")) {
    securityGroups[group.nativeId] = records(group.configuration.ingress).flatMap(ingressRules);
  }

  // Route tables: raw routes -> RouteEvidence, plus subnet association maps.
  const routeTables: Record<string, RouteEvidence[]> = {};
  const routeTableBySubnet = new Map<string, string>();
  const mainRouteTableByVpc = new Map<string, string>();
  for (const table of of("route-table")) {
    const config = table.configuration;
    routeTables[table.nativeId] = records(config.routes).flatMap((route) => {
      const destinationCidr = str(route.destination);
      const gatewayId = str(route.target);
      return destinationCidr === undefined || gatewayId === undefined
        ? []
        : [{ destinationCidr, gatewayId }];
    });
    for (const subnetId of strArray(config.associatedSubnetIds)) routeTableBySubnet.set(subnetId, table.nativeId);
    const vpcId = str(config.vpcId);
    if (bool(config.main) && vpcId !== undefined) mainRouteTableByVpc.set(vpcId, table.nativeId);
  }

  // Network ACLs: ordered entries -> engine rules, and the subnet -> ACL map so
  // subnet-boundary port filtering can be evaluated.
  const networkAcls: Record<string, NetworkAclRule[]> = {};
  const networkAclBySubnet = new Map<string, string>();
  for (const acl of of("network-acl")) {
    const config = acl.configuration;
    networkAcls[acl.nativeId] = records(config.entries).flatMap((entry) => {
      const ruleNumber = num(entry.ruleNumber);
      const ruleAction = str(entry.ruleAction);
      if (ruleNumber === undefined || (ruleAction !== "allow" && ruleAction !== "deny")) return [];
      const cidr = str(entry.cidr);
      const fromPort = num(entry.fromPort);
      const toPort = num(entry.toPort);
      return [{
        ruleNumber,
        egress: entry.egress === true,
        protocol: str(entry.protocol) ?? "-1",
        ruleAction,
        ...(cidr === undefined ? {} : { cidr }),
        ...(fromPort === undefined ? {} : { fromPort }),
        ...(toPort === undefined ? {} : { toPort }),
      }];
    });
    for (const subnetId of strArray(config.associatedSubnetIds)) networkAclBySubnet.set(subnetId, acl.nativeId);
  }

  // A subnet's route table is its explicit association, else its VPC's main
  // route table (AWS's own fallback); its NACL is the associated ACL if collected.
  const subnets: Record<string, SubnetEvidence> = {};
  for (const subnet of of("subnet")) {
    const config = subnet.configuration;
    const vpcId = str(config.vpcId);
    const routeTableId = routeTableBySubnet.get(subnet.nativeId)
      ?? (vpcId === undefined ? undefined : mainRouteTableByVpc.get(vpcId));
    if (routeTableId === undefined) continue; // no association evidence -> engine treats subnet as unknown
    const networkAclId = networkAclBySubnet.get(subnet.nativeId);
    subnets[subnet.nativeId] = {
      routeTableId,
      mapPublicIpOnLaunch: bool(config.mapPublicIpOnLaunch),
      ...(networkAclId === undefined ? {} : { networkAclId }),
    };
  }

  const internetGateways = of("internet-gateway").map((igw) => igw.nativeId);

  // Listeners grouped by their load balancer, and the load balancers themselves.
  const listenerPortsByLb = new Map<string, number[]>();
  for (const listener of of("listener")) {
    const lbArn = str(listener.configuration.loadBalancerArn);
    const port = num(listener.configuration.port);
    if (lbArn === undefined || port === undefined) continue;
    const existing = listenerPortsByLb.get(lbArn);
    if (existing === undefined) listenerPortsByLb.set(lbArn, [port]);
    else existing.push(port);
  }

  const loadBalancers: LoadBalancerEvidence[] = [];
  const dnsRecords: DnsRecordEvidence[] = [];
  for (const lb of of("load-balancer")) {
    const config = lb.configuration;
    const scheme = str(config.scheme) === "internet-facing" ? "internet-facing" : "internal";
    loadBalancers.push({
      ref: lb.nativeId,
      scheme,
      listeners: (listenerPortsByLb.get(lb.nativeId) ?? []).map((port) => ({ port })),
      targets: [], // target-group membership is not collected yet
    });
    const dnsName = str(config.dnsName);
    if (dnsName !== undefined) {
      dnsRecords.push({ name: dnsName, type: "ALIAS", public: scheme === "internet-facing", targetRef: lb.nativeId });
    }
  }

  return {
    resources: networkResources,
    securityGroups,
    subnets,
    routeTables,
    internetGateways,
    loadBalancers,
    ...(Object.keys(networkAcls).length > 0 ? { networkAcls } : {}),
    ...(dnsRecords.length > 0 ? { dnsRecords } : {}),
    ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
  };
}

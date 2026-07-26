/**
 * Pure, deterministic "idle & unused resource waste" detection derived ONLY from
 * collected CMDB configuration (no CUR/FOCUS billing lines, no live clock).
 *
 * Relationship to `lib/finops-idle-waste.ts`
 * ------------------------------------------
 * This is a COMPLEMENTARY, config-only view — it is intentionally NOT wired into
 * the same output as the CUR-aware idle/waste engine and does not reuse its
 * finding ids, schema, or `IdleWasteCategory` taxonomy. Its `wasteKind` labels
 * are deliberately distinct so a reader can never mistake one engine's finding
 * for the other's:
 *
 *   this engine (`ResourceWasteKind`)   idle-waste engine (`IdleWasteCategory`)
 *   ---------------------------------   ---------------------------------------
 *   available-ebs-volume                unattached-ebs-volume
 *   unassociated-elastic-ip             unused-elastic-ip
 *   empty-load-balancer                 idle-load-balancer
 *   aged-ebs-snapshot          (novel)  orphaned-snapshot        (different axis)
 *   stopped-ec2-instance-storage        stopped-instance-billing
 *
 * The genuinely new capability here is AGE-based snapshot detection: the
 * idle-waste engine flags a snapshot only when its SOURCE VOLUME is gone
 * (orphaned); this engine flags snapshots older than a caller-supplied
 * `thresholdDays` regardless of orphan status — a cleanup-candidate axis the
 * other engine does not cover. The remaining four kinds share the same
 * underlying resource signals; they are exposed on a SEPARATE endpoint and are
 * never merged into the idle-waste engine's response, so no single response ever
 * lists a resource twice.
 *
 * Honesty rules (never relaxed):
 * - A monthly `$` is attached ONLY when derivable from a collected sizing/type
 *   attribute times a disclosed, conservative published USD list price. When no
 *   basis exists the amount is `null` and `estimateBasis` is `null`. A number is
 *   NEVER fabricated. Every estimate is labelled "approx ... list price".
 * - Determinism: the reference `now` and `thresholdDays` are passed IN. The
 *   engine never calls Date.now(). Given identical inputs it returns identical
 *   output.
 * - Robustness: missing/malformed configuration keys are skipped, never thrown.
 */
import type { JsonValue, PilotResource } from "./pilot-types.ts";

export type ResourceWasteKind =
  | "available-ebs-volume"
  | "unassociated-elastic-ip"
  | "empty-load-balancer"
  | "aged-ebs-snapshot"
  | "stopped-ec2-instance-storage";

export interface ResourceWasteFinding {
  readonly resourceKey: string;
  readonly resourceType: string;
  readonly region: string | null;
  readonly wasteKind: ResourceWasteKind;
  /** Human-readable reason this resource is flagged as waste. */
  readonly reason: string;
  /**
   * Approximate monthly USD, or null when no honest basis is derivable from the
   * collected configuration. Never fabricated; always a labelled approximation.
   */
  readonly estimatedMonthlyUsd: number | null;
  /** Disclosure of how `estimatedMonthlyUsd` was derived; null when it is null. */
  readonly estimateBasis: string | null;
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
}

export interface ResourceWasteGroup {
  readonly wasteKind: ResourceWasteKind;
  readonly count: number;
  /** Summed approximate USD across the group's derivable estimates (null if none). */
  readonly estimatedMonthlyUsd: number | null;
}

export interface ResourceWasteReport {
  readonly schema: "sutra.finops-resource-waste.v1";
  readonly findings: readonly ResourceWasteFinding[];
  readonly groups: readonly ResourceWasteGroup[];
  readonly totalEstimatedMonthlyUsd: number;
  /** Age threshold (days) that was applied to snapshots. */
  readonly thresholdDays: number;
  readonly disclaimer: string;
}

export interface ResourceWasteOptions {
  /**
   * Reference instant for snapshot age. Supplied by the caller (the route) so
   * the engine stays clock-free. When absent, aged-snapshot detection is skipped
   * (no age can be computed honestly).
   */
  readonly now?: Date;
  /** Snapshots at least this many days old are flagged. Default 90. */
  readonly thresholdDays?: number;
  /** Override the bundled USD list prices (tests / region-specific pricing). */
  readonly pricing?: Partial<ResourceWastePricing>;
}

export interface ResourceWastePricing {
  /** EBS gp3 storage, USD per GiB-month (us-east-1 list). */
  readonly ebsGiBMonthUsd: number;
  /** Idle/unassociated Elastic IP, USD per month (0.005/hr * 720). */
  readonly elasticIpMonthUsd: number;
  /** Application Load Balancer fixed hourly component, USD/month (0.0225/hr * 720). */
  readonly albMonthUsd: number;
  /** Network/Gateway Load Balancer fixed hourly component, USD/month. */
  readonly nlbMonthUsd: number;
}

/** Conservative, publicly documented us-east-1 list prices, in USD. Labelled INPUT estimates, never quotes. */
export const DEFAULT_RESOURCE_WASTE_PRICING: ResourceWastePricing = {
  ebsGiBMonthUsd: 0.08,
  elasticIpMonthUsd: 3.6,
  albMonthUsd: 16.2,
  nlbMonthUsd: 16.2,
};

export const RESOURCE_WASTE_DISCLAIMER =
  "Resource-waste findings are derived only from collected CMDB configuration " +
  "(no billing data). Any monthly cost shown is an APPROXIMATION: a conservative " +
  "USD us-east-1 published list price applied to a collected sizing/type " +
  "attribute, labelled \"approx ... list price\" — it is an estimate input, not a " +
  "quote or billed cost. Where no sizing attribute is collected no figure is " +
  "claimed (null). Review each item against the workload before acting.";

const DEFAULT_THRESHOLD_DAYS = 90;
const DAY_MS = 86_400_000;

const VOLUME_TYPES = new Set(["aws.ec2.volume", "ec2.volume"]);
const INSTANCE_TYPES = new Set(["aws.ec2.instance", "ec2.instance"]);
const ELASTIC_IP_TYPES = new Set(["aws.ec2.elastic-ip", "ec2.elastic-ip"]);
const SNAPSHOT_TYPES = new Set(["aws.ec2.snapshot", "ec2.snapshot"]);
const LOAD_BALANCER_TYPES = new Set([
  "aws.elasticloadbalancingv2.load-balancer",
  "elasticloadbalancingv2.load-balancer",
  "aws.elasticloadbalancing.load-balancer",
  "elasticloadbalancing.load-balancer",
]);
const TARGET_GROUP_TYPES = new Set([
  "aws.elasticloadbalancingv2.target-group",
  "elasticloadbalancingv2.target-group",
]);
const STOPPED_STATE = /^(stopped|stopping|shutting-down|deallocated)$/iu;

function num(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: JsonValue | undefined): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/** First present numeric sizing attribute among several possible key spellings. */
function sizeGiB(config: Readonly<Record<string, JsonValue>>): number | null {
  return num(config.sizeGiB) ?? num(config.size) ?? num(config.sizeGib) ?? num(config.volumeSize);
}

function region(resource: PilotResource): string | null {
  return resource.region.length > 0 ? resource.region : null;
}

/** Round to whole cents so summed estimates stay tidy and deterministic. */
function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

function volumeAttached(config: Readonly<Record<string, JsonValue>>): boolean {
  const state = str(config.state);
  if (state !== null && state.toLowerCase() === "available") return false;
  if (state !== null && state.toLowerCase() === "in-use") return true;
  // No explicit state: treat as attached if any attachment/instance signal exists.
  return instanceIdsOf(config).length > 0;
}

function instanceIdsOf(config: Readonly<Record<string, JsonValue>>): readonly string[] {
  const ids = stringArray(config.instanceIds);
  if (ids.length > 0) return ids;
  const attachments = Array.isArray(config.attachments) ? config.attachments : [];
  const found: string[] = [];
  for (const attachment of attachments) {
    if (typeof attachment !== "object" || attachment === null || Array.isArray(attachment)) continue;
    const id = str((attachment as Record<string, JsonValue>).instanceId);
    if (id !== null) found.push(id);
  }
  return found;
}

function elasticIpAssociated(config: Readonly<Record<string, JsonValue>>): boolean {
  if (typeof config.associated === "boolean") return config.associated;
  return (
    str(config.associationId) !== null ||
    str(config.instanceId) !== null ||
    str(config.networkInterfaceId) !== null
  );
}

/** Snapshot start/create time from any of the common key spellings. */
function snapshotStart(config: Readonly<Record<string, JsonValue>>): string | null {
  return (
    str(config.startTime) ??
    str(config.createTime) ??
    str(config.startedAt) ??
    str(config.createdAt) ??
    str(config.creationTime)
  );
}

function ageDays(startIso: string, now: Date): number | null {
  const started = Date.parse(startIso);
  if (!Number.isFinite(started)) return null;
  const delta = now.getTime() - started;
  if (!Number.isFinite(delta)) return null;
  return delta / DAY_MS;
}

export function detectResourceWaste(
  resources: readonly PilotResource[],
  options: ResourceWasteOptions = {},
): ResourceWasteReport {
  const pricing: ResourceWastePricing = {
    ebsGiBMonthUsd: options.pricing?.ebsGiBMonthUsd ?? DEFAULT_RESOURCE_WASTE_PRICING.ebsGiBMonthUsd,
    elasticIpMonthUsd: options.pricing?.elasticIpMonthUsd ?? DEFAULT_RESOURCE_WASTE_PRICING.elasticIpMonthUsd,
    albMonthUsd: options.pricing?.albMonthUsd ?? DEFAULT_RESOURCE_WASTE_PRICING.albMonthUsd,
    nlbMonthUsd: options.pricing?.nlbMonthUsd ?? DEFAULT_RESOURCE_WASTE_PRICING.nlbMonthUsd,
  };
  const thresholdDays =
    typeof options.thresholdDays === "number" && Number.isFinite(options.thresholdDays) && options.thresholdDays >= 0
      ? options.thresholdDays
      : DEFAULT_THRESHOLD_DAYS;
  const now = options.now;

  // Pre-pass: EBS storage (GiB) attached to each instance, so a stopped
  // instance's still-billing storage can be priced when the volumes were
  // collected. Robust to volumes with no sizing attribute (counted as 0).
  const attachedGiBByInstanceId = new Map<string, number>();
  // Pre-pass: registered target/instance count per load balancer arn, joined
  // across the balancer's target groups (v2) and classic `instances`.
  const registeredByLbArn = new Map<string, number>();
  for (const resource of resources) {
    const config = resource.configuration;
    if (VOLUME_TYPES.has(resource.resourceType)) {
      const size = sizeGiB(config) ?? 0;
      for (const instanceId of instanceIdsOf(config)) {
        attachedGiBByInstanceId.set(instanceId, (attachedGiBByInstanceId.get(instanceId) ?? 0) + size);
      }
    } else if (TARGET_GROUP_TYPES.has(resource.resourceType)) {
      const targets = Array.isArray(config.targets) ? config.targets : [];
      const registered = targets.filter(
        (target) => typeof target === "object" && target !== null && !Array.isArray(target),
      ).length;
      for (const arn of stringArray(config.loadBalancerArns)) {
        registeredByLbArn.set(arn, (registeredByLbArn.get(arn) ?? 0) + registered);
      }
    }
  }

  const findings: ResourceWasteFinding[] = [];

  for (const resource of resources) {
    const config = resource.configuration;
    const base = { resourceKey: resource.resourceKey, resourceType: resource.resourceType, region: region(resource) };

    if (VOLUME_TYPES.has(resource.resourceType)) {
      if (volumeAttached(config)) continue; // in-use → not waste (and the CUR engine's domain)
      const size = sizeGiB(config);
      const estimate = size !== null && size > 0 ? cents(Math.trunc(size) * pricing.ebsGiBMonthUsd) : null;
      findings.push({
        ...base,
        wasteKind: "available-ebs-volume",
        reason:
          `EBS volume is in state "available" (not attached to any instance) yet keeps billing for ` +
          `${size !== null ? `${Math.trunc(size)} GiB of ` : ""}provisioned storage. Snapshot then delete if unused.`,
        estimatedMonthlyUsd: estimate,
        estimateBasis: estimate !== null ? "approx gp3 list price" : null,
        evidence: compact({ state: str(config.state) ?? undefined, sizeGiB: size ?? undefined, attached: false }),
      });
      continue;
    }

    if (ELASTIC_IP_TYPES.has(resource.resourceType)) {
      if (elasticIpAssociated(config)) continue;
      findings.push({
        ...base,
        wasteKind: "unassociated-elastic-ip",
        reason:
          "Elastic IP is allocated but not associated with any instance or network interface; AWS bills idle EIPs hourly. Release it if unused.",
        estimatedMonthlyUsd: cents(pricing.elasticIpMonthUsd),
        estimateBasis: "approx idle Elastic IP list price",
        evidence: compact({ associated: false }),
      });
      continue;
    }

    if (LOAD_BALANCER_TYPES.has(resource.resourceType)) {
      const arn = resource.arn ?? resource.nativeId;
      const classicInstances = Array.isArray(config.instances) ? config.instances.length : 0;
      const registered = (registeredByLbArn.get(arn) ?? 0) + classicInstances;
      if (registered > 0) continue;
      const lbType = str(config.type);
      const estimate = bundledLbUsd(lbType, pricing);
      findings.push({
        ...base,
        wasteKind: "empty-load-balancer",
        reason:
          "Load balancer has zero registered targets/instances yet keeps billing for its provisioned hours. Remove it or register a backend.",
        estimatedMonthlyUsd: estimate !== null ? cents(estimate) : null,
        estimateBasis: estimate !== null ? "approx load balancer fixed-hours list price" : null,
        evidence: compact({ loadBalancerType: lbType ?? undefined, registeredTargetCount: registered }),
      });
      continue;
    }

    if (SNAPSHOT_TYPES.has(resource.resourceType)) {
      if (now === undefined) continue; // cannot compute age honestly without a reference clock
      const start = snapshotStart(config);
      if (start === null) continue;
      const age = ageDays(start, now);
      if (age === null || age < thresholdDays) continue;
      findings.push({
        ...base,
        wasteKind: "aged-ebs-snapshot",
        reason:
          `EBS snapshot is ${Math.floor(age)} days old (>= ${thresholdDays}-day cleanup threshold). ` +
          "Delete it if it is not part of a retention policy or restore plan.",
        // Incremental snapshot storage is not derivable from configuration, so no
        // cost is claimed (source-volume size is only a loose upper bound).
        estimatedMonthlyUsd: null,
        estimateBasis: null,
        evidence: compact({ startTime: start, ageDays: Math.floor(age), thresholdDays }),
      });
      continue;
    }

    if (INSTANCE_TYPES.has(resource.resourceType)) {
      const state = str(config.state) ?? (resource.state.length > 0 ? resource.state : null);
      if (state === null || !STOPPED_STATE.test(state)) continue;
      const attachedGiB = attachedGiBByInstanceId.get(resource.nativeId);
      const estimate =
        attachedGiB !== undefined && attachedGiB > 0 ? cents(Math.trunc(attachedGiB) * pricing.ebsGiBMonthUsd) : null;
      findings.push({
        ...base,
        wasteKind: "stopped-ec2-instance-storage",
        reason:
          "EC2 instance is stopped (compute is $0) but its attached EBS storage keeps billing. Informational: snapshot-and-terminate if the instance is no longer needed.",
        estimatedMonthlyUsd: estimate,
        estimateBasis: estimate !== null ? "approx gp3 list price (attached EBS)" : null,
        evidence: compact({
          state,
          instanceType: str(config.instanceType) ?? undefined,
          attachedVolumeGiB: attachedGiB ?? undefined,
        }),
      });
    }
  }

  // Deterministic order: by wasteKind, then resourceKey.
  findings.sort(
    (left, right) =>
      left.wasteKind.localeCompare(right.wasteKind, "en-US") ||
      left.resourceKey.localeCompare(right.resourceKey, "en-US"),
  );

  const groups = groupByKind(findings);
  const totalEstimatedMonthlyUsd = cents(
    findings.reduce((sum, finding) => sum + (finding.estimatedMonthlyUsd ?? 0), 0),
  );

  return {
    schema: "sutra.finops-resource-waste.v1",
    findings,
    groups,
    totalEstimatedMonthlyUsd,
    thresholdDays,
    disclaimer: RESOURCE_WASTE_DISCLAIMER,
  };
}

function bundledLbUsd(type: string | null, pricing: ResourceWastePricing): number | null {
  if (type === null) return null;
  const normalized = type.trim().toLowerCase();
  if (normalized === "network" || normalized === "gateway") return pricing.nlbMonthUsd;
  if (normalized === "application") return pricing.albMonthUsd;
  return null;
}

function groupByKind(findings: readonly ResourceWasteFinding[]): ResourceWasteGroup[] {
  const order: readonly ResourceWasteKind[] = [
    "available-ebs-volume",
    "unassociated-elastic-ip",
    "empty-load-balancer",
    "aged-ebs-snapshot",
    "stopped-ec2-instance-storage",
  ];
  const counts = new Map<ResourceWasteKind, { count: number; usd: number; hasEstimate: boolean }>();
  for (const finding of findings) {
    const entry = counts.get(finding.wasteKind) ?? { count: 0, usd: 0, hasEstimate: false };
    entry.count += 1;
    if (finding.estimatedMonthlyUsd !== null) {
      entry.usd += finding.estimatedMonthlyUsd;
      entry.hasEstimate = true;
    }
    counts.set(finding.wasteKind, entry);
  }
  const groups: ResourceWasteGroup[] = [];
  for (const kind of order) {
    const entry = counts.get(kind);
    if (entry === undefined) continue;
    groups.push({
      wasteKind: kind,
      count: entry.count,
      estimatedMonthlyUsd: entry.hasEstimate ? cents(entry.usd) : null,
    });
  }
  return groups;
}

function compact(
  values: Readonly<Record<string, string | number | boolean | undefined>>,
): Readonly<Record<string, string | number | boolean>> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

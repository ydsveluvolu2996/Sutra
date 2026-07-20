/**
 * Adapter: maps collected CMDB resources (EBS volumes, ELBv2 load balancers +
 * target groups, Elastic IPs, EC2 instances, EBS snapshots) and — optionally —
 * ingested CUR/FOCUS lines into the pure idle/waste engine's input.
 *
 * Honesty is preserved end-to-end: the adapter only shapes collected metadata
 * and joins CUR cost when a resource-identifying tag makes an exact join
 * possible. When cost is not derivable it is simply omitted (the engine then
 * falls back to a bundled list price where a sizing attribute exists, or emits a
 * null estimate with a disclosed reason). Nothing is invented.
 */
import type { NormalizedCurLine } from "./finops-cur.ts";
import type { JsonValue, PilotResource } from "./pilot-types.ts";
import type {
  DerivedCurCost,
  IdleLoadBalancerInput,
  IdleWasteInput,
  OrphanedSnapshotInput,
  StoppedInstanceInput,
  UnattachedVolumeInput,
  UnusedElasticIpInput,
} from "./finops-idle-waste.ts";

export interface IdleWasteAdapterInput {
  readonly resources: readonly PilotResource[];
  /** Optional ingested CUR/FOCUS lines used to derive exact per-resource cost. */
  readonly curLines?: readonly NormalizedCurLine[];
  /**
   * Tag key on a CUR line whose value equals the resource nativeId (e.g. a
   * resource-id cost-allocation tag). Only when supplied is CUR cost joined.
   */
  readonly curResourceTagKey?: string;
  readonly pricing?: IdleWasteInput["pricing"];
}

const VOLUME_TYPES = new Set(["aws.ec2.volume", "ec2.volume"]);
const INSTANCE_TYPES = new Set(["aws.ec2.instance", "ec2.instance"]);
const ELASTIC_IP_TYPES = new Set(["aws.ec2.elastic-ip", "ec2.elastic-ip"]);
const SNAPSHOT_TYPES = new Set(["aws.ec2.snapshot", "ec2.snapshot"]);
const LOAD_BALANCER_TYPES = new Set([
  "aws.elasticloadbalancingv2.load-balancer",
  "elasticloadbalancingv2.load-balancer",
]);
const TARGET_GROUP_TYPES = new Set([
  "aws.elasticloadbalancingv2.target-group",
  "elasticloadbalancingv2.target-group",
]);
const STOPPED_STATE = /^(stopped|stopping|shutting-down|deallocated)$/iu;
const MICROS = /^-?\d+$/u;

function num(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nativeId(resource: PilotResource): string {
  return resource.nativeId;
}

/**
 * Derive per-resource monthly cost from CUR lines by summing amounts whose
 * identifying tag equals the resource nativeId. A resource with lines in more
 * than one currency is skipped (a single total is never guessed).
 */
function curCostByResourceId(
  curLines: readonly NormalizedCurLine[],
  tagKey: string,
): Map<string, DerivedCurCost> {
  const byId = new Map<string, Map<string, bigint>>();
  for (const line of curLines) {
    const id = line.tags[tagKey];
    if (id === undefined || id.length === 0 || !MICROS.test(line.amountMicros)) continue;
    const amount = BigInt(line.amountMicros);
    if (amount <= BigInt(0)) continue;
    const perCurrency = byId.get(id) ?? new Map<string, bigint>();
    perCurrency.set(line.currency, (perCurrency.get(line.currency) ?? BigInt(0)) + amount);
    byId.set(id, perCurrency);
  }
  const result = new Map<string, DerivedCurCost>();
  for (const [id, perCurrency] of byId) {
    if (perCurrency.size !== 1) continue; // ambiguous currency — do not guess a total
    const [currency, micros] = [...perCurrency.entries()][0];
    result.set(id, { currency, monthlyMicros: micros.toString() });
  }
  return result;
}

export function buildIdleWasteInputs(input: IdleWasteAdapterInput): IdleWasteInput {
  const curCost =
    input.curLines !== undefined && input.curResourceTagKey !== undefined && input.curResourceTagKey.length > 0
      ? curCostByResourceId(input.curLines, input.curResourceTagKey)
      : new Map<string, DerivedCurCost>();
  const cost = (id: string): DerivedCurCost | null => curCost.get(id) ?? null;

  // Live EBS volumes, indexed by attached instance id, to price stopped-instance
  // storage and to know which volumes are attached.
  const attachedGiBByInstanceId = new Map<string, number>();
  const knownVolumeIds = new Set<string>();
  for (const resource of input.resources) {
    if (!VOLUME_TYPES.has(resource.resourceType)) continue;
    knownVolumeIds.add(nativeId(resource));
    const size = num(resource.configuration.sizeGiB) ?? 0;
    for (const instanceId of instanceIdsOf(resource)) {
      attachedGiBByInstanceId.set(instanceId, (attachedGiBByInstanceId.get(instanceId) ?? 0) + size);
    }
  }

  // Target health aggregated per load balancer ARN.
  const targetsByLbArn = new Map<string, { healthy: number; registered: number }>();
  for (const resource of input.resources) {
    if (!TARGET_GROUP_TYPES.has(resource.resourceType)) continue;
    const targets = Array.isArray(resource.configuration.targets) ? resource.configuration.targets : [];
    const lbArns = stringArray(resource.configuration.loadBalancerArns);
    for (const arn of lbArns) {
      const entry = targetsByLbArn.get(arn) ?? { healthy: 0, registered: 0 };
      for (const target of targets) {
        if (typeof target !== "object" || target === null || Array.isArray(target)) continue;
        entry.registered += 1;
        if (str((target as Record<string, JsonValue>).state) === "healthy") entry.healthy += 1;
      }
      targetsByLbArn.set(arn, entry);
    }
  }

  const volumes: UnattachedVolumeInput[] = [];
  const loadBalancers: IdleLoadBalancerInput[] = [];
  const elasticIps: UnusedElasticIpInput[] = [];
  const stoppedInstances: StoppedInstanceInput[] = [];
  const snapshots: OrphanedSnapshotInput[] = [];

  for (const resource of input.resources) {
    const base = {
      resourceKey: resource.resourceKey,
      region: resource.region.length > 0 ? resource.region : null,
      name: resource.name,
      curCost: cost(nativeId(resource)),
    };

    if (VOLUME_TYPES.has(resource.resourceType)) {
      const state = str(resource.configuration.state);
      const attached = instanceIdsOf(resource).length > 0 || (state !== null && state.toLowerCase() === "in-use");
      volumes.push({
        ...base,
        attached,
        sizeGiB: num(resource.configuration.sizeGiB),
        volumeType: str(resource.configuration.volumeType),
      });
      continue;
    }

    if (LOAD_BALANCER_TYPES.has(resource.resourceType)) {
      const arn = resource.arn ?? nativeId(resource);
      const targets = targetsByLbArn.get(arn) ?? { healthy: 0, registered: 0 };
      loadBalancers.push({
        ...base,
        loadBalancerType: str(resource.configuration.type),
        healthyTargetCount: targets.healthy,
        registeredTargetCount: targets.registered,
      });
      continue;
    }

    if (ELASTIC_IP_TYPES.has(resource.resourceType)) {
      elasticIps.push({ ...base, associated: elasticIpAssociated(resource) });
      continue;
    }

    if (INSTANCE_TYPES.has(resource.resourceType)) {
      const state = str(resource.configuration.state) ?? resource.state;
      const stopped = STOPPED_STATE.test(state ?? "");
      if (!stopped) continue;
      const attachedGiB = attachedGiBByInstanceId.get(nativeId(resource));
      stoppedInstances.push({
        ...base,
        stopped,
        attachedVolumeGiB: attachedGiB === undefined ? null : attachedGiB,
        instanceType: str(resource.configuration.instanceType),
      });
      continue;
    }

    if (SNAPSHOT_TYPES.has(resource.resourceType)) {
      const sourceVolumeId = str(resource.configuration.volumeId);
      // Orphaned when the source volume id is absent, sentinel, or unknown to the
      // collected volume inventory.
      const sourceVolumeExists =
        sourceVolumeId !== null && sourceVolumeId !== "vol-ffffffff" && knownVolumeIds.has(sourceVolumeId);
      snapshots.push({
        ...base,
        sourceVolumeExists,
        volumeSizeGiB: num(resource.configuration.volumeSizeGiB),
      });
    }
  }

  return {
    volumes,
    loadBalancers,
    elasticIps,
    stoppedInstances,
    snapshots,
    ...(input.pricing === undefined ? {} : { pricing: input.pricing }),
  };
}

function instanceIdsOf(volume: PilotResource): readonly string[] {
  const ids = stringArray(volume.configuration.instanceIds);
  if (ids.length > 0) return ids;
  // Fall back to attachment records that carry an instanceId.
  const attachments = Array.isArray(volume.configuration.attachments) ? volume.configuration.attachments : [];
  const fromAttachments: string[] = [];
  for (const attachment of attachments) {
    if (typeof attachment !== "object" || attachment === null || Array.isArray(attachment)) continue;
    const id = str((attachment as Record<string, JsonValue>).instanceId);
    if (id !== null) fromAttachments.push(id);
  }
  return fromAttachments;
}

function elasticIpAssociated(resource: PilotResource): boolean {
  const config = resource.configuration;
  if (typeof config.associated === "boolean") return config.associated;
  return (
    str(config.associationId) !== null ||
    str(config.instanceId) !== null ||
    str(config.networkInterfaceId) !== null
  );
}

function stringArray(value: JsonValue | undefined): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

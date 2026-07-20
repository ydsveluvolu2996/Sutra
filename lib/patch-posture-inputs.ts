/**
 * Adapter: maps collected CMDB resources (EC2 instances and their read-only SSM
 * `aws.ssm.patch-state` facts) into the pure patch-posture engine's input.
 *
 * Honesty is preserved end-to-end: the adapter only shapes collected facts and
 * joins each patch-state resource to its instance by id. When no patch-state
 * resource was collected for an instance, `patch` is left null and the engine
 * reports the instance as not-assessed — never compliant. Nothing is invented.
 */
import type { JsonValue, PilotResource } from "./pilot-types.ts";
import type { PatchDetail, PatchInstanceInput, PatchPostureInput, PatchStateFacts } from "./patch-posture.ts";

export interface PatchPostureAdapterInput {
  readonly resources: readonly PilotResource[];
}

const INSTANCE_TYPES = new Set(["aws.ec2.instance", "ec2.instance"]);
const PATCH_STATE_TYPES = new Set(["aws.ssm.patch-state", "ssm.patch-state"]);
const MAX_MISSING_PATCH_DETAIL = 100;

function num(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bool(value: JsonValue | undefined): boolean {
  return value === true;
}

function toPatchDetail(value: JsonValue): PatchDetail | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, JsonValue>>;
  return {
    title: str(record.title),
    kbId: str(record.kbId),
    classification: str(record.classification),
    severity: str(record.severity),
  };
}

function toPatchFacts(resource: PilotResource): PatchStateFacts {
  const config = resource.configuration;
  const rawMissing = Array.isArray(config.missingPatches) ? config.missingPatches : [];
  const missingPatches: PatchDetail[] = [];
  for (const entry of rawMissing.slice(0, MAX_MISSING_PATCH_DETAIL)) {
    const detail = toPatchDetail(entry);
    if (detail !== null) missingPatches.push(detail);
  }
  return {
    managed: bool(config.managed),
    patchStateAvailable: bool(config.patchStateAvailable),
    baselineId: str(config.baselineId),
    operation: str(config.operation),
    lastScanAt: str(config.lastScanAt),
    installedCount: num(config.installedCount),
    missingCount: num(config.missingCount),
    failedCount: num(config.failedCount),
    notApplicableCount: num(config.notApplicableCount),
    criticalMissingCount: num(config.criticalMissingCount),
    securityMissingCount: num(config.securityMissingCount),
    otherNonCompliantCount: num(config.otherNonCompliantCount),
    missingPatches,
  };
}

export function buildPatchPostureInputs(input: PatchPostureAdapterInput): PatchPostureInput {
  // Index collected patch-state resources by the instance id they describe. The
  // patch-state resource's nativeId equals the instance id, and it also carries
  // an explicit `instanceId` fact; either resolves the join.
  const patchByInstanceId = new Map<string, PatchStateFacts>();
  for (const resource of input.resources) {
    if (!PATCH_STATE_TYPES.has(resource.resourceType)) continue;
    const instanceId = str(resource.configuration.instanceId) ?? resource.nativeId;
    if (instanceId === null || instanceId.length === 0) continue;
    patchByInstanceId.set(instanceId, toPatchFacts(resource));
  }

  const instances: PatchInstanceInput[] = [];
  for (const resource of input.resources) {
    if (!INSTANCE_TYPES.has(resource.resourceType)) continue;
    instances.push({
      resourceKey: resource.resourceKey,
      instanceId: resource.nativeId,
      name: resource.name,
      region: resource.region.length > 0 ? resource.region : null,
      instanceState: str(resource.configuration.state) ?? (resource.state.length > 0 ? resource.state : null),
      platform: str(resource.configuration.platformDetails) ?? str(resource.configuration.architecture),
      patch: patchByInstanceId.get(resource.nativeId) ?? null,
    });
  }

  return { instances };
}

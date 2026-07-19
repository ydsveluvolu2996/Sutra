import type { JsonValue, PilotResource } from "./pilot-types";

export type CmdbResourceChangeType = "added" | "changed" | "removed";

/**
 * Stable resource evidence retained on a change event. Collector timestamps and
 * other observation metadata are deliberately excluded so a routine rescan does
 * not look like a configuration change.
 */
export interface CmdbComparableResource {
  readonly resourceKey: string;
  readonly service: string;
  readonly resourceType: string;
  readonly nativeId: string;
  readonly arn: string | null;
  readonly name: string | null;
  readonly region: string;
  readonly state: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly contentSha256: string;
}

export interface CmdbResourceChange {
  readonly changeType: CmdbResourceChangeType;
  readonly resourceKey: string;
  readonly changedPaths: readonly string[];
  readonly before: CmdbComparableResource | null;
  readonly after: CmdbComparableResource | null;
}

export function toComparableResource(resource: PilotResource): CmdbComparableResource {
  return {
    resourceKey: resource.resourceKey,
    service: resource.service,
    resourceType: resource.resourceType,
    nativeId: resource.nativeId,
    arn: resource.arn,
    name: resource.name,
    region: resource.region,
    state: resource.state,
    tags: resource.tags,
    configuration: resource.configuration,
    contentSha256: resource.contentSha256,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && valuesEqual(left[key], right[key]));
  }
  return false;
}

function appendChangedPaths(
  before: unknown,
  after: unknown,
  path: string,
  changedPaths: string[],
): void {
  if (valuesEqual(before, after)) return;

  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      changedPaths.push(path);
      return;
    }
    for (let index = 0; index < before.length; index += 1) {
      appendChangedPaths(before[index], after[index], `${path}[${index}]`, changedPaths);
    }
    return;
  }

  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      const childPath = path.length === 0 ? key : `${path}.${key}`;
      if (!(key in before) || !(key in after)) {
        changedPaths.push(childPath);
      } else {
        appendChangedPaths(before[key], after[key], childPath, changedPaths);
      }
    }
    return;
  }

  changedPaths.push(path);
}

function indexResources(resources: readonly CmdbComparableResource[], label: string): Map<string, CmdbComparableResource> {
  const indexed = new Map<string, CmdbComparableResource>();
  for (const resource of resources) {
    if (indexed.has(resource.resourceKey)) {
      throw new Error(`Duplicate resourceKey in ${label} CMDB snapshot: ${resource.resourceKey}`);
    }
    indexed.set(resource.resourceKey, resource);
  }
  return indexed;
}

/**
 * Computes one deterministic event per logical resource identity. Output is
 * sorted by resourceKey and changed paths are stable across object key order.
 */
export function diffCmdbResources(
  previous: readonly CmdbComparableResource[],
  current: readonly CmdbComparableResource[],
): readonly CmdbResourceChange[] {
  const beforeByKey = indexResources(previous, "previous");
  const afterByKey = indexResources(current, "current");
  const resourceKeys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort();
  const changes: CmdbResourceChange[] = [];

  for (const resourceKey of resourceKeys) {
    const before = beforeByKey.get(resourceKey) ?? null;
    const after = afterByKey.get(resourceKey) ?? null;
    if (before === null && after !== null) {
      changes.push({ changeType: "added", resourceKey, changedPaths: [], before: null, after });
      continue;
    }
    if (before !== null && after === null) {
      changes.push({ changeType: "removed", resourceKey, changedPaths: [], before, after: null });
      continue;
    }
    if (before === null || after === null) continue;

    const changedPaths: string[] = [];
    appendChangedPaths(before.service, after.service, "service", changedPaths);
    appendChangedPaths(before.resourceType, after.resourceType, "resourceType", changedPaths);
    appendChangedPaths(before.nativeId, after.nativeId, "nativeId", changedPaths);
    appendChangedPaths(before.arn, after.arn, "arn", changedPaths);
    appendChangedPaths(before.name, after.name, "name", changedPaths);
    appendChangedPaths(before.region, after.region, "region", changedPaths);
    appendChangedPaths(before.state, after.state, "state", changedPaths);
    appendChangedPaths(before.tags, after.tags, "tags", changedPaths);
    appendChangedPaths(before.configuration, after.configuration, "configuration", changedPaths);

    if (changedPaths.length > 0) {
      changes.push({ changeType: "changed", resourceKey, changedPaths, before, after });
    }
  }

  return changes;
}

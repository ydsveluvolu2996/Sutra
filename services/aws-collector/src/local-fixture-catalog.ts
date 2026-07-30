import { createHash } from "node:crypto";

import {
  buildFixtureSnapshot,
  finalizePilotSnapshot,
  type PilotCoverageEntry,
  type PilotResource,
  type PilotSnapshot,
} from "./fixture-inventory.js";
import type { RegisteredAwsConnection } from "./local-registry.js";
import type { SafeJsonObject, SafeJsonValue } from "./types.js";

export const LOCAL_FIXTURE_VERSIONS = ["2026.07.0", "2026.07.1"] as const;

export type LocalFixtureVersion = (typeof LOCAL_FIXTURE_VERSIONS)[number];

export interface LocalFixtureAccountDescriptor {
  readonly fixtureId: string;
  readonly customerName: string;
  readonly customerId: string;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: "aws";
  readonly enabledRegions: readonly string[];
  readonly availableVersions: readonly LocalFixtureVersion[];
}

interface LocalFixtureDefinition extends LocalFixtureAccountDescriptor {
  readonly connection: RegisteredAwsConnection;
}

export interface BuildLocalFixtureSnapshotInput {
  readonly fixtureId: string;
  readonly version: LocalFixtureVersion;
  readonly jobId: string;
  readonly now?: Date;
}

export const LOCAL_FIXTURE_COLLECTION_JOB_KIND = "fixture.inventory.collect";

export interface LocalFixtureCollectionJobPayload extends SafeJsonObject {
  readonly fixtureId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly version: LocalFixtureVersion;
}

export interface LocalFixtureCollectionJobResult {
  readonly jobId: string;
  readonly tenantId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly fixtureId: string;
  readonly version: LocalFixtureVersion;
  readonly snapshot: PilotSnapshot;
}

export type FixtureEvolutionEvent =
  | {
      readonly eventId: string;
      readonly kind: "added";
      readonly resourceKey: string;
      readonly after: PilotResource;
    }
  | {
      readonly eventId: string;
      readonly kind: "changed";
      readonly resourceKey: string;
      readonly changedFields: readonly string[];
      readonly before: PilotResource;
      readonly after: PilotResource;
    }
  | {
      readonly eventId: string;
      readonly kind: "removed";
      readonly resourceKey: string;
      readonly before: PilotResource;
    };

export interface LocalFixtureEvolution {
  readonly fixtureId: string;
  readonly fromVersion: LocalFixtureVersion;
  readonly toVersion: LocalFixtureVersion;
  readonly events: readonly FixtureEvolutionEvent[];
}

const FIXTURES: readonly LocalFixtureDefinition[] = [
  fixtureDefinition({
    fixtureId: "northstar-retail",
    customerName: "Northstar Retail",
    customerId: "cust_11111111111111111111111111111111",
    tenantId: "org_local_sutra",
    connectionId: "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    accountId: "111122223333",
    enabledRegions: ["us-east-1", "us-west-2"],
  }),
  fixtureDefinition({
    fixtureId: "meridian-health",
    customerName: "Meridian Health",
    customerId: "cust_22222222222222222222222222222222",
    tenantId: "org_local_sutra",
    connectionId: "conn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    accountId: "444455556666",
    enabledRegions: ["ap-south-1", "ap-southeast-1"],
  }),
  fixtureDefinition({
    fixtureId: "bluepeak-finance",
    customerName: "BluePeak Finance",
    customerId: "cust_33333333333333333333333333333333",
    tenantId: "org_local_sutra",
    connectionId: "conn_cccccccccccccccccccccccccccccccc",
    accountId: "777788889999",
    enabledRegions: ["eu-west-1", "eu-central-1"],
  }),
];

/**
 * Return safe fixture metadata only. Role material and fixture External IDs remain
 * private to this module and can never be serialized by catalog consumers.
 */
export function listLocalFixtureAccounts(): readonly LocalFixtureAccountDescriptor[] {
  return FIXTURES.map((definition) => safeDescriptor(definition));
}

export function getLocalFixtureAccount(
  fixtureId: string,
): LocalFixtureAccountDescriptor {
  return safeDescriptor(fixtureById(fixtureId));
}

export function createLocalFixtureCollectionJobPayload(
  fixtureId: string,
  version: LocalFixtureVersion,
): LocalFixtureCollectionJobPayload {
  const descriptor = getLocalFixtureAccount(fixtureId);
  assertFixtureVersion(version);
  return {
    fixtureId,
    customerId: descriptor.customerId,
    connectionId: descriptor.connectionId,
    version,
  };
}

/**
 * Collector-local execution boundary for a leased durable job. It validates the
 * complete tenant/customer/connection scope and returns the full snapshot for the
 * control plane to persist. No AWS client or role material is used.
 */
export function executeLocalFixtureCollectionJob(input: {
  readonly jobId: string;
  readonly tenantId: string;
  readonly payload: SafeJsonObject;
  readonly now?: Date;
}): LocalFixtureCollectionJobResult {
  const payload = parseCollectionJobPayload(input.payload);
  const definition = fixtureById(payload.fixtureId);
  if (
    input.tenantId !== definition.tenantId ||
    payload.customerId !== definition.customerId ||
    payload.connectionId !== definition.connectionId
  ) {
    throw new LocalFixtureCatalogError(
      "Local fixture job scope does not match the catalog account",
    );
  }
  const snapshot = buildLocalFixtureSnapshot({
    fixtureId: payload.fixtureId,
    version: payload.version,
    jobId: input.jobId,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return {
    jobId: input.jobId,
    tenantId: input.tenantId,
    customerId: definition.customerId,
    connectionId: definition.connectionId,
    fixtureId: definition.fixtureId,
    version: payload.version,
    snapshot,
  };
}

export function buildLocalFixtureSnapshot(
  input: BuildLocalFixtureSnapshotInput,
): PilotSnapshot {
  const definition = fixtureById(input.fixtureId);
  assertFixtureVersion(input.version);
  const baseline = buildFixtureSnapshot({
    jobId: input.jobId,
    connection: definition.connection,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return input.version === "2026.07.0" ? baseline : evolveFixture(baseline);
}

/**
 * Build two catalog versions at the same observation time and return semantic
 * CMDB events. Collection timestamps and content hashes are intentionally ignored
 * when deciding whether a resource changed.
 */
export function buildLocalFixtureEvolution(input: {
  readonly fixtureId: string;
  readonly fromVersion: LocalFixtureVersion;
  readonly toVersion: LocalFixtureVersion;
  readonly now?: Date;
}): LocalFixtureEvolution {
  const observedAt = input.now ?? new Date("2026-07-15T00:00:00.000Z");
  const before = buildLocalFixtureSnapshot({
    fixtureId: input.fixtureId,
    version: input.fromVersion,
    jobId: `fixture-evolution-${input.fixtureId}-${input.fromVersion}`,
    now: observedAt,
  });
  const after = buildLocalFixtureSnapshot({
    fixtureId: input.fixtureId,
    version: input.toVersion,
    jobId: `fixture-evolution-${input.fixtureId}-${input.toVersion}`,
    now: observedAt,
  });
  return {
    fixtureId: input.fixtureId,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    events: diffFixtureSnapshots(before, after),
  };
}

export function diffFixtureSnapshots(
  before: PilotSnapshot,
  after: PilotSnapshot,
): readonly FixtureEvolutionEvent[] {
  if (
    before.accountId !== after.accountId ||
    before.connectionId !== after.connectionId ||
    before.partition !== after.partition
  ) {
    throw new LocalFixtureCatalogError(
      "Fixture snapshots must describe the same scoped account connection",
    );
  }

  const beforeByKey = new Map(before.resources.map((resource) => [resource.resourceKey, resource]));
  const afterByKey = new Map(after.resources.map((resource) => [resource.resourceKey, resource]));
  const resourceKeys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort();
  const events: FixtureEvolutionEvent[] = [];

  for (const resourceKey of resourceKeys) {
    const previous = beforeByKey.get(resourceKey);
    const current = afterByKey.get(resourceKey);
    if (previous === undefined && current !== undefined) {
      events.push({
        eventId: evolutionEventId("added", resourceKey, "", resourceSemanticHash(current)),
        kind: "added",
        resourceKey,
        after: structuredClone(current),
      });
      continue;
    }
    if (previous !== undefined && current === undefined) {
      events.push({
        eventId: evolutionEventId("removed", resourceKey, resourceSemanticHash(previous), ""),
        kind: "removed",
        resourceKey,
        before: structuredClone(previous),
      });
      continue;
    }
    if (previous === undefined || current === undefined) continue;

    const previousHash = resourceSemanticHash(previous);
    const currentHash = resourceSemanticHash(current);
    if (previousHash !== currentHash) {
      events.push({
        eventId: evolutionEventId("changed", resourceKey, previousHash, currentHash),
        kind: "changed",
        resourceKey,
        changedFields: changedResourceFields(previous, current),
        before: structuredClone(previous),
        after: structuredClone(current),
      });
    }
  }
  return events;
}

export class LocalFixtureCatalogError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LocalFixtureCatalogError";
  }
}

function fixtureDefinition(input: {
  readonly fixtureId: string;
  readonly customerName: string;
  readonly customerId: string;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly enabledRegions: readonly string[];
}): LocalFixtureDefinition {
  const connection: RegisteredAwsConnection = {
    tenantId: input.tenantId,
    connectionId: input.connectionId,
    expectedAccountId: input.accountId,
    partition: "aws",
    roleArn: `arn:aws:iam::${input.accountId}:role/sutra-fixture/SutraReadOnlyRole`,
    externalId: `local-fixture-${input.fixtureId}-external-id`,
      status: "ACTIVE",
      permissionPackVersion: "standard-2026-07.4",
    sessionNamePrefix: "sutra-fixture-",
    enabledRegions: [...input.enabledRegions],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
  return {
    fixtureId: input.fixtureId,
    customerName: input.customerName,
    customerId: input.customerId,
    tenantId: input.tenantId,
    connectionId: input.connectionId,
    accountId: input.accountId,
    partition: "aws",
    enabledRegions: [...input.enabledRegions],
    availableVersions: [...LOCAL_FIXTURE_VERSIONS],
    connection,
  };
}

function parseCollectionJobPayload(
  payload: SafeJsonObject,
): LocalFixtureCollectionJobPayload {
  const keys = Object.keys(payload).sort();
  if (
    keys.join(",") !== "connectionId,customerId,fixtureId,version" ||
    typeof payload.fixtureId !== "string" ||
    typeof payload.customerId !== "string" ||
    typeof payload.connectionId !== "string" ||
    typeof payload.version !== "string"
  ) {
    throw new LocalFixtureCatalogError("Local fixture collection job payload is invalid");
  }
  assertFixtureVersion(payload.version);
  return {
    fixtureId: payload.fixtureId,
    customerId: payload.customerId,
    connectionId: payload.connectionId,
    version: payload.version,
  };
}

function fixtureById(fixtureId: string): LocalFixtureDefinition {
  const definition = FIXTURES.find((candidate) => candidate.fixtureId === fixtureId);
  if (definition === undefined) {
    throw new LocalFixtureCatalogError(`Unknown local fixture: ${fixtureId}`);
  }
  return definition;
}

function assertFixtureVersion(version: string): asserts version is LocalFixtureVersion {
  if (!(LOCAL_FIXTURE_VERSIONS as readonly string[]).includes(version)) {
    throw new LocalFixtureCatalogError(`Unknown local fixture version: ${version}`);
  }
}

function evolveFixture(snapshot: PilotSnapshot): PilotSnapshot {
  const removedWorker = snapshot.resources.find(
    (resource) =>
      resource.resourceType === "aws.ec2.instance" && resource.nativeId === "i-0f9e8d7c6b5a43210",
  );
  const database = snapshot.resources.find(
    (resource) => resource.resourceType === "aws.rds.db-instance",
  );
  if (removedWorker === undefined || database === undefined) {
    throw new LocalFixtureCatalogError("Baseline fixture is missing evolution anchors");
  }

  const remediatedDatabase = rehashResource({
    ...database,
    tags: { ...database.tags, Remediation: "verified" },
    configuration: {
      ...database.configuration,
      storageEncrypted: true,
      publiclyAccessible: false,
      multiAz: true,
    },
  });
  const primaryRegion = snapshot.resources.find(
    (resource) => resource.resourceType === "aws.ec2.vpc",
  )?.region;
  if (primaryRegion === undefined) {
    throw new LocalFixtureCatalogError("Baseline fixture is missing its primary Region");
  }
  const auditBucket = newResource({
    accountId: snapshot.accountId,
    partition: snapshot.partition,
    collectedAt: snapshot.collectedAt,
    region: primaryRegion,
    service: "s3",
    resourceType: "aws.s3.bucket",
    nativeId: `sutra-audit-evidence-${snapshot.accountId}`,
    arn: `arn:${snapshot.partition}:s3:::sutra-audit-evidence-${snapshot.accountId}`,
    name: `sutra-audit-evidence-${snapshot.accountId}`,
    state: "active",
    tags: { DataClass: "audit", Environment: "production" },
    api: "s3:ListBuckets",
    configuration: {
      bucketRegion: primaryRegion,
      blockPublicAcls: true,
      ignorePublicAcls: true,
      blockPublicPolicy: true,
      restrictPublicBuckets: true,
      versioning: "enabled",
      defaultEncryption: "aws:kms",
    },
  });

  const resources = snapshot.resources
    .filter((resource) => resource.resourceKey !== removedWorker.resourceKey)
    .map((resource) =>
      resource.resourceKey === database.resourceKey ? remediatedDatabase : resource,
    )
    .concat(auditBucket);
  const resourceKeys = new Set(resources.map((resource) => resource.resourceKey));
  const relationships = snapshot.relationships.filter(
    (item) =>
      resourceKeys.has(item.fromResourceKey) && resourceKeys.has(item.toResourceKey),
  );
  const remediatedControls = new Set([
    "SUTRA.AWS.RDS.STORAGE_ENCRYPTED",
    "SUTRA.AWS.RDS.PUBLIC_ACCESS",
  ]);
  const findings = snapshot.findings.filter(
    (item) => !remediatedControls.has(item.controlKey),
  );
  const coverage = recountCoverage(snapshot.coverage, resources);
  const { snapshotSha256, ...unsigned } = snapshot;
  void snapshotSha256;
  return finalizePilotSnapshot({
    ...unsigned,
    resources,
    relationships,
    findings,
    coverage,
  });
}

function safeDescriptor(
  definition: LocalFixtureDefinition,
): LocalFixtureAccountDescriptor {
  return structuredClone({
    fixtureId: definition.fixtureId,
    customerName: definition.customerName,
    customerId: definition.customerId,
    tenantId: definition.tenantId,
    connectionId: definition.connectionId,
    accountId: definition.accountId,
    partition: definition.partition,
    enabledRegions: definition.enabledRegions,
    availableVersions: definition.availableVersions,
  });
}

function newResource(input: {
  readonly accountId: string;
  readonly partition: string;
  readonly collectedAt: string;
  readonly region: string;
  readonly service: string;
  readonly resourceType: string;
  readonly nativeId: string;
  readonly arn: string | null;
  readonly name: string | null;
  readonly state: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly api: string;
  readonly configuration: SafeJsonObject;
}): PilotResource {
  const resourceKey = `${input.partition}:${input.accountId}:${input.region}:${input.service}:${input.resourceType}:${input.nativeId}`;
  return rehashResource({
    resourceKey,
    service: input.service,
    resourceType: input.resourceType,
    nativeId: input.nativeId,
    arn: input.arn,
    name: input.name,
    region: input.region,
    state: input.state,
    tags: input.tags,
    configuration: input.configuration,
    source: {
      api: input.api,
      accountId: input.accountId,
      collectedAt: input.collectedAt,
    },
    contentSha256: "",
  });
}

function rehashResource(resource: PilotResource): PilotResource {
  const unsigned = {
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
    source: resource.source,
  };
  return {
    ...unsigned,
    contentSha256: sha256(JSON.stringify(unsigned)),
  };
}

function recountCoverage(
  coverage: readonly PilotCoverageEntry[],
  resources: readonly PilotResource[],
): readonly PilotCoverageEntry[] {
  return coverage.map((entry) => {
    const resourceType = resourceTypeForCollector(entry.collectorKey);
    if (resourceType === null) return entry;
    const itemsObserved = resources.filter(
      (resource) =>
        resource.resourceType === resourceType &&
        (entry.region === "global" || resource.region === entry.region),
    ).length;
    return { ...entry, itemsObserved };
  });
}

function resourceTypeForCollector(collectorKey: string): string | null {
  const types: Readonly<Record<string, string>> = {
    "iam.account": "aws.iam.account",
    "iam.password-policy": "aws.iam.account",
    "s3.buckets": "aws.s3.bucket",
    "ec2.instances": "aws.ec2.instance",
    "ec2.vpcs": "aws.ec2.vpc",
    "ec2.subnets": "aws.ec2.subnet",
    "ec2.security-groups": "aws.ec2.security-group",
    "rds.db-instances": "aws.rds.db-instance",
    "cloudtrail.trails": "aws.cloudtrail.trail",
    "guardduty.detectors": "aws.guardduty.detector",
    "securityhub.hub": "aws.securityhub.hub",
  };
  return types[collectorKey] ?? null;
}

function resourceSemanticHash(resource: PilotResource): string {
  return sha256(
    canonicalJson({
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
      source: {
        api: resource.source.api,
        accountId: resource.source.accountId,
      },
    }),
  );
}

function changedResourceFields(
  before: PilotResource,
  after: PilotResource,
): readonly string[] {
  const fields: readonly (keyof PilotResource)[] = [
    "service",
    "resourceType",
    "nativeId",
    "arn",
    "name",
    "region",
    "state",
    "tags",
    "configuration",
  ];
  return fields.filter(
    (field) => canonicalJson(before[field]) !== canonicalJson(after[field]),
  );
}

function evolutionEventId(
  kind: FixtureEvolutionEvent["kind"],
  resourceKey: string,
  beforeHash: string,
  afterHash: string,
): string {
  return `change_${sha256(`${kind}\u0000${resourceKey}\u0000${beforeHash}\u0000${afterHash}`).slice(0, 40)}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): SafeJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (typeof value === "object") {
    const result: Record<string, SafeJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalValue((value as Readonly<Record<string, unknown>>)[key]);
    }
    return result;
  }
  throw new LocalFixtureCatalogError("Fixture contains a non-JSON value");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

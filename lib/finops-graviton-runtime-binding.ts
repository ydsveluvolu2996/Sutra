/** Durable, credential-free scheduler/replay binding for Graviton materialization. */
import {
  runGravitonMaterializationJob,
  type GravitonSignedCollector,
  type GravitonSnapshotStore,
} from "./finops-graviton-savings-job.ts";
import {
  GRAVITON_SAVINGS_BOUNDS,
  type GravitonTenantBoundary,
} from "./finops-graviton-savings.ts";

export const GRAVITON_MATERIALIZATION_JOB_KIND = "finops-graviton-savings-materialize";
export const GRAVITON_PROVIDER_ADAPTER_UNAVAILABLE = "GRAVITON_CROSS_SERVICE_MATERIALIZER_NOT_DEPLOYED";

const JOB_ID = /^job_[a-f0-9]{32,64}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const REQUEST_KEY = /^gvrq_[a-f0-9]{64}$/u;
const GENERATION = /^gvg_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SIGNATURE_VALUE = /^[A-Za-z0-9_-]{1,8192}$/u;
const MAX_CONNECTIONS = 10_000;
const SOURCE_STATES = new Set(["COMPLETE", "PARTIAL", "CONFIGURATION_REQUIRED"]);

export interface GravitonRuntimeQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: typeof GRAVITON_MATERIALIZATION_JOB_KIND;
    readonly payload: { readonly scheduledWindow: string };
    readonly maxAttempts: 5;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export interface GravitonDurableJob {
  readonly id: string;
  readonly kind: typeof GRAVITON_MATERIALIZATION_JOB_KIND;
  readonly orgId: string;
  readonly customerId: string | null;
  readonly connectionId: string | null;
  readonly payload: unknown;
  readonly attempt: number;
  readonly maxAttempts: number;
}

export interface GravitonRuntimeReceipt {
  readonly schemaVersion: "sutra.graviton-runtime-receipt.v1";
  readonly requestKey: `gvrq_${string}`;
  readonly scope: GravitonTenantBoundary["scope"];
  readonly scheduledWindow: string;
  readonly generationId: string;
  readonly sourceCollectionId: string;
  readonly sourceState: string;
  readonly becameActive: boolean;
  readonly completedAtIso: string;
  readonly evidenceSha256: string;
  readonly signature: {
    readonly keyId: string;
    readonly algorithm: "ED25519" | "ECDSA_P256_SHA256";
    readonly value: string;
  };
}

export interface GravitonRuntimeDependencies {
  readonly loadBoundary: (scope: {
    readonly organizationId: string;
    readonly customerId: string;
    readonly connectionId: string;
  }) => Promise<GravitonTenantBoundary>;
  readonly collector: GravitonSignedCollector | null;
  readonly store: GravitonSnapshotStore;
  readonly loadReceipt: (
    scope: GravitonTenantBoundary["scope"],
    requestKey: `gvrq_${string}`,
  ) => Promise<GravitonRuntimeReceipt | null>;
  readonly verifyReceipt: (receipt: GravitonRuntimeReceipt) => Promise<boolean>;
  readonly sealEvidence: (evidence: Readonly<Record<string, unknown>>) => Promise<GravitonRuntimeReceipt["signature"]>;
  readonly recordReceipt: (receipt: GravitonRuntimeReceipt) => Promise<void>;
  readonly now?: () => number;
}

export class GravitonRuntimeBindingError extends Error {
  public readonly code: "INVALID_JOB" | "SCOPE_MISMATCH" | "REPLAY_REJECTED" | "EVIDENCE_REJECTED";

  public constructor(code: GravitonRuntimeBindingError["code"]) {
    super("Graviton runtime binding rejected the job");
    this.name = "GravitonRuntimeBindingError";
    this.code = code;
  }
}

function reject(code: GravitonRuntimeBindingError["code"]): never {
  throw new GravitonRuntimeBindingError(code);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameScope(left: GravitonTenantBoundary["scope"], right: GravitonTenantBoundary["scope"]): boolean {
  return left.orgId === right.orgId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId;
}

function validWindow(value: string): boolean {
  return WINDOW.test(value) && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function validScope(scope: { readonly organizationId: string; readonly customerId: string;
  readonly connectionId: string }): boolean {
  return ID.test(scope.organizationId) && ID.test(scope.customerId)
    && CONNECTION.test(scope.connectionId);
}

function sortedUnique(values: readonly string[], pattern: RegExp, maximum: number): boolean {
  return values.length >= 1 && values.length <= maximum
    && values.every((value) => pattern.test(value))
    && JSON.stringify(values) === JSON.stringify([...new Set(values)].sort());
}

function validBoundary(boundary: GravitonTenantBoundary): boolean {
  return ID.test(boundary.scope.orgId) && ID.test(boundary.scope.customerId)
    && CONNECTION.test(boundary.scope.connectionId)
    && ACCOUNT.test(boundary.managementAccountId)
    && ["aws", "aws-cn", "aws-us-gov"].includes(boundary.partition)
    && sortedUnique(boundary.accountIds, ACCOUNT, GRAVITON_SAVINGS_BOUNDS.maximumAccounts)
    && boundary.accountIds.includes(boundary.managementAccountId)
    && sortedUnique(boundary.regions, REGION, GRAVITON_SAVINGS_BOUNDS.maximumRegions);
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function validReceipt(value: unknown): value is GravitonRuntimeReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (Object.keys(receipt).length !== 11 || receipt.schemaVersion !== "sutra.graviton-runtime-receipt.v1"
    || typeof receipt.requestKey !== "string" || !REQUEST_KEY.test(receipt.requestKey)
    || typeof receipt.scheduledWindow !== "string" || !validWindow(receipt.scheduledWindow)
    || typeof receipt.generationId !== "string" || !GENERATION.test(receipt.generationId)
    || typeof receipt.sourceCollectionId !== "string" || !ID.test(receipt.sourceCollectionId)
    || typeof receipt.sourceState !== "string" || !SOURCE_STATES.has(receipt.sourceState)
    || typeof receipt.becameActive !== "boolean"
    || typeof receipt.completedAtIso !== "string" || !validTimestamp(receipt.completedAtIso)
    || typeof receipt.evidenceSha256 !== "string" || !SHA256.test(receipt.evidenceSha256)
    || typeof receipt.scope !== "object" || receipt.scope === null || Array.isArray(receipt.scope)
    || typeof receipt.signature !== "object" || receipt.signature === null
    || Array.isArray(receipt.signature)) return false;
  const scope = receipt.scope as Record<string, unknown>;
  const signature = receipt.signature as Record<string, unknown>;
  return Object.keys(scope).length === 3
    && typeof scope.orgId === "string" && ID.test(scope.orgId)
    && typeof scope.customerId === "string" && ID.test(scope.customerId)
    && typeof scope.connectionId === "string" && CONNECTION.test(scope.connectionId)
    && Object.keys(signature).length === 3
    && typeof signature.keyId === "string" && ID.test(signature.keyId)
    && (signature.algorithm === "ED25519" || signature.algorithm === "ECDSA_P256_SHA256")
    && typeof signature.value === "string" && SIGNATURE_VALUE.test(signature.value);
}

export async function deriveGravitonRequestKey(
  boundary: GravitonTenantBoundary,
  scheduledWindow: string,
): Promise<`gvrq_${string}`> {
  if (!validWindow(scheduledWindow) || !validBoundary(boundary)) reject("INVALID_JOB");
  const identity = [
    boundary.scope.orgId,
    boundary.scope.customerId,
    boundary.scope.connectionId,
    boundary.managementAccountId,
    boundary.partition,
    scheduledWindow,
    [...boundary.accountIds].sort().join(","),
    [...boundary.regions].sort().join(","),
  ].join("\n");
  return `gvrq_${await sha256(identity)}`;
}

function parseJob(job: GravitonDurableJob): {
  readonly scope: { readonly organizationId: string; readonly customerId: string; readonly connectionId: string };
  readonly scheduledWindow: string;
} {
  if (!JOB_ID.test(job.id)
    || job.kind !== GRAVITON_MATERIALIZATION_JOB_KIND
    || !ID.test(job.orgId)
    || job.customerId === null
    || job.connectionId === null
    || !ID.test(job.customerId)
    || !CONNECTION.test(job.connectionId)
    || !Number.isSafeInteger(job.attempt) || job.attempt < 1 || job.attempt > 5
    || job.maxAttempts !== 5
    || typeof job.payload !== "object"
    || job.payload === null
    || Array.isArray(job.payload)) reject("INVALID_JOB");
  const payload = job.payload as Record<string, unknown>;
  if (Object.keys(payload).length !== 1
    || typeof payload.scheduledWindow !== "string"
    || !validWindow(payload.scheduledWindow)) reject("INVALID_JOB");
  return {
    scope: { organizationId: job.orgId, customerId: job.customerId, connectionId: job.connectionId },
    scheduledWindow: payload.scheduledWindow,
  };
}

export function gravitonCollectionWindow(nowMs = Date.now()): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) reject("INVALID_JOB");
  const date = new Date(nowMs);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    .toISOString();
}

export async function scheduleGravitonMaterializations(input: {
  readonly scheduledWindow: string;
  readonly loadEligibleScopes: () => Promise<readonly {
    readonly organizationId: string;
    readonly customerId: string;
    readonly connectionId: string;
  }[]>;
  readonly queue: GravitonRuntimeQueue;
}): Promise<number> {
  if (!validWindow(input.scheduledWindow)) reject("INVALID_JOB");
  const scopes = [...await input.loadEligibleScopes()]
    .sort((left, right) => left.connectionId.localeCompare(right.connectionId));
  if (scopes.length > MAX_CONNECTIONS) reject("INVALID_JOB");
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (!validScope(scope) || seen.has(scope.connectionId)) reject("INVALID_JOB");
    seen.add(scope.connectionId);
  }
  for (const scope of scopes) {
    const idempotencyKey = `graviton:${[
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      input.scheduledWindow,
    ].map(encodeURIComponent).join(":")}`;
    await input.queue.enqueue({
      orgId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: scope.connectionId,
      kind: GRAVITON_MATERIALIZATION_JOB_KIND,
      payload: Object.freeze({ scheduledWindow: input.scheduledWindow }),
      maxAttempts: 5,
      idempotencyKey,
    });
  }
  return scopes.length;
}

function receiptEvidence(input: {
  readonly requestKey: `gvrq_${string}`;
  readonly boundary: GravitonTenantBoundary;
  readonly scheduledWindow: string;
  readonly result: Awaited<ReturnType<typeof runGravitonMaterializationJob>>;
  readonly completedAtIso: string;
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: "sutra.graviton-runtime-evidence.v1",
    requestKey: input.requestKey,
    scope: input.boundary.scope,
    managementAccountId: input.boundary.managementAccountId,
    partition: input.boundary.partition,
    scheduledWindow: input.scheduledWindow,
    expectedAccountIds: [...input.boundary.accountIds],
    expectedRegions: [...input.boundary.regions],
    generationId: input.result.generationId,
    sourceCollectionId: input.result.sourceCollectionId,
    sourceState: input.result.state,
    becameActive: input.result.becameActive,
    completedAtIso: input.completedAtIso,
  });
}

export async function runGravitonDurableJob(
  job: GravitonDurableJob,
  dependencies: GravitonRuntimeDependencies,
) {
  const parsed = parseJob(job);
  const boundary = await dependencies.loadBoundary(parsed.scope);
  const expectedScope = {
    orgId: parsed.scope.organizationId,
    customerId: parsed.scope.customerId,
    connectionId: parsed.scope.connectionId,
  };
  if (!validBoundary(boundary) || !sameScope(boundary.scope, expectedScope)) reject("SCOPE_MISMATCH");
  const requestKey = await deriveGravitonRequestKey(boundary, parsed.scheduledWindow);
  const prior = await dependencies.loadReceipt(boundary.scope, requestKey);
  if (prior !== null) {
    if (!validReceipt(prior)
      || !sameScope(prior.scope, boundary.scope)
      || prior.requestKey !== requestKey
      || prior.scheduledWindow !== parsed.scheduledWindow
      || !await dependencies.verifyReceipt(prior)) reject("REPLAY_REJECTED");
    return {
      status: "replayed" as const,
      requestKey,
      generationId: prior.generationId,
      sourceCollectionId: prior.sourceCollectionId,
      state: prior.sourceState,
      becameActive: prior.becameActive,
      replayed: true,
      activationReason: null,
    };
  }
  if (dependencies.collector === null) return {
    status: "configuration_required" as const,
    requestKey,
    generationId: null,
    sourceCollectionId: null,
    state: "CONFIGURATION_REQUIRED",
    becameActive: false,
    replayed: false,
    activationReason: GRAVITON_PROVIDER_ADAPTER_UNAVAILABLE,
  };
  const now = dependencies.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) reject("INVALID_JOB");
  const result = await runGravitonMaterializationJob({
    requestKey,
    scheduledWindow: parsed.scheduledWindow,
    boundary,
    collector: dependencies.collector,
    store: dependencies.store,
    nowMs: now,
  });
  if (!GENERATION.test(result.generationId) || !ID.test(result.sourceCollectionId)
    || !SOURCE_STATES.has(result.state) || typeof result.becameActive !== "boolean") {
    reject("EVIDENCE_REJECTED");
  }
  const completedAtIso = new Date(now).toISOString();
  const evidence = receiptEvidence({ requestKey, boundary, scheduledWindow: parsed.scheduledWindow, result, completedAtIso });
  const evidenceSha256 = await sha256(JSON.stringify(evidence));
  const signature = await dependencies.sealEvidence({ ...evidence, evidenceSha256 });
  if (!ID.test(signature.keyId)
    || (signature.algorithm !== "ED25519" && signature.algorithm !== "ECDSA_P256_SHA256")
    || !SIGNATURE_VALUE.test(signature.value)) reject("EVIDENCE_REJECTED");
  const receipt: GravitonRuntimeReceipt = {
    schemaVersion: "sutra.graviton-runtime-receipt.v1",
    requestKey,
    scope: boundary.scope,
    scheduledWindow: parsed.scheduledWindow,
    generationId: result.generationId,
    sourceCollectionId: result.sourceCollectionId,
    sourceState: result.state,
    becameActive: result.becameActive,
    completedAtIso,
    evidenceSha256,
    signature,
  };
  await dependencies.recordReceipt(receipt);
  return { ...result, status: "recorded" as const, requestKey, replayed: false, activationReason: null };
}

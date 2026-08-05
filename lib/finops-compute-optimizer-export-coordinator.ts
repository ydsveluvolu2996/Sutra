/**
 * Pure first phase of the multi-Region Compute Optimizer materialization state
 * machine. It seals the exact regional launch matrix, verifies terminal launch
 * evidence plus exact-ID Describe observations, and releases an immutable plan
 * set only when every sealed Region and all eight export families are complete.
 *
 * No provider call, credential, database write, or public launch route exists
 * in this module. Later materialization phases consume the READY checkpoint.
 */
import { canonicalJson } from "./canonical-json.ts";
import {
  createComputeOptimizerExportGenerationAttempt,
  finalizeComputeOptimizerExportGeneration,
  type ComputeOptimizerExportGeneration,
  type ComputeOptimizerExportGenerationAttempt,
} from "./finops-compute-optimizer-export-generation.ts";
import {
  ComputeOptimizerExportFreshResolverError,
  resolveFreshComputeOptimizerExportBinding,
  type ComputeOptimizerExportDescribeReader,
  type FreshComputeOptimizerExportBinding,
} from "./finops-compute-optimizer-export-fresh-resolver.ts";
import {
  ComputeOptimizerExportMapperError,
  mapComputeOptimizerExportTarget,
  type MappedComputeOptimizerExportTarget,
} from "./finops-compute-optimizer-export-mapper.ts";
import {
  ComputeOptimizerExportObjectSetError,
  loadComputeOptimizerExportObjectSet,
  type ComputeOptimizerExportObjectReader,
} from "./finops-compute-optimizer-export-object-set.ts";
import {
  createComputeOptimizerExportPlanInputFromLaunchAttempt,
  verifyComputeOptimizerExportLaunchAttempt,
  verifyComputeOptimizerExportLaunchExecution,
  type ComputeOptimizerExportLaunchAttempt,
  type ComputeOptimizerExportLaunchExecution,
  type ComputeOptimizerExportLaunchPublicErrorCode,
} from "./finops-compute-optimizer-export-launch.ts";
import {
  createComputeOptimizerExportPlan,
  createComputeOptimizerExportPlanSet,
  verifyComputeOptimizerExportPlanSet,
  type ComputeOptimizerExportPlan,
  type ComputeOptimizerExportPlanSet,
  type ComputeOptimizerExportPlanScope,
} from "./finops-compute-optimizer-export-plan.ts";
import type {
  StoredComputeOptimizerFinalizedExportEvidence,
} from "../db/finops-compute-optimizer-discovery-repository.ts";

const ACTIVATION_ID = /^comra_[a-f0-9]{64}$/u;
const CHECKPOINT_ID = /^comrp_[a-f0-9]{64}$/u;
const EXECUTION_ID = /^coele_[a-f0-9]{64}$/u;
const PLAN_ID = /^cope_[a-f0-9]{64}$/u;
const PLAN_SET_ID = /^copes_[a-f0-9]{64}$/u;
const ATTEMPT_ID = /^coa_[a-f0-9]{64}$/u;
const GENERATION_ID = /^cog_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DAILY_WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const MAX_REGIONS = 50;
const EXPORT_FAMILY_COUNT = 8;
const MAX_DATE_MS = 8_640_000_000_000_000;
const PUBLIC_LAUNCH_ERRORS = new Set<ComputeOptimizerExportLaunchPublicErrorCode>([
  "ABORTED", "ACCESS_DENIED", "CONCURRENT_EXPORT_LIMIT", "DEADLINE_EXCEEDED",
  "ENROLLMENT_REQUIRED", "INVALID_PROVIDER_RESPONSE", "INVALID_REQUEST",
  "PROVIDER_REQUEST_FAILED", "RATE_LIMITED", "SERVICE_UNAVAILABLE",
]);
const COORDINATOR_ERRORS = new Set<ComputeOptimizerCoordinatorRegionErrorCode>([
  "REGION_EVIDENCE_MISSING", "EXECUTION_INVALID", "LAUNCH_PARTIAL", "DESCRIBE_INVALID",
  ...PUBLIC_LAUNCH_ERRORS,
]);

export const COMPUTE_OPTIMIZER_MATERIALIZATION_COORDINATOR_BOUNDS = Object.freeze({
  maximumRegions: MAX_REGIONS,
  exportFamiliesPerRegion: EXPORT_FAMILY_COUNT,
  maximumSerializedBytes: 32 * 1_024 * 1_024,
  maximumMaterializationDurationMs: 15 * 60 * 1_000,
} as const);

export interface ComputeOptimizerMaterializationActivation {
  readonly schemaVersion: "sutra.compute-optimizer-materialization-activation.v1";
  readonly activationId: string;
  readonly contentSha256: string;
  readonly scope: ComputeOptimizerExportPlanScope;
  readonly requesterAccountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly scheduledWindow: string;
  readonly regions: readonly string[];
  /** Exactly one verified, plan-ordered eight-family launch attempt per Region. */
  readonly launchAttempts: readonly ComputeOptimizerExportLaunchAttempt[];
}

export interface ComputeOptimizerRegionalLaunchDescribeEvidence {
  readonly launchAttemptId: string;
  readonly execution: unknown;
  readonly completedJobs: unknown;
}

export type ComputeOptimizerCoordinatorRegionErrorCode =
  | "REGION_EVIDENCE_MISSING"
  | "EXECUTION_INVALID"
  | "LAUNCH_PARTIAL"
  | "DESCRIBE_INVALID"
  | ComputeOptimizerExportLaunchPublicErrorCode;

export interface ComputeOptimizerCoordinatorRegionCheckpoint {
  readonly region: string;
  readonly launchAttemptId: string;
  readonly launchExecutionId: string | null;
  readonly state: "MISSING" | "LAUNCH_BLOCKED" | "DESCRIBE_BLOCKED" | "PLAN_READY";
  readonly errorCodes: readonly ComputeOptimizerCoordinatorRegionErrorCode[];
  readonly completedJobCount: number;
  readonly planId: string | null;
  readonly planContentSha256: string | null;
}

export interface ComputeOptimizerMaterializationPlanCheckpoint {
  readonly schemaVersion: "sutra.compute-optimizer-materialization-plan-checkpoint.v1";
  readonly checkpointId: string;
  readonly contentSha256: string;
  readonly activationId: string;
  readonly activationContentSha256: string;
  readonly status: "BLOCKED" | "PLAN_SET_READY";
  readonly scope: ComputeOptimizerExportPlanScope;
  readonly requesterAccountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly scheduledWindow: string;
  readonly regions: readonly ComputeOptimizerCoordinatorRegionCheckpoint[];
  readonly planSet: ComputeOptimizerExportPlanSet | null;
}

/** Structural target for the exact repository; later phases inject it. */
export interface ComputeOptimizerExactGenerationPersistence {
  recordAttempt(
    scope: { readonly organizationId: string; readonly customerId: string; readonly connectionId: string },
    planSet: ComputeOptimizerExportPlanSet,
    attempt: ComputeOptimizerExportGenerationAttempt,
  ): Promise<unknown>;
  recordAcceptedGeneration(
    scope: { readonly organizationId: string; readonly customerId: string; readonly connectionId: string },
    planSet: ComputeOptimizerExportPlanSet,
    generation: ComputeOptimizerExportGeneration,
  ): Promise<unknown>;
}

export interface ComputeOptimizerMaterializationRegionRuntime {
  readonly region: string;
  readonly discoveryEvidence: StoredComputeOptimizerFinalizedExportEvidence;
  readonly describeReader: ComputeOptimizerExportDescribeReader;
  readonly objectReader: ComputeOptimizerExportObjectReader;
}

export interface RunComputeOptimizerMaterializationOptions {
  readonly materializedAtMs: number;
  readonly deadlineAtMs: number;
  readonly persistence: ComputeOptimizerExactGenerationPersistence;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

/**
 * Non-sensitive durable lineage used when the worker rehydrates an immutable
 * sealed plan set. The enqueue boundary verifies the original activation and
 * READY checkpoint before retaining only these identities.
 */
export interface ComputeOptimizerPersistedPlanSetMaterializationInput {
  readonly schemaVersion: "sutra.compute-optimizer-persisted-plan-materialization.v1";
  readonly activationId: string;
  readonly planCheckpointId: string;
  readonly scheduledWindow: string;
  readonly scope: ComputeOptimizerExportPlanScope;
  readonly requesterAccountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly planSetId: string;
  readonly planSetContentSha256: string;
}

export type ComputeOptimizerMaterializationRuntimeErrorCode =
  | "RUNTIME_MISSING"
  | "FRESH_RESOLUTION_FAILED"
  | "OBJECT_LOAD_FAILED"
  | "MAPPING_FAILED";

export interface ComputeOptimizerMaterializationRuntimeRegionCheckpoint {
  readonly region: string;
  readonly planId: string;
  readonly state: "FRESH_BLOCKED" | "FRESH_READY" | "OBJECT_BLOCKED" | "MAPPING_BLOCKED" | "MAPPED";
  readonly errorCode: ComputeOptimizerMaterializationRuntimeErrorCode | null;
  readonly freshBindingContentSha256: string | null;
  readonly mappedTargetCount: number;
}

export interface ComputeOptimizerMaterializationGenerationAttemptReference {
  readonly attemptId: string;
  readonly contentSha256: string;
  readonly state: "PARTIAL" | "ALL_REGION_COMPLETE";
}

export interface ComputeOptimizerMaterializationGenerationReference {
  readonly generationId: string;
  readonly contentSha256: string;
  readonly dataThroughAtIso: string;
  readonly observedAtIso: string;
}

export interface ComputeOptimizerMaterializationRuntimeCheckpoint {
  readonly schemaVersion: "sutra.compute-optimizer-materialization-runtime-checkpoint.v1";
  readonly checkpointId: string;
  readonly contentSha256: string;
  readonly activationId: string;
  readonly planCheckpointId: string;
  readonly planSetId: string;
  readonly status: "FRESH_BLOCKED" | "PARTIAL_ATTEMPT_RECORDED" | "GENERATION_ACCEPTED";
  readonly scheduledWindow: string;
  readonly materializedAtIso: string;
  readonly regions: readonly ComputeOptimizerMaterializationRuntimeRegionCheckpoint[];
  readonly attempt: ComputeOptimizerMaterializationGenerationAttemptReference | null;
  readonly generation: ComputeOptimizerMaterializationGenerationReference | null;
}

export class ComputeOptimizerMaterializationCoordinatorError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "LIMIT_EXCEEDED"
    | "ACTIVATION_MISMATCH"
    | "DUPLICATE_REGION"
    | "REGION_EXPANSION"
    | "CONTENT_HASH_MISMATCH"
    | "CHECKPOINT_INVALID"
    | "ABORTED"
    | "DEADLINE_EXCEEDED"
    | "PERSISTENCE_FAILED";

  public constructor(code: ComputeOptimizerMaterializationCoordinatorError["code"]) {
    super("Compute Optimizer materialization coordination rejected");
    this.name = "ComputeOptimizerMaterializationCoordinatorError";
    this.code = code;
  }
}

function reject(code: ComputeOptimizerMaterializationCoordinatorError["code"]): never {
  throw new ComputeOptimizerMaterializationCoordinatorError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function assertBound(value: unknown): void {
  if (new TextEncoder().encode(canonicalJson(value)).byteLength
    > COMPUTE_OPTIMIZER_MATERIALIZATION_COORDINATOR_BOUNDS.maximumSerializedBytes) {
    reject("LIMIT_EXCEEDED");
  }
}

function sameScope(left: ComputeOptimizerExportPlanScope, right: ComputeOptimizerExportPlanScope): boolean {
  return left.orgId === right.orgId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId;
}

function activationBody(value: Omit<ComputeOptimizerMaterializationActivation,
"activationId" | "contentSha256">): unknown {
  return value;
}

export async function createComputeOptimizerMaterializationActivation(
  unsafeAttempts: readonly unknown[],
): Promise<ComputeOptimizerMaterializationActivation> {
  if (!Array.isArray(unsafeAttempts) || unsafeAttempts.length < 1) reject("INVALID_INPUT");
  if (unsafeAttempts.length > MAX_REGIONS) reject("LIMIT_EXCEEDED");
  const attempts: ComputeOptimizerExportLaunchAttempt[] = [];
  for (const unsafe of unsafeAttempts) {
    try {
      attempts.push(await verifyComputeOptimizerExportLaunchAttempt(structuredClone(unsafe)));
    } catch {
      reject("INVALID_INPUT");
    }
  }
  attempts.sort((left, right) => compare(left.region, right.region));
  const first = attempts[0]!;
  const regions = new Set<string>();
  const batches = new Set<string>();
  const buckets = new Set<string>();
  for (const attempt of attempts) {
    if (regions.has(attempt.region)) reject("DUPLICATE_REGION");
    if (batches.has(attempt.requestBatchId)) reject("INVALID_INPUT");
    const regionBuckets = new Set(attempt.targets.map(({ bucket }) => bucket));
    if (regionBuckets.size !== 1) reject("INVALID_INPUT");
    const bucket = regionBuckets.values().next().value;
    if (typeof bucket !== "string" || buckets.has(bucket)) reject("INVALID_INPUT");
    if (!sameScope(attempt.scope, first.scope)
      || attempt.requesterAccountId !== first.requesterAccountId
      || attempt.partition !== first.partition
      || attempt.scheduledWindow !== first.scheduledWindow
      || attempt.targets.length !== EXPORT_FAMILY_COUNT) reject("ACTIVATION_MISMATCH");
    regions.add(attempt.region);
    batches.add(attempt.requestBatchId);
    buckets.add(bucket);
  }
  const body = {
    schemaVersion: "sutra.compute-optimizer-materialization-activation.v1" as const,
    scope: { ...first.scope },
    requesterAccountId: first.requesterAccountId,
    partition: first.partition,
    scheduledWindow: first.scheduledWindow,
    regions: attempts.map(({ region }) => region),
    launchAttempts: attempts,
  };
  assertBound(body);
  const contentSha256 = await sha256(canonicalJson(activationBody(body)));
  return deepFreeze({
    ...body,
    activationId: `comra_${contentSha256}`,
    contentSha256,
  });
}

export async function verifyComputeOptimizerMaterializationActivation(
  value: unknown,
): Promise<ComputeOptimizerMaterializationActivation> {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "activationId", "contentSha256", "scope", "requesterAccountId",
    "partition", "scheduledWindow", "regions", "launchAttempts",
  ]) || value.schemaVersion !== "sutra.compute-optimizer-materialization-activation.v1"
    || typeof value.activationId !== "string" || !ACTIVATION_ID.test(value.activationId)
    || typeof value.contentSha256 !== "string" || !SHA256.test(value.contentSha256)
    || !Array.isArray(value.launchAttempts)) reject("INVALID_INPUT");
  const regenerated = await createComputeOptimizerMaterializationActivation(value.launchAttempts);
  if (canonicalJson(value) !== canonicalJson(regenerated)) reject("CONTENT_HASH_MISMATCH");
  return regenerated;
}

function checkpointBody(value: Omit<ComputeOptimizerMaterializationPlanCheckpoint,
"checkpointId" | "contentSha256">): unknown {
  return value;
}

function sanitizedLaunchErrors(
  execution: ComputeOptimizerExportLaunchExecution,
): readonly ComputeOptimizerCoordinatorRegionErrorCode[] {
  const values = execution.outcomes.flatMap((outcome) =>
    outcome.status === "SUCCEEDED" ? [] : [outcome.errorCode]);
  return [...new Set<ComputeOptimizerCoordinatorRegionErrorCode>([
    "LAUNCH_PARTIAL",
    ...values,
  ])].sort(compare);
}

async function checkpoint(
  body: Omit<ComputeOptimizerMaterializationPlanCheckpoint, "checkpointId" | "contentSha256">,
): Promise<ComputeOptimizerMaterializationPlanCheckpoint> {
  assertBound(body);
  const contentSha256 = await sha256(canonicalJson(checkpointBody(body)));
  return deepFreeze({
    ...body,
    checkpointId: `comrp_${contentSha256}`,
    contentSha256,
  });
}

export async function coordinateComputeOptimizerMaterializationPlans(
  unsafeActivation: unknown,
  unsafeRegionalEvidence: readonly unknown[],
): Promise<ComputeOptimizerMaterializationPlanCheckpoint> {
  const activation = await verifyComputeOptimizerMaterializationActivation(unsafeActivation);
  if (!Array.isArray(unsafeRegionalEvidence)) reject("INVALID_INPUT");
  if (unsafeRegionalEvidence.length > activation.regions.length) reject("REGION_EXPANSION");
  const expectedAttempts = new Map(activation.launchAttempts.map((attempt) => [
    attempt.launchAttemptId,
    attempt,
  ]));
  const evidenceByAttempt = new Map<string, ComputeOptimizerRegionalLaunchDescribeEvidence>();
  for (const unsafe of unsafeRegionalEvidence) {
    if (!isRecord(unsafe) || !exactKeys(unsafe, [
      "launchAttemptId", "execution", "completedJobs",
    ]) || typeof unsafe.launchAttemptId !== "string") reject("INVALID_INPUT");
    if (!expectedAttempts.has(unsafe.launchAttemptId)) reject("REGION_EXPANSION");
    if (evidenceByAttempt.has(unsafe.launchAttemptId)) reject("DUPLICATE_REGION");
    evidenceByAttempt.set(
      unsafe.launchAttemptId,
      unsafe as unknown as ComputeOptimizerRegionalLaunchDescribeEvidence,
    );
  }

  const regionCheckpoints: ComputeOptimizerCoordinatorRegionCheckpoint[] = [];
  const regionalPlans: ComputeOptimizerExportPlan[] = [];
  const regionalInputs: Awaited<ReturnType<
  typeof createComputeOptimizerExportPlanInputFromLaunchAttempt>>[] = [];
  for (const attempt of activation.launchAttempts) {
    const evidence = evidenceByAttempt.get(attempt.launchAttemptId);
    if (evidence === undefined) {
      regionCheckpoints.push({
        region: attempt.region,
        launchAttemptId: attempt.launchAttemptId,
        launchExecutionId: null,
        state: "MISSING",
        errorCodes: ["REGION_EVIDENCE_MISSING"],
        completedJobCount: 0,
        planId: null,
        planContentSha256: null,
      });
      continue;
    }
    let execution: ComputeOptimizerExportLaunchExecution;
    try {
      execution = await verifyComputeOptimizerExportLaunchExecution(
        attempt,
        structuredClone(evidence.execution),
      );
    } catch {
      regionCheckpoints.push({
        region: attempt.region,
        launchAttemptId: attempt.launchAttemptId,
        launchExecutionId: null,
        state: "LAUNCH_BLOCKED",
        errorCodes: ["EXECUTION_INVALID"],
        completedJobCount: 0,
        planId: null,
        planContentSha256: null,
      });
      continue;
    }
    if (execution.status !== "COMPLETE") {
      regionCheckpoints.push({
        region: attempt.region,
        launchAttemptId: attempt.launchAttemptId,
        launchExecutionId: execution.executionId,
        state: "LAUNCH_BLOCKED",
        errorCodes: sanitizedLaunchErrors(execution),
        completedJobCount: execution.outcomes.filter(({ status }) => status === "SUCCEEDED").length,
        planId: null,
        planContentSha256: null,
      });
      continue;
    }
    let input: Awaited<ReturnType<typeof createComputeOptimizerExportPlanInputFromLaunchAttempt>>;
    let plan: ComputeOptimizerExportPlan;
    try {
      input = await createComputeOptimizerExportPlanInputFromLaunchAttempt(
        attempt,
        execution,
        structuredClone(evidence.completedJobs),
      );
      plan = await createComputeOptimizerExportPlan(input);
    } catch {
      regionCheckpoints.push({
        region: attempt.region,
        launchAttemptId: attempt.launchAttemptId,
        launchExecutionId: execution.executionId,
        state: "DESCRIBE_BLOCKED",
        errorCodes: ["DESCRIBE_INVALID"],
        completedJobCount: 0,
        planId: null,
        planContentSha256: null,
      });
      continue;
    }
    regionalInputs.push(input);
    regionalPlans.push(plan);
    regionCheckpoints.push({
      region: attempt.region,
      launchAttemptId: attempt.launchAttemptId,
      launchExecutionId: execution.executionId,
      state: "PLAN_READY",
      errorCodes: [],
      completedJobCount: input.targets.length,
      planId: plan.planId,
      planContentSha256: plan.contentSha256,
    });
  }

  let planSet: ComputeOptimizerExportPlanSet | null = null;
  if (regionalPlans.length === activation.regions.length) {
    const first = regionalInputs[0];
    if (first === undefined) reject("CHECKPOINT_INVALID");
    try {
      planSet = await createComputeOptimizerExportPlanSet({
        scope: { ...activation.scope },
        requesterAccountId: activation.requesterAccountId,
        partition: activation.partition,
        regions: [...activation.regions],
        exportFamilies: first.exportFamilies,
        targets: regionalInputs.flatMap(({ targets }) => targets),
      });
    } catch {
      reject("CHECKPOINT_INVALID");
    }
    if (planSet.plans.some((plan, index) => plan.planId !== regionalPlans[index]?.planId)) {
      reject("CHECKPOINT_INVALID");
    }
  }
  return checkpoint({
    schemaVersion: "sutra.compute-optimizer-materialization-plan-checkpoint.v1",
    activationId: activation.activationId,
    activationContentSha256: activation.contentSha256,
    status: planSet === null ? "BLOCKED" : "PLAN_SET_READY",
    scope: { ...activation.scope },
    requesterAccountId: activation.requesterAccountId,
    partition: activation.partition,
    scheduledWindow: activation.scheduledWindow,
    regions: regionCheckpoints,
    planSet,
  });
}

export async function verifyComputeOptimizerMaterializationPlanCheckpoint(
  unsafeActivation: unknown,
  value: unknown,
): Promise<ComputeOptimizerMaterializationPlanCheckpoint> {
  const activation = await verifyComputeOptimizerMaterializationActivation(unsafeActivation);
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "checkpointId", "contentSha256", "activationId",
    "activationContentSha256", "status", "scope", "requesterAccountId", "partition",
    "scheduledWindow", "regions", "planSet",
  ]) || value.schemaVersion !== "sutra.compute-optimizer-materialization-plan-checkpoint.v1"
    || typeof value.checkpointId !== "string" || !CHECKPOINT_ID.test(value.checkpointId)
    || typeof value.contentSha256 !== "string" || !SHA256.test(value.contentSha256)
    || value.activationId !== activation.activationId
    || value.activationContentSha256 !== activation.contentSha256
    || !sameScope(value.scope as ComputeOptimizerExportPlanScope, activation.scope)
    || value.requesterAccountId !== activation.requesterAccountId
    || value.partition !== activation.partition
    || value.scheduledWindow !== activation.scheduledWindow
    || (value.status !== "BLOCKED" && value.status !== "PLAN_SET_READY")
    || !Array.isArray(value.regions)
    || value.regions.length !== activation.regions.length) reject("CHECKPOINT_INVALID");
  const regions = value.regions as unknown[];
  let readyRegions = 0;
  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index];
    const attempt = activation.launchAttempts[index]!;
    if (!isRecord(region) || !exactKeys(region, [
      "region", "launchAttemptId", "launchExecutionId", "state", "errorCodes",
      "completedJobCount", "planId", "planContentSha256",
    ]) || region.region !== attempt.region
      || region.launchAttemptId !== attempt.launchAttemptId
      || !Array.isArray(region.errorCodes)) reject("CHECKPOINT_INVALID");
    const errorCodes = region.errorCodes as unknown[];
    const completedJobCount = region.completedJobCount;
    if (errorCodes.some((error) => typeof error !== "string"
        || !COORDINATOR_ERRORS.has(error as ComputeOptimizerCoordinatorRegionErrorCode))
      || new Set(errorCodes).size !== errorCodes.length
      || errorCodes.some((error, errorIndex) => errorIndex > 0
        && compare(errorCodes[errorIndex - 1] as string, error as string) >= 0)
      || !Number.isSafeInteger(completedJobCount)
      || (completedJobCount as number) < 0
      || (completedJobCount as number) > EXPORT_FAMILY_COUNT
      || (region.launchExecutionId !== null
        && (typeof region.launchExecutionId !== "string"
          || !EXECUTION_ID.test(region.launchExecutionId)))
      || (region.planId !== null
        && (typeof region.planId !== "string" || !PLAN_ID.test(region.planId)))
      || (region.planContentSha256 !== null
        && (typeof region.planContentSha256 !== "string"
          || !SHA256.test(region.planContentSha256)))) reject("CHECKPOINT_INVALID");
    if (region.state === "MISSING") {
      if (region.launchExecutionId !== null || completedJobCount !== 0
        || canonicalJson(errorCodes) !== canonicalJson(["REGION_EVIDENCE_MISSING"])
        || region.planId !== null || region.planContentSha256 !== null) reject("CHECKPOINT_INVALID");
    } else if (region.state === "LAUNCH_BLOCKED") {
      const invalid = canonicalJson(errorCodes) === canonicalJson(["EXECUTION_INVALID"]);
      if (region.planId !== null || region.planContentSha256 !== null
        || (invalid && (region.launchExecutionId !== null || completedJobCount !== 0))
        || (!invalid && (region.launchExecutionId === null
          || !errorCodes.includes("LAUNCH_PARTIAL")
          || (completedJobCount as number) >= EXPORT_FAMILY_COUNT))) reject("CHECKPOINT_INVALID");
    } else if (region.state === "DESCRIBE_BLOCKED") {
      if (region.launchExecutionId === null || completedJobCount !== 0
        || canonicalJson(errorCodes) !== canonicalJson(["DESCRIBE_INVALID"])
        || region.planId !== null || region.planContentSha256 !== null) reject("CHECKPOINT_INVALID");
    } else if (region.state === "PLAN_READY") {
      readyRegions += 1;
      if (region.launchExecutionId === null || completedJobCount !== EXPORT_FAMILY_COUNT
        || errorCodes.length !== 0 || region.planId === null
        || region.planContentSha256 === null
        || region.planId !== `cope_${region.planContentSha256}`) reject("CHECKPOINT_INVALID");
    } else reject("CHECKPOINT_INVALID");
  }
  let planSet: ComputeOptimizerExportPlanSet | null = null;
  if (value.status === "PLAN_SET_READY") {
    if (value.planSet === null) reject("CHECKPOINT_INVALID");
    try {
      planSet = await verifyComputeOptimizerExportPlanSet(structuredClone(value.planSet));
    } catch {
      reject("CHECKPOINT_INVALID");
    }
    if (!sameScope(planSet.scope, activation.scope)
      || planSet.requesterAccountId !== activation.requesterAccountId
      || planSet.partition !== activation.partition
      || planSet.regions.length !== activation.regions.length
      || planSet.regions.some((region, index) => region !== activation.regions[index])
      || planSet.exportFamilies.length !== EXPORT_FAMILY_COUNT
      || readyRegions !== activation.regions.length
      || planSet.planIds.some((planId, index) =>
        (regions[index] as Record<string, unknown>).planId !== planId)
      || planSet.plans.some((plan, index) =>
        (regions[index] as Record<string, unknown>).planContentSha256
          !== plan.contentSha256)) reject("CHECKPOINT_INVALID");
  } else if (value.planSet !== null || readyRegions === activation.regions.length) {
    reject("CHECKPOINT_INVALID");
  }
  const body = {
    schemaVersion: value.schemaVersion,
    activationId: value.activationId,
    activationContentSha256: value.activationContentSha256,
    status: value.status,
    scope: value.scope,
    requesterAccountId: value.requesterAccountId,
    partition: value.partition,
    scheduledWindow: value.scheduledWindow,
    regions: value.regions,
    planSet,
  } as Omit<ComputeOptimizerMaterializationPlanCheckpoint, "checkpointId" | "contentSha256">;
  const contentSha256 = await sha256(canonicalJson(checkpointBody(body)));
  if (value.contentSha256 !== contentSha256 || value.checkpointId !== `comrp_${contentSha256}`) {
    reject("CONTENT_HASH_MISMATCH");
  }
  assertBound(value);
  return deepFreeze({ ...body, checkpointId: value.checkpointId, contentSha256 });
}

type MutableRuntimeRegionCheckpoint = {
  -readonly [Key in keyof ComputeOptimizerMaterializationRuntimeRegionCheckpoint]:
  ComputeOptimizerMaterializationRuntimeRegionCheckpoint[Key]
};

function safeNow(clock: (() => number) | undefined): number {
  let value: unknown;
  try {
    value = (clock ?? Date.now)();
  } catch {
    reject("INVALID_INPUT");
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)
    || value < 0 || value > MAX_DATE_MS) {
    reject("INVALID_INPUT");
  }
  return value;
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function assertRuntimeActive(
  signal: AbortSignal | undefined,
  deadlineAtMs: number,
  clock: (() => number) | undefined,
): void {
  if (signal?.aborted === true) reject("ABORTED");
  if (safeNow(clock) >= deadlineAtMs) reject("DEADLINE_EXCEEDED");
}

async function withRuntimeBoundary<T>(
  operation: () => Promise<T>,
  signal: AbortSignal | undefined,
  deadlineAtMs: number,
  clock: (() => number) | undefined,
): Promise<T> {
  assertRuntimeActive(signal, deadlineAtMs, clock);
  const remainingMs = deadlineAtMs - safeNow(clock);
  let rejectBoundary: ((error: ComputeOptimizerMaterializationCoordinatorError) => void)
    | undefined;
  const boundary = new Promise<never>((_resolve, rejectPromise) => {
    rejectBoundary = rejectPromise;
  });
  void boundary.catch(() => undefined);
  let settled = false;
  const stop = (boundaryCode: "ABORTED" | "DEADLINE_EXCEEDED"): void => {
    if (settled) return;
    settled = true;
    rejectBoundary?.(new ComputeOptimizerMaterializationCoordinatorError(boundaryCode));
  };
  const onAbort = (): void => stop("ABORTED");
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted === true) stop("ABORTED");
  const timer = setTimeout(() => stop("DEADLINE_EXCEEDED"), remainingMs);
  try {
    const result = await Promise.race([Promise.resolve().then(operation), boundary]);
    settled = true;
    assertRuntimeActive(signal, deadlineAtMs, clock);
    return result;
  } finally {
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function persistenceScope(scope: ComputeOptimizerExportPlanScope) {
  return {
    organizationId: scope.orgId,
    customerId: scope.customerId,
    connectionId: scope.connectionId,
  };
}

function runtimeCheckpointBody(value: Omit<ComputeOptimizerMaterializationRuntimeCheckpoint,
"checkpointId" | "contentSha256">): unknown {
  return value;
}

async function runtimeCheckpoint(
  body: Omit<ComputeOptimizerMaterializationRuntimeCheckpoint, "checkpointId" | "contentSha256">,
): Promise<ComputeOptimizerMaterializationRuntimeCheckpoint> {
  assertBound(body);
  const contentSha256 = await sha256(canonicalJson(runtimeCheckpointBody(body)));
  return deepFreeze({
    ...body,
    checkpointId: `comrm_${contentSha256}`,
    contentSha256,
  });
}

function runtimeFailure(error: unknown): "ABORTED" | "DEADLINE_EXCEEDED" | null {
  if (error instanceof ComputeOptimizerMaterializationCoordinatorError
    && (error.code === "ABORTED" || error.code === "DEADLINE_EXCEEDED")) return error.code;
  if ((error instanceof ComputeOptimizerExportFreshResolverError
      || error instanceof ComputeOptimizerExportObjectSetError)
    && (error.code === "ABORTED" || error.code === "DEADLINE_EXCEEDED")) {
    return error.code;
  }
  return null;
}

/**
 * Executes the fail-closed materialization phase from a verified READY plan
 * checkpoint. Freshness must succeed for every Region before any object is
 * loaded. Thereafter, each successful Region is retained in a PARTIAL attempt;
 * only a complete matrix is finalized and offered to the accepted-head store.
 */
export async function runComputeOptimizerMaterialization(
  unsafeActivation: unknown,
  unsafePlanCheckpoint: unknown,
  unsafeRuntimes: readonly unknown[],
  options: RunComputeOptimizerMaterializationOptions,
): Promise<ComputeOptimizerMaterializationRuntimeCheckpoint> {
  let activationId: string;
  let planCheckpointId: string;
  let scheduledWindow: string;
  let materializationScope: ComputeOptimizerExportPlanScope;
  let planSet: ComputeOptimizerExportPlanSet;
  if (isRecord(unsafeActivation)
    && unsafeActivation.schemaVersion
      === "sutra.compute-optimizer-persisted-plan-materialization.v1") {
    if (!exactKeys(unsafeActivation, [
      "schemaVersion", "activationId", "planCheckpointId", "scheduledWindow", "scope",
      "requesterAccountId", "partition", "planSetId", "planSetContentSha256",
    ]) || typeof unsafeActivation.activationId !== "string"
      || !ACTIVATION_ID.test(unsafeActivation.activationId)
      || typeof unsafeActivation.planCheckpointId !== "string"
      || !CHECKPOINT_ID.test(unsafeActivation.planCheckpointId)
      || typeof unsafeActivation.scheduledWindow !== "string"
      || !DAILY_WINDOW.test(unsafeActivation.scheduledWindow)
      || !Number.isSafeInteger(Date.parse(unsafeActivation.scheduledWindow))
      || new Date(Date.parse(unsafeActivation.scheduledWindow)).toISOString()
        !== unsafeActivation.scheduledWindow
      || typeof unsafeActivation.planSetId !== "string"
      || !PLAN_SET_ID.test(unsafeActivation.planSetId)
      || typeof unsafeActivation.planSetContentSha256 !== "string"
      || !SHA256.test(unsafeActivation.planSetContentSha256)) reject("INVALID_INPUT");
    try {
      planSet = await verifyComputeOptimizerExportPlanSet(
        structuredClone(unsafePlanCheckpoint),
      );
    } catch {
      return reject("CHECKPOINT_INVALID");
    }
    const lineage = unsafeActivation as unknown as
      ComputeOptimizerPersistedPlanSetMaterializationInput;
    if (!sameScope(lineage.scope, planSet.scope)
      || lineage.requesterAccountId !== planSet.requesterAccountId
      || lineage.partition !== planSet.partition
      || lineage.planSetId !== planSet.planSetId
      || lineage.planSetContentSha256 !== planSet.contentSha256) {
      reject("CHECKPOINT_INVALID");
    }
    activationId = lineage.activationId;
    planCheckpointId = lineage.planCheckpointId;
    scheduledWindow = lineage.scheduledWindow;
    materializationScope = lineage.scope;
  } else {
    const activation = await verifyComputeOptimizerMaterializationActivation(unsafeActivation);
    const planCheckpoint = await verifyComputeOptimizerMaterializationPlanCheckpoint(
      activation,
      unsafePlanCheckpoint,
    );
    if (planCheckpoint.status !== "PLAN_SET_READY" || planCheckpoint.planSet === null) {
      reject("CHECKPOINT_INVALID");
    }
    activationId = activation.activationId;
    planCheckpointId = planCheckpoint.checkpointId;
    scheduledWindow = activation.scheduledWindow;
    materializationScope = activation.scope;
    planSet = planCheckpoint.planSet;
  }
  if (!Array.isArray(unsafeRuntimes) || !isRecord(options)
    || !exactKeys(options as unknown as Record<string, unknown>, [
      "materializedAtMs", "deadlineAtMs", "persistence",
      ...(options.signal === undefined ? [] : ["signal"]),
      ...(options.now === undefined ? [] : ["now"]),
    ])) reject("INVALID_INPUT");
  if (!Number.isSafeInteger(options.materializedAtMs) || options.materializedAtMs < 0
    || options.materializedAtMs > MAX_DATE_MS
    || !Number.isSafeInteger(options.deadlineAtMs) || options.deadlineAtMs < 0
    || options.deadlineAtMs > MAX_DATE_MS
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    || (options.now !== undefined && typeof options.now !== "function")
    || (!isRecord(options.persistence) && typeof options.persistence !== "function")
    || typeof options.persistence.recordAttempt !== "function"
    || typeof options.persistence.recordAcceptedGeneration !== "function") reject("INVALID_INPUT");
  const startedAtMs = safeNow(options.now);
  const builtInDeadline = startedAtMs
    + COMPUTE_OPTIMIZER_MATERIALIZATION_COORDINATOR_BOUNDS.maximumMaterializationDurationMs;
  if (!Number.isSafeInteger(builtInDeadline)) reject("INVALID_INPUT");
  const deadlineAtMs = Math.min(options.deadlineAtMs, builtInDeadline);
  if (deadlineAtMs <= startedAtMs) reject("DEADLINE_EXCEEDED");
  assertRuntimeActive(options.signal, deadlineAtMs, options.now);

  const expectedRegions = new Set(planSet.regions);
  if (unsafeRuntimes.length > planSet.regions.length) reject("REGION_EXPANSION");
  const runtimeByRegion = new Map<string, ComputeOptimizerMaterializationRegionRuntime>();
  for (const unsafe of unsafeRuntimes) {
    if (!isRecord(unsafe) || !exactKeys(unsafe, [
      "region", "discoveryEvidence", "describeReader", "objectReader",
    ]) || typeof unsafe.region !== "string"
      || typeof unsafe.describeReader !== "function"
      || typeof unsafe.objectReader !== "function") reject("INVALID_INPUT");
    if (!expectedRegions.has(unsafe.region)) reject("REGION_EXPANSION");
    if (runtimeByRegion.has(unsafe.region)) reject("DUPLICATE_REGION");
    runtimeByRegion.set(
      unsafe.region,
      unsafe as unknown as ComputeOptimizerMaterializationRegionRuntime,
    );
  }

  const regionStates: MutableRuntimeRegionCheckpoint[] = planSet.plans.map((plan) => ({
    region: plan.regions[0]!,
    planId: plan.planId,
    state: "FRESH_BLOCKED",
    errorCode: "RUNTIME_MISSING",
    freshBindingContentSha256: null,
    mappedTargetCount: 0,
  }));
  const freshBindings: FreshComputeOptimizerExportBinding[] = [];
  let freshBlocked = false;
  for (let index = 0; index < planSet.plans.length; index += 1) {
    assertRuntimeActive(options.signal, deadlineAtMs, options.now);
    const plan = planSet.plans[index]!;
    const state = regionStates[index]!;
    const runtime = runtimeByRegion.get(state.region);
    if (runtime === undefined) {
      freshBlocked = true;
      continue;
    }
    try {
      const binding = await resolveFreshComputeOptimizerExportBinding(
        plan,
        runtime.discoveryEvidence,
        runtime.describeReader,
        {
          signal: options.signal,
          deadlineAtMs,
          now: options.now,
        },
      );
      freshBindings.push(binding);
      state.state = "FRESH_READY";
      state.errorCode = null;
      state.freshBindingContentSha256 = await sha256(canonicalJson(binding));
    } catch (error) {
      const boundary = runtimeFailure(error);
      if (boundary !== null) reject(boundary);
      freshBlocked = true;
      state.state = "FRESH_BLOCKED";
      state.errorCode = "FRESH_RESOLUTION_FAILED";
    }
  }
  if (freshBlocked) {
    return runtimeCheckpoint({
      schemaVersion: "sutra.compute-optimizer-materialization-runtime-checkpoint.v1",
      activationId,
      planCheckpointId,
      planSetId: planSet.planSetId,
      status: "FRESH_BLOCKED",
      scheduledWindow,
      materializedAtIso: new Date(options.materializedAtMs).toISOString(),
      regions: regionStates,
      attempt: null,
      generation: null,
    });
  }
  if (freshBindings.length !== planSet.plans.length) reject("CHECKPOINT_INVALID");

  const mappedTargets: MappedComputeOptimizerExportTarget[] = [];
  for (let index = 0; index < planSet.plans.length; index += 1) {
    assertRuntimeActive(options.signal, deadlineAtMs, options.now);
    const plan = planSet.plans[index]!;
    const runtime = runtimeByRegion.get(plan.regions[0]!) ?? reject("CHECKPOINT_INVALID");
    const state = regionStates[index]!;
    let objectSet: Awaited<ReturnType<typeof loadComputeOptimizerExportObjectSet>>;
    try {
      objectSet = await loadComputeOptimizerExportObjectSet(
        freshBindings[index]!.binding,
        runtime.objectReader,
        { signal: options.signal, deadlineAtMs, now: options.now },
      );
    } catch (error) {
      const boundary = runtimeFailure(error);
      if (boundary !== null) reject(boundary);
      state.state = "OBJECT_BLOCKED";
      state.errorCode = "OBJECT_LOAD_FAILED";
      continue;
    }
    try {
      const mapped = await withRuntimeBoundary(
        () => Promise.all(objectSet.targets.map((bundle) =>
          mapComputeOptimizerExportTarget(bundle, plan))),
        options.signal,
        deadlineAtMs,
        options.now,
      );
      mappedTargets.push(...mapped);
      state.state = "MAPPED";
      state.errorCode = null;
      state.mappedTargetCount = mapped.length;
    } catch (error) {
      const boundary = runtimeFailure(error);
      if (boundary !== null) reject(boundary);
      if (error instanceof ComputeOptimizerExportMapperError) {
        state.state = "MAPPING_BLOCKED";
        state.errorCode = "MAPPING_FAILED";
        continue;
      }
      state.state = "MAPPING_BLOCKED";
      state.errorCode = "MAPPING_FAILED";
    }
  }

  const generationOptions = {
    scheduledWindow,
    materializedAtMs: options.materializedAtMs,
  };
  let attempt: ComputeOptimizerExportGenerationAttempt;
  try {
    attempt = await withRuntimeBoundary(
      () => createComputeOptimizerExportGenerationAttempt(
        planSet,
        mappedTargets,
        freshBindings,
        generationOptions,
      ),
      options.signal,
      deadlineAtMs,
      options.now,
    );
  } catch (error) {
    const boundary = runtimeFailure(error);
    if (boundary !== null) reject(boundary);
    reject("CHECKPOINT_INVALID");
  }
  try {
    await withRuntimeBoundary(
      () => options.persistence.recordAttempt(
        persistenceScope(materializationScope),
        planSet,
        attempt,
      ),
      options.signal,
      deadlineAtMs,
      options.now,
    );
  } catch (error) {
    const boundary = runtimeFailure(error);
    if (boundary !== null) reject(boundary);
    reject("PERSISTENCE_FAILED");
  }
  const attemptReference: ComputeOptimizerMaterializationGenerationAttemptReference = {
    attemptId: attempt.attemptId,
    contentSha256: attempt.contentSha256,
    state: attempt.state,
  };
  if (mappedTargets.length !== planSet.plans.reduce(
    (total, plan) => total + plan.targets.length,
    0,
  )) {
    return runtimeCheckpoint({
      schemaVersion: "sutra.compute-optimizer-materialization-runtime-checkpoint.v1",
      activationId,
      planCheckpointId,
      planSetId: planSet.planSetId,
      status: "PARTIAL_ATTEMPT_RECORDED",
      scheduledWindow,
      materializedAtIso: new Date(options.materializedAtMs).toISOString(),
      regions: regionStates,
      attempt: attemptReference,
      generation: null,
    });
  }

  let generation: ComputeOptimizerExportGeneration;
  try {
    generation = await withRuntimeBoundary(
      () => finalizeComputeOptimizerExportGeneration(
        planSet,
        mappedTargets,
        freshBindings,
        generationOptions,
      ),
      options.signal,
      deadlineAtMs,
      options.now,
    );
  } catch (error) {
    const boundary = runtimeFailure(error);
    if (boundary !== null) reject(boundary);
    reject("CHECKPOINT_INVALID");
  }
  try {
    await withRuntimeBoundary(
      () => options.persistence.recordAcceptedGeneration(
        persistenceScope(materializationScope),
        planSet,
        generation,
      ),
      options.signal,
      deadlineAtMs,
      options.now,
    );
  } catch (error) {
    const boundary = runtimeFailure(error);
    if (boundary !== null) reject(boundary);
    reject("PERSISTENCE_FAILED");
  }
  return runtimeCheckpoint({
    schemaVersion: "sutra.compute-optimizer-materialization-runtime-checkpoint.v1",
    activationId,
    planCheckpointId,
    planSetId: planSet.planSetId,
    status: "GENERATION_ACCEPTED",
    scheduledWindow,
    materializedAtIso: new Date(options.materializedAtMs).toISOString(),
    regions: regionStates,
    attempt: attemptReference,
    generation: {
      generationId: generation.generationId,
      contentSha256: generation.contentSha256,
      dataThroughAtIso: generation.dataThroughAtIso,
      observedAtIso: generation.observedAtIso,
    },
  });
}

/** Execute the same exact coordinator from a rehydrated sealed plan set. */
export function runComputeOptimizerPersistedPlanSetMaterialization(
  input: ComputeOptimizerPersistedPlanSetMaterializationInput,
  planSet: ComputeOptimizerExportPlanSet,
  runtimes: readonly unknown[],
  options: RunComputeOptimizerMaterializationOptions,
): Promise<ComputeOptimizerMaterializationRuntimeCheckpoint> {
  return runComputeOptimizerMaterialization(input, planSet, runtimes, options);
}

export async function verifyComputeOptimizerMaterializationRuntimeCheckpoint(
  unsafeActivation: unknown,
  unsafePlanCheckpoint: unknown,
  value: unknown,
): Promise<ComputeOptimizerMaterializationRuntimeCheckpoint> {
  const activation = await verifyComputeOptimizerMaterializationActivation(unsafeActivation);
  const planCheckpoint = await verifyComputeOptimizerMaterializationPlanCheckpoint(
    activation,
    unsafePlanCheckpoint,
  );
  if (planCheckpoint.status !== "PLAN_SET_READY" || planCheckpoint.planSet === null
    || !isRecord(value) || !exactKeys(value, [
      "schemaVersion", "checkpointId", "contentSha256", "activationId", "planCheckpointId",
      "planSetId", "status", "scheduledWindow", "materializedAtIso", "regions",
      "attempt", "generation",
    ]) || value.schemaVersion !== "sutra.compute-optimizer-materialization-runtime-checkpoint.v1"
    || typeof value.checkpointId !== "string" || !/^comrm_[a-f0-9]{64}$/u.test(value.checkpointId)
    || typeof value.contentSha256 !== "string" || !SHA256.test(value.contentSha256)
    || value.activationId !== activation.activationId
    || value.planCheckpointId !== planCheckpoint.checkpointId
    || value.planSetId !== planCheckpoint.planSet.planSetId
    || value.scheduledWindow !== activation.scheduledWindow
    || !isCanonicalIso(value.materializedAtIso)
    || !Array.isArray(value.regions)
    || value.regions.length !== activation.regions.length
    || !["FRESH_BLOCKED", "PARTIAL_ATTEMPT_RECORDED", "GENERATION_ACCEPTED"]
      .includes(value.status as string)) reject("CHECKPOINT_INVALID");
  const runtimeRegions = value.regions as Array<Record<string, unknown>>;
  for (let index = 0; index < runtimeRegions.length; index += 1) {
    const region = runtimeRegions[index];
    const plan = planCheckpoint.planSet.plans[index]!;
    if (!isRecord(region) || !exactKeys(region, [
      "region", "planId", "state", "errorCode", "freshBindingContentSha256",
      "mappedTargetCount",
    ]) || region.region !== plan.regions[0] || region.planId !== plan.planId
      || !["FRESH_BLOCKED", "FRESH_READY", "OBJECT_BLOCKED", "MAPPING_BLOCKED", "MAPPED"]
        .includes(region.state as string)
      || !Number.isSafeInteger(region.mappedTargetCount)
      || (region.mappedTargetCount as number) < 0
      || (region.mappedTargetCount as number) > EXPORT_FAMILY_COUNT
      || (region.freshBindingContentSha256 !== null
        && (typeof region.freshBindingContentSha256 !== "string"
          || !SHA256.test(region.freshBindingContentSha256)))) reject("CHECKPOINT_INVALID");
    if (region.state === "FRESH_BLOCKED") {
      if ((region.errorCode !== "RUNTIME_MISSING"
          && region.errorCode !== "FRESH_RESOLUTION_FAILED")
        || region.freshBindingContentSha256 !== null
        || region.mappedTargetCount !== 0) reject("CHECKPOINT_INVALID");
    } else if (region.state === "FRESH_READY") {
      if (region.errorCode !== null || region.freshBindingContentSha256 === null
        || region.mappedTargetCount !== 0) reject("CHECKPOINT_INVALID");
    } else if (region.state === "OBJECT_BLOCKED") {
      if (region.errorCode !== "OBJECT_LOAD_FAILED"
        || region.freshBindingContentSha256 === null
        || region.mappedTargetCount !== 0) reject("CHECKPOINT_INVALID");
    } else if (region.state === "MAPPING_BLOCKED") {
      if (region.errorCode !== "MAPPING_FAILED"
        || region.freshBindingContentSha256 === null
        || region.mappedTargetCount !== 0) reject("CHECKPOINT_INVALID");
    } else if (region.errorCode !== null || region.freshBindingContentSha256 === null
      || region.mappedTargetCount !== plan.targets.length) reject("CHECKPOINT_INVALID");
  }
  if (value.status === "FRESH_BLOCKED") {
    if (value.attempt !== null || value.generation !== null
      || !runtimeRegions.some(({ state }) => state === "FRESH_BLOCKED")
      || !runtimeRegions.every(({ state }) => state === "FRESH_BLOCKED"
        || state === "FRESH_READY")) reject("CHECKPOINT_INVALID");
  } else {
    if (!isRecord(value.attempt)
      || !exactKeys(value.attempt, ["attemptId", "contentSha256", "state"])
      || typeof value.attempt.attemptId !== "string" || !ATTEMPT_ID.test(value.attempt.attemptId)
      || typeof value.attempt.contentSha256 !== "string" || !SHA256.test(value.attempt.contentSha256)
      || value.attempt.attemptId !== `coa_${value.attempt.contentSha256}`) {
      reject("CHECKPOINT_INVALID");
    }
    if (value.status === "PARTIAL_ATTEMPT_RECORDED") {
      if (value.attempt.state !== "PARTIAL" || value.generation !== null
        || !runtimeRegions.some(({ state }) => state === "OBJECT_BLOCKED"
          || state === "MAPPING_BLOCKED")
        || !runtimeRegions.every(({ state }) => state === "MAPPED"
          || state === "OBJECT_BLOCKED" || state === "MAPPING_BLOCKED")) {
        reject("CHECKPOINT_INVALID");
      }
    } else if (!isRecord(value.generation)
      || !exactKeys(value.generation, [
        "generationId", "contentSha256", "dataThroughAtIso", "observedAtIso",
      ]) || typeof value.generation.generationId !== "string"
      || !GENERATION_ID.test(value.generation.generationId)
      || typeof value.generation.contentSha256 !== "string"
      || !SHA256.test(value.generation.contentSha256)
      || value.generation.generationId !== `cog_${value.generation.contentSha256}`
      || !isCanonicalIso(value.generation.dataThroughAtIso)
      || !isCanonicalIso(value.generation.observedAtIso)
      || Date.parse(value.generation.dataThroughAtIso as string)
        > Date.parse(value.generation.observedAtIso as string)
      || Date.parse(value.generation.observedAtIso as string)
        > Date.parse(value.materializedAtIso)
      || value.attempt.state !== "ALL_REGION_COMPLETE"
      || !runtimeRegions.every(({ state }) => state === "MAPPED")) {
      reject("CHECKPOINT_INVALID");
    }
  }
  const body = Object.fromEntries(Object.entries(value).filter(([key]) =>
    key !== "checkpointId" && key !== "contentSha256"));
  const contentSha256 = await sha256(canonicalJson(body));
  if (value.contentSha256 !== contentSha256 || value.checkpointId !== `comrm_${contentSha256}`) {
    reject("CONTENT_HASH_MISMATCH");
  }
  assertBound(value);
  return deepFreeze(structuredClone(value)) as unknown as
    ComputeOptimizerMaterializationRuntimeCheckpoint;
}

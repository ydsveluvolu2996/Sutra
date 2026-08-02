/**
 * Server-only Compute Optimizer activation reconcile/replay producer.
 *
 * This application boundary deliberately accepts only trusted scope and
 * schedule identities. Capability topology is rehydrated from the signed
 * collector manifest; credentials and browser-controlled provider fields are
 * never accepted or emitted. This is not the initial provider-launch workflow:
 * production invokes it only after a separate durable launch and discovery
 * phase. Its launch boundary must deterministically replay the sealed ledger.
 */
import { canonicalJson } from "./canonical-json.ts";
import {
  COMPUTE_OPTIMIZER_PROVIDER_RESOURCE_TYPES_BY_EXPORT_FAMILY,
  createComputeOptimizerExportLaunchAttempt,
  verifyComputeOptimizerExportLaunchExecution,
  type ComputeOptimizerExportLaunchAttempt,
  type ComputeOptimizerExportLaunchExecution,
  type ComputeOptimizerExportLaunchCompletedJobObservation,
} from "./finops-compute-optimizer-export-launch.ts";
import {
  createComputeOptimizerMaterializationActivation,
  coordinateComputeOptimizerMaterializationPlans,
  type ComputeOptimizerMaterializationActivation,
  type ComputeOptimizerMaterializationPlanCheckpoint,
} from "./finops-compute-optimizer-export-coordinator.ts";
import {
  ComputeOptimizerExactDescribeReaderError,
  createComputeOptimizerExactDescribeReader,
  type ComputeOptimizerExactDescribeTransport,
} from "./finops-compute-optimizer-export-exact-describe-reader.ts";
import {
  ComputeOptimizerMaterializationActivationReaderError,
  readComputeOptimizerMaterializationActivationManifest,
  type ComputeOptimizerMaterializationActivationManifestTransport,
} from "./finops-compute-optimizer-materialization-activation-reader.ts";
import type {
  ComputeOptimizerExactDescribePlannedJob,
  ComputeOptimizerExactDescribeRequest,
} from "../services/aws-collector/src/compute-optimizer-export-exact-describe.ts";
import type {
  ComputeOptimizerMaterializationActivationManifest,
  ComputeOptimizerMaterializationActivationManifestRegion,
} from "../services/aws-collector/src/compute-optimizer-materialization-activation-manifest.ts";
import type {
  ComputeOptimizerMaterializationRegionContracts,
} from "./finops-compute-optimizer-materialization-runtime.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DAILY_WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const DISCOVERY_RUN_ID = /^cor_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_REGIONS = 50;
const MAXIMUM_DURATION_MS = 330_000;
const MAXIMUM_DISCOVERY_FINALIZATION_LAG_MS = 24 * 60 * 60 * 1_000;

export const COMPUTE_OPTIMIZER_ACTIVATION_PRODUCER_BOUNDS = Object.freeze({
  maximumRegions: MAX_REGIONS,
  maximumDurationMs: MAXIMUM_DURATION_MS,
  maximumDiscoveryFinalizationLagMs: MAXIMUM_DISCOVERY_FINALIZATION_LAG_MS,
} as const);

type Partition = "aws" | "aws-us-gov" | "aws-cn";

export interface ComputeOptimizerActivationProducerInput {
  readonly scope: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
  };
  readonly requesterAccountId: string;
  readonly partition: Partition;
  readonly scheduledWindow: string;
  readonly sealedAtIso: string;
  readonly attemptNumber: number;
  readonly enabledRegions: readonly string[];
  readonly requestId: string;
  readonly jobId: string;
  readonly deadlineAtMs: number;
  readonly signal?: AbortSignal;
}

export interface ComputeOptimizerActivationLaunchTransport {
  /**
   * Resolves only after authenticated ledger replay is verified. Production
   * must not use this boundary to initiate an unrecorded first provider launch.
   */
  launchExact(
    attempt: ComputeOptimizerExportLaunchAttempt,
    context: {
      readonly launchContractId: string;
      readonly requestId: string;
      readonly jobId: string;
      readonly signal: AbortSignal;
      readonly deadlineAtMs: number;
    },
  ): Promise<unknown>;
}

export interface ComputeOptimizerActivationDiscoveryEvidenceReference {
  readonly schemaVersion: "sutra.compute-optimizer-finalized-discovery-reference.v1";
  readonly scope: {
    readonly organizationId: string;
    readonly customerId: string;
    readonly connectionId: string;
  };
  readonly region: string;
  readonly discoveryRunId: string;
  readonly contentSha256: string;
  readonly accountId: string;
  readonly partition: Partition;
  readonly finalizedAtIso: string;
  readonly expectedJobSetContentSha256: string;
}

export interface ComputeOptimizerActivationExpectedDiscoveryJobSet {
  readonly schemaVersion: "sutra.compute-optimizer-expected-discovery-job-set.v1";
  readonly region: string;
  readonly jobs: readonly {
    readonly jobId: string;
    readonly providerResourceType: ComputeOptimizerExportLaunchCompletedJobObservation["providerResourceType"];
    readonly bucketSha256: string;
    readonly objectKeySha256: string;
    readonly metadataKeySha256: string;
  }[];
  readonly contentSha256: string;
}

export interface ComputeOptimizerActivationReadyPersistenceInput {
  readonly activation: ComputeOptimizerMaterializationActivation;
  readonly checkpoint: ComputeOptimizerMaterializationPlanCheckpoint & {
    readonly status: "PLAN_SET_READY";
  };
  readonly regionalPlans: NonNullable<ComputeOptimizerMaterializationPlanCheckpoint["planSet"]>["plans"];
  readonly regionalPlanDiscoveryReferences: readonly {
    readonly region: string;
    readonly planId: string;
    readonly discoveryRunId: string;
  }[];
  /** Exact opaque inputs retained for the materializer outbox dispatcher. */
  readonly regionContracts: readonly ComputeOptimizerMaterializationRegionContracts[];
}

export interface ComputeOptimizerActivationBlockedOutcome {
  readonly schemaVersion: "sutra.compute-optimizer-activation-blocked-outcome.v1";
  readonly requestId: string;
  readonly jobId: string;
  readonly activationId: string;
  readonly checkpointId: string;
  readonly scheduledWindow: string;
  readonly scope: ComputeOptimizerActivationProducerInput["scope"];
  readonly requesterAccountId: string;
  readonly partition: Partition;
  readonly regions: readonly {
    readonly region: string;
    readonly state: "MISSING" | "LAUNCH_BLOCKED" | "DESCRIBE_BLOCKED" | "PLAN_READY";
    readonly errorCodes: readonly string[];
  }[];
}

export interface ComputeOptimizerDiscoveryRefreshRequiredOutcome {
  readonly schemaVersion: "sutra.compute-optimizer-discovery-refresh-required-outcome.v1";
  readonly requestId: string;
  readonly jobId: string;
  readonly activationId: string;
  readonly scheduledWindow: string;
  readonly scope: ComputeOptimizerActivationProducerInput["scope"];
  readonly requesterAccountId: string;
  readonly partition: Partition;
  readonly errorCode: "DISCOVERY_REFRESH_REQUIRED";
  readonly regions: readonly {
    readonly region: string;
    readonly expectedJobSetContentSha256: string;
  }[];
}

export interface ComputeOptimizerActivationProducerDependencies {
  readonly manifestTransport: ComputeOptimizerMaterializationActivationManifestTransport;
  readonly launchTransport: ComputeOptimizerActivationLaunchTransport;
  readonly describeTransport: ComputeOptimizerExactDescribeTransport;
  /**
   * Must return null unless finalized evidence contains the exact secret-free
   * job-set proof. Raw S3 addresses are deliberately absent from this contract.
   */
  readonly loadMatchingFinalizedDiscoveryEvidenceReference: (
    input: {
      readonly organizationId: string;
      readonly customerId: string;
      readonly connectionId: string;
      readonly requesterAccountId: string;
      readonly partition: Partition;
      readonly region: string;
      readonly expectedJobSet: ComputeOptimizerActivationExpectedDiscoveryJobSet;
    },
    context: { readonly signal: AbortSignal; readonly deadlineAtMs: number },
  ) => Promise<unknown>;
  /**
   * Must transactionally seal/persist every regional plan against its existing
   * discovery run and stage one deterministic materializer outbox entry with
   * activation, checkpoint and regionContracts. Queue dispatch happens from
   * that durable outbox in a separate replay-safe step.
   */
  readonly persistReadyAndStageEnqueue: (
    input: ComputeOptimizerActivationReadyPersistenceInput,
    context: { readonly signal: AbortSignal; readonly deadlineAtMs: number },
  ) => Promise<unknown>;
  readonly recordBlockedOutcome: (
    outcome: ComputeOptimizerActivationBlockedOutcome,
    context: { readonly signal: AbortSignal; readonly deadlineAtMs: number },
  ) => Promise<unknown>;
  readonly recordDiscoveryRefreshRequired: (
    outcome: ComputeOptimizerDiscoveryRefreshRequiredOutcome,
    context: { readonly signal: AbortSignal; readonly deadlineAtMs: number },
  ) => Promise<unknown>;
  readonly now?: () => number;
}

export interface ComputeOptimizerActivationProducerReadyOutcome {
  readonly schemaVersion: "sutra.compute-optimizer-activation-producer-outcome.v1";
  readonly status: "PLAN_SET_READY";
  readonly requestId: string;
  readonly jobId: string;
  readonly activationId: string;
  readonly checkpointId: string;
  readonly planSetId: string;
  readonly regions: readonly string[];
}

export class ComputeOptimizerActivationProducerError extends Error {
  public constructor(public readonly code:
    | "INVALID_CONFIGURATION"
    | "INVALID_INPUT"
    | "ABORTED"
    | "DEADLINE_EXCEEDED"
    | "DEPENDENCY_FAILED"
    | "DISCOVERY_EVIDENCE_INVALID"
    | "DISCOVERY_REFRESH_REQUIRED"
    | "LAUNCH_RESPONSE_INVALID"
    | "DESCRIBE_RESPONSE_INVALID"
    | "PLAN_SET_BLOCKED") {
    super("Compute Optimizer activation production rejected");
    this.name = "ComputeOptimizerActivationProducerError";
  }
}

function reject(code: ComputeOptimizerActivationProducerError["code"]): never {
  throw new ComputeOptimizerActivationProducerError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isSafeInteger(epoch) && new Date(epoch).toISOString() === value;
}

function regionMatchesPartition(region: string, partition: Partition): boolean {
  if (partition === "aws-cn") return region.startsWith("cn-");
  if (partition === "aws-us-gov") return region.startsWith("us-gov-");
  return !region.startsWith("cn-") && !region.startsWith("us-gov-");
}

function readNow(clock: (() => number) | undefined): number {
  let value: unknown;
  try { value = (clock ?? Date.now)(); } catch { return reject("INVALID_CONFIGURATION"); }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    reject("INVALID_CONFIGURATION");
  }
  return value;
}

function assertActive(
  signal: AbortSignal,
  deadlineAtMs: number,
  now: (() => number) | undefined,
): void {
  if (signal.aborted) reject("ABORTED");
  if (readNow(now) >= deadlineAtMs) reject("DEADLINE_EXCEEDED");
}

async function awaitWhileActive<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  deadlineAtMs: number,
  now: (() => number) | undefined,
): Promise<T> {
  assertActive(signal, deadlineAtMs, now);
  const value = await operation();
  assertActive(signal, deadlineAtMs, now);
  return value;
}

function validateInput(
  value: unknown,
  now: (() => number) | undefined,
): ComputeOptimizerActivationProducerInput & { readonly enabledRegions: readonly string[] } {
  if (!isRecord(value) || !exactKeys(value, [
    "scope", "requesterAccountId", "partition", "scheduledWindow", "sealedAtIso",
    "attemptNumber", "enabledRegions", "requestId", "jobId", "deadlineAtMs",
    ...(value.signal === undefined ? [] : ["signal"]),
  ]) || !isRecord(value.scope) || !exactKeys(value.scope, [
    "orgId", "customerId", "connectionId",
  ]) || typeof value.scope.orgId !== "string" || !IDENTIFIER.test(value.scope.orgId)
    || typeof value.scope.customerId !== "string" || !IDENTIFIER.test(value.scope.customerId)
    || typeof value.scope.connectionId !== "string" || !CONNECTION_ID.test(value.scope.connectionId)
    || typeof value.requesterAccountId !== "string" || !ACCOUNT_ID.test(value.requesterAccountId)
    || (value.partition !== "aws" && value.partition !== "aws-us-gov"
      && value.partition !== "aws-cn")
    || !timestamp(value.scheduledWindow) || !DAILY_WINDOW.test(value.scheduledWindow)
    || !timestamp(value.sealedAtIso)
    || Date.parse(value.sealedAtIso) < Date.parse(value.scheduledWindow)
    || !Number.isSafeInteger(value.attemptNumber) || (value.attemptNumber as number) < 1
    || (value.attemptNumber as number) > 1_000
    || typeof value.requestId !== "string" || !IDENTIFIER.test(value.requestId)
    || typeof value.jobId !== "string" || !IDENTIFIER.test(value.jobId)
    || !Number.isSafeInteger(value.deadlineAtMs)
    || (value.signal !== undefined && !(value.signal instanceof AbortSignal))
    || !Array.isArray(value.enabledRegions) || value.enabledRegions.length < 1
    || value.enabledRegions.length > MAX_REGIONS) reject("INVALID_INPUT");
  const partition = value.partition as Partition;
  if (value.enabledRegions.some((region) => typeof region !== "string" || !REGION.test(region)
    || !regionMatchesPartition(region, partition))) reject("INVALID_INPUT");
  const regions = [...value.enabledRegions].sort() as string[];
  if (new Set(regions).size !== regions.length) reject("INVALID_INPUT");
  const startedAt = readNow(now);
  if ((value.deadlineAtMs as number) <= startedAt
    || (value.deadlineAtMs as number) - startedAt > MAXIMUM_DURATION_MS) {
    reject("INVALID_INPUT");
  }
  return Object.freeze({
    ...(value as unknown as ComputeOptimizerActivationProducerInput),
    scope: Object.freeze({ ...value.scope }) as ComputeOptimizerActivationProducerInput["scope"],
    enabledRegions: Object.freeze(regions),
  });
}

function validateDependencies(value: unknown): asserts value is ComputeOptimizerActivationProducerDependencies {
  if (!isRecord(value) || !exactKeys(value, [
    "manifestTransport", "launchTransport", "describeTransport",
    "loadMatchingFinalizedDiscoveryEvidenceReference",
    "persistReadyAndStageEnqueue", "recordBlockedOutcome",
    "recordDiscoveryRefreshRequired",
    ...(value.now === undefined ? [] : ["now"]),
  ]) || !isRecord(value.manifestTransport)
    || typeof value.manifestTransport.readActivationManifest !== "function"
    || !isRecord(value.launchTransport) || typeof value.launchTransport.launchExact !== "function"
    || !isRecord(value.describeTransport) || typeof value.describeTransport.describeExact !== "function"
    || typeof value.loadMatchingFinalizedDiscoveryEvidenceReference !== "function"
    || typeof value.persistReadyAndStageEnqueue !== "function"
    || typeof value.recordBlockedOutcome !== "function"
    || typeof value.recordDiscoveryRefreshRequired !== "function"
    || (value.now !== undefined && typeof value.now !== "function")) {
    reject("INVALID_CONFIGURATION");
  }
}

function absoluteBoundary<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  deadlineAtMs: number,
  now: (() => number) | undefined,
): Promise<T> {
  return new Promise<T>((resolve, rejectPromise) => {
    const controller = new AbortController();
    let settled = false;
    const timer: { current?: ReturnType<typeof setTimeout> } = {};
    const finish = (result:
      | { readonly ok: true; readonly value: T }
      | { readonly ok: false; readonly error: unknown }): void => {
      if (settled) return;
      settled = true;
      if (timer.current !== undefined) clearTimeout(timer.current);
      parentSignal?.removeEventListener("abort", onAbort);
      if (!result.ok) controller.abort();
      if (result.ok) resolve(result.value);
      else rejectPromise(result.error);
    };
    const onAbort = (): void => finish({
      ok: false,
      error: new ComputeOptimizerActivationProducerError("ABORTED"),
    });
    if (parentSignal?.aborted === true) return onAbort();
    const remaining = deadlineAtMs - readNow(now);
    if (remaining <= 0) return finish({
      ok: false,
      error: new ComputeOptimizerActivationProducerError("DEADLINE_EXCEEDED"),
    });
    parentSignal?.addEventListener("abort", onAbort, { once: true });
    timer.current = setTimeout(() => finish({
      ok: false,
      error: new ComputeOptimizerActivationProducerError("DEADLINE_EXCEEDED"),
    }), remaining);
    Promise.resolve().then(() => operation(controller.signal)).then(
      (result) => finish({ ok: true, value: result }),
      (error: unknown) => finish({ ok: false, error }),
    );
  });
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Canonical(value: unknown): Promise<string> {
  return await sha256Text(canonicalJson(value));
}

function optionalPrefix(row: ComputeOptimizerMaterializationActivationManifestRegion): string | null {
  return row.basePrefix === "" ? null : row.basePrefix.slice(0, -1);
}

function finalizedDiscoveryReference(
  value: unknown,
  input: ComputeOptimizerActivationProducerInput,
  region: string,
  expectedJobSetContentSha256: string,
  nowMs: number,
): ComputeOptimizerActivationDiscoveryEvidenceReference {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "scope", "region", "discoveryRunId", "contentSha256",
    "accountId", "partition", "finalizedAtIso", "expectedJobSetContentSha256",
  ]) || value.schemaVersion !== "sutra.compute-optimizer-finalized-discovery-reference.v1"
    || !isRecord(value.scope) || !exactKeys(value.scope, [
      "organizationId", "customerId", "connectionId",
    ]) || value.scope.organizationId !== input.scope.orgId
    || value.scope.customerId !== input.scope.customerId
    || value.scope.connectionId !== input.scope.connectionId
    || value.region !== region
    || typeof value.discoveryRunId !== "string" || !DISCOVERY_RUN_ID.test(value.discoveryRunId)
    || typeof value.contentSha256 !== "string" || !SHA256.test(value.contentSha256)
    || value.accountId !== input.requesterAccountId
    || value.partition !== input.partition
    || value.expectedJobSetContentSha256 !== expectedJobSetContentSha256
    || !timestamp(value.finalizedAtIso)
    || Date.parse(value.finalizedAtIso) < Date.parse(input.sealedAtIso)
    || Date.parse(value.finalizedAtIso) - Date.parse(input.scheduledWindow)
      > MAXIMUM_DISCOVERY_FINALIZATION_LAG_MS
    || Date.parse(value.finalizedAtIso) > nowMs) {
    reject("DISCOVERY_EVIDENCE_INVALID");
  }
  return Object.freeze({
    schemaVersion: "sutra.compute-optimizer-finalized-discovery-reference.v1",
    scope: Object.freeze({
      organizationId: input.scope.orgId,
      customerId: input.scope.customerId,
      connectionId: input.scope.connectionId,
    }),
    region,
    discoveryRunId: value.discoveryRunId,
    contentSha256: value.contentSha256,
    accountId: input.requesterAccountId,
    partition: input.partition,
    finalizedAtIso: value.finalizedAtIso,
    expectedJobSetContentSha256,
  });
}

async function expectedDiscoveryJobSet(
  region: string,
  completedJobs: readonly ComputeOptimizerExportLaunchCompletedJobObservation[],
): Promise<ComputeOptimizerActivationExpectedDiscoveryJobSet> {
  const jobs = await Promise.all(completedJobs.map(async (job) => ({
    jobId: job.jobId,
    providerResourceType: job.providerResourceType,
    bucketSha256: await sha256Text(job.bucket),
    objectKeySha256: await sha256Text(job.objectKey),
    metadataKeySha256: await sha256Text(job.metadataKey),
  })));
  jobs.sort((left, right) => left.jobId.localeCompare(right.jobId));
  const body = {
    schemaVersion: "sutra.compute-optimizer-expected-discovery-job-set.v1" as const,
    region,
    jobs,
  };
  return Object.freeze({
    ...body,
    jobs: Object.freeze(jobs.map((job) => Object.freeze(job))),
    contentSha256: await sha256Canonical(body),
  });
}

function propagatedBoundaryError(error: unknown): "ABORTED" | "DEADLINE_EXCEEDED" | null {
  if (!isRecord(error)) return null;
  if (error.code === "ABORTED") return "ABORTED";
  if (error.code === "DEADLINE_EXCEEDED") return "DEADLINE_EXCEEDED";
  return null;
}

function plannedJobs(
  attempt: ComputeOptimizerExportLaunchAttempt,
  execution: ComputeOptimizerExportLaunchExecution,
): readonly ComputeOptimizerExactDescribePlannedJob[] {
  if (execution.status !== "COMPLETE") return [];
  return attempt.targets.map((target, index) => {
    const outcome = execution.outcomes[index]!;
    if (outcome.status !== "SUCCEEDED") return reject("LAUNCH_RESPONSE_INVALID");
    const providerResourceType =
      COMPUTE_OPTIMIZER_PROVIDER_RESOURCE_TYPES_BY_EXPORT_FAMILY[target.exportFamily][0];
    if (providerResourceType === undefined) return reject("LAUNCH_RESPONSE_INVALID");
    return {
      targetId: target.targetId,
      plannedJobId: outcome.jobId,
      exportFamily: target.exportFamily,
      providerResourceType,
      requestSha256: target.requestSha256,
      bucket: outcome.bucket,
      objectKey: outcome.objectKey,
      metadataKey: outcome.metadataKey,
    };
  });
}

async function completedJobsFromExactDescribe(
  input: ComputeOptimizerActivationProducerInput,
  row: ComputeOptimizerMaterializationActivationManifestRegion,
  attempt: ComputeOptimizerExportLaunchAttempt,
  execution: ComputeOptimizerExportLaunchExecution,
  transport: ComputeOptimizerExactDescribeTransport,
  collectionJobId: string,
  signal: AbortSignal,
  now: (() => number) | undefined,
): Promise<readonly ComputeOptimizerExportLaunchCompletedJobObservation[]> {
  const jobs = plannedJobs(attempt, execution);
  if (jobs.length !== attempt.targets.length) reject("LAUNCH_RESPONSE_INVALID");
  const boundary: ComputeOptimizerExactDescribeRequest = {
    schema: "sutra.compute-optimizer-export-exact-describe-request.v1",
    tenantId: input.scope.orgId,
    connectionId: input.scope.connectionId,
    collectionJobId,
    contractId: row.describeContractId,
    accountId: input.requesterAccountId,
    partition: input.partition,
    region: row.region,
    plannedJobs: jobs,
  };
  const reader = createComputeOptimizerExactDescribeReader(boundary, transport, {
    deadlineAtMs: input.deadlineAtMs,
    now,
  });
  let page;
  try {
    page = await awaitWhileActive(() => reader({
      region: row.region,
      jobIds: jobs.map(({ plannedJobId }) => plannedJobId).sort(),
      maxResults: 1_000,
    }, signal), signal, input.deadlineAtMs, now);
  } catch (error) {
    if (error instanceof ComputeOptimizerExactDescribeReaderError) {
      if (error.code === "ABORTED") return reject("ABORTED");
      if (error.code === "DEADLINE_EXCEEDED") return reject("DEADLINE_EXCEEDED");
    }
    return reject("DESCRIBE_RESPONSE_INVALID");
  }
  const observed = page.recommendationExportJobs;
  if (!Array.isArray(observed) || observed.length !== jobs.length || page.nextToken !== undefined) {
    reject("DESCRIBE_RESPONSE_INVALID");
  }
  return Object.freeze(jobs.map((job, index) => {
    const actual = observed[index];
    if (!isRecord(actual) || actual.jobId !== job.plannedJobId
      || typeof actual.resourceType !== "string" || actual.status !== "Complete"
      || typeof actual.creationTimestamp !== "string"
      || typeof actual.lastUpdatedTimestamp !== "string"
      || !isRecord(actual.destination) || !isRecord(actual.destination.s3)
      || actual.destination.s3.bucket !== job.bucket
      || actual.destination.s3.key !== job.objectKey
      || actual.destination.s3.metadataKey !== job.metadataKey) {
      return reject("DESCRIBE_RESPONSE_INVALID");
    }
    return Object.freeze({
      ...job,
      providerResourceType: actual.resourceType as ComputeOptimizerExportLaunchCompletedJobObservation["providerResourceType"],
      jobId: job.plannedJobId,
      status: "COMPLETE" as const,
      creationTimestampIso: actual.creationTimestamp,
      lastUpdatedTimestampIso: actual.lastUpdatedTimestamp,
      destination: Object.freeze({
        bucket: job.bucket,
        objectKey: job.objectKey,
        metadataKey: job.metadataKey,
      }),
    });
  }));
}

function blockedOutcome(
  input: ComputeOptimizerActivationProducerInput,
  activation: ComputeOptimizerMaterializationActivation,
  checkpoint: ComputeOptimizerMaterializationPlanCheckpoint,
): ComputeOptimizerActivationBlockedOutcome {
  return Object.freeze({
    schemaVersion: "sutra.compute-optimizer-activation-blocked-outcome.v1",
    requestId: input.requestId,
    jobId: input.jobId,
    activationId: activation.activationId,
    checkpointId: checkpoint.checkpointId,
    scheduledWindow: input.scheduledWindow,
    scope: Object.freeze({ ...input.scope }),
    requesterAccountId: input.requesterAccountId,
    partition: input.partition,
    regions: Object.freeze(checkpoint.regions.map((region) => Object.freeze({
      region: region.region,
      state: region.state,
      errorCodes: Object.freeze([...region.errorCodes]),
    }))),
  });
}

function discoveryRefreshRequiredOutcome(
  input: ComputeOptimizerActivationProducerInput,
  activation: ComputeOptimizerMaterializationActivation,
  expectedJobSets: readonly ComputeOptimizerActivationExpectedDiscoveryJobSet[],
): ComputeOptimizerDiscoveryRefreshRequiredOutcome {
  return Object.freeze({
    schemaVersion: "sutra.compute-optimizer-discovery-refresh-required-outcome.v1",
    requestId: input.requestId,
    jobId: input.jobId,
    activationId: activation.activationId,
    scheduledWindow: input.scheduledWindow,
    scope: Object.freeze({ ...input.scope }),
    requesterAccountId: input.requesterAccountId,
    partition: input.partition,
    errorCode: "DISCOVERY_REFRESH_REQUIRED",
    regions: Object.freeze(expectedJobSets.map((proof) => Object.freeze({
      region: proof.region,
      expectedJobSetContentSha256: proof.contentSha256,
    }))),
  });
}

/** Creates the reconcile/replay engine without registering its two-phase scheduler. */
export function createComputeOptimizerActivationProducer(
  dependencies: ComputeOptimizerActivationProducerDependencies,
): (input: ComputeOptimizerActivationProducerInput) =>
Promise<ComputeOptimizerActivationProducerReadyOutcome> {
  validateDependencies(dependencies);
  return async (unsafeInput) => {
    const input = validateInput(unsafeInput, dependencies.now);
    return await absoluteBoundary(async (signal) => {
      let manifest: ComputeOptimizerMaterializationActivationManifest;
      try {
        manifest = await awaitWhileActive(() =>
          readComputeOptimizerMaterializationActivationManifest({
            request: {
              schema: "sutra.compute-optimizer-materialization-activation-manifest-request.v1",
              requestId: input.requestId,
              tenantId: input.scope.orgId,
              connectionId: input.scope.connectionId,
              accountId: input.requesterAccountId,
              partition: input.partition,
              requiredPermissionPackVersion: "standard-2026-08.5",
            },
            enabledRegions: input.enabledRegions,
          }, dependencies.manifestTransport, {
            signal,
            deadlineAtMs: input.deadlineAtMs,
            now: dependencies.now,
          }), signal, input.deadlineAtMs, dependencies.now);
      } catch (error) {
        if (error instanceof ComputeOptimizerActivationProducerError) throw error;
        if (error instanceof ComputeOptimizerMaterializationActivationReaderError) {
          if (error.code === "ABORTED") return reject("ABORTED");
          if (error.code === "DEADLINE_EXCEEDED") return reject("DEADLINE_EXCEEDED");
        }
        return reject("DEPENDENCY_FAILED");
      }

      const attempts: ComputeOptimizerExportLaunchAttempt[] = [];
      const executions: ComputeOptimizerExportLaunchExecution[] = [];
      for (const row of manifest.regions) {
        const attempt = await createComputeOptimizerExportLaunchAttempt({
          scope: input.scope,
          requesterAccountId: input.requesterAccountId,
          partition: input.partition,
          region: row.region,
          scheduledWindow: input.scheduledWindow,
          sealedAtIso: input.sealedAtIso,
          attemptNumber: input.attemptNumber,
          bucket: row.bucket,
          optionalPrefix: optionalPrefix(row),
        });
        if (attempt.targets.some((target) => target.effectivePrefix !== row.effectivePrefix)) {
          reject("INVALID_INPUT");
        }
        let execution: ComputeOptimizerExportLaunchExecution;
        try {
          const raw = await awaitWhileActive(() =>
            dependencies.launchTransport.launchExact(attempt, {
              launchContractId: row.launchContractId,
              requestId: input.requestId,
              jobId: input.jobId,
              signal,
              deadlineAtMs: input.deadlineAtMs,
            }), signal, input.deadlineAtMs, dependencies.now);
          execution = await verifyComputeOptimizerExportLaunchExecution(attempt, raw);
        } catch (error) {
          const code = propagatedBoundaryError(error);
          if (code !== null) return reject(code);
          return reject("LAUNCH_RESPONSE_INVALID");
        }
        attempts.push(attempt);
        executions.push(execution);
      }

      const activation = await createComputeOptimizerMaterializationActivation(attempts);
      const evidence: Array<{
        readonly launchAttemptId: string;
        readonly execution: ComputeOptimizerExportLaunchExecution;
        readonly completedJobs: readonly ComputeOptimizerExportLaunchCompletedJobObservation[];
      }> = [];
      for (let index = 0; index < manifest.regions.length; index += 1) {
        const row = manifest.regions[index]!;
        const attempt = attempts[index]!;
        const execution = executions[index]!;
        const collectionJobId = `coapd_${await sha256Canonical({
          requestId: input.requestId,
          jobId: input.jobId,
          activationId: activation.activationId,
          launchAttemptId: attempt.launchAttemptId,
          describeContractId: row.describeContractId,
        })}`;
        const completedJobs = execution.status === "COMPLETE"
          ? await completedJobsFromExactDescribe(
            input, row, attempt, execution, dependencies.describeTransport,
            collectionJobId, signal, dependencies.now,
          )
          : Object.freeze([]);
        evidence.push({ launchAttemptId: attempt.launchAttemptId, execution, completedJobs });
      }

      const checkpoint = await coordinateComputeOptimizerMaterializationPlans(
        activation,
        evidence,
      );
      if (checkpoint.status === "BLOCKED" || checkpoint.planSet === null) {
        try {
          await awaitWhileActive(() => dependencies.recordBlockedOutcome(
            blockedOutcome(input, activation, checkpoint),
            { signal, deadlineAtMs: input.deadlineAtMs },
          ), signal, input.deadlineAtMs, dependencies.now);
        } catch (error) {
          const code = propagatedBoundaryError(error);
          if (code !== null) return reject(code);
          return reject("DEPENDENCY_FAILED");
        }
        reject("PLAN_SET_BLOCKED");
      }
      const expectedJobSets = await Promise.all(manifest.regions.map(async (row, index) => {
        const completedJobs = evidence[index]?.completedJobs;
        if (completedJobs === undefined || completedJobs.length !== 8) {
          return reject("DISCOVERY_EVIDENCE_INVALID");
        }
        return await expectedDiscoveryJobSet(row.region, completedJobs);
      }));
      const discoveryReferences: ComputeOptimizerActivationDiscoveryEvidenceReference[] = [];
      const missingDiscoveryRegions: string[] = [];
      for (let index = 0; index < manifest.regions.length; index += 1) {
        const row = manifest.regions[index]!;
        const expectedJobSet = expectedJobSets[index]!;
        let value: unknown;
        try {
          value = await awaitWhileActive(() =>
            dependencies.loadMatchingFinalizedDiscoveryEvidenceReference({
              organizationId: input.scope.orgId,
              customerId: input.scope.customerId,
              connectionId: input.scope.connectionId,
              requesterAccountId: input.requesterAccountId,
              partition: input.partition,
              region: row.region,
              expectedJobSet,
            }, { signal, deadlineAtMs: input.deadlineAtMs }),
            signal, input.deadlineAtMs, dependencies.now);
        } catch (error) {
          const code = propagatedBoundaryError(error);
          if (code !== null) return reject(code);
          return reject("DISCOVERY_EVIDENCE_INVALID");
        }
        if (value === null) {
          missingDiscoveryRegions.push(row.region);
          continue;
        }
        discoveryReferences.push(finalizedDiscoveryReference(
          value,
          input,
          row.region,
          expectedJobSet.contentSha256,
          readNow(dependencies.now),
        ));
      }
      if (missingDiscoveryRegions.length > 0) {
        try {
          await awaitWhileActive(() => dependencies.recordDiscoveryRefreshRequired(
            discoveryRefreshRequiredOutcome(input, activation, expectedJobSets),
            { signal, deadlineAtMs: input.deadlineAtMs },
          ), signal, input.deadlineAtMs, dependencies.now);
        } catch (error) {
          const code = propagatedBoundaryError(error);
          if (code !== null) return reject(code);
          return reject("DEPENDENCY_FAILED");
        }
        reject("DISCOVERY_REFRESH_REQUIRED");
      }
      if (discoveryReferences.length !== manifest.regions.length
        || new Set(discoveryReferences.map(({ discoveryRunId }) => discoveryRunId)).size
          !== discoveryReferences.length) reject("DISCOVERY_EVIDENCE_INVALID");
      const readyCheckpoint = checkpoint as ComputeOptimizerMaterializationPlanCheckpoint & {
        readonly status: "PLAN_SET_READY";
      };
      const planSet = checkpoint.planSet;
      const regionalPlanDiscoveryReferences = planSet.plans.map((plan, index) => {
        const reference = discoveryReferences[index];
        if (reference === undefined || reference.region !== plan.regions[0]) {
          return reject("DISCOVERY_EVIDENCE_INVALID");
        }
        return Object.freeze({
          region: reference.region,
          planId: plan.planId,
          discoveryRunId: reference.discoveryRunId,
        });
      });
      const regionContracts: readonly ComputeOptimizerMaterializationRegionContracts[] =
        Object.freeze(manifest.regions.map((row) => Object.freeze({
          region: row.region,
          describeContractId: row.describeContractId,
          objectContractId: row.objectReadContractId,
        })));
      try {
        await awaitWhileActive(() => dependencies.persistReadyAndStageEnqueue({
          activation,
          checkpoint: readyCheckpoint,
          regionalPlans: planSet.plans,
          regionalPlanDiscoveryReferences: Object.freeze(regionalPlanDiscoveryReferences),
          regionContracts,
        }, { signal, deadlineAtMs: input.deadlineAtMs }),
          signal, input.deadlineAtMs, dependencies.now);
      } catch (error) {
        const code = propagatedBoundaryError(error);
        if (code !== null) return reject(code);
        return reject("DEPENDENCY_FAILED");
      }
      return Object.freeze({
        schemaVersion: "sutra.compute-optimizer-activation-producer-outcome.v1",
        status: "PLAN_SET_READY",
        requestId: input.requestId,
        jobId: input.jobId,
        activationId: activation.activationId,
        checkpointId: checkpoint.checkpointId,
        planSetId: planSet.planSetId,
        regions: Object.freeze([...input.enabledRegions]),
      });
    }, input.signal, input.deadlineAtMs, dependencies.now).catch((error: unknown) => {
      if (error instanceof ComputeOptimizerActivationProducerError) throw error;
      reject("DEPENDENCY_FAILED");
    });
  };
}

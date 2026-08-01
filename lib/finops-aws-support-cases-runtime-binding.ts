/** Scheduler and durable handler contract for signed AWS Support-case collection. */
import type { JobHandler, RunnableJob } from "./background-job-runner.ts";
import {
  createAwsSupportCasesCollectionJob,
  type AwsSupportCasesJobScope,
  type AwsSupportCasesSnapshotWriter,
  type AwsSupportCasesTargetResolver,
} from "./finops-aws-support-cases-job.ts";
import {
  AWS_SUPPORT_CASES_COLLECTION_BOUNDS,
  type AwsSupportCasesSnapshot,
  type AwsSupportCasesTransport,
  type AwsSupportCollectionWindow,
} from "./finops-aws-support-cases-radar.ts";
import { AWS_SUPPORT_CASES_SIGNED_BROKER_ACTIVATION_REASON } from
  "./finops-aws-support-cases-signed-broker.ts";

export const AWS_SUPPORT_CASES_RUNTIME_JOB_KIND = "finops.aws-support-cases.collect";
export const AWS_SUPPORT_CASES_SCHEDULER_CADENCE = "rate(1 day)";

const JOB_ID = /^job_[a-f0-9]{32}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

export interface AwsSupportCasesRuntimeQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: typeof AWS_SUPPORT_CASES_RUNTIME_JOB_KIND;
    readonly payload: { readonly window: AwsSupportCollectionWindow };
    readonly maxAttempts: 5;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export class AwsSupportCasesRuntimeBindingError extends Error {
  public constructor() {
    super("AWS Support cases runtime binding failed");
    this.name = "AwsSupportCasesRuntimeBindingError";
  }
}

function reject(): never {
  throw new AwsSupportCasesRuntimeBindingError();
}

function validIso(value: string): boolean {
  return ISO.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validScope(scope: unknown): scope is AwsSupportCasesJobScope {
  return record(scope)
    && exactKeys(scope, ["customerId", "organizationId", "parentConnectionId", "partition"])
    && typeof scope.organizationId === "string"
    && typeof scope.customerId === "string"
    && typeof scope.parentConnectionId === "string"
    && typeof scope.partition === "string"
    && IDENTIFIER.test(scope.organizationId)
    && IDENTIFIER.test(scope.customerId)
    && CONNECTION_ID.test(scope.parentConnectionId)
    && new Set(["aws", "aws-us-gov"]).has(scope.partition);
}

function validWindow(window: unknown): window is AwsSupportCollectionWindow {
  if (!record(window)
    || !exactKeys(window, ["afterTime", "beforeTime", "mode", "nextWatermark", "priorWatermark"])
    || typeof window.mode !== "string"
    || typeof window.afterTime !== "string"
    || typeof window.beforeTime !== "string"
    || typeof window.nextWatermark !== "string"
    || (window.priorWatermark !== null && typeof window.priorWatermark !== "string")) return false;
  const durationMs = Date.parse(window.beforeTime) - Date.parse(window.afterTime);
  const priorMs = window.priorWatermark === null ? null : Date.parse(window.priorWatermark);
  return new Set(["INITIAL", "INCREMENTAL"]).has(window.mode)
    && validIso(window.afterTime)
    && validIso(window.beforeTime)
    && validIso(window.nextWatermark)
    && (window.priorWatermark === null || validIso(window.priorWatermark))
    && Date.parse(window.afterTime) < Date.parse(window.beforeTime)
    && window.nextWatermark === window.beforeTime
    && (window.mode === "INITIAL"
      ? window.priorWatermark === null
        && durationMs <= AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumInitialLookbackDays * DAY_MS
      : priorMs !== null
        && Date.parse(window.beforeTime) > priorMs
        && Date.parse(window.afterTime) <= priorMs
        && priorMs - Date.parse(window.afterTime)
          <= AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumIncrementalOverlapHours * HOUR_MS
        && durationMs <= AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumIncrementalWindowDays * DAY_MS);
}

function parseJob(job: RunnableJob): AwsSupportCollectionWindow {
  if (
    job.kind !== AWS_SUPPORT_CASES_RUNTIME_JOB_KIND
    || job.customerId === null
    || job.connectionId === null
    || !JOB_ID.test(job.id)
    || !IDENTIFIER.test(job.orgId)
    || !IDENTIFIER.test(job.customerId)
    || !CONNECTION_ID.test(job.connectionId)
    || !Number.isSafeInteger(job.attempt)
    || job.attempt < 1
    || job.attempt > 5
    || job.maxAttempts !== 5
    || typeof job.payload !== "object"
    || job.payload === null
    || Array.isArray(job.payload)
  ) reject();
  const payload = job.payload as Record<string, unknown>;
  if (
    Object.keys(payload).length !== 1
    || typeof payload.window !== "object"
    || payload.window === null
    || Array.isArray(payload.window)
  ) reject();
  const window = payload.window;
  if (
    JSON.stringify(Object.keys(payload.window as Record<string, unknown>).sort())
      !== JSON.stringify([
        "afterTime", "beforeTime", "mode", "nextWatermark", "priorWatermark",
      ])
    || !validWindow(window)
  ) reject();
  return Object.freeze({ ...window });
}

async function supportJobId(scope: AwsSupportCasesJobScope, window: AwsSupportCollectionWindow) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify({
      schemaVersion: "sutra.aws-support-cases-runtime-identity.v1",
      scope,
      window,
    })),
  );
  return `supportjob_${[...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32)}`;
}

export async function scheduleAwsSupportCasesCollections(input: {
  readonly loadEligibleScopes: () => Promise<readonly AwsSupportCasesJobScope[]>;
  readonly resolveWindow: (
    scope: AwsSupportCasesJobScope,
  ) => Promise<AwsSupportCollectionWindow>;
  readonly queue: AwsSupportCasesRuntimeQueue;
}): Promise<{ readonly enqueued: number }> {
  const loaded = await input.loadEligibleScopes();
  if (!Array.isArray(loaded)) reject();
  const scopes = [...loaded];
  if (scopes.length > 10_000) reject();
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (!validScope(scope) || seen.has(scope.parentConnectionId)) reject();
    seen.add(scope.parentConnectionId);
  }
  scopes.sort((left, right) =>
    left.parentConnectionId.localeCompare(right.parentConnectionId));
  const planned: { readonly scope: AwsSupportCasesJobScope; readonly window: AwsSupportCollectionWindow }[] = [];
  for (const scope of scopes) {
    const resolved: unknown = await input.resolveWindow(scope);
    if (!validWindow(resolved)) reject();
    planned.push({ scope, window: Object.freeze({ ...resolved }) });
  }
  for (const { scope, window } of planned) {
    await input.queue.enqueue({
      orgId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: scope.parentConnectionId,
      kind: AWS_SUPPORT_CASES_RUNTIME_JOB_KIND,
      payload: Object.freeze({ window }),
      maxAttempts: 5,
      idempotencyKey: `aws-support-cases:${scope.parentConnectionId}:${window.nextWatermark}`,
    });
  }
  return { enqueued: planned.length };
}

export async function runAwsSupportCasesRuntimeHandler(job: RunnableJob, dependencies: {
  readonly loadScope: (input: {
    readonly organizationId: string;
    readonly customerId: string;
    readonly connectionId: string;
  }) => Promise<AwsSupportCasesJobScope>;
  readonly targets: AwsSupportCasesTargetResolver;
  readonly transport: AwsSupportCasesTransport;
  readonly snapshots: AwsSupportCasesSnapshotWriter;
  readonly now?: () => Date;
}): Promise<AwsSupportCasesSnapshot> {
  const window = parseJob(job);
  const scope = await dependencies.loadScope({
    organizationId: job.orgId,
    customerId: job.customerId!,
    connectionId: job.connectionId!,
  });
  if (
    !validScope(scope)
    || scope.organizationId !== job.orgId
    || scope.customerId !== job.customerId
    || scope.parentConnectionId !== job.connectionId
  ) reject();
  const deterministicJobId = await supportJobId(scope, window);
  try {
    return await createAwsSupportCasesCollectionJob({
      targets: dependencies.targets,
      transport: dependencies.transport,
      snapshots: dependencies.snapshots,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      createJobId: () => deterministicJobId,
    }).run(scope, window);
  } catch {
    return reject();
  }
}

export function createAwsSupportCasesRuntimeJobHandler(
  dependencies: Parameters<typeof runAwsSupportCasesRuntimeHandler>[1],
): JobHandler {
  return async (job) => { await runAwsSupportCasesRuntimeHandler(job, dependencies); };
}

export const AWS_SUPPORT_CASES_RUNTIME_BINDING = Object.freeze({
  jobKind: AWS_SUPPORT_CASES_RUNTIME_JOB_KIND,
  cadence: AWS_SUPPORT_CASES_SCHEDULER_CADENCE,
  handlerFactory: createAwsSupportCasesRuntimeJobHandler,
  registeredInSharedRuntime: false,
  activationReason: AWS_SUPPORT_CASES_SIGNED_BROKER_ACTIVATION_REASON,
});

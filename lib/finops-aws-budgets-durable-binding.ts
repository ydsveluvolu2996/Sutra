/**
 * ADV-08 permanent scheduler/handler boundary for provider AWS Budgets.
 *
 * The queue payload contains only a scheduler-owned window. Account, partition,
 * organization and customer scope are always reloaded from trusted server
 * state. The broker request is signed elsewhere; this module never owns AWS
 * credentials and never accepts provider scope from a caller-controlled body.
 */
import type { JobHandler, RunnableJob } from "./background-job-runner.ts";
import {
  AWS_BUDGETS_COLLECTION_BOUNDS,
  AWS_BUDGETS_ORGANIZATION_READ_IAM_ACTIONS,
  AWS_BUDGETS_READ_API_OPERATIONS,
  type AwsBudgetsCapture,
  type AwsBudgetsScope,
  type AwsOrganizationHierarchyEvidence,
} from "./finops-aws-budgets-organization.ts";

const JOB_ID = /^job_[a-f0-9]{32}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/u;
const GENERATION_ID = /^abg_[a-f0-9]{64}$/u;
const CAPTURE_ID = /^awsbudgets_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;

export const AWS_BUDGETS_DURABLE_JOB_KIND = "finops.aws-budgets.collect";
export const AWS_BUDGETS_SCHEDULER_CADENCE = "rate(6 hours)";
export const AWS_BUDGETS_HANDLER_ACTIVATION_REASON =
  "AWS_BUDGETS_SIGNED_BROKER_HANDLER_NOT_REGISTERED";
export const AWS_BUDGETS_DURABLE_TIMEOUT_MS = 5 * 60 * 1_000;

export interface AwsBudgetsDurableBrokerRequest {
  readonly schemaVersion: "sutra.aws-budgets-durable-request.v1";
  readonly requestId: string;
  readonly jobId: string;
  readonly scheduledWindow: string;
  readonly scope: AwsBudgetsScope;
  readonly budgetOperations: typeof AWS_BUDGETS_READ_API_OPERATIONS;
  readonly organizationOperations: typeof AWS_BUDGETS_ORGANIZATION_READ_IAM_ACTIONS;
  readonly hierarchyTagKey: "cid:budget-level";
  readonly bounds: typeof AWS_BUDGETS_COLLECTION_BOUNDS;
  readonly maximumDurationMs: number;
}

export interface VerifiedAwsBudgetsBrokerResult {
  readonly capture: AwsBudgetsCapture;
  readonly hierarchy: AwsOrganizationHierarchyEvidence | null;
  readonly verification: {
    readonly requestBodySha256: string;
    readonly responseBodySha256: string;
    readonly brokerKeyId: string;
  };
}

export interface AwsBudgetsDurableAttempt {
  readonly requestId: string;
  readonly jobAttempt: number;
  readonly state: "ready" | "partial" | "configuration_required" | "unavailable" | "failed";
  readonly generationId: string | null;
  readonly captureId: string | null;
  readonly failureCode: AwsBudgetsDurableFailureCode | null;
}

export type AwsBudgetsDurableFailureCode =
  | "BROKER_AUTHENTICATION_FAILED"
  | "BROKER_TIMEOUT"
  | "BROKER_UNAVAILABLE"
  | "BROKER_RESPONSE_INVALID"
  | "SCOPE_REJECTED"
  | "EVIDENCE_REJECTED"
  | "PERSISTENCE_REJECTED"
  | "INTERNAL_ERROR";

export interface AwsBudgetsDurableAttemptStore {
  getAttempt(scope: AwsBudgetsScope, requestId: string, jobAttempt: number): Promise<AwsBudgetsDurableAttempt | null>;
  recordAttempt(input: {
    readonly scope: AwsBudgetsScope;
    readonly requestId: string;
    readonly jobId: string;
    readonly jobAttempt: number;
    readonly scheduledWindow: string;
    readonly state: AwsBudgetsDurableAttempt["state"];
    readonly generationId: string | null;
    readonly captureId: string | null;
    readonly hierarchyEvidenceId: string | null;
    readonly requestBodySha256: string | null;
    readonly responseBodySha256: string | null;
    readonly brokerKeyId: string | null;
    readonly failureCode: AwsBudgetsDurableFailureCode | null;
    readonly completedAtMs: number;
  }): Promise<AwsBudgetsDurableAttempt>;
}

export interface AwsBudgetsScheduledQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: typeof AWS_BUDGETS_DURABLE_JOB_KIND;
    readonly payload: { readonly scheduledWindow: string };
    readonly maxAttempts: 5;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export class AwsBudgetsDurableBindingError extends Error {
  public readonly code: AwsBudgetsDurableFailureCode | "INVALID_JOB";

  public constructor(code: AwsBudgetsDurableBindingError["code"] = "INTERNAL_ERROR") {
    super("AWS Budgets durable collection failed");
    this.name = "AwsBudgetsDurableBindingError";
    this.code = code;
  }
}

function validScope(scope: AwsBudgetsScope): boolean {
  return IDENTIFIER.test(scope.orgId) && IDENTIFIER.test(scope.customerId)
    && CONNECTION_ID.test(scope.connectionId) && ACCOUNT_ID.test(scope.accountId)
    && ["aws", "aws-us-gov", "aws-cn"].includes(scope.partition);
}

function sameScope(left: AwsBudgetsScope, right: AwsBudgetsScope): boolean {
  return left.orgId === right.orgId && left.customerId === right.customerId
    && left.connectionId === right.connectionId && left.accountId === right.accountId
    && left.partition === right.partition;
}

function validWindow(value: string): boolean {
  return WINDOW.test(value) && new Date(Date.parse(value)).toISOString() === value;
}

function canonicalScope(scope: AwsBudgetsScope): AwsBudgetsScope {
  if (!validScope(scope)) throw new AwsBudgetsDurableBindingError("SCOPE_REJECTED");
  return Object.freeze({ ...scope });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function requestIdFor(input: {
  readonly scope: AwsBudgetsScope;
  readonly scheduledWindow: string;
}): Promise<string> {
  return `abr_${await sha256(JSON.stringify({
    schemaVersion: "sutra.aws-budgets-request-id.v1",
    scope: input.scope,
    scheduledWindow: input.scheduledWindow,
  }))}`;
}

function parseJob(job: RunnableJob): { readonly scheduledWindow: string } {
  if (job.kind !== AWS_BUDGETS_DURABLE_JOB_KIND || job.customerId === null
    || job.connectionId === null || !JOB_ID.test(job.id)
    || !Number.isSafeInteger(job.attempt) || job.attempt < 1 || job.attempt > 25
    || typeof job.payload !== "object" || job.payload === null || Array.isArray(job.payload)) {
    throw new AwsBudgetsDurableBindingError("INVALID_JOB");
  }
  const payload = job.payload as Record<string, unknown>;
  if (Object.keys(payload).length !== 1 || typeof payload.scheduledWindow !== "string"
    || !validWindow(payload.scheduledWindow)) {
    throw new AwsBudgetsDurableBindingError("INVALID_JOB");
  }
  return { scheduledWindow: payload.scheduledWindow };
}

function failureCode(error: unknown): AwsBudgetsDurableFailureCode {
  if (error instanceof AwsBudgetsDurableBindingError && error.code !== "INVALID_JOB") return error.code;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { readonly code: unknown }).code);
    if ([
      "BROKER_AUTHENTICATION_FAILED", "BROKER_TIMEOUT", "BROKER_UNAVAILABLE",
      "BROKER_RESPONSE_INVALID", "SCOPE_REJECTED", "EVIDENCE_REJECTED",
      "PERSISTENCE_REJECTED", "INTERNAL_ERROR",
    ].includes(code)) return code as AwsBudgetsDurableFailureCode;
  }
  return "INTERNAL_ERROR";
}

export async function scheduleAwsBudgetsCollections(input: {
  /** Trusted system query; not a request-body supplied list. */
  readonly loadEligibleScopes: () => Promise<readonly AwsBudgetsScope[]>;
  readonly queue: AwsBudgetsScheduledQueue;
  readonly scheduledWindow: string;
}): Promise<{ readonly scheduledWindow: string; readonly enqueued: number }> {
  if (!validWindow(input.scheduledWindow)) throw new AwsBudgetsDurableBindingError("INVALID_JOB");
  const scopes = (await input.loadEligibleScopes()).map(canonicalScope)
    .sort((left, right) => left.connectionId.localeCompare(right.connectionId));
  if (scopes.length > 10_000) throw new AwsBudgetsDurableBindingError("SCOPE_REJECTED");
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (seen.has(scope.connectionId)) throw new AwsBudgetsDurableBindingError("SCOPE_REJECTED");
    seen.add(scope.connectionId);
    await input.queue.enqueue({
      orgId: scope.orgId,
      customerId: scope.customerId,
      connectionId: scope.connectionId,
      kind: AWS_BUDGETS_DURABLE_JOB_KIND,
      payload: Object.freeze({ scheduledWindow: input.scheduledWindow }),
      maxAttempts: 5,
      idempotencyKey: `aws-budgets:${scope.connectionId}:${input.scheduledWindow}`,
    });
  }
  return { scheduledWindow: input.scheduledWindow, enqueued: scopes.length };
}

export async function runAwsBudgetsDurableHandler(job: RunnableJob, dependencies: {
  readonly loadScope: (input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
  }) => Promise<AwsBudgetsScope>;
  readonly broker: { readonly collect: (request: AwsBudgetsDurableBrokerRequest) => Promise<VerifiedAwsBudgetsBrokerResult> };
  readonly captureStore: {
    readonly recordCapture: (
      scope: AwsBudgetsScope,
      capture: AwsBudgetsCapture,
      hierarchy: AwsOrganizationHierarchyEvidence | null,
      nowMs: number,
    ) => Promise<{
      readonly generation: { readonly generationId: string; readonly snapshot: { readonly captureId: string; readonly collectionState: string } };
      readonly becameActive: boolean;
    }>;
  };
  readonly attempts: AwsBudgetsDurableAttemptStore;
  readonly now?: () => number;
}): Promise<{ readonly requestId: string; readonly generationId: string; readonly state: string; readonly replayed: boolean }> {
  const payload = parseJob(job);
  const now = dependencies.now ?? Date.now;
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new AwsBudgetsDurableBindingError();
  let trusted: AwsBudgetsScope;
  try {
    trusted = canonicalScope(await dependencies.loadScope({
      orgId: job.orgId,
      customerId: job.customerId!,
      connectionId: job.connectionId!,
    }));
  } catch (error) {
    if (error instanceof AwsBudgetsDurableBindingError) throw error;
    throw new AwsBudgetsDurableBindingError("INTERNAL_ERROR");
  }
  if (trusted.orgId !== job.orgId || trusted.customerId !== job.customerId
    || trusted.connectionId !== job.connectionId) {
    throw new AwsBudgetsDurableBindingError("SCOPE_REJECTED");
  }
  const requestId = await requestIdFor({ scope: trusted, scheduledWindow: payload.scheduledWindow });
  let prior: AwsBudgetsDurableAttempt | null;
  try {
    prior = await dependencies.attempts.getAttempt(trusted, requestId, job.attempt);
  } catch {
    throw new AwsBudgetsDurableBindingError("PERSISTENCE_REJECTED");
  }
  if (prior !== null) {
    if (prior.failureCode !== null || prior.generationId === null) {
      throw new AwsBudgetsDurableBindingError(prior.failureCode ?? "INTERNAL_ERROR");
    }
    return { requestId, generationId: prior.generationId, state: prior.state, replayed: true };
  }
  const request: AwsBudgetsDurableBrokerRequest = Object.freeze({
    schemaVersion: "sutra.aws-budgets-durable-request.v1",
    requestId,
    jobId: job.id,
    scheduledWindow: payload.scheduledWindow,
    scope: trusted,
    budgetOperations: AWS_BUDGETS_READ_API_OPERATIONS,
    organizationOperations: AWS_BUDGETS_ORGANIZATION_READ_IAM_ACTIONS,
    hierarchyTagKey: "cid:budget-level",
    bounds: AWS_BUDGETS_COLLECTION_BOUNDS,
    maximumDurationMs: AWS_BUDGETS_DURABLE_TIMEOUT_MS,
  });
  const expectedRequestBodySha256 = await sha256(JSON.stringify(request));
  try {
    const response = await dependencies.broker.collect(request);
    if (response.verification.requestBodySha256 !== expectedRequestBodySha256
      || !SHA256.test(response.verification.responseBodySha256)
      || !KEY_ID.test(response.verification.brokerKeyId)) {
      throw new AwsBudgetsDurableBindingError("BROKER_RESPONSE_INVALID");
    }
    if (!sameScope(response.capture.scope, trusted)
      || (response.hierarchy !== null && (
        response.hierarchy.scope.orgId !== trusted.orgId
        || response.hierarchy.scope.customerId !== trusted.customerId
        || response.hierarchy.scope.connectionId !== trusted.connectionId
      ))) throw new AwsBudgetsDurableBindingError("SCOPE_REJECTED");
    let stored: Awaited<ReturnType<typeof dependencies.captureStore.recordCapture>>;
    try {
      stored = await dependencies.captureStore.recordCapture(
        trusted, response.capture, response.hierarchy, now(),
      );
    } catch {
      throw new AwsBudgetsDurableBindingError("PERSISTENCE_REJECTED");
    }
    if (!GENERATION_ID.test(stored.generation.generationId)
      || !CAPTURE_ID.test(stored.generation.snapshot.captureId)
      || !["ready", "partial", "configuration_required", "unavailable"]
        .includes(stored.generation.snapshot.collectionState)) {
      throw new AwsBudgetsDurableBindingError("PERSISTENCE_REJECTED");
    }
    let recorded: AwsBudgetsDurableAttempt;
    try {
      recorded = await dependencies.attempts.recordAttempt({
        scope: trusted, requestId, jobId: job.id, jobAttempt: job.attempt,
        scheduledWindow: payload.scheduledWindow,
        state: stored.generation.snapshot.collectionState as AwsBudgetsDurableAttempt["state"],
        generationId: stored.generation.generationId,
        captureId: stored.generation.snapshot.captureId,
        hierarchyEvidenceId: response.hierarchy?.sourceEvidenceId ?? null,
        requestBodySha256: response.verification.requestBodySha256,
        responseBodySha256: response.verification.responseBodySha256,
        brokerKeyId: response.verification.brokerKeyId,
        failureCode: null,
        completedAtMs: now(),
      });
    } catch {
      throw new AwsBudgetsDurableBindingError("PERSISTENCE_REJECTED");
    }
    return { requestId, generationId: stored.generation.generationId, state: recorded.state, replayed: false };
  } catch (error) {
    const code = failureCode(error);
    try {
      await dependencies.attempts.recordAttempt({
        scope: trusted, requestId, jobId: job.id, jobAttempt: job.attempt,
        scheduledWindow: payload.scheduledWindow, state: "failed", generationId: null,
        captureId: null, hierarchyEvidenceId: null,
        requestBodySha256: expectedRequestBodySha256,
        responseBodySha256: null, brokerKeyId: null, failureCode: code,
        completedAtMs: now(),
      });
    } catch {
      // Do not let persistence diagnostics or provider data escape the handler.
    }
    throw new AwsBudgetsDurableBindingError(code);
  }
}

export function createAwsBudgetsDurableJobHandler(
  dependencies: Parameters<typeof runAwsBudgetsDurableHandler>[1],
): JobHandler {
  return async (job) => { await runAwsBudgetsDurableHandler(job, dependencies); };
}

export const AWS_BUDGETS_DURABLE_BINDING = Object.freeze({
  jobKind: AWS_BUDGETS_DURABLE_JOB_KIND,
  cadence: AWS_BUDGETS_SCHEDULER_CADENCE,
  handlerFactory: createAwsBudgetsDurableJobHandler,
  registeredInSharedRuntime: false,
  activationReason: AWS_BUDGETS_HANDLER_ACTIVATION_REASON,
});

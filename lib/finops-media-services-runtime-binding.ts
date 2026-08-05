/**
 * ADV-13 permanent scheduler/handler boundary for Media Services Insights.
 *
 * The durable payload contains only a scheduler window. Connection, AWS
 * account, partition, Region, active CUR2 lineage, and governed planning
 * evidence are always resolved from trusted server state.
 */
import type { JobHandler, RunnableJob } from "./background-job-runner.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  MEDIA_SERVICES_INSIGHTS_BOUNDS,
  MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS,
  normalizeMediaServicesCapture,
  type MediaCostBasis,
  type MediaServicesCapture,
  type MediaServicesScope,
  type MediaServicesSnapshot,
} from "./finops-media-services-insights.ts";
import { MEDIA_SERVICES_INSIGHTS_JOB_KIND } from
  "./finops-media-services-collector-job.ts";
import type {
  MediaServicesPersistenceScope,
  StoredMediaServicesSnapshot,
} from "../db/finops-media-services-repository.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REQUEST_ID = /^msr_[a-f0-9]{64}$/u;
const CAPTURE_ID = /^media_[a-f0-9]{64}$/u;
const BILLING_GENERATION = /^fbg_[a-f0-9]{64}$/u;
const BUDGET_GENERATION = /^abg_[a-f0-9]{64}$/u;
const SOURCE_GENERATION = /^fss_[a-f0-9]{64}$/u;
const SNAPSHOT_GENERATION = /^msg_[a-f0-9]{64}$/u;
const EVIDENCE_OBJECT = /^eobj_[a-f0-9]{32}$/u;
const SEALED_REFERENCE = /^fsev1\.[A-Za-z0-9_-]{26,8186}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const MAX_CONNECTIONS = 10_000;
const MAX_TARGETS = 5_000;
const MEDIA_SERVICES_RUNTIME_MAX_EVIDENCE_BYTES = 12 * 1_024 * 1_024;

export const MEDIA_SERVICES_RUNTIME_JOB_KIND = MEDIA_SERVICES_INSIGHTS_JOB_KIND;
export const MEDIA_SERVICES_RUNTIME_CADENCE = "rate(1 day)";
export const MEDIA_SERVICES_RUNTIME_TIMEOUT_MS =
  MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumDurationMs;
/** Leaves bounded envelope headroom below the production evidence-store limit. */
export const MEDIA_SERVICES_RUNTIME_MAX_CAPTURE_BYTES = 11 * 1_024 * 1_024;
export const MEDIA_SERVICES_RUNTIME_ACTIVATION_REASON =
  "MEDIA_SERVICES_AWS_ADAPTER_JOB_HANDLER_NOT_REGISTERED";
export const MEDIA_SERVICES_EVIDENCE_SOURCE_ID =
  "media_services_telemetry" as const;
export const MEDIA_SERVICES_EVIDENCE_ACTOR_ID =
  "finops-media-services-runtime" as const;

export const MEDIA_SERVICES_RUNTIME_WORKFLOWS = Object.freeze([
  Object.freeze({
    id: "MEDIACONNECT_FLOW",
    providers: Object.freeze(["MEDIACONNECT"] as const),
    resourceTypes: Object.freeze(["FLOW"] as const),
  }),
  Object.freeze({
    id: "MEDIACONVERT_PROCESSING",
    providers: Object.freeze(["MEDIACONVERT"] as const),
    resourceTypes: Object.freeze(["JOB", "QUEUE"] as const),
  }),
  Object.freeze({
    id: "MEDIALIVE_CHANNEL",
    providers: Object.freeze(["MEDIALIVE"] as const),
    resourceTypes: Object.freeze([
      "CHANNEL", "MULTIPLEX", "OFFERING", "RESERVATION",
    ] as const),
  }),
  Object.freeze({
    id: "MEDIATAILOR_AD_INSERTION",
    providers: Object.freeze(["MEDIATAILOR"] as const),
    resourceTypes: Object.freeze([
      "PLAYBACK_CONFIGURATION", "CHANNEL", "SOURCE_LOCATION", "LIVE_SOURCE",
      "VOD_SOURCE",
    ] as const),
  }),
  Object.freeze({
    id: "MEDIAPACKAGE_ORIGINATION",
    providers: Object.freeze(["MEDIAPACKAGE_V1", "MEDIAPACKAGE_V2"] as const),
    resourceTypes: Object.freeze([
      "CHANNEL_GROUP", "CHANNEL", "ORIGIN_ENDPOINT", "HARVEST_JOB",
    ] as const),
  }),
] as const);

export interface MediaServicesActiveBillingLineage {
  readonly source: "AWS_CUR2_ACTIVE_GENERATION";
  readonly state: "ACTIVE_RECONCILED";
  readonly generationId: string;
  readonly manifestSha256: string;
  readonly dataThroughAtIso: string;
  readonly costBasis: MediaCostBasis;
  readonly currency: string;
  readonly rowsExhausted: true;
}

export type MediaServicesBudgetEvidence =
  | {
      readonly state: "UNAVAILABLE";
      readonly reason: "GOVERNED_AWS_BUDGETS_EVIDENCE_NOT_AVAILABLE";
    }
  | {
      readonly state: "PINNED";
      readonly source: "AWS_BUDGETS_ACCEPTED_GENERATION";
      readonly generationId: string;
      readonly contentSha256: string;
      readonly dataThroughAtIso: string;
      readonly currency: string;
    };

export type MediaServicesReservationPricingEvidence =
  | {
      readonly state: "UNAVAILABLE";
      readonly reason:
        "GOVERNED_MEDIALIVE_ON_DEMAND_PRICE_EVIDENCE_NOT_AVAILABLE";
    }
  | {
      readonly state: "PINNED";
      readonly source: "AWS_PRICE_LIST_ACCEPTED_GENERATION";
      readonly generationId: string;
      readonly contentSha256: string;
      readonly effectiveAtIso: string;
      readonly currency: string;
    };

export interface MediaServicesPlanningEvidence {
  readonly budget: MediaServicesBudgetEvidence;
  readonly reservationPricing: MediaServicesReservationPricingEvidence;
}

export interface MediaServicesRuntimeTarget extends MediaServicesScope {
  readonly lastAcceptedCompletedAtIso: string | null;
  readonly activeBilling: MediaServicesActiveBillingLineage;
  readonly planningEvidence: MediaServicesPlanningEvidence;
}

export interface MediaServicesRuntimeAdapterRequest {
  readonly schemaVersion: "sutra.media-services-runtime-request.v1";
  readonly requestId: string;
  readonly expectedCaptureId: string;
  readonly scheduledWindow: string;
  readonly scope: MediaServicesScope;
  readonly incrementalAfterIso: string | null;
  readonly credentials: "SERVER_OWNED_TRUST_ROLE_SESSION";
  readonly workflows: typeof MEDIA_SERVICES_RUNTIME_WORKFLOWS;
  readonly operations: typeof MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS;
  readonly pagination: {
    readonly pageSize: 100;
    readonly maximumApiCallsPerProvider:
      typeof MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumApiCallsPerProvider;
    readonly rejectTokenReplay: true;
    readonly requireExhaustionEvidence: true;
  };
  readonly activeBilling: MediaServicesActiveBillingLineage;
  /** References only. No budget, price, savings, or threshold values are inferred. */
  readonly planningEvidence: MediaServicesPlanningEvidence;
  readonly costJoin: "EXACT_RESOURCE_ARN_OR_SERVICE_LEVEL_UNATTRIBUTED";
  readonly bounds: Omit<typeof MEDIA_SERVICES_INSIGHTS_BOUNDS, "maximumCaptureBytes"> & {
    readonly maximumCaptureBytes: typeof MEDIA_SERVICES_RUNTIME_MAX_CAPTURE_BYTES;
  };
  readonly maximumDurationMs:
    typeof MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumDurationMs;
}

export interface MediaServicesRuntimeAwsAdapter {
  collect(
    request: MediaServicesRuntimeAdapterRequest,
    signal: AbortSignal,
  ): Promise<MediaServicesCapture>;
}

export interface MediaServicesRuntimeQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: typeof MEDIA_SERVICES_RUNTIME_JOB_KIND;
    readonly payload: { readonly scheduledWindow: string };
    readonly maxAttempts: 5;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export interface MediaServicesEvidenceArchive {
  archive(input: {
    readonly scope: {
      readonly orgId: string;
      readonly customerId: string;
      readonly connectionId: string;
    };
    readonly runId: string;
    readonly snapshotId: string;
    readonly artifactKind: "finops_source_snapshot";
    readonly contentType: "application/json";
    readonly body: Uint8Array;
    readonly createdBy: typeof MEDIA_SERVICES_EVIDENCE_ACTOR_ID;
    readonly now: number;
  }): Promise<{
    readonly id: string;
    readonly status: "staging" | "available" | "failed";
    readonly contentSha256: string;
  }>;
}

export interface MediaServicesEvidenceSealer {
  seal(objectId: string, context: {
    readonly organizationId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly sourceId: typeof MEDIA_SERVICES_EVIDENCE_SOURCE_ID;
    readonly generationId: string;
  }): Promise<{ readonly ciphertext: string; readonly keyVersion: string }>;
}

export interface MediaServicesAcceptedRuntimeAttempt {
  readonly requestId: string;
  readonly scheduledWindow: string;
  readonly snapshot: StoredMediaServicesSnapshot;
  readonly evidence: {
    readonly generationId: string;
    readonly objectId: string;
    readonly contentSha256: string;
    readonly reference: { readonly ciphertext: string; readonly keyVersion: string };
  };
}

export type MediaServicesRuntimeFailureCode =
  | "ADAPTER_TIMEOUT"
  | "ADAPTER_UNAVAILABLE"
  | "CAPTURE_REJECTED"
  | "EVIDENCE_REJECTED"
  | "PERSISTENCE_REJECTED";

export interface MediaServicesImmutableEvidenceHandoff {
  getAccepted(
    scope: MediaServicesPersistenceScope,
    target: MediaServicesScope,
    requestId: string,
  ): Promise<MediaServicesAcceptedRuntimeAttempt | null>;
  commit(input: {
    readonly scope: MediaServicesPersistenceScope;
    readonly target: MediaServicesScope;
    readonly requestId: string;
    readonly scheduledWindow: string;
    readonly capture: MediaServicesCapture;
    readonly normalizedSnapshot: MediaServicesSnapshot;
    readonly planningEvidence: MediaServicesPlanningEvidence;
    readonly evidence: MediaServicesAcceptedRuntimeAttempt["evidence"];
    readonly nowMs: number;
  }): Promise<{
    readonly accepted: MediaServicesAcceptedRuntimeAttempt;
    readonly becameActive: boolean;
  }>;
  recordFailure(input: {
    readonly scope: MediaServicesPersistenceScope;
    readonly target: MediaServicesScope;
    readonly requestId: string;
    readonly scheduledWindow: string;
    readonly code: MediaServicesRuntimeFailureCode;
    readonly completedAtMs: number;
  }): Promise<void>;
}

export interface MediaServicesRuntimeDependencies {
  readonly loadScope: (identity: MediaServicesPersistenceScope) =>
    Promise<MediaServicesPersistenceScope>;
  readonly listTargets: (scope: MediaServicesPersistenceScope) =>
    Promise<readonly MediaServicesRuntimeTarget[]>;
  readonly adapter: MediaServicesRuntimeAwsAdapter | null;
  readonly evidence: MediaServicesEvidenceArchive;
  readonly sealer: MediaServicesEvidenceSealer;
  readonly handoff: MediaServicesImmutableEvidenceHandoff;
  readonly now?: () => number;
}

export class MediaServicesRuntimeBindingError extends Error {
  public readonly code:
    | "INVALID_JOB"
    | "SCOPE_REJECTED"
    | "TARGETS_REJECTED"
    | MediaServicesRuntimeFailureCode;

  public constructor(code: MediaServicesRuntimeBindingError["code"]) {
    super("Media Services runtime collection failed");
    this.name = "MediaServicesRuntimeBindingError";
    this.code = code;
  }
}

export type MediaServicesRuntimeResult =
  | {
      readonly status: "unavailable";
      readonly reason: typeof MEDIA_SERVICES_RUNTIME_ACTIVATION_REASON;
    }
  | {
      readonly status: "collected";
      readonly targetCount: number;
      readonly acceptedHeadCount: number;
      readonly incompleteCount: number;
      readonly replayedCount: number;
      readonly governedBudgetTargetCount: number;
      readonly governedReservationPricingTargetCount: number;
      readonly generations: readonly string[];
      readonly evidenceGenerations: readonly string[];
    };

function reject(code: MediaServicesRuntimeBindingError["code"]): never {
  throw new MediaServicesRuntimeBindingError(code);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort())
    === JSON.stringify([...keys].sort());
}

function validIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validWindow(value: unknown): value is string {
  return typeof value === "string" && WINDOW.test(value) && validIso(value);
}

function validScope(scope: MediaServicesPersistenceScope): boolean {
  return IDENTIFIER.test(scope.organizationId)
    && IDENTIFIER.test(scope.customerId)
    && CONNECTION.test(scope.connectionId);
}

function sameScope(
  left: MediaServicesPersistenceScope,
  right: MediaServicesPersistenceScope,
): boolean {
  return left.organizationId === right.organizationId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId;
}

function mediaScope(target: MediaServicesRuntimeTarget): MediaServicesScope {
  return Object.freeze({
    orgId: target.orgId,
    customerId: target.customerId,
    connectionId: target.connectionId,
    accountId: target.accountId,
    partition: target.partition,
    region: target.region,
  });
}

function sameTarget(left: MediaServicesScope, right: MediaServicesScope): boolean {
  return left.orgId === right.orgId && left.customerId === right.customerId
    && left.connectionId === right.connectionId
    && left.accountId === right.accountId && left.partition === right.partition
    && left.region === right.region;
}

function validBilling(value: MediaServicesActiveBillingLineage): boolean {
  return exactKeys(value, [
    "source", "state", "generationId", "manifestSha256", "dataThroughAtIso",
    "costBasis", "currency", "rowsExhausted",
  ])
    && value.source === "AWS_CUR2_ACTIVE_GENERATION"
    && value.state === "ACTIVE_RECONCILED"
    && BILLING_GENERATION.test(value.generationId)
    && SHA256.test(value.manifestSha256)
    && validIso(value.dataThroughAtIso)
    && new Set([
      "UNBLENDED", "AMORTIZED", "NET_UNBLENDED", "NET_AMORTIZED",
    ]).has(value.costBasis)
    && CURRENCY.test(value.currency)
    && value.rowsExhausted === true;
}

function validBudget(value: MediaServicesBudgetEvidence): boolean {
  if (value.state === "UNAVAILABLE") {
    return exactKeys(value, ["state", "reason"])
      && value.reason === "GOVERNED_AWS_BUDGETS_EVIDENCE_NOT_AVAILABLE";
  }
  return exactKeys(value, [
    "state", "source", "generationId", "contentSha256", "dataThroughAtIso",
    "currency",
  ])
    && value.source === "AWS_BUDGETS_ACCEPTED_GENERATION"
    && BUDGET_GENERATION.test(value.generationId)
    && SHA256.test(value.contentSha256)
    && validIso(value.dataThroughAtIso)
    && CURRENCY.test(value.currency);
}

function validReservation(value: MediaServicesReservationPricingEvidence): boolean {
  if (value.state === "UNAVAILABLE") {
    return exactKeys(value, ["state", "reason"])
      && value.reason
        === "GOVERNED_MEDIALIVE_ON_DEMAND_PRICE_EVIDENCE_NOT_AVAILABLE";
  }
  return exactKeys(value, [
    "state", "source", "generationId", "contentSha256", "effectiveAtIso",
    "currency",
  ])
    && value.source === "AWS_PRICE_LIST_ACCEPTED_GENERATION"
    && SOURCE_GENERATION.test(value.generationId)
    && SHA256.test(value.contentSha256)
    && validIso(value.effectiveAtIso)
    && CURRENCY.test(value.currency);
}

function validPlanning(value: MediaServicesPlanningEvidence): boolean {
  return exactKeys(value, ["budget", "reservationPricing"])
    && validBudget(value.budget)
    && validReservation(value.reservationPricing);
}

function validTarget(
  target: MediaServicesRuntimeTarget,
  scope: MediaServicesPersistenceScope,
): boolean {
  return exactKeys(target, [
    "orgId", "customerId", "connectionId", "accountId", "partition", "region",
    "lastAcceptedCompletedAtIso", "activeBilling", "planningEvidence",
  ])
    && target.orgId === scope.organizationId
    && target.customerId === scope.customerId
    && target.connectionId === scope.connectionId
    && ACCOUNT.test(target.accountId)
    && new Set(["aws", "aws-cn", "aws-us-gov"]).has(target.partition)
    && REGION.test(target.region)
    && (target.lastAcceptedCompletedAtIso === null
      || validIso(target.lastAcceptedCompletedAtIso))
    && validBilling(target.activeBilling)
    && validPlanning(target.planningEvidence)
    && (target.planningEvidence.budget.state === "UNAVAILABLE"
      || target.planningEvidence.budget.currency === target.activeBilling.currency)
    && (target.planningEvidence.reservationPricing.state === "UNAVAILABLE"
      || target.planningEvidence.reservationPricing.currency
        === target.activeBilling.currency);
}

function currentTime(now: (() => number) | undefined): number {
  const value = now?.() ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) reject("INVALID_JOB");
  return value;
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0")).join("");
}

function parseJob(job: RunnableJob): {
  readonly scope: MediaServicesPersistenceScope;
  readonly scheduledWindow: string;
} {
  if (job.kind !== MEDIA_SERVICES_RUNTIME_JOB_KIND || job.customerId === null
    || job.connectionId === null || !IDENTIFIER.test(job.id)
    || !IDENTIFIER.test(job.orgId) || !IDENTIFIER.test(job.customerId)
    || !CONNECTION.test(job.connectionId) || !Number.isSafeInteger(job.attempt)
    || job.attempt < 1 || job.attempt > 25
    || !Number.isSafeInteger(job.maxAttempts) || job.maxAttempts < job.attempt
    || typeof job.payload !== "object" || job.payload === null
    || Array.isArray(job.payload)) reject("INVALID_JOB");
  const payload = job.payload as Record<string, unknown>;
  if (!exactKeys(payload, ["scheduledWindow"])
    || !validWindow(payload.scheduledWindow)) reject("INVALID_JOB");
  return {
    scope: {
      organizationId: job.orgId,
      customerId: job.customerId,
      connectionId: job.connectionId,
    },
    scheduledWindow: payload.scheduledWindow,
  };
}

async function requestIdentity(input: {
  readonly scope: MediaServicesScope;
  readonly scheduledWindow: string;
  readonly activeBilling: MediaServicesActiveBillingLineage;
  readonly planningEvidence: MediaServicesPlanningEvidence;
}): Promise<{ readonly requestId: string; readonly expectedCaptureId: string }> {
  const digest = await sha256(canonicalJson({
    schemaVersion: "sutra.media-services-runtime-identity.v1", ...input,
  }));
  return { requestId: `msr_${digest}`, expectedCaptureId: `media_${digest}` };
}

function requestFor(
  identity: { readonly requestId: string; readonly expectedCaptureId: string },
  target: MediaServicesRuntimeTarget,
  scheduledWindow: string,
): MediaServicesRuntimeAdapterRequest {
  const bounds = Object.freeze({
    ...MEDIA_SERVICES_INSIGHTS_BOUNDS,
    maximumCaptureBytes: MEDIA_SERVICES_RUNTIME_MAX_CAPTURE_BYTES,
  });
  return Object.freeze({
    schemaVersion: "sutra.media-services-runtime-request.v1",
    ...identity,
    scheduledWindow,
    scope: mediaScope(target),
    incrementalAfterIso: target.lastAcceptedCompletedAtIso,
    credentials: "SERVER_OWNED_TRUST_ROLE_SESSION",
    workflows: MEDIA_SERVICES_RUNTIME_WORKFLOWS,
    operations: MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS,
    pagination: Object.freeze({
      pageSize: 100,
      maximumApiCallsPerProvider:
        MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumApiCallsPerProvider,
      rejectTokenReplay: true,
      requireExhaustionEvidence: true,
    }),
    activeBilling: Object.freeze({ ...target.activeBilling }),
    planningEvidence: Object.freeze({
      budget: Object.freeze({ ...target.planningEvidence.budget }),
      reservationPricing: Object.freeze({
        ...target.planningEvidence.reservationPricing,
      }),
    }),
    costJoin: "EXACT_RESOURCE_ARN_OR_SERVICE_LEVEL_UNATTRIBUTED",
    bounds,
    maximumDurationMs: MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumDurationMs,
  });
}

function acceptedIsValid(
  accepted: MediaServicesAcceptedRuntimeAttempt,
  expected: {
    readonly scope: MediaServicesPersistenceScope;
    readonly target: MediaServicesScope;
    readonly requestId: string;
    readonly scheduledWindow: string;
    readonly captureId: string;
    readonly billing: MediaServicesActiveBillingLineage;
    readonly evidenceGenerationId?: string;
    readonly evidenceContentSha256?: string;
    readonly evidenceObjectId?: string;
    readonly reference?: { readonly ciphertext: string; readonly keyVersion: string };
  },
): boolean {
  const stored = accepted.snapshot;
  const billing = stored.snapshot.costEvidence;
  return accepted.requestId === expected.requestId
    && REQUEST_ID.test(accepted.requestId)
    && accepted.scheduledWindow === expected.scheduledWindow
    && sameScope(stored.scope, expected.scope)
    && sameTarget(stored.snapshot.scope, expected.target)
    && SNAPSHOT_GENERATION.test(stored.generationId)
    && SHA256.test(stored.contentSha256)
    && stored.snapshot.captureId === expected.captureId
    && CAPTURE_ID.test(stored.snapshot.captureId)
    && billing.generationId === expected.billing.generationId
    && billing.manifestSha256 === expected.billing.manifestSha256
    && billing.dataThroughAtIso === expected.billing.dataThroughAtIso
    && billing.costBasis === expected.billing.costBasis
    && billing.currency === expected.billing.currency
    && billing.rowsExhausted === expected.billing.rowsExhausted
    && SOURCE_GENERATION.test(accepted.evidence.generationId)
    && EVIDENCE_OBJECT.test(accepted.evidence.objectId)
    && SHA256.test(accepted.evidence.contentSha256)
    && SEALED_REFERENCE.test(accepted.evidence.reference.ciphertext)
    && KEY_VERSION.test(accepted.evidence.reference.keyVersion)
    && (expected.evidenceGenerationId === undefined
      || accepted.evidence.generationId === expected.evidenceGenerationId)
    && (expected.evidenceContentSha256 === undefined
      || accepted.evidence.contentSha256 === expected.evidenceContentSha256)
    && (expected.evidenceObjectId === undefined
      || accepted.evidence.objectId === expected.evidenceObjectId)
    && (expected.reference === undefined
      || (accepted.evidence.reference.ciphertext === expected.reference.ciphertext
        && accepted.evidence.reference.keyVersion === expected.reference.keyVersion));
}

async function fail(
  dependencies: MediaServicesRuntimeDependencies,
  input: Parameters<MediaServicesImmutableEvidenceHandoff["recordFailure"]>[0],
): Promise<never> {
  try { await dependencies.handoff.recordFailure(input); } catch {
    // Persistence diagnostics and provider messages never replace the safe code.
  }
  throw new MediaServicesRuntimeBindingError(input.code);
}

export async function scheduleMediaServicesCollections(input: {
  readonly loadEligibleScopes: () => Promise<readonly MediaServicesPersistenceScope[]>;
  readonly queue: MediaServicesRuntimeQueue;
  readonly scheduledWindow: string;
}): Promise<{ readonly scheduledWindow: string; readonly enqueued: number }> {
  if (!validWindow(input.scheduledWindow)) reject("INVALID_JOB");
  let scopes: readonly MediaServicesPersistenceScope[];
  try { scopes = await input.loadEligibleScopes(); } catch {
    return reject("SCOPE_REJECTED");
  }
  if (scopes.length > MAX_CONNECTIONS) reject("SCOPE_REJECTED");
  const ordered = [...scopes].sort((left, right) =>
    left.connectionId.localeCompare(right.connectionId));
  const seen = new Set<string>();
  for (const scope of ordered) {
    if (!validScope(scope) || seen.has(scope.connectionId)) {
      reject("SCOPE_REJECTED");
    }
    seen.add(scope.connectionId);
    await input.queue.enqueue({
      orgId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: scope.connectionId,
      kind: MEDIA_SERVICES_RUNTIME_JOB_KIND,
      payload: Object.freeze({ scheduledWindow: input.scheduledWindow }),
      maxAttempts: 5,
      idempotencyKey: `media-services:${scope.connectionId}:${input.scheduledWindow}`,
    });
  }
  return { scheduledWindow: input.scheduledWindow, enqueued: ordered.length };
}

export async function runMediaServicesRuntimeHandler(
  job: RunnableJob,
  dependencies: MediaServicesRuntimeDependencies,
): Promise<MediaServicesRuntimeResult> {
  const parsed = parseJob(job);
  if (dependencies.adapter === null) {
    return { status: "unavailable", reason: MEDIA_SERVICES_RUNTIME_ACTIVATION_REASON };
  }
  let trustedScope: MediaServicesPersistenceScope;
  try { trustedScope = await dependencies.loadScope(parsed.scope); } catch {
    return reject("SCOPE_REJECTED");
  }
  if (!validScope(trustedScope) || !sameScope(trustedScope, parsed.scope)) {
    reject("SCOPE_REJECTED");
  }
  let loaded: readonly MediaServicesRuntimeTarget[];
  try { loaded = await dependencies.listTargets(trustedScope); } catch {
    return reject("TARGETS_REJECTED");
  }
  if (loaded.length > MAX_TARGETS) reject("TARGETS_REJECTED");
  const unique = new Set<string>();
  for (const target of loaded) {
    const key = `${target.accountId}\0${target.partition}\0${target.region}`;
    if (!validTarget(target, trustedScope) || unique.has(key)) {
      reject("TARGETS_REJECTED");
    }
    unique.add(key);
  }
  const targets = [...loaded].sort((left, right) =>
    left.accountId.localeCompare(right.accountId)
      || left.partition.localeCompare(right.partition)
      || left.region.localeCompare(right.region));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEDIA_SERVICES_RUNTIME_TIMEOUT_MS);
  let cursor = 0;
  let acceptedHeadCount = 0;
  let incompleteCount = 0;
  let replayedCount = 0;
  const generations: string[] = [];
  const evidenceGenerations: string[] = [];
  try {
    const workers = Array.from({
      length: Math.min(
        MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumConcurrency,
        targets.length,
      ),
    }, async () => {
      while (cursor < targets.length && !controller.signal.aborted) {
        const target = targets[cursor++]!;
        const trustedTarget = mediaScope(target);
        const identity = await requestIdentity({
          scope: trustedTarget,
          scheduledWindow: parsed.scheduledWindow,
          activeBilling: target.activeBilling,
          planningEvidence: target.planningEvidence,
        });
        let prior: MediaServicesAcceptedRuntimeAttempt | null = null;
        try {
          prior = await dependencies.handoff.getAccepted(
            trustedScope, trustedTarget, identity.requestId,
          );
        } catch {
          await fail(dependencies, {
            scope: trustedScope, target: trustedTarget,
            requestId: identity.requestId, scheduledWindow: parsed.scheduledWindow,
            code: "PERSISTENCE_REJECTED",
            completedAtMs: currentTime(dependencies.now),
          });
          return;
        }
        if (prior !== null) {
          if (!acceptedIsValid(prior, {
            scope: trustedScope, target: trustedTarget,
            requestId: identity.requestId, scheduledWindow: parsed.scheduledWindow,
            captureId: identity.expectedCaptureId, billing: target.activeBilling,
          })) {
            await fail(dependencies, {
              scope: trustedScope, target: trustedTarget,
              requestId: identity.requestId, scheduledWindow: parsed.scheduledWindow,
              code: "PERSISTENCE_REJECTED",
              completedAtMs: currentTime(dependencies.now),
            });
            return;
          }
          replayedCount += 1;
          if (!prior.snapshot.snapshot.complete) incompleteCount += 1;
          generations.push(prior.snapshot.generationId);
          evidenceGenerations.push(prior.evidence.generationId);
          continue;
        }
        const request = requestFor(identity, target, parsed.scheduledWindow);
        let capture: MediaServicesCapture | null = null;
        try { capture = await dependencies.adapter!.collect(request, controller.signal); } catch {
          const code: MediaServicesRuntimeFailureCode = controller.signal.aborted
            ? "ADAPTER_TIMEOUT" : "ADAPTER_UNAVAILABLE";
          controller.abort();
          await fail(dependencies, {
            scope: trustedScope, target: trustedTarget,
            requestId: identity.requestId, scheduledWindow: parsed.scheduledWindow,
            code, completedAtMs: currentTime(dependencies.now),
          });
          return;
        }
        if (capture === null) return;
        const normalizedAt = currentTime(dependencies.now);
        let snapshot: MediaServicesSnapshot | null = null;
        try {
          const billing = capture.costEvidence;
          if (capture.captureId !== identity.expectedCaptureId
            || billing.generationId !== target.activeBilling.generationId
            || billing.manifestSha256 !== target.activeBilling.manifestSha256
            || billing.dataThroughAtIso !== target.activeBilling.dataThroughAtIso
            || billing.costBasis !== target.activeBilling.costBasis
            || billing.currency !== target.activeBilling.currency
            || billing.rowsExhausted !== target.activeBilling.rowsExhausted) {
            throw new Error("media-lineage-substitution");
          }
          if (new TextEncoder().encode(canonicalJson(capture)).byteLength
            > MEDIA_SERVICES_RUNTIME_MAX_CAPTURE_BYTES) {
            throw new Error("media-runtime-capture-byte-limit");
          }
          snapshot = normalizeMediaServicesCapture(capture, trustedTarget, normalizedAt);
        } catch {
          controller.abort();
          await fail(dependencies, {
            scope: trustedScope, target: trustedTarget,
            requestId: identity.requestId, scheduledWindow: parsed.scheduledWindow,
            code: "CAPTURE_REJECTED", completedAtMs: normalizedAt,
          });
          return;
        }
        if (snapshot === null) return;
        const body = new TextEncoder().encode(canonicalJson({
          schemaVersion: "sutra.media-services-runtime-evidence.v1",
          request,
          capture,
        }));
        if (body.byteLength > MEDIA_SERVICES_RUNTIME_MAX_EVIDENCE_BYTES) {
          controller.abort();
          await fail(dependencies, {
            scope: trustedScope, target: trustedTarget,
            requestId: identity.requestId, scheduledWindow: parsed.scheduledWindow,
            code: "EVIDENCE_REJECTED", completedAtMs: normalizedAt,
          });
        }
        const contentSha256 = await sha256(body);
        const evidenceGenerationId = `fss_${await sha256(canonicalJson({
          schemaVersion: "sutra.media-services-evidence-identity.v1",
          requestId: identity.requestId,
          contentSha256,
        }))}`;
        let archived: Awaited<ReturnType<MediaServicesEvidenceArchive["archive"]>> | null = null;
        let reference: { readonly ciphertext: string; readonly keyVersion: string } | null = null;
        try {
          archived = await dependencies.evidence.archive({
            scope: {
              orgId: trustedScope.organizationId,
              customerId: trustedScope.customerId,
              connectionId: trustedScope.connectionId,
            },
            runId: identity.requestId,
            snapshotId: evidenceGenerationId,
            artifactKind: "finops_source_snapshot",
            contentType: "application/json",
            body,
            createdBy: MEDIA_SERVICES_EVIDENCE_ACTOR_ID,
            now: normalizedAt,
          });
          if (archived.status !== "available" || !EVIDENCE_OBJECT.test(archived.id)
            || archived.contentSha256 !== contentSha256) {
            throw new Error("media-evidence-archive-rejected");
          }
          reference = await dependencies.sealer.seal(archived.id, {
            organizationId: trustedScope.organizationId,
            customerId: trustedScope.customerId,
            connectionId: trustedScope.connectionId,
            sourceId: MEDIA_SERVICES_EVIDENCE_SOURCE_ID,
            generationId: evidenceGenerationId,
          });
          if (!SEALED_REFERENCE.test(reference.ciphertext)
            || !KEY_VERSION.test(reference.keyVersion)) {
            throw new Error("media-evidence-reference-rejected");
          }
        } catch {
          controller.abort();
          await fail(dependencies, {
            scope: trustedScope, target: trustedTarget,
            requestId: identity.requestId, scheduledWindow: parsed.scheduledWindow,
            code: "EVIDENCE_REJECTED", completedAtMs: normalizedAt,
          });
          return;
        }
        if (archived === null || reference === null) return;
        const expectedEvidence = Object.freeze({
          generationId: evidenceGenerationId,
          objectId: archived.id,
          contentSha256,
          reference: Object.freeze({ ...reference }),
        });
        let committed: Awaited<ReturnType<MediaServicesImmutableEvidenceHandoff["commit"]>> | null = null;
        try {
          committed = await dependencies.handoff.commit({
            scope: trustedScope, target: trustedTarget,
            requestId: identity.requestId, scheduledWindow: parsed.scheduledWindow,
            capture, normalizedSnapshot: snapshot,
            planningEvidence: target.planningEvidence,
            evidence: expectedEvidence, nowMs: normalizedAt,
          });
          if (!acceptedIsValid(committed.accepted, {
            scope: trustedScope, target: trustedTarget,
            requestId: identity.requestId, scheduledWindow: parsed.scheduledWindow,
            captureId: identity.expectedCaptureId, billing: target.activeBilling,
            evidenceGenerationId, evidenceContentSha256: contentSha256,
            evidenceObjectId: archived.id, reference,
          }) || canonicalJson(committed.accepted.snapshot.snapshot)
            !== canonicalJson(snapshot)) {
            throw new Error("media-persistence-result-rejected");
          }
        } catch {
          controller.abort();
          await fail(dependencies, {
            scope: trustedScope, target: trustedTarget,
            requestId: identity.requestId, scheduledWindow: parsed.scheduledWindow,
            code: "PERSISTENCE_REJECTED", completedAtMs: normalizedAt,
          });
          return;
        }
        if (committed === null) return;
        if (committed.becameActive) acceptedHeadCount += 1;
        if (!committed.accepted.snapshot.snapshot.complete) incompleteCount += 1;
        generations.push(committed.accepted.snapshot.generationId);
        evidenceGenerations.push(committed.accepted.evidence.generationId);
      }
    });
    await Promise.all(workers);
  } finally { clearTimeout(timeout); }
  return {
    status: "collected",
    targetCount: targets.length,
    acceptedHeadCount,
    incompleteCount,
    replayedCount,
    governedBudgetTargetCount: targets.filter((target) =>
      target.planningEvidence.budget.state === "PINNED").length,
    governedReservationPricingTargetCount: targets.filter((target) =>
      target.planningEvidence.reservationPricing.state === "PINNED").length,
    generations: generations.sort(),
    evidenceGenerations: evidenceGenerations.sort(),
  };
}

export function createMediaServicesRuntimeJobHandler(
  dependencies: MediaServicesRuntimeDependencies,
): JobHandler {
  return async (job) => {
    const result = await runMediaServicesRuntimeHandler(job, dependencies);
    if (result.status === "unavailable") {
      throw new MediaServicesRuntimeBindingError("ADAPTER_UNAVAILABLE");
    }
  };
}

export const MEDIA_SERVICES_RUNTIME_BINDING = Object.freeze({
  jobKind: MEDIA_SERVICES_RUNTIME_JOB_KIND,
  cadence: MEDIA_SERVICES_RUNTIME_CADENCE,
  handlerFactory: createMediaServicesRuntimeJobHandler,
  registeredInSharedRuntime: false,
  activationReason: MEDIA_SERVICES_RUNTIME_ACTIVATION_REASON,
});

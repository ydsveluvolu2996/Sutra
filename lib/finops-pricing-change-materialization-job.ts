/**
 * ADD-13 server-owned Pricing Change Analysis materialization.
 *
 * The durable payload contains identities only. Policy dates, the active
 * reconciled CUR2 generation, account/Region scope, historical AWS Price List
 * files, evidence storage, and encryption are all resolved by server ports.
 */
import type { JobHandler, RunnableJob } from "./background-job-runner.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  buildPricingChangeAnalysis,
  PRICING_CHANGE_ANALYSIS_BOUNDS,
  PRICING_CHANGE_READ_OPERATIONS,
  type PricingChangeCapture,
  type PricingChangePartition,
  type PricingChangeSnapshot,
  type PricingChangeTenantBoundary,
} from "./finops-pricing-change-analysis.ts";
import type {
  RecordPricingChangeMaterializationInput,
  StoredPricingChangeMaterialization,
} from "../db/finops-pricing-change-repository.ts";

export const FINOPS_PRICING_CHANGE_MATERIALIZE_JOB_KIND =
  "finops-pricing-change-materialize";
export const PRICING_CHANGE_EVIDENCE_SOURCE_ID = "aws_pricing_catalog" as const;
export const PRICING_CHANGE_EVIDENCE_SCHEMA =
  "sutra.pricing-change.capture-evidence.v1" as const;
export const PRICING_CHANGE_MATERIALIZER_ACTIVATION_REASONS = Object.freeze({
  policy: "PRICING_CHANGE_SERVER_POLICY_NOT_CONFIGURED",
  cur2: "ACTIVE_RECONCILED_CUR2_GENERATION_NOT_AVAILABLE",
  provider: "AWS_HISTORICAL_PRICE_LIST_MATERIALIZER_NOT_REGISTERED",
} as const);
export const PRICING_CHANGE_MATERIALIZER_SCHEDULER_CADENCE = "rate(1 day)" as const;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;
const REGION = /^(?:[a-z]{2}(?:-gov)?-[a-z]+-\d|GLOBAL)$/u;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const GENERATION_ID = /^fbg_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const COLLECTION_ID = /^pca_[a-f0-9]{64}$/u;
const EVIDENCE_GENERATION_ID = /^fss_[a-f0-9]{64}$/u;
const EVIDENCE_OBJECT_ID = /^eobj_[a-f0-9]{32}$/u;
const SEALED_REFERENCE = /^fsev1\.[A-Za-z0-9_-]{26,8186}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const POLICY_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const EXPORT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const DAILY_WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const MAX_SCHEDULED_POLICIES = 10_000;

export interface PricingChangeJobScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface PricingChangeServerPolicy {
  readonly policyId: string;
  readonly scope: PricingChangeJobScope;
  readonly exportName: string;
  readonly billingPeriod: string;
  readonly baselineEffectiveAt: string;
  readonly comparisonEffectiveAt: string;
}

export interface PricingChangeActiveCur2Source {
  readonly source: "ACTIVE_RECONCILED_CUR2_GENERATION";
  readonly scope: PricingChangeJobScope;
  readonly partition: PricingChangePartition;
  readonly exportName: string;
  readonly billingPeriod: string;
  readonly generationId: string;
  readonly manifestSha256: string;
  readonly generatedAtIso: string;
  readonly usagePeriodStartAt: string;
  readonly usagePeriodEndAt: string;
  readonly sourceFormat: "aws-cur";
  readonly sourceVersion: "2.0";
  readonly payerAccountIds: readonly string[];
  readonly linkedAccountIds: readonly string[];
  readonly regions: readonly string[];
  readonly coverage: {
    readonly readPermissionsValidated: boolean;
    readonly manifestObjectCount: number;
    readonly processedObjectCount: number;
    readonly acceptedRowCount: number;
    readonly rejectedRowCount: number;
  };
}

export interface PricingChangeMaterializerRequest {
  readonly schemaVersion: "sutra.pricing-change.materializer-request.v1";
  readonly scope: PricingChangeJobScope;
  readonly collectionId: string;
  readonly activeCur2: PricingChangeActiveCur2Source;
  readonly boundary: PricingChangeTenantBoundary;
  readonly baselineEffectiveAt: string;
  readonly comparisonEffectiveAt: string;
  readonly historicalPriceList: {
    readonly source: "AWS_PRICE_LIST_BULK_API_HISTORICAL_FILES";
    readonly operations: typeof PRICING_CHANGE_READ_OPERATIONS;
    readonly fileFormat: "json";
    readonly selectionAxes: "ACTIVE_CUR2_SERVICE_REGION_CURRENCY_ONLY";
    readonly exactApplicabilityRequired: true;
    readonly tierAllocationRequiredForNonFlatRates: true;
  };
  readonly bounds: typeof PRICING_CHANGE_ANALYSIS_BOUNDS;
  readonly deadlineAtIso: string;
}

export interface PricingChangeCaptureMaterializer {
  collect(
    request: PricingChangeMaterializerRequest,
    signal: AbortSignal,
  ): Promise<PricingChangeCapture>;
}

export interface PricingChangeMaterializationStore {
  recordMaterialization(
    scope: PricingChangeJobScope,
    input: RecordPricingChangeMaterializationInput,
    nowMs?: number,
  ): Promise<{
    readonly materialization: StoredPricingChangeMaterialization;
    readonly becameActive: boolean;
  }>;
}

export interface PricingChangeEvidenceArchive {
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
    readonly createdBy: string;
    readonly now: number;
  }): Promise<{
    readonly id: string;
    readonly status: "staging" | "available" | "failed";
    readonly contentSha256: string;
  }>;
}

export interface PricingChangeEvidenceSealer {
  seal(objectId: string, context: {
    readonly organizationId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly sourceId: typeof PRICING_CHANGE_EVIDENCE_SOURCE_ID;
    readonly generationId: string;
  }): Promise<{ readonly ciphertext: string; readonly keyVersion: string }>;
}

export interface PricingChangeMaterializationJobDependencies {
  readonly loadPolicy: (
    scope: PricingChangeJobScope,
    policyId: string,
  ) => Promise<PricingChangeServerPolicy | null>;
  readonly loadActiveCur2: (
    scope: PricingChangeJobScope,
    selection: { readonly exportName: string; readonly billingPeriod: string },
  ) => Promise<PricingChangeActiveCur2Source | null>;
  readonly materializer: PricingChangeCaptureMaterializer | null;
  readonly evidence: PricingChangeEvidenceArchive;
  readonly sealer: PricingChangeEvidenceSealer;
  readonly materializations: PricingChangeMaterializationStore;
  readonly now?: () => number;
}

export interface PricingChangeMaterializationQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: typeof FINOPS_PRICING_CHANGE_MATERIALIZE_JOB_KIND;
    readonly payload: { readonly connectionId: string; readonly policyId: string };
    readonly maxAttempts: 5;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export type PricingChangeMaterializationJobResult =
  | {
      readonly status: "unavailable";
      readonly reason: typeof PRICING_CHANGE_MATERIALIZER_ACTIVATION_REASONS[keyof
        typeof PRICING_CHANGE_MATERIALIZER_ACTIVATION_REASONS];
    }
  | {
      readonly status: "materialized";
      readonly report: PricingChangeSnapshot;
      readonly evidenceGenerationId: string;
      readonly contentSha256: string;
      readonly materialization: StoredPricingChangeMaterialization;
      readonly becameActive: boolean;
    };

export class PricingChangeMaterializationJobError extends Error {
  public readonly code:
    | "INVALID_JOB"
    | "SCOPE_MISMATCH"
    | "POLICY_REJECTED"
    | "CUR2_REJECTED"
    | "CAPTURE_REJECTED"
    | "EVIDENCE_REJECTED"
    | "PERSISTENCE_REJECTED";

  public constructor(code: PricingChangeMaterializationJobError["code"]) {
    super("Pricing Change materialization job rejected");
    this.name = "PricingChangeMaterializationJobError";
    this.code = code;
  }
}

export class PricingChangeMaterializationUnavailableError extends Error {
  public constructor(public readonly reason: Extract<
    PricingChangeMaterializationJobResult,
    { status: "unavailable" }
  >["reason"]) {
    super(reason);
    this.name = "PricingChangeMaterializationUnavailableError";
  }
}

function reject(code: PricingChangeMaterializationJobError["code"]): never {
  throw new PricingChangeMaterializationJobError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactPayload(value: unknown): { readonly connectionId: string; readonly policyId: string } {
  if (!isRecord(value)) reject("INVALID_JOB");
  const keys = Object.keys(value).sort().join("\0");
  if (
    keys !== ["connectionId", "policyId"].sort().join("\0")
    || typeof value.connectionId !== "string"
    || !CONNECTION_ID.test(value.connectionId)
    || typeof value.policyId !== "string"
    || !POLICY_ID.test(value.policyId)
  ) reject("INVALID_JOB");
  return { connectionId: value.connectionId, policyId: value.policyId };
}

function normalizedIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value
    ? value
    : null;
}

function currentTime(dependency: (() => number) | undefined): number {
  const value = dependency?.() ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) reject("INVALID_JOB");
  return value;
}

function sameScope(left: PricingChangeJobScope, right: PricingChangeJobScope): boolean {
  return left.organizationId === right.organizationId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId;
}

function scopeFrom(job: RunnableJob, connectionId: string): PricingChangeJobScope {
  if (
    job.kind !== FINOPS_PRICING_CHANGE_MATERIALIZE_JOB_KIND
    || job.customerId === null
    || job.connectionId !== connectionId
    || !IDENTIFIER.test(job.orgId)
    || !IDENTIFIER.test(job.customerId)
    || !CONNECTION_ID.test(connectionId)
    || !JOB_ID.test(job.id)
    || !Number.isSafeInteger(job.attempt)
    || job.attempt < 1
    || job.attempt > 5
    || job.maxAttempts !== 5
  ) reject("INVALID_JOB");
  return {
    organizationId: job.orgId,
    customerId: job.customerId,
    connectionId,
  };
}

function validDailyWindow(value: string): boolean {
  return DAILY_WINDOW.test(value) && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

export function pricingChangeMaterializationWindow(nowMs = Date.now()): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) reject("INVALID_JOB");
  const date = new Date(nowMs);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    .toISOString();
}

export function pricingChangeMaterializationIdempotencyKey(input: {
  readonly scope: PricingChangeJobScope;
  readonly policyId: string;
  readonly scheduledWindow: string;
}): string {
  if (!IDENTIFIER.test(input.scope.organizationId)
    || !IDENTIFIER.test(input.scope.customerId)
    || !CONNECTION_ID.test(input.scope.connectionId)
    || !POLICY_ID.test(input.policyId)
    || !validDailyWindow(input.scheduledWindow)) reject("INVALID_JOB");
  return `pricing-change:${[
    input.scope.organizationId,
    input.scope.customerId,
    input.scope.connectionId,
    input.policyId,
    input.scheduledWindow,
  ].map(encodeURIComponent).join(":")}`;
}

/** Enqueue each server-owned pricing policy at most once per UTC day. */
export async function schedulePricingChangeMaterializations(input: {
  readonly scheduledWindow: string;
  readonly loadEligiblePolicies: () => Promise<readonly {
    readonly scope: PricingChangeJobScope;
    readonly policyId: string;
  }[]>;
  readonly queue: PricingChangeMaterializationQueue;
}): Promise<number> {
  if (!validDailyWindow(input.scheduledWindow)) reject("INVALID_JOB");
  const policies = [...await input.loadEligiblePolicies()].sort((left, right) =>
    `${left.scope.connectionId}\0${left.policyId}`
      .localeCompare(`${right.scope.connectionId}\0${right.policyId}`));
  if (policies.length > MAX_SCHEDULED_POLICIES) reject("INVALID_JOB");
  const seen = new Set<string>();
  for (const candidate of policies) {
    const key = pricingChangeMaterializationIdempotencyKey({
      ...candidate,
      scheduledWindow: input.scheduledWindow,
    });
    if (seen.has(key)) reject("INVALID_JOB");
    seen.add(key);
  }
  for (const candidate of policies) {
    await input.queue.enqueue({
      orgId: candidate.scope.organizationId,
      customerId: candidate.scope.customerId,
      connectionId: candidate.scope.connectionId,
      kind: FINOPS_PRICING_CHANGE_MATERIALIZE_JOB_KIND,
      payload: Object.freeze({
        connectionId: candidate.scope.connectionId,
        policyId: candidate.policyId,
      }),
      maxAttempts: 5,
      idempotencyKey: pricingChangeMaterializationIdempotencyKey({
        ...candidate,
        scheduledWindow: input.scheduledWindow,
      }),
    });
  }
  return policies.length;
}

function sortedUnique(
  values: readonly string[],
  maximum: number,
  pattern: RegExp,
): readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > maximum) {
    reject("CUR2_REJECTED");
  }
  const result = [...values].sort();
  if (
    result.some((value) => typeof value !== "string" || !pattern.test(value))
    || new Set(result).size !== result.length
    || JSON.stringify(result) !== JSON.stringify(values)
  ) reject("CUR2_REJECTED");
  return result;
}

function validatePolicy(
  value: PricingChangeServerPolicy,
  scope: PricingChangeJobScope,
  policyId: string,
  nowMs: number,
): PricingChangeServerPolicy {
  const baseline = normalizedIso(value.baselineEffectiveAt);
  const comparison = normalizedIso(value.comparisonEffectiveAt);
  if (
    value.policyId !== policyId
    || !sameScope(value.scope, scope)
    || !EXPORT_NAME.test(value.exportName)
    || !PERIOD.test(value.billingPeriod)
    || baseline === null
    || comparison === null
    || Date.parse(comparison) <= Date.parse(baseline)
    || Date.parse(comparison) > nowMs + CLOCK_SKEW_MS
  ) reject("POLICY_REJECTED");
  return { ...value, baselineEffectiveAt: baseline, comparisonEffectiveAt: comparison };
}

function validateCur2(
  value: PricingChangeActiveCur2Source,
  scope: PricingChangeJobScope,
  policy: PricingChangeServerPolicy,
  nowMs: number,
): PricingChangeActiveCur2Source {
  const generatedAtIso = normalizedIso(value.generatedAtIso);
  const usagePeriodStartAt = normalizedIso(value.usagePeriodStartAt);
  const usagePeriodEndAt = normalizedIso(value.usagePeriodEndAt);
  const coverage = value.coverage;
  if (
    value.source !== "ACTIVE_RECONCILED_CUR2_GENERATION"
    || !sameScope(value.scope, scope)
    || !new Set(["aws", "aws-us-gov", "aws-cn"]).has(value.partition)
    || value.exportName !== policy.exportName
    || value.billingPeriod !== policy.billingPeriod
    || !GENERATION_ID.test(value.generationId)
    || !SHA256.test(value.manifestSha256)
    || generatedAtIso === null
    || Date.parse(generatedAtIso) > nowMs + CLOCK_SKEW_MS
    || usagePeriodStartAt === null
    || usagePeriodEndAt === null
    || usagePeriodEndAt <= usagePeriodStartAt
    || usagePeriodStartAt.slice(0, 7) !== policy.billingPeriod
    || value.sourceFormat !== "aws-cur"
    || value.sourceVersion !== "2.0"
    || !isRecord(coverage)
    || coverage.readPermissionsValidated !== true
    || ![
      coverage.manifestObjectCount,
      coverage.processedObjectCount,
      coverage.acceptedRowCount,
      coverage.rejectedRowCount,
    ].every((count) => Number.isSafeInteger(count) && count >= 0)
    || coverage.manifestObjectCount < 1
    || coverage.processedObjectCount !== coverage.manifestObjectCount
    || coverage.rejectedRowCount !== 0
    || coverage.acceptedRowCount > PRICING_CHANGE_ANALYSIS_BOUNDS.maximumUsageRecords
  ) reject("CUR2_REJECTED");
  return {
    ...value,
    generatedAtIso,
    usagePeriodStartAt,
    usagePeriodEndAt,
    payerAccountIds: sortedUnique(
      value.payerAccountIds,
      PRICING_CHANGE_ANALYSIS_BOUNDS.maximumAccounts,
      ACCOUNT_ID,
    ),
    linkedAccountIds: sortedUnique(
      value.linkedAccountIds,
      PRICING_CHANGE_ANALYSIS_BOUNDS.maximumAccounts,
      ACCOUNT_ID,
    ),
    regions: sortedUnique(
      value.regions,
      PRICING_CHANGE_ANALYSIS_BOUNDS.maximumRegions,
      REGION,
    ),
  };
}

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function collectionId(
  scope: PricingChangeJobScope,
  policy: PricingChangeServerPolicy,
  cur2: PricingChangeActiveCur2Source,
): Promise<string> {
  return `pca_${await sha256(canonicalJson({
    schemaVersion: "sutra.pricing-change.materialization-identity.v1",
    scope,
    policyId: policy.policyId,
    baselineEffectiveAt: policy.baselineEffectiveAt,
    comparisonEffectiveAt: policy.comparisonEffectiveAt,
    activeCur2GenerationId: cur2.generationId,
    activeCur2ManifestSha256: cur2.manifestSha256,
  }))}`;
}

function boundaryFor(
  scope: PricingChangeJobScope,
  cur2: PricingChangeActiveCur2Source,
): PricingChangeTenantBoundary {
  return {
    scope: {
      orgId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: scope.connectionId,
    },
    partition: cur2.partition,
    payerAccountIds: cur2.payerAccountIds,
    linkedAccountIds: cur2.linkedAccountIds,
    regions: cur2.regions,
  };
}

function assertCaptureBinding(
  capture: PricingChangeCapture,
  request: PricingChangeMaterializerRequest,
): void {
  if (
    capture.collectionId !== request.collectionId
    || capture.scope.orgId !== request.scope.organizationId
    || capture.scope.customerId !== request.scope.customerId
    || capture.scope.connectionId !== request.scope.connectionId
    || capture.partition !== request.activeCur2.partition
    || capture.activeCur2GenerationId !== request.activeCur2.generationId
    || capture.activeCur2GeneratedAt !== request.activeCur2.generatedAtIso
    || capture.activeCur2ManifestSha256 !== request.activeCur2.manifestSha256
    || capture.usagePeriodStartAt !== request.activeCur2.usagePeriodStartAt
    || capture.usagePeriodEndAt !== request.activeCur2.usagePeriodEndAt
    || capture.baselineEffectiveAt !== request.baselineEffectiveAt
    || capture.comparisonEffectiveAt !== request.comparisonEffectiveAt
    || JSON.stringify(capture.payerAccountIds) !== JSON.stringify(request.boundary.payerAccountIds)
    || JSON.stringify(capture.linkedAccountIds) !== JSON.stringify(request.boundary.linkedAccountIds)
    || JSON.stringify(capture.regions) !== JSON.stringify(request.boundary.regions)
    || capture.cur2Coverage.readPermissionsValidated !== true
    || capture.cur2Coverage.manifestObjectCount
      !== request.activeCur2.coverage.manifestObjectCount
    || capture.cur2Coverage.processedObjectCount
      !== request.activeCur2.coverage.processedObjectCount
  ) reject("CAPTURE_REJECTED");
}

export async function runPricingChangeMaterializationJob(
  job: RunnableJob,
  dependencies: PricingChangeMaterializationJobDependencies,
): Promise<PricingChangeMaterializationJobResult> {
  const payload = exactPayload(job.payload);
  const scope = scopeFrom(job, payload.connectionId);
  const nowMs = currentTime(dependencies.now);
  const loadedPolicy = await dependencies.loadPolicy(scope, payload.policyId);
  if (loadedPolicy === null) {
    return {
      status: "unavailable",
      reason: PRICING_CHANGE_MATERIALIZER_ACTIVATION_REASONS.policy,
    };
  }
  const policy = validatePolicy(loadedPolicy, scope, payload.policyId, nowMs);
  const loadedCur2 = await dependencies.loadActiveCur2(scope, {
    exportName: policy.exportName,
    billingPeriod: policy.billingPeriod,
  });
  if (loadedCur2 === null) {
    return {
      status: "unavailable",
      reason: PRICING_CHANGE_MATERIALIZER_ACTIVATION_REASONS.cur2,
    };
  }
  const cur2 = validateCur2(loadedCur2, scope, policy, nowMs);
  if (dependencies.materializer === null) {
    return {
      status: "unavailable",
      reason: PRICING_CHANGE_MATERIALIZER_ACTIVATION_REASONS.provider,
    };
  }
  const expectedCollectionId = await collectionId(scope, policy, cur2);
  if (!COLLECTION_ID.test(expectedCollectionId)) reject("CAPTURE_REJECTED");
  const boundary = boundaryFor(scope, cur2);
  const request: PricingChangeMaterializerRequest = Object.freeze({
    schemaVersion: "sutra.pricing-change.materializer-request.v1",
    scope: Object.freeze({ ...scope }),
    collectionId: expectedCollectionId,
    activeCur2: Object.freeze({
      ...cur2,
      scope: Object.freeze({ ...cur2.scope }),
      payerAccountIds: Object.freeze([...cur2.payerAccountIds]),
      linkedAccountIds: Object.freeze([...cur2.linkedAccountIds]),
      regions: Object.freeze([...cur2.regions]),
      coverage: Object.freeze({ ...cur2.coverage }),
    }),
    boundary: Object.freeze({
      ...boundary,
      scope: Object.freeze({ ...boundary.scope }),
      payerAccountIds: Object.freeze([...boundary.payerAccountIds]),
      linkedAccountIds: Object.freeze([...boundary.linkedAccountIds]),
      regions: Object.freeze([...boundary.regions]),
    }),
    baselineEffectiveAt: policy.baselineEffectiveAt,
    comparisonEffectiveAt: policy.comparisonEffectiveAt,
    historicalPriceList: Object.freeze({
      source: "AWS_PRICE_LIST_BULK_API_HISTORICAL_FILES",
      operations: PRICING_CHANGE_READ_OPERATIONS,
      fileFormat: "json",
      selectionAxes: "ACTIVE_CUR2_SERVICE_REGION_CURRENCY_ONLY",
      exactApplicabilityRequired: true,
      tierAllocationRequiredForNonFlatRates: true,
    }),
    bounds: PRICING_CHANGE_ANALYSIS_BOUNDS,
    deadlineAtIso: new Date(
      nowMs + PRICING_CHANGE_ANALYSIS_BOUNDS.maximumDurationMs,
    ).toISOString(),
  });
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("pricing-change-materialization-timeout")),
    PRICING_CHANGE_ANALYSIS_BOUNDS.maximumDurationMs,
  );
  timer.unref?.();
  let capture: PricingChangeCapture;
  try {
    capture = await dependencies.materializer.collect(request, controller.signal);
  } catch {
    return reject("CAPTURE_REJECTED");
  } finally {
    clearTimeout(timer);
  }
  assertCaptureBinding(capture, request);
  let report: PricingChangeSnapshot;
  try {
    report = buildPricingChangeAnalysis(boundary, capture, new Date(nowMs));
  } catch {
    return reject("CAPTURE_REJECTED");
  }
  if (report.collectionId !== expectedCollectionId) reject("CAPTURE_REJECTED");
  const evidencePayload = {
    schemaVersion: PRICING_CHANGE_EVIDENCE_SCHEMA,
    boundary,
    capture,
  };
  const body = new TextEncoder().encode(canonicalJson(evidencePayload));
  if (body.byteLength > PRICING_CHANGE_ANALYSIS_BOUNDS.maximumCaptureBytes) {
    reject("EVIDENCE_REJECTED");
  }
  const contentSha256 = await sha256(body);
  const evidenceRunId = `pcjob_${await sha256(canonicalJson({
    schemaVersion: "sutra.pricing-change.evidence-run.v1",
    scope,
    jobId: job.id,
    attempt: job.attempt,
  }))}`;
  const evidenceGenerationId = `fss_${await sha256(canonicalJson({
    schemaVersion: PRICING_CHANGE_EVIDENCE_SCHEMA,
    scope,
    collectionId: report.collectionId,
    contentSha256,
  }))}`;
  if (!EVIDENCE_GENERATION_ID.test(evidenceGenerationId)) {
    reject("EVIDENCE_REJECTED");
  }
  let archived: Awaited<ReturnType<PricingChangeEvidenceArchive["archive"]>>;
  try {
    archived = await dependencies.evidence.archive({
      scope: {
        orgId: scope.organizationId,
        customerId: scope.customerId,
        connectionId: scope.connectionId,
      },
      runId: evidenceRunId,
      snapshotId: evidenceGenerationId,
      artifactKind: "finops_source_snapshot",
      contentType: "application/json",
      body,
      createdBy: "system_finops_pricing_change_materializer",
      now: Date.parse(capture.completedAt),
    });
  } catch {
    return reject("EVIDENCE_REJECTED");
  }
  if (
    archived.status !== "available"
    || archived.contentSha256 !== contentSha256
    || !EVIDENCE_OBJECT_ID.test(archived.id)
  ) reject("EVIDENCE_REJECTED");
  let evidenceReference: Awaited<ReturnType<PricingChangeEvidenceSealer["seal"]>>;
  try {
    evidenceReference = await dependencies.sealer.seal(archived.id, {
      organizationId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: scope.connectionId,
      sourceId: PRICING_CHANGE_EVIDENCE_SOURCE_ID,
      generationId: evidenceGenerationId,
    });
  } catch {
    return reject("EVIDENCE_REJECTED");
  }
  if (
    !SEALED_REFERENCE.test(evidenceReference.ciphertext)
    || !KEY_VERSION.test(evidenceReference.keyVersion)
  ) reject("EVIDENCE_REJECTED");
  let persisted: Awaited<ReturnType<
    PricingChangeMaterializationStore["recordMaterialization"]
  >>;
  try {
    persisted = await dependencies.materializations.recordMaterialization(
      scope,
      { snapshot: report, evidenceGenerationId, contentSha256, evidenceReference },
      Date.parse(capture.completedAt),
    );
  } catch {
    return reject("PERSISTENCE_REJECTED");
  }
  if (
    persisted.materialization.snapshotId !== report.collectionId
    || persisted.materialization.evidenceGenerationId !== evidenceGenerationId
    || persisted.materialization.contentSha256 !== contentSha256
    || persisted.materialization.activeCur2GenerationId !== cur2.generationId
  ) reject("PERSISTENCE_REJECTED");
  return {
    status: "materialized",
    report,
    evidenceGenerationId,
    contentSha256,
    materialization: persisted.materialization,
    becameActive: persisted.becameActive,
  };
}

/** Shared-runner adapter. Unavailable activation is a failed job, never success. */
export function createPricingChangeMaterializationJobHandler(
  dependencies: PricingChangeMaterializationJobDependencies,
): JobHandler {
  return async (job) => {
    const result = await runPricingChangeMaterializationJob(job, dependencies);
    if (result.status === "unavailable") {
      throw new PricingChangeMaterializationUnavailableError(result.reason);
    }
  };
}

export const PRICING_CHANGE_MATERIALIZATION_RUNTIME_BINDING = Object.freeze({
  jobKind: FINOPS_PRICING_CHANGE_MATERIALIZE_JOB_KIND,
  cadence: PRICING_CHANGE_MATERIALIZER_SCHEDULER_CADENCE,
  handlerFactory: createPricingChangeMaterializationJobHandler,
  registeredInSharedRuntime: false,
  activationReason: PRICING_CHANGE_MATERIALIZER_ACTIVATION_REASONS.provider,
});

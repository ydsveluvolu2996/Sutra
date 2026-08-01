/** Server-owned daily Media Services inventory plus active-CUR2 materialization contract. */
import type {
  MediaServicesPersistenceScope,
  StoredMediaServicesSnapshot,
} from "../db/finops-media-services-repository.ts";
import {
  MEDIA_SERVICES_INSIGHTS_BOUNDS,
  MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS,
  type MediaServicesCapture,
  type MediaServicesScope,
} from "./finops-media-services-insights.ts";

export const MEDIA_SERVICES_INSIGHTS_JOB_KIND = "finops-media-services-insights-daily-collect";
export const MEDIA_SERVICES_INSIGHTS_SCHEDULE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;

export interface MediaServicesCollectionJob {
  readonly id: string;
  readonly orgId: string;
  readonly customerId: string | null;
  readonly connectionId: string | null;
  readonly payload: unknown;
}
export interface MediaServicesCollectorTarget extends MediaServicesScope {
  readonly lastAcceptedCompletedAtIso: string | null;
  readonly activeBillingGenerationId: string;
}
export interface MediaServicesAwsAdapter {
  collect(request: {
    readonly schemaVersion: "sutra.media-services-insights-collector-request.v1";
    readonly scope: MediaServicesScope;
    readonly incrementalAfterIso: string | null;
    readonly requiredBillingGenerationId: string;
    readonly requiredBillingSource: "AWS_CUR2_ACTIVE_GENERATION";
    readonly operations: typeof MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS;
    readonly bounds: typeof MEDIA_SERVICES_INSIGHTS_BOUNDS;
  }, signal: AbortSignal): Promise<MediaServicesCapture>;
}
export interface MediaServicesJobDependencies {
  readonly listTargets: (scope: MediaServicesPersistenceScope) => Promise<readonly MediaServicesCollectorTarget[]>;
  readonly adapter: MediaServicesAwsAdapter;
  readonly recordCapture: (scope: MediaServicesPersistenceScope, trustedScope: MediaServicesScope,
    capture: MediaServicesCapture, nowMs: number) => Promise<{ readonly snapshot: StoredMediaServicesSnapshot; readonly becameActive: boolean }>;
  readonly now?: () => number;
}
export interface MediaServicesJobResult {
  readonly targetCount: number;
  readonly acceptedHeadCount: number;
  readonly incompleteCount: number;
  readonly generations: readonly string[];
}

function invalid(): never { throw new Error("finops-media-services-job-invalid"); }
export function mediaServicesCollectionWindow(nowMs = Date.now()): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) invalid();
  return new Date(Math.floor(nowMs / MEDIA_SERVICES_INSIGHTS_SCHEDULE_INTERVAL_MS)
    * MEDIA_SERVICES_INSIGHTS_SCHEDULE_INTERVAL_MS).toISOString();
}
export function mediaServicesJobIdempotencyKey(scope: MediaServicesPersistenceScope, window: string): string {
  if (!WINDOW.test(window)) invalid();
  return `media-services:${scope.organizationId}:${scope.customerId}:${scope.connectionId}:${window}`;
}
export async function runMediaServicesCollectionJob(job: MediaServicesCollectionJob,
  dependencies: MediaServicesJobDependencies): Promise<MediaServicesJobResult> {
  if (job.customerId === null || job.connectionId === null || typeof job.payload !== "object"
    || job.payload === null || Array.isArray(job.payload)) invalid();
  const payload = job.payload as Record<string, unknown>;
  if (Object.keys(payload).length !== 1 || Object.keys(payload)[0] !== "scheduledWindow"
    || typeof payload.scheduledWindow !== "string" || !WINDOW.test(payload.scheduledWindow)) invalid();
  const scope = { organizationId: job.orgId, customerId: job.customerId, connectionId: job.connectionId };
  const targets = await dependencies.listTargets(scope);
  if (targets.length > 5_000) invalid();
  const unique = new Set<string>();
  for (const target of targets) {
    if (target.orgId !== scope.organizationId || target.customerId !== scope.customerId
      || target.connectionId !== scope.connectionId || !/^fbg_[a-f0-9]{64}$/u.test(target.activeBillingGenerationId)) invalid();
    const key = `${target.accountId}:${target.partition}:${target.region}`;
    if (unique.has(key)) invalid(); unique.add(key);
  }
  const now = dependencies.now ?? Date.now; const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumDurationMs);
  const generations: string[] = []; let acceptedHeadCount = 0; let incompleteCount = 0; let cursor = 0;
  try {
    const workers = Array.from({ length: Math.min(MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumConcurrency, targets.length) }, async () => {
      while (cursor < targets.length) {
        const target = targets[cursor++]!;
        const capture = await dependencies.adapter.collect({
          schemaVersion: "sutra.media-services-insights-collector-request.v1", scope: target,
          incrementalAfterIso: target.lastAcceptedCompletedAtIso,
          requiredBillingGenerationId: target.activeBillingGenerationId,
          requiredBillingSource: "AWS_CUR2_ACTIVE_GENERATION",
          operations: MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS, bounds: MEDIA_SERVICES_INSIGHTS_BOUNDS,
        }, controller.signal);
        if (capture.costEvidence.generationId !== target.activeBillingGenerationId) invalid();
        const recorded = await dependencies.recordCapture(scope,target,capture,now());
        generations.push(recorded.snapshot.generationId);
        if (recorded.becameActive) acceptedHeadCount += 1;
        if (!recorded.snapshot.snapshot.complete) incompleteCount += 1;
      }
    });
    await Promise.all(workers);
  } finally { clearTimeout(timeout); }
  return { targetCount: targets.length, acceptedHeadCount, incompleteCount, generations: generations.sort() };
}

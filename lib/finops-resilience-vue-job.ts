/** Server-owned daily incremental AWS Resilience Hub collection contract. */
import {
  RESILIENCE_VUE_COLLECTION_BOUNDS,
  RESILIENCE_VUE_READ_OPERATIONS,
  type ResilienceVueCapture,
  type ResilienceVueScope,
} from "./finops-resilience-vue.ts";
import type {
  ResilienceVuePersistenceScope,
  StoredResilienceVueSnapshot,
} from "../db/finops-resilience-vue-repository.ts";

export const RESILIENCE_VUE_JOB_KIND = "finops-resilience-vue-daily-collect";
export const RESILIENCE_VUE_SCHEDULE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;

export interface ResilienceVueCollectionJob {
  readonly id: string;
  readonly orgId: string;
  readonly customerId: string | null;
  readonly connectionId: string | null;
  readonly payload: unknown;
}
export interface ResilienceVueCollectorTarget extends ResilienceVueScope {
  /** Server-owned cursor; adapters may use it to avoid refetching unchanged assessment history. */
  readonly lastAcceptedCompletedAtIso: string | null;
}
export interface ResilienceVueAwsAdapter {
  collect(request: {
    readonly schemaVersion: "sutra.resilience-vue-collector-request.v1";
    readonly scope: ResilienceVueScope;
    readonly incrementalAfterIso: string | null;
    readonly operations: typeof RESILIENCE_VUE_READ_OPERATIONS;
    readonly bounds: typeof RESILIENCE_VUE_COLLECTION_BOUNDS;
  }, signal: AbortSignal): Promise<ResilienceVueCapture>;
}
export interface ResilienceVueJobDependencies {
  readonly listTargets: (scope: ResilienceVuePersistenceScope) => Promise<readonly ResilienceVueCollectorTarget[]>;
  readonly adapter: ResilienceVueAwsAdapter;
  readonly recordCapture: (scope: ResilienceVuePersistenceScope, trustedScope: ResilienceVueScope,
    capture: ResilienceVueCapture, nowMs: number) => Promise<{ readonly snapshot: StoredResilienceVueSnapshot; readonly becameActive: boolean }>;
  readonly now?: () => number;
}
export interface ResilienceVueJobResult {
  readonly targetCount: number;
  readonly acceptedHeadCount: number;
  readonly incompleteCount: number;
  readonly generations: readonly string[];
}

function invalid(): never { throw new Error("finops-resilience-vue-job-invalid"); }
export function resilienceVueCollectionWindow(nowMs = Date.now()): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) invalid();
  return new Date(Math.floor(nowMs / RESILIENCE_VUE_SCHEDULE_INTERVAL_MS) * RESILIENCE_VUE_SCHEDULE_INTERVAL_MS).toISOString();
}
export function resilienceVueJobIdempotencyKey(scope: ResilienceVuePersistenceScope, window: string): string {
  if (!WINDOW.test(window)) invalid();
  return `resilience-vue:${scope.organizationId}:${scope.customerId}:${scope.connectionId}:${window}`;
}
export async function runResilienceVueCollectionJob(job: ResilienceVueCollectionJob,
  dependencies: ResilienceVueJobDependencies): Promise<ResilienceVueJobResult> {
  if (job.customerId === null || job.connectionId === null || typeof job.payload !== "object"
    || job.payload === null || Array.isArray(job.payload)) invalid();
  const payload = job.payload as Record<string, unknown>; const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== "scheduledWindow" || typeof payload.scheduledWindow !== "string"
    || !WINDOW.test(payload.scheduledWindow)) invalid();
  const scope = { organizationId: job.orgId, customerId: job.customerId, connectionId: job.connectionId };
  const targets = await dependencies.listTargets(scope);
  if (targets.length > 5_000) invalid();
  const unique = new Set<string>();
  for (const target of targets) {
    if (target.orgId !== scope.organizationId || target.customerId !== scope.customerId
      || target.connectionId !== scope.connectionId) invalid();
    const key = `${target.accountId}:${target.partition}:${target.region}`;
    if (unique.has(key)) invalid(); unique.add(key);
  }
  const now = dependencies.now ?? Date.now; const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESILIENCE_VUE_COLLECTION_BOUNDS.maximumDurationMs);
  const generations: string[] = []; let acceptedHeadCount = 0; let incompleteCount = 0; let cursor = 0;
  try {
    const workers = Array.from({ length: Math.min(RESILIENCE_VUE_COLLECTION_BOUNDS.maximumConcurrency, targets.length) }, async () => {
      while (cursor < targets.length) {
        const target = targets[cursor++]!;
        const capture = await dependencies.adapter.collect({
          schemaVersion: "sutra.resilience-vue-collector-request.v1", scope: target,
          incrementalAfterIso: target.lastAcceptedCompletedAtIso,
          operations: RESILIENCE_VUE_READ_OPERATIONS, bounds: RESILIENCE_VUE_COLLECTION_BOUNDS,
        }, controller.signal);
        const recorded = await dependencies.recordCapture(scope, target, capture, now());
        generations.push(recorded.snapshot.generationId);
        if (recorded.becameActive) acceptedHeadCount += 1;
        if (!recorded.snapshot.snapshot.complete) incompleteCount += 1;
      }
    });
    await Promise.all(workers);
  } finally { clearTimeout(timeout); }
  return { targetCount: targets.length, acceptedHeadCount, incompleteCount, generations: generations.sort() };
}

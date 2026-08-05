/** Production dependency composition for the complete ADV-10 local vertical. */
import type { RunnableJob } from "./background-job-runner.ts";
import { EvidenceRepository } from "../db/evidence-repository.ts";
import { JobQueueRepository } from "../db/job-queue-repository.ts";
import { ResilienceVueRuntimeRepository } from "../db/finops-resilience-vue-runtime-repository.ts";
import { FinopsEvidenceReferenceSealer } from "./finops-source-evidence-reference.ts";
import { createResilienceVueSignedBroker, type ResilienceVueSignedBrokerConfiguration } from
  "./finops-resilience-vue-signed-broker.ts";
import { runResilienceVueRuntimeHandler, scheduleResilienceVueCollections,
  type ResilienceVueRuntimeAwsAdapter } from "./finops-resilience-vue-runtime-binding.ts";

export const RESILIENCE_VUE_PRODUCTION_COMPOSITION_SCHEMA = "sutra.resilience-vue-production-composition.v1" as const;
export const RESILIENCE_VUE_SCHEDULE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const RESILIENCE_VUE_PRODUCTION_COMPOSITION_STATUS = Object.freeze({
  schemaVersion: RESILIENCE_VUE_PRODUCTION_COMPOSITION_SCHEMA,
  credentialOwningProviderRouteImplemented: true, signedBrokerClientImplemented: true,
  durableReplayRepositoryImplemented: true, immutableSnapshotRepositoryImplemented: true,
  explicitRuntimeStatesImplemented: true, deterministicDailyTickImplemented: true,
  sharedWorkerRegistered: true, activationState: "REGISTERED_LOCAL_RUNTIME" as const,
});

export function resilienceVueScheduledWindow(atMs: number): string {
  if (!Number.isSafeInteger(atMs) || atMs < 0) throw new Error("RESILIENCE_VUE_SCHEDULE_INVALID");
  return new Date(Math.floor(atMs / RESILIENCE_VUE_SCHEDULE_INTERVAL_MS) * RESILIENCE_VUE_SCHEDULE_INTERVAL_MS).toISOString();
}

export interface ResilienceVueProductionCompositionOptions {
  readonly database?: D1Database;
  readonly now?: () => number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly brokerConfiguration?: ResilienceVueSignedBrokerConfiguration;
  readonly fetcher?: typeof fetch;
  readonly adapter?: ResilienceVueRuntimeAwsAdapter;
}
export async function createResilienceVueProductionComposition(options: ResilienceVueProductionCompositionOptions) {
  if ((options.adapter === undefined) === (options.brokerConfiguration === undefined)) {
    throw new Error("RESILIENCE_VUE_EXACTLY_ONE_ADAPTER_REQUIRED");
  }
  if (options.fetcher !== undefined && options.brokerConfiguration === undefined) {
    throw new Error("RESILIENCE_VUE_FETCHER_REQUIRES_SIGNED_BROKER_CONFIGURATION");
  }
  const now = options.now ?? Date.now;
  const runtime = new ResilienceVueRuntimeRepository(options.database, { now });
  const evidence = new EvidenceRepository(options.database);
  const sealer = await FinopsEvidenceReferenceSealer.fromEnvironment(options.env);
  const adapter = options.adapter ?? createResilienceVueSignedBroker({ configuration: options.brokerConfiguration!,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }), now });
  const queue = new JobQueueRepository(options.database);
  return Object.freeze({ schemaVersion: RESILIENCE_VUE_PRODUCTION_COMPOSITION_SCHEMA,
    runtimeRepository: runtime,
    handler: async (job: RunnableJob): Promise<void> => {
      // Lease ownership is invocation-local. A duplicate worker cannot observe
      // or mutate another invocation's in-memory lease token.
      const attemptRuntime = new ResilienceVueRuntimeRepository(options.database, { now });
      await runResilienceVueRuntimeHandler(job, {
        loadScope: attemptRuntime.loadScope.bind(attemptRuntime),
        listTargets: attemptRuntime.listTargets.bind(attemptRuntime),
        adapter, evidence, sealer, handoff: attemptRuntime, now,
      });
    },
    scheduleTick: (scheduledAtMs: number) => scheduleResilienceVueCollections({
      loadEligibleScopes: runtime.listEligibleScopes.bind(runtime), queue,
      scheduledWindow: resilienceVueScheduledWindow(scheduledAtMs),
    }),
  });
}

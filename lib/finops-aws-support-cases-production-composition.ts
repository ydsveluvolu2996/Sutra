/** Production dependency composition for the complete ADV-09 local runtime. */
import type { RunnableJob } from "./background-job-runner.ts";
import { AwsSupportCasesRuntimeRepository } from "../db/finops-aws-support-cases-runtime-repository.ts";
import { AwsSupportCasesRepository } from "../db/finops-aws-support-cases-repository.ts";
import { JobQueueRepository } from "../db/job-queue-repository.ts";
import {
  AWS_SUPPORT_CASES_RUNTIME_BINDING,
  createAwsSupportCasesRuntimeJobHandler,
  scheduleAwsSupportCasesCollections,
} from "./finops-aws-support-cases-runtime-binding.ts";
import {
  createAwsSupportCasesSignedBroker,
  type AwsSupportCasesSignedBrokerConfiguration,
} from "./finops-aws-support-cases-signed-broker.ts";
import type { AwsSupportCasesTransport } from "./finops-aws-support-cases-radar.ts";

export const AWS_SUPPORT_CASES_PRODUCTION_COMPOSITION_SCHEMA =
  "sutra.aws-support-cases-production-composition.v1" as const;
export const AWS_SUPPORT_CASES_SCHEDULE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export const AWS_SUPPORT_CASES_PRODUCTION_COMPOSITION_STATUS = Object.freeze({
  schemaVersion: AWS_SUPPORT_CASES_PRODUCTION_COMPOSITION_SCHEMA,
  credentialOwningProviderAdapterImplemented: true,
  signedBrokerClientImplemented: true,
  trustedScopeAndTargetCatalogImplemented: true,
  completeHeadWatermarkImplemented: true,
  immutableSnapshotRepositoryImplemented: true,
  deterministicDailyTickImplemented: true,
  privacyMinimizationImplemented: true,
  sharedWorkerRegistered: AWS_SUPPORT_CASES_RUNTIME_BINDING.registeredInSharedRuntime,
  activationState: AWS_SUPPORT_CASES_RUNTIME_BINDING.registeredInSharedRuntime
    ? "REGISTERED_LOCAL_RUNTIME" as const
    : "AWAITING_SHARED_REGISTRY_HOOK" as const,
});

export interface AwsSupportCasesProductionCompositionOptions {
  readonly database?: D1Database;
  readonly now?: () => number;
  readonly brokerConfiguration?: AwsSupportCasesSignedBrokerConfiguration;
  readonly fetcher?: typeof fetch;
  /** Focused test seam; production must use brokerConfiguration. */
  readonly transport?: AwsSupportCasesTransport;
}

export interface AwsSupportCasesProductionComposition {
  readonly schemaVersion: typeof AWS_SUPPORT_CASES_PRODUCTION_COMPOSITION_SCHEMA;
  readonly handler: (job: RunnableJob) => Promise<void>;
  readonly scheduleTick: (scheduledAtMs: number) => Promise<{
    readonly scheduledWindow: string;
    readonly enqueued: number;
  }>;
  readonly runtimeRepository: AwsSupportCasesRuntimeRepository;
  readonly snapshotRepository: AwsSupportCasesRepository;
}

export function awsSupportCasesScheduledWindow(scheduledAtMs: number): string {
  if (!Number.isSafeInteger(scheduledAtMs) || scheduledAtMs < 0) {
    throw new Error("AWS_SUPPORT_CASES_SCHEDULE_INVALID");
  }
  return new Date(
    Math.floor(scheduledAtMs / AWS_SUPPORT_CASES_SCHEDULE_INTERVAL_MS)
      * AWS_SUPPORT_CASES_SCHEDULE_INTERVAL_MS,
  ).toISOString();
}

export function createAwsSupportCasesProductionComposition(
  options: AwsSupportCasesProductionCompositionOptions,
): AwsSupportCasesProductionComposition {
  if ((options.transport === undefined) === (options.brokerConfiguration === undefined)) {
    throw new Error("AWS_SUPPORT_CASES_EXACTLY_ONE_TRANSPORT_REQUIRED");
  }
  if (options.fetcher !== undefined && options.brokerConfiguration === undefined) {
    throw new Error("AWS_SUPPORT_CASES_FETCHER_REQUIRES_SIGNED_BROKER_CONFIGURATION");
  }
  const nowMs = options.now ?? Date.now;
  const runtimeRepository = new AwsSupportCasesRuntimeRepository(options.database);
  const snapshotRepository = new AwsSupportCasesRepository(options.database);
  const queue = new JobQueueRepository(options.database);
  const transport = options.transport ?? createAwsSupportCasesSignedBroker({
    configuration: options.brokerConfiguration!,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    now: nowMs,
  });
  return Object.freeze({
    schemaVersion: AWS_SUPPORT_CASES_PRODUCTION_COMPOSITION_SCHEMA,
    handler: createAwsSupportCasesRuntimeJobHandler({
      loadScope: runtimeRepository.loadScope.bind(runtimeRepository),
      targets: runtimeRepository,
      transport,
      snapshots: runtimeRepository,
      now: () => new Date(nowMs()),
    }),
    scheduleTick: async (scheduledAtMs: number) => {
      const scheduledWindow = awsSupportCasesScheduledWindow(scheduledAtMs);
      const result = await scheduleAwsSupportCasesCollections({
        loadEligibleScopes: () => runtimeRepository.listEligibleScopes(scheduledWindow),
        resolveWindow: (scope) => runtimeRepository.resolveWindow(scope, scheduledWindow),
        queue,
      });
      return Object.freeze({ scheduledWindow, enqueued: result.enqueued });
    },
    runtimeRepository,
    snapshotRepository,
  });
}

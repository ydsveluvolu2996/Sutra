/** Production dependency composition for ADV-04 Extended Support. */
import type { RunnableJob } from "./background-job-runner.ts";
import { ExtendedSupportRepository } from "../db/finops-extended-support-repository.ts";
import { ExtendedSupportRuntimeRepository } from
  "../db/finops-extended-support-runtime-repository.ts";
import { JobQueueRepository } from "../db/job-queue-repository.ts";
import {
  EXTENDED_SUPPORT_RUNTIME_BINDING,
  createExtendedSupportRuntimeJobHandler,
  extendedSupportCollectionWindow,
  scheduleExtendedSupportCollections,
} from "./finops-extended-support-runtime-binding.ts";
import {
  createExtendedSupportSignedBroker,
  type ExtendedSupportSignedBrokerConfiguration,
} from "./finops-extended-support-signed-broker.ts";
import type { ExtendedSupportSignedBroker } from "./finops-extended-support-collector-job.ts";

export const EXTENDED_SUPPORT_PRODUCTION_COMPOSITION_SCHEMA =
  "sutra.extended-support-production-composition.v1" as const;

export const EXTENDED_SUPPORT_PRODUCTION_COMPOSITION_STATUS = Object.freeze({
  schemaVersion: EXTENDED_SUPPORT_PRODUCTION_COMPOSITION_SCHEMA,
  serverOwnedBoundaryLoaderImplemented: true,
  deterministicDailySchedulerImplemented: true,
  durableReplayRepositoryImplemented: true,
  signedBrokerClientImplemented: true,
  immutableReadyOnlySnapshotRepositoryImplemented: true,
  sharedWorkerRegistered: EXTENDED_SUPPORT_RUNTIME_BINDING.registeredInSharedRuntime,
  activationState: EXTENDED_SUPPORT_RUNTIME_BINDING.registeredInSharedRuntime
    ? "REGISTERED_LOCAL_RUNTIME" as const
    : "AWAITING_SHARED_REGISTRY_HOOK" as const,
});

export interface ExtendedSupportProductionCompositionOptions {
  readonly database?: D1Database;
  readonly now?: () => number;
  readonly brokerConfiguration?: ExtendedSupportSignedBrokerConfiguration;
  readonly fetcher?: typeof fetch;
  /** Focused test seam. Production must supply signed broker configuration. */
  readonly broker?: ExtendedSupportSignedBroker;
}

export interface ExtendedSupportProductionComposition {
  readonly schemaVersion: typeof EXTENDED_SUPPORT_PRODUCTION_COMPOSITION_SCHEMA;
  readonly handler: (job: RunnableJob) => Promise<void>;
  readonly scheduleTick: (scheduledAtMs: number) => Promise<{
    readonly scheduledWindow: string;
    readonly enqueued: number;
  }>;
  readonly runtimeRepository: ExtendedSupportRuntimeRepository;
  readonly snapshotRepository: ExtendedSupportRepository;
}

export function createExtendedSupportProductionComposition(
  options: ExtendedSupportProductionCompositionOptions,
): ExtendedSupportProductionComposition {
  if ((options.broker === undefined) === (options.brokerConfiguration === undefined)) {
    throw new Error("EXTENDED_SUPPORT_EXACTLY_ONE_BROKER_CONFIGURATION_REQUIRED");
  }
  if (options.fetcher !== undefined && options.brokerConfiguration === undefined) {
    throw new Error("EXTENDED_SUPPORT_FETCHER_REQUIRES_SIGNED_BROKER_CONFIGURATION");
  }
  const now = options.now ?? Date.now;
  const runtimeRepository = new ExtendedSupportRuntimeRepository(options.database, { now });
  const snapshotRepository = new ExtendedSupportRepository(options.database);
  const queue = new JobQueueRepository(options.database);
  const broker = options.broker ?? createExtendedSupportSignedBroker({
    configuration: options.brokerConfiguration!,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    now,
  });
  return Object.freeze({
    schemaVersion: EXTENDED_SUPPORT_PRODUCTION_COMPOSITION_SCHEMA,
    handler: createExtendedSupportRuntimeJobHandler({
      loadBoundary: runtimeRepository.loadBoundary.bind(runtimeRepository),
      broker,
      store: snapshotRepository,
      replayStore: runtimeRepository,
      now,
    }),
    scheduleTick: async (scheduledAtMs: number) => {
      const scheduledWindow = extendedSupportCollectionWindow(scheduledAtMs);
      return {
        scheduledWindow,
        enqueued: await scheduleExtendedSupportCollections({
          scheduledWindow,
          loadEligibleScopes: runtimeRepository.listEligibleScopes.bind(runtimeRepository),
          queue,
        }),
      };
    },
    runtimeRepository,
    snapshotRepository,
  });
}

/** Production dependency composition for the complete local ADV-12 runtime. */
import type { RunnableJob } from "./background-job-runner.ts";
import { JobQueueRepository } from "../db/job-queue-repository.ts";
import { DcfRepository } from "../db/finops-dcf-repository.ts";
import {
  DCF_REQUIRED_PERMISSION_PACK,
  DcfRuntimeRepository,
} from "../db/finops-dcf-runtime-repository.ts";
import {
  DCF_STEP_FUNCTIONS_RUNTIME_BINDING,
  createDcfStepFunctionsRuntimeJobHandler,
  dcfStepFunctionsCollectionWindow,
  scheduleDcfStepFunctionsCollections,
} from "./finops-dcf-durable-runtime-binding.ts";
import type {
  DcfStepFunctionsBoundary,
  DcfStepFunctionsCollectionResult,
} from "./finops-dcf-step-functions-adapter.ts";
import {
  createDcfStepFunctionsSignedBroker,
  type DcfStepFunctionsSignedBrokerConfiguration,
} from "./finops-dcf-signed-broker.ts";

export const DCF_PRODUCTION_COMPOSITION_SCHEMA = "sutra.dcf-production-composition.v1" as const;
export const DCF_PRODUCTION_COMPOSITION_STATUS = Object.freeze({
  schemaVersion: DCF_PRODUCTION_COMPOSITION_SCHEMA,
  credentialOwningProviderAdapterImplemented: true,
  signedBrokerClientImplemented: true,
  serverResolvedModuleInventoryImplemented: true,
  exactStateMachineArnActivationGateImplemented: true,
  durableReplayLeaseImplemented: true,
  immutableCompleteHeadImplemented: true,
  deterministicHourlyTickImplemented: true,
  explicitRuntimeStatesImplemented: true,
  privacyMinimizationImplemented: true,
  requiredPermissionPack: DCF_REQUIRED_PERMISSION_PACK,
  requiredSdk: "@aws-sdk/client-sfn@3.1087.0",
  sharedWorkerRegistered: DCF_STEP_FUNCTIONS_RUNTIME_BINDING.registeredInSharedRuntime,
  activationState: DCF_STEP_FUNCTIONS_RUNTIME_BINDING.registeredInSharedRuntime
    ? "REGISTERED_LOCAL_RUNTIME" as const : "AWAITING_SHARED_REGISTRY_HOOK" as const,
});

export interface DcfProductionAdapter {
  collect(boundary: DcfStepFunctionsBoundary, signal: AbortSignal): Promise<DcfStepFunctionsCollectionResult>;
}
export interface DcfProductionCompositionOptions {
  readonly database?: D1Database;
  readonly now?: () => number;
  readonly brokerConfiguration?: DcfStepFunctionsSignedBrokerConfiguration;
  readonly fetcher?: typeof fetch;
  /** Focused test seam; production must use the signed broker configuration. */
  readonly adapter?: DcfProductionAdapter;
}
export interface DcfProductionComposition {
  readonly schemaVersion: typeof DCF_PRODUCTION_COMPOSITION_SCHEMA;
  readonly handler: (job: RunnableJob) => Promise<void>;
  readonly scheduleTick: (scheduledAtMs: number) => Promise<{ readonly scheduledWindow: string; readonly enqueued: number }>;
  readonly runtimeRepository: DcfRuntimeRepository;
  readonly snapshotRepository: DcfRepository;
}

export function createDcfProductionComposition(options: DcfProductionCompositionOptions): DcfProductionComposition {
  if ((options.adapter === undefined) === (options.brokerConfiguration === undefined)) {
    throw new Error("DCF_EXACTLY_ONE_ADAPTER_REQUIRED");
  }
  if (options.fetcher !== undefined && options.brokerConfiguration === undefined) {
    throw new Error("DCF_FETCHER_REQUIRES_SIGNED_BROKER_CONFIGURATION");
  }
  const now = options.now ?? Date.now;
  const runtimeRepository = new DcfRuntimeRepository(options.database, { now });
  const snapshotRepository = new DcfRepository(options.database);
  const queue = new JobQueueRepository(options.database);
  const adapter = options.adapter ?? createDcfStepFunctionsSignedBroker({
    configuration: options.brokerConfiguration!,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    now,
  });
  return Object.freeze({
    schemaVersion: DCF_PRODUCTION_COMPOSITION_SCHEMA,
    handler: createDcfStepFunctionsRuntimeJobHandler({
      loadBoundary: runtimeRepository.loadBoundary.bind(runtimeRepository),
      adapter,
      record: runtimeRepository.record.bind(runtimeRepository),
      replayStore: runtimeRepository,
    }),
    scheduleTick: async (scheduledAtMs: number) => {
      const scheduledWindow = dcfStepFunctionsCollectionWindow(scheduledAtMs);
      const result = await scheduleDcfStepFunctionsCollections({
        scheduledWindow,
        loadEligibleScopes: runtimeRepository.listEligibleScopes.bind(runtimeRepository),
        queue,
      });
      return Object.freeze({ scheduledWindow, enqueued: result.enqueued });
    },
    runtimeRepository,
    snapshotRepository,
  });
}

/** Production dependency composition for the complete local ADV-06 runtime. */
import type { RunnableJob } from "./background-job-runner.ts";
import { JobQueueRepository } from "../db/job-queue-repository.ts";
import { AwsHealthRepository } from "../db/finops-aws-health-repository.ts";
import { AwsHealthRuntimeRepository } from "../db/finops-aws-health-runtime-repository.ts";
import {
  AWS_HEALTH_RUNTIME_BINDING,
  runAwsHealthOrganizationRuntimeHandler,
  scheduleAwsHealthOrganizationCollections,
  type AwsHealthRuntimeAdapter,
} from "./finops-aws-health-runtime-binding.ts";
import {
  createAwsHealthSignedBrokerAdapter,
  type AwsHealthSignedBrokerConfiguration,
} from "./finops-aws-health-signed-broker.ts";

export const AWS_HEALTH_PRODUCTION_COMPOSITION_SCHEMA = "sutra.aws-health-production-composition.v1" as const;
export const AWS_HEALTH_SCHEDULE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const AWS_HEALTH_REQUIRED_PERMISSION_PACK = "standard-2026-08.8" as const;
export const AWS_HEALTH_PRODUCTION_COMPOSITION_STATUS = Object.freeze({
  schemaVersion: AWS_HEALTH_PRODUCTION_COMPOSITION_SCHEMA,
  credentialOwningProviderAdapterImplemented: true,
  signedBrokerClientImplemented: true,
  durableReplayLeaseImplemented: true,
  immutableAttemptAndHistoryImplemented: true,
  managementAndDelegatedAdministratorValidationImplemented: true,
  initialLoadWaitEvidenceImplemented: true,
  deterministicDailyTickImplemented: true,
  requiredPermissionPack: AWS_HEALTH_REQUIRED_PERMISSION_PACK,
  sharedWorkerRegistered: AWS_HEALTH_RUNTIME_BINDING.registeredInSharedRuntime,
  activationState: AWS_HEALTH_RUNTIME_BINDING.registeredInSharedRuntime
    ? "REGISTERED_LOCAL_RUNTIME" as const : "AWAITING_SHARED_REGISTRY_HOOK" as const,
});

export interface AwsHealthProductionCompositionOptions {
  readonly database?: D1Database;
  readonly now?: () => number;
  readonly brokerConfiguration?: AwsHealthSignedBrokerConfiguration;
  readonly fetcher?: typeof fetch;
  /** Focused test seam; production must use the signed broker configuration. */
  readonly adapter?: AwsHealthRuntimeAdapter;
}
export interface AwsHealthProductionComposition {
  readonly schemaVersion: typeof AWS_HEALTH_PRODUCTION_COMPOSITION_SCHEMA;
  readonly handler: (job: RunnableJob) => Promise<void>;
  readonly scheduleTick: (scheduledAtMs: number) => Promise<{ readonly scheduledWindow: string; readonly enqueued: number }>;
  readonly runtimeRepository: AwsHealthRuntimeRepository;
  readonly snapshotRepository: AwsHealthRepository;
}
export function awsHealthScheduledWindow(scheduledAtMs: number): string {
  if (!Number.isSafeInteger(scheduledAtMs) || scheduledAtMs < 0) throw new Error("AWS_HEALTH_SCHEDULE_INVALID");
  return new Date(Math.floor(scheduledAtMs / AWS_HEALTH_SCHEDULE_INTERVAL_MS) * AWS_HEALTH_SCHEDULE_INTERVAL_MS).toISOString();
}
export async function scheduleAwsHealthProductionTick(scheduledAtMs: number, database?: D1Database) {
  const runtime = new AwsHealthRuntimeRepository(database);
  const scheduledWindow = awsHealthScheduledWindow(scheduledAtMs);
  return scheduleAwsHealthOrganizationCollections({
    scheduledWindow, loadEligibleScopes: runtime.listEligibleScopes.bind(runtime), queue: new JobQueueRepository(database),
  });
}
export function createAwsHealthProductionComposition(options: AwsHealthProductionCompositionOptions): AwsHealthProductionComposition {
  if ((options.adapter === undefined) === (options.brokerConfiguration === undefined)) throw new Error("AWS_HEALTH_EXACTLY_ONE_ADAPTER_REQUIRED");
  if (options.fetcher !== undefined && options.brokerConfiguration === undefined) throw new Error("AWS_HEALTH_FETCHER_REQUIRES_BROKER_CONFIGURATION");
  const now = options.now ?? Date.now;
  const runtimeRepository = new AwsHealthRuntimeRepository(options.database, { now });
  const snapshotRepository = new AwsHealthRepository(options.database);
  const queue = new JobQueueRepository(options.database);
  const adapter = options.adapter ?? createAwsHealthSignedBrokerAdapter({
    configuration: options.brokerConfiguration!,
    resolveContext: (request) => runtimeRepository.loadProviderContext({
      organizationId: request.scope.orgId, customerId: request.scope.customerId,
      connectionId: request.scope.connectionId,
    }),
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }), now,
  });
  return Object.freeze({
    schemaVersion: AWS_HEALTH_PRODUCTION_COMPOSITION_SCHEMA,
    handler: async (job: RunnableJob) => { await runAwsHealthOrganizationRuntimeHandler(job, {
      loadScope: runtimeRepository.loadScope.bind(runtimeRepository), adapter,
      handoff: runtimeRepository, now,
    }); },
    scheduleTick: async (scheduledAtMs: number) => {
      const scheduledWindow = awsHealthScheduledWindow(scheduledAtMs);
      return scheduleAwsHealthOrganizationCollections({
        scheduledWindow, loadEligibleScopes: runtimeRepository.listEligibleScopes.bind(runtimeRepository), queue,
      });
    },
    runtimeRepository, snapshotRepository,
  });
}

/** Production dependency composition for the ADV-08 durable AWS Budgets path. */
import type { RunnableJob } from "./background-job-runner.ts";
import { AwsBudgetsDurableAttemptRepository } from "../db/finops-aws-budgets-durable-attempt-repository.ts";
import { AwsBudgetsOrganizationRepository } from "../db/finops-aws-budgets-organization-repository.ts";
import { AwsBudgetsRuntimeRepository } from "../db/finops-aws-budgets-runtime-repository.ts";
import { JobQueueRepository } from "../db/job-queue-repository.ts";
import {
  AWS_BUDGETS_DURABLE_BINDING,
  createAwsBudgetsDurableJobHandler,
  scheduleAwsBudgetsCollections,
  type VerifiedAwsBudgetsBrokerResult,
  type AwsBudgetsDurableBrokerRequest,
} from "./finops-aws-budgets-durable-binding.ts";
import {
  createAwsBudgetsSignedBroker,
  type AwsBudgetsSignedBrokerConfiguration,
} from "./finops-aws-budgets-signed-broker.ts";

export const AWS_BUDGETS_PRODUCTION_COMPOSITION_SCHEMA =
  "sutra.aws-budgets-production-composition.v1" as const;
export const AWS_BUDGETS_SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export const AWS_BUDGETS_PRODUCTION_COMPOSITION_STATUS = Object.freeze({
  schemaVersion: AWS_BUDGETS_PRODUCTION_COMPOSITION_SCHEMA,
  durableScopeCatalogImplemented: true,
  deterministicSixHourTickImplemented: true,
  signedBrokerClientImplemented: true,
  immutableAttemptRepositoryImplemented: true,
  immutableSnapshotRepositoryImplemented: true,
  sharedWorkerRegistered: AWS_BUDGETS_DURABLE_BINDING.registeredInSharedRuntime,
  activationState: AWS_BUDGETS_DURABLE_BINDING.registeredInSharedRuntime
    ? "REGISTERED_LOCAL_RUNTIME" as const
    : "AWAITING_SHARED_REGISTRY_HOOK" as const,
});

interface AwsBudgetsBroker {
  readonly collect: (
    request: AwsBudgetsDurableBrokerRequest,
  ) => Promise<VerifiedAwsBudgetsBrokerResult>;
}

export interface AwsBudgetsProductionCompositionOptions {
  readonly database?: D1Database;
  readonly now?: () => number;
  /** Production supplies server-owned signing configuration and an egress-controlled fetcher. */
  readonly brokerConfiguration?: AwsBudgetsSignedBrokerConfiguration;
  readonly fetcher?: typeof fetch;
  /** Focused test seam. Never derive this dependency from request data. */
  readonly broker?: AwsBudgetsBroker;
}

export interface AwsBudgetsProductionComposition {
  readonly schemaVersion: typeof AWS_BUDGETS_PRODUCTION_COMPOSITION_SCHEMA;
  readonly handler: (job: RunnableJob) => Promise<void>;
  readonly scheduleTick: (scheduledAtMs: number) => Promise<{
    readonly scheduledWindow: string;
    readonly enqueued: number;
  }>;
  readonly runtimeRepository: AwsBudgetsRuntimeRepository;
  readonly snapshotRepository: AwsBudgetsOrganizationRepository;
  readonly attemptRepository: AwsBudgetsDurableAttemptRepository;
}

export function awsBudgetsScheduledWindow(scheduledAtMs: number): string {
  if (!Number.isSafeInteger(scheduledAtMs) || scheduledAtMs < 0) {
    throw new Error("AWS_BUDGETS_SCHEDULE_INVALID");
  }
  const window = Math.floor(scheduledAtMs / AWS_BUDGETS_SCHEDULE_INTERVAL_MS)
    * AWS_BUDGETS_SCHEDULE_INTERVAL_MS;
  return new Date(window).toISOString();
}

/** Scheduler-only hook: it needs no broker origin or signing private key. */
export async function scheduleAwsBudgetsProductionTick(
  scheduledAtMs: number,
  database?: D1Database,
): Promise<{ readonly scheduledWindow: string; readonly enqueued: number }> {
  const runtimeRepository = new AwsBudgetsRuntimeRepository(database);
  return scheduleAwsBudgetsCollections({
    loadEligibleScopes: runtimeRepository.listActiveScopes.bind(runtimeRepository),
    queue: new JobQueueRepository(database),
    scheduledWindow: awsBudgetsScheduledWindow(scheduledAtMs),
  });
}

export function createAwsBudgetsProductionComposition(
  options: AwsBudgetsProductionCompositionOptions,
): AwsBudgetsProductionComposition {
  if ((options.broker === undefined) === (options.brokerConfiguration === undefined)) {
    throw new Error("AWS_BUDGETS_EXACTLY_ONE_BROKER_CONFIGURATION_REQUIRED");
  }
  if (options.fetcher !== undefined && options.brokerConfiguration === undefined) {
    throw new Error("AWS_BUDGETS_FETCHER_REQUIRES_SIGNED_BROKER_CONFIGURATION");
  }
  const now = options.now ?? Date.now;
  const runtimeRepository = new AwsBudgetsRuntimeRepository(options.database);
  const snapshotRepository = new AwsBudgetsOrganizationRepository(options.database);
  const attemptRepository = new AwsBudgetsDurableAttemptRepository(options.database);
  const queue = new JobQueueRepository(options.database);
  const broker = options.broker ?? createAwsBudgetsSignedBroker({
    configuration: options.brokerConfiguration!,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    now,
  });
  const handler = createAwsBudgetsDurableJobHandler({
    loadScope: runtimeRepository.loadScope.bind(runtimeRepository),
    broker,
    captureStore: snapshotRepository,
    attempts: attemptRepository,
    now,
  });
  return Object.freeze({
    schemaVersion: AWS_BUDGETS_PRODUCTION_COMPOSITION_SCHEMA,
    handler,
    scheduleTick: async (scheduledAtMs: number) => scheduleAwsBudgetsCollections({
      loadEligibleScopes: runtimeRepository.listActiveScopes.bind(runtimeRepository),
      queue,
      scheduledWindow: awsBudgetsScheduledWindow(scheduledAtMs),
    }),
    runtimeRepository,
    snapshotRepository,
    attemptRepository,
  });
}

/** Complete local production composition for ADD-06 Kubecost CCA exports. */
import { JobQueueRepository } from "../db/job-queue-repository.ts";
import { KubecostAllocationRepository } from "../db/finops-kubecost-allocation-repository.ts";
import { KubecostRuntimeAttemptRepository } from "../db/finops-kubecost-runtime-attempt-repository.ts";
import type { RunnableJob } from "./background-job-runner.ts";
import {
  KUBECOST_DURABLE_JOB_KIND,
  KUBECOST_RUNTIME_BINDING,
  createKubecostRuntimeHandler,
  scheduleKubecostCollections,
  type KubecostRuntimeContext,
  type KubecostRuntimeRequest,
  type VerifiedKubecostRuntimeResult,
} from "./finops-kubecost-runtime-binding.ts";
import { createKubecostSignedExportBroker } from "./finops-kubecost-signed-export-broker.ts";

export const KUBECOST_PRODUCTION_COMPOSITION_SCHEMA =
  "sutra.kubecost-production-composition.v1" as const;
export const KUBECOST_SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1_000;

/**
 * Exact known successor chain. Never replace this allow-list with a lexical
 * comparison: `standard-2026-08.90` is not an implicitly trusted successor.
 */
export const KUBECOST_ACCEPTED_PERMISSION_PACKS = Object.freeze([
  "standard-2026-08.9",
  "standard-2026-08.10",
  "standard-2026-08.11",
  "standard-2026-08.12",
  "standard-2026-08.13",
  "standard-2026-08.14",
] as const);
export function isKubecostPermissionPackAccepted(value: string): boolean {
  return (KUBECOST_ACCEPTED_PERMISSION_PACKS as readonly string[]).includes(value);
}

export const KUBECOST_PRODUCTION_COMPOSITION_STATUS = Object.freeze({
  schemaVersion: KUBECOST_PRODUCTION_COMPOSITION_SCHEMA,
  officialSourceCommit: "8a581332a70ae55d53464e52a0bb8b3dd64cb425",
  officialArtifactCount: 8,
  officialDatasetColumnCount: 62,
  officialAthenaViewQuerySha256:
    "2a5db62703b857a19d56a50661e5a20be4d02776aad3d1065422c7bab8b2e07c",
  credentialOwningProviderAdapterImplemented: true,
  signedBrokerImplemented: true,
  versionPinnedObjectReadsImplemented: true,
  immutableAttemptReplayImplemented: true,
  immutableCompleteHeadImplemented: true,
  deterministicSixHourSchedulerImplemented: true,
  identityOnlyQueuePayload: true,
  nodeCapacityAndInstanceDimensionsImplemented: true,
  explicitRuntimeStatesImplemented: true,
  requiredSdk: "@aws-sdk/client-s3@3.1087.0",
  acceptedPermissionPacks: KUBECOST_ACCEPTED_PERMISSION_PACKS,
  sharedWorkerRegistered: KUBECOST_RUNTIME_BINDING.registeredInSharedRuntime,
  activationState: KUBECOST_RUNTIME_BINDING.registeredInSharedRuntime
    ? "REGISTERED_LOCAL_RUNTIME" as const
    : "AWAITING_SHARED_REGISTRY_HOOK" as const,
});

export interface KubecostProductionBroker {
  collect(request: KubecostRuntimeRequest): Promise<VerifiedKubecostRuntimeResult>;
}

export interface KubecostProductionCompositionOptions {
  readonly database?: D1Database;
  readonly now?: () => number;
  readonly loadEligibleContexts: () => Promise<readonly KubecostRuntimeContext[]>;
  readonly loadRuntimeContext: (scope: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
  }) => Promise<KubecostRuntimeContext>;
  /** Focused test seam. Production supplies exactly one signed broker config. */
  readonly broker?: KubecostProductionBroker;
  readonly brokerConfiguration?: Parameters<typeof createKubecostSignedExportBroker>[0];
}

export function kubecostScheduledWindow(scheduledAtMs: number): string {
  if (!Number.isSafeInteger(scheduledAtMs) || scheduledAtMs < 0) {
    throw new Error("KUBECOST_SCHEDULE_INVALID");
  }
  return new Date(
    Math.floor(scheduledAtMs / KUBECOST_SCHEDULE_INTERVAL_MS) * KUBECOST_SCHEDULE_INTERVAL_MS,
  ).toISOString();
}

export function createKubecostProductionComposition(
  options: KubecostProductionCompositionOptions,
): Readonly<{
  schemaVersion: typeof KUBECOST_PRODUCTION_COMPOSITION_SCHEMA;
  handler: (job: RunnableJob) => Promise<void>;
  scheduleTick: (scheduledAtMs: number) => Promise<{
    readonly scheduledWindow: string;
    readonly enqueued: number;
  }>;
  snapshotRepository: KubecostAllocationRepository;
  attemptRepository: KubecostRuntimeAttemptRepository;
}> {
  if ((options.broker === undefined) === (options.brokerConfiguration === undefined)) {
    throw new Error("KUBECOST_EXACTLY_ONE_BROKER_REQUIRED");
  }
  const now = options.now ?? Date.now;
  const snapshotRepository = new KubecostAllocationRepository(options.database);
  const attemptRepository = new KubecostRuntimeAttemptRepository(options.database);
  const queue = new JobQueueRepository(options.database);
  const broker = options.broker ?? createKubecostSignedExportBroker(options.brokerConfiguration!);
  const handler = createKubecostRuntimeHandler({
    loadRuntimeContext: options.loadRuntimeContext,
    broker,
    recordCapture: snapshotRepository.recordCapture.bind(snapshotRepository),
    attempts: attemptRepository,
    now,
  });
  return Object.freeze({
    schemaVersion: KUBECOST_PRODUCTION_COMPOSITION_SCHEMA,
    handler,
    scheduleTick: async (scheduledAtMs: number) => {
      const scheduledWindow = kubecostScheduledWindow(scheduledAtMs);
      const enqueued = await scheduleKubecostCollections({
        scheduledWindow,
        loadEligibleContexts: options.loadEligibleContexts,
        enqueue: async (value) => queue.enqueue({
          orgId: value.orgId,
          customerId: value.customerId,
          connectionId: value.connectionId,
          kind: KUBECOST_DURABLE_JOB_KIND,
          payload: value.payload,
          maxAttempts: value.maxAttempts,
          idempotencyKey: value.idempotencyKey,
        }, now()),
      });
      return Object.freeze({ scheduledWindow, enqueued });
    },
    snapshotRepository,
    attemptRepository,
  });
}

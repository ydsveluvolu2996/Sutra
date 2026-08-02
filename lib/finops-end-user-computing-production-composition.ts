/** Production dependency composition for the complete local ADV-11 vertical. */
import type { RunnableJob } from "./background-job-runner.ts";
import { JobQueueRepository } from "../db/job-queue-repository.ts";
import { EndUserComputingRepository } from "../db/finops-end-user-computing-repository.ts";
import { EndUserComputingRuntimeAttemptRepository } from "../db/finops-end-user-computing-runtime-attempt-repository.ts";
import { createEndUserComputingSignedBroker } from "./finops-end-user-computing-signed-broker.ts";
import type { HostedBrokerClientSigningConfiguration } from "./hosted-broker-client-security.ts";
import {
  createEndUserComputingRuntimeHandler,
  runEndUserComputingRuntimeJob,
  scheduleEndUserComputingCollectionsDetailed,
  type EndUserComputingRuntimeContext,
  type VerifiedEndUserComputingBrokerResult,
} from "./finops-end-user-computing-runtime-binding.ts";
import type { EndUserComputingBoundary } from "./finops-end-user-computing.ts";

export const END_USER_COMPUTING_PRODUCTION_COMPOSITION_SCHEMA = "sutra.end-user-computing-production-composition.v1" as const;
export const END_USER_COMPUTING_SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const END_USER_COMPUTING_REQUIRED_PERMISSION_PACK = "standard-2026-08.11" as const;
export const END_USER_COMPUTING_PRODUCTION_COMPOSITION_STATUS = Object.freeze({
  schemaVersion: END_USER_COMPUTING_PRODUCTION_COMPOSITION_SCHEMA,
  credentialOwningProviderRouteImplemented: true,
  strictSignedBrokerImplemented: true,
  immutableSnapshotAndAttemptReplayImplemented: true,
  deterministicSixHourTickImplemented: true,
  explicitUnavailableCollectingFailedReadyStatesImplemented: true,
  privacyMinimizedUsageDimensionsImplemented: true,
  rollingNinetyThreeDayHistoryBoundaryImplemented: true,
  requiredPermissionPack: END_USER_COMPUTING_REQUIRED_PERMISSION_PACK,
  requiredSdks: Object.freeze(["@aws-sdk/client-appstream@3.1087.0", "@aws-sdk/client-cloudwatch@3.1087.0", "@aws-sdk/client-workspaces@3.1087.0"]),
  sharedWorkerRegistered: true,
  activationState: "REGISTERED_LOCAL_RUNTIME" as const,
});

export function endUserComputingScheduledWindow(atMs: number): string {
  if (!Number.isSafeInteger(atMs) || atMs < 0) throw new Error("END_USER_COMPUTING_SCHEDULE_INVALID");
  return new Date(Math.floor(atMs / END_USER_COMPUTING_SCHEDULE_INTERVAL_MS)
    * END_USER_COMPUTING_SCHEDULE_INTERVAL_MS).toISOString();
}

export interface EndUserComputingProductionCompositionOptions {
  readonly database?: D1Database;
  readonly now?: () => number;
  /** Server-owned scope resolver; it must not accept a tenant identifier from a job payload. */
  readonly loadEligibleBoundaries: () => Promise<readonly EndUserComputingBoundary[]>;
  readonly loadRuntimeContext: (scope: { readonly orgId: string; readonly customerId: string;
    readonly connectionId: string }) => Promise<EndUserComputingRuntimeContext>;
  readonly brokerConfiguration?: { readonly brokerOrigin: string; readonly signing: HostedBrokerClientSigningConfiguration };
  readonly fetcher?: typeof fetch;
  /** Focused test seam. Production must use brokerConfiguration. */
  readonly broker?: { readonly collect: (request: Parameters<ReturnType<typeof createEndUserComputingSignedBroker>["collect"]>[0]) => Promise<VerifiedEndUserComputingBrokerResult> };
}

export function createEndUserComputingProductionComposition(options: EndUserComputingProductionCompositionOptions) {
  if ((options.broker === undefined) === (options.brokerConfiguration === undefined)) {
    throw new Error("END_USER_COMPUTING_EXACTLY_ONE_BROKER_REQUIRED");
  }
  if (options.fetcher !== undefined && options.brokerConfiguration === undefined) {
    throw new Error("END_USER_COMPUTING_FETCHER_REQUIRES_SIGNED_BROKER_CONFIGURATION");
  }
  const now=options.now??Date.now,repository=new EndUserComputingRepository(options.database),
    attempts=new EndUserComputingRuntimeAttemptRepository(options.database),queue=new JobQueueRepository(options.database);
  const broker=options.broker??createEndUserComputingSignedBroker({brokerOrigin:options.brokerConfiguration!.brokerOrigin,
    signing:options.brokerConfiguration!.signing,...(options.fetcher===undefined?{}:{fetcher:options.fetcher}),now});
  const dependencies={loadRuntimeContext:options.loadRuntimeContext,broker,
    recordCapture:repository.recordCapture.bind(repository),attempts,now};
  return Object.freeze({schemaVersion:END_USER_COMPUTING_PRODUCTION_COMPOSITION_SCHEMA,
    snapshotRepository:repository,attemptRepository:attempts,
    handler:createEndUserComputingRuntimeHandler(dependencies),
    run:async(job:RunnableJob)=>runEndUserComputingRuntimeJob(job,dependencies),
    scheduleTick:async(scheduledAtMs:number)=>{const scheduledWindow=endUserComputingScheduledWindow(scheduledAtMs);
      const result=await scheduleEndUserComputingCollectionsDetailed({scheduledWindow,
        loadEligibleBoundaries:options.loadEligibleBoundaries,enqueue:queue.enqueue.bind(queue)});
      return Object.freeze({scheduledWindow,connectionCount:result.connectionCount,
        enqueued:result.submittedCount,rejected:result.rejectedCount});},
  });
}

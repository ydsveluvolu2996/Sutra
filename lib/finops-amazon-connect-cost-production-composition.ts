/** Complete local production dependency composition for ADD-11. */
import type { RunnableJob } from "./background-job-runner.ts";
import { JobQueueRepository } from "../db/job-queue-repository.ts";
import { AmazonConnectCostInsightRepository,
  type AmazonConnectCostInsightPersistenceScope } from
  "../db/finops-amazon-connect-cost-insight-repository.ts";
import { AmazonConnectCostRuntimeRepository,
  AMAZON_CONNECT_COST_RUNTIME_PERMISSION_PACK } from
  "../db/finops-amazon-connect-cost-runtime-repository.ts";
import {
  AMAZON_CONNECT_COST_RUNTIME_BINDING,
  createAmazonConnectCostRuntimeJobHandler,
  scheduleAmazonConnectCostCollections,
  type AmazonConnectCostEvidenceArchive,
  type AmazonConnectCostEvidenceSealer,
  type AmazonConnectCostRuntimeBoundary,
  type AmazonConnectCostRuntimeMaterializer,
} from "./finops-amazon-connect-cost-insight-runtime-binding.ts";
import { createAmazonConnectCostSignedBroker,
  type AmazonConnectCostSignedBrokerConfiguration } from
  "./finops-amazon-connect-cost-signed-broker.ts";

export const AMAZON_CONNECT_COST_PRODUCTION_COMPOSITION_SCHEMA =
  "sutra.amazon-connect-cost-production-composition.v1" as const;
export const AMAZON_CONNECT_COST_SCHEDULE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const AMAZON_CONNECT_COST_PRODUCTION_COMPOSITION_STATUS = Object.freeze({
  schemaVersion: AMAZON_CONNECT_COST_PRODUCTION_COMPOSITION_SCHEMA,
  pinnedOfficialSheets: 8,
  pinnedOfficialVisuals: 121,
  pinnedOfficialControls: 61,
  requiredPermissionPack: AMAZON_CONNECT_COST_RUNTIME_PERMISSION_PACK,
  credentialOwningProviderAdapterImplemented: true,
  exactInstanceAndTargetArnEnforcementImplemented: true,
  signedBrokerImplemented: true,
  durableLeaseAndReplayImplemented: true,
  immutableAggregateHistoryImplemented: true,
  deterministicDailySchedulerImplemented: true,
  resourceConnectViewDatasetPublished: false,
  supportingServiceEvidenceState: "UNAVAILABLE_SEPARATE_AUTHORITATIVE_EVIDENCE_REQUIRED" as const,
  exactContactLookupState: "UNAVAILABLE_APPROVAL_AUDIT_GRANT_ROUTE_REQUIRED" as const,
  sharedWorkerRegistered: AMAZON_CONNECT_COST_RUNTIME_BINDING.registeredInSharedRuntime,
  activationState: AMAZON_CONNECT_COST_RUNTIME_BINDING.registeredInSharedRuntime
    ? "REGISTERED_LOCAL_RUNTIME" as const : "AWAITING_SHARED_REGISTRY_HOOKS" as const,
});

export interface AmazonConnectCostProductionCompositionOptions {
  readonly database?: D1Database;
  readonly now?: () => number;
  readonly loadBoundary: (
    scope: AmazonConnectCostInsightPersistenceScope,
  ) => Promise<AmazonConnectCostRuntimeBoundary | null>;
  readonly listEligibleScopes: (
    limit: number,
  ) => Promise<readonly AmazonConnectCostInsightPersistenceScope[]>;
  readonly evidence: AmazonConnectCostEvidenceArchive;
  readonly sealer: AmazonConnectCostEvidenceSealer;
  readonly brokerConfiguration?: AmazonConnectCostSignedBrokerConfiguration;
  readonly fetcher?: typeof fetch;
  /** Focused test seam. Production must use brokerConfiguration. */
  readonly materializer?: AmazonConnectCostRuntimeMaterializer;
}

export function amazonConnectCostScheduledWindow(scheduledAtMs: number): string {
  if (!Number.isSafeInteger(scheduledAtMs) || scheduledAtMs < 0) {
    throw new Error("AMAZON_CONNECT_COST_SCHEDULE_INVALID");
  }
  return new Date(Math.floor(scheduledAtMs / AMAZON_CONNECT_COST_SCHEDULE_INTERVAL_MS)
    * AMAZON_CONNECT_COST_SCHEDULE_INTERVAL_MS).toISOString();
}

export function createAmazonConnectCostProductionComposition(
  options: AmazonConnectCostProductionCompositionOptions,
) {
  if ((options.materializer === undefined) === (options.brokerConfiguration === undefined)) {
    throw new Error("AMAZON_CONNECT_COST_EXACTLY_ONE_MATERIALIZER_REQUIRED");
  }
  if (options.fetcher !== undefined && options.brokerConfiguration === undefined) {
    throw new Error("AMAZON_CONNECT_COST_FETCHER_REQUIRES_SIGNED_BROKER_CONFIGURATION");
  }
  const now = options.now ?? Date.now;
  const runtimeRepository = new AmazonConnectCostRuntimeRepository(options.database, { now });
  const snapshotRepository = new AmazonConnectCostInsightRepository(options.database);
  const queue = new JobQueueRepository(options.database);
  const materializer = options.materializer ?? createAmazonConnectCostSignedBroker({
    configuration: options.brokerConfiguration!,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    now,
  });
  const handler = createAmazonConnectCostRuntimeJobHandler({
    loadBoundary: options.loadBoundary,
    materializer,
    evidence: options.evidence,
    sealer: options.sealer,
    handoff: runtimeRepository,
    now,
  });
  return Object.freeze({
    schemaVersion: AMAZON_CONNECT_COST_PRODUCTION_COMPOSITION_SCHEMA,
    handler: (job: RunnableJob) => handler(job),
    scheduleTick: async (scheduledAtMs: number) => {
      const scheduledWindow = amazonConnectCostScheduledWindow(scheduledAtMs);
      const result = await scheduleAmazonConnectCostCollections({
        scheduledWindow,
        loadEligibleScopes: async () => {
          const scopes = await options.listEligibleScopes(10_001);
          if (scopes.length > 10_000) throw new Error("AMAZON_CONNECT_COST_SCOPE_BOUND_REACHED");
          return scopes;
        },
        queue,
      });
      return Object.freeze({ scheduledWindow, enqueued: result.enqueued });
    },
    runtimeRepository,
    snapshotRepository,
  });
}

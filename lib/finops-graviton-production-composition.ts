/** Production dependency composition for the locally complete ADV-05 runtime. */
import type { RunnableJob } from "./background-job-runner.ts";
import { JobQueueRepository } from "../db/job-queue-repository.ts";
import { GravitonSavingsRepository } from "../db/finops-graviton-savings-repository.ts";
import { GravitonRuntimeRepository } from "../db/finops-graviton-runtime-repository.ts";
import type { GravitonProductionAuthorityConfiguration } from "../db/finops-graviton-runtime-repository.ts";
import {
  GRAVITON_MATERIALIZATION_JOB_KIND,
  gravitonCollectionWindow,
  runGravitonDurableJob,
  scheduleGravitonMaterializations,
  type GravitonRuntimeReceipt,
} from "./finops-graviton-runtime-binding.ts";
import {
  createGravitonSignedBrokerCollector,
  type GravitonSignedBrokerConfiguration,
} from "./finops-graviton-signed-broker.ts";

export const GRAVITON_REQUIRED_PERMISSION_PACK = "standard-2026-08.12" as const;
export const GRAVITON_PRODUCTION_COMPOSITION_STATUS = Object.freeze({
  schemaVersion: "sutra.graviton-production-composition.v1" as const,
  credentialOwningProviderBoundaryImplemented: true,
  exactSignedTransportImplemented: true,
  durableLeaseAndSignedReplayImplemented: true,
  immutableCompleteOnlySnapshotHistoryImplemented: true,
  contentAddressedCur2PricingCompatibilityAuthoritiesImplemented: true,
  deterministicDailyTickImplemented: true,
  requiredPermissionPack: GRAVITON_REQUIRED_PERMISSION_PACK,
  sharedWorkerRegistered: true,
  activationState: "REGISTERED_LOCAL_RUNTIME" as const,
});
export interface GravitonEvidenceSigner {
  readonly seal: (evidence: Readonly<Record<string, unknown>>) => Promise<GravitonRuntimeReceipt["signature"]>;
  readonly verify: (receipt: GravitonRuntimeReceipt) => Promise<boolean>;
}
export interface GravitonProductionCompositionOptions {
  readonly database?: D1Database;
  readonly now?: () => number;
  readonly brokerConfiguration: GravitonSignedBrokerConfiguration;
  readonly signer: GravitonEvidenceSigner;
  readonly authorityConfiguration: GravitonProductionAuthorityConfiguration;
  readonly fetcher?: typeof fetch;
}
export function createGravitonProductionComposition(options: GravitonProductionCompositionOptions) {
  const now = options.now ?? Date.now, runtime = new GravitonRuntimeRepository(options.database, { now });
  const snapshots = new GravitonSavingsRepository(options.database), queue = new JobQueueRepository(options.database);
  const collector = createGravitonSignedBrokerCollector({ configuration: options.brokerConfiguration,
    resolveContext: runtime.loadProviderContext.bind(runtime), ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }), now });
  return Object.freeze({
    schemaVersion: "sutra.graviton-production-composition.v1" as const,
    kind: GRAVITON_MATERIALIZATION_JOB_KIND,
    handler: async (job: RunnableJob) => {
      await runGravitonDurableJob(job as Parameters<typeof runGravitonDurableJob>[0], {
        loadBoundary: runtime.loadBoundary.bind(runtime), collector, store: snapshots,
        prepareAttempt: runtime.prepareAttempt.bind(runtime), loadReceipt: runtime.loadReceipt.bind(runtime),
        verifyReceipt: options.signer.verify, sealEvidence: options.signer.seal,
        recordReceipt: runtime.recordReceipt.bind(runtime), recordFailure: runtime.recordFailure.bind(runtime), now,
      });
    },
    scheduleTick: async (scheduledAtMs: number) => {
      await runtime.bindProductionAuthorities(options.authorityConfiguration);
      const scheduledWindow = gravitonCollectionWindow(scheduledAtMs);
      const enqueued = await scheduleGravitonMaterializations({ scheduledWindow,
        loadEligibleScopes: runtime.listEligibleScopes.bind(runtime), queue });
      return { scheduledWindow, enqueued };
    },
    runtimeRepository: runtime,
    snapshotRepository: snapshots,
  });
}

/** Production dependency composition for ADD-12 AWS Config compliance. */
import type { RunnableJob } from "./background-job-runner.ts";
import { JobQueueRepository } from "../db/job-queue-repository.ts";
import { AwsConfigComplianceRepository } from "../db/finops-aws-config-compliance-repository.ts";
import { AwsConfigComplianceRuntimeRepository } from
  "../db/finops-aws-config-compliance-runtime-repository.ts";
import {
  AWS_CONFIG_COMPLIANCE_RUNTIME_BINDING,
  awsConfigComplianceCollectionWindow,
  runAwsConfigComplianceRuntimeHandler,
  scheduleAwsConfigComplianceCollections,
} from "./finops-aws-config-compliance-runtime-binding.ts";
import { createAwsConfigComplianceSignedBrokerAdapter,
  type AwsConfigComplianceSignedBrokerConfiguration } from
  "./finops-aws-config-compliance-signed-broker.ts";
import type { AwsConfigComplianceCollectorAdapter } from "./finops-aws-config-compliance-job.ts";

export const AWS_CONFIG_COMPLIANCE_PRODUCTION_COMPOSITION_SCHEMA =
  "sutra.aws-config-compliance-production-composition.v1" as const;
export const AWS_CONFIG_COMPLIANCE_RUNTIME_PERMISSION_PACK = "standard-2026-08.18" as const;
export const AWS_CONFIG_COMPLIANCE_PRODUCTION_STATUS = Object.freeze({
  schemaVersion: AWS_CONFIG_COMPLIANCE_PRODUCTION_COMPOSITION_SCHEMA,
  pinnedOfficialVersion: "5.0.0", pinnedSheets: 7, pinnedVisuals: 124,
  pinnedControls: 64, pinnedDatasets: 13, pinnedAthenaViews: 14,
  requiredPermissionPack: AWS_CONFIG_COMPLIANCE_RUNTIME_PERMISSION_PACK,
  credentialOwningProviderAdapterImplemented: true,
  strictSignedRouteImplemented: true,
  durableReplayAndLeaseImplemented: true,
  immutableSnapshotHistoryImplemented: true,
  deterministicDailySchedulerImplemented: true,
  tagComplianceState: "UNAVAILABLE_AUTHORITATIVE_TAG_PROJECTION_NOT_CONFIGURED",
  threatInformedState: "UNAVAILABLE_NO_VERSIONED_AUTHORITATIVE_THREAT_CONTRACT",
  configurationItemEventsState: "UNAVAILABLE_NO_VERSIONED_CONFIG_DELIVERY_EVENT_CONTRACT",
  securityHubOrCloudTrailSubstitution: false,
  sharedWorkerRegistered: AWS_CONFIG_COMPLIANCE_RUNTIME_BINDING.registeredInSharedRuntime,
});

export interface AwsConfigComplianceProductionCompositionOptions {
  readonly database?: D1Database; readonly now?: () => number;
  readonly brokerConfiguration?: AwsConfigComplianceSignedBrokerConfiguration;
  readonly fetcher?: typeof fetch;
  /** Focused test seam. Production must provide brokerConfiguration. */
  readonly adapter?: AwsConfigComplianceCollectorAdapter;
}
export function createAwsConfigComplianceProductionComposition(
  options: AwsConfigComplianceProductionCompositionOptions,
) {
  if ((options.adapter === undefined) === (options.brokerConfiguration === undefined)) {
    throw new Error("AWS_CONFIG_COMPLIANCE_EXACTLY_ONE_ADAPTER_REQUIRED");
  }
  if (options.fetcher !== undefined && options.brokerConfiguration === undefined) {
    throw new Error("AWS_CONFIG_COMPLIANCE_FETCHER_REQUIRES_BROKER_CONFIGURATION");
  }
  const now = options.now ?? Date.now;
  const runtimeRepository = new AwsConfigComplianceRuntimeRepository(options.database, { now });
  const snapshotRepository = new AwsConfigComplianceRepository(options.database);
  const queue = new JobQueueRepository(options.database);
  const adapter = options.adapter ?? createAwsConfigComplianceSignedBrokerAdapter({
    configuration: options.brokerConfiguration!,
    resolveContext: (request) => runtimeRepository.loadProviderContext({
      organizationId: request.scope.orgId, customerId: request.scope.customerId,
      connectionId: request.scope.connectionId,
    }),
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }), now,
  });
  return Object.freeze({
    schemaVersion: AWS_CONFIG_COMPLIANCE_PRODUCTION_COMPOSITION_SCHEMA,
    handler: async (job: RunnableJob) => { await runAwsConfigComplianceRuntimeHandler(job, {
      loadScope: runtimeRepository.loadScope.bind(runtimeRepository), adapter,
      store: snapshotRepository, replayStore: runtimeRepository, now,
    }); },
    scheduleTick: async (scheduledAtMs: number) => {
      const scheduledWindow = awsConfigComplianceCollectionWindow(scheduledAtMs);
      const enqueued = await scheduleAwsConfigComplianceCollections({ scheduledWindow,
        loadEligibleScopes: runtimeRepository.listEligibleScopes.bind(runtimeRepository), queue });
      return Object.freeze({ scheduledWindow, enqueued });
    },
    runtimeRepository, snapshotRepository,
  });
}

/** Complete local production composition for ADD-01 CORA. */
import type { RunnableJob } from "./background-job-runner.ts";
import { JobQueueRepository } from "../db/job-queue-repository.ts";
import { CoraExportObjectRepository, type CoraExportObjectScope } from "../db/finops-cora-export-object-repository.ts";
import { CoraRepository } from "../db/finops-cora-repository.ts";
import { CoraRuntimeAttemptRepository, type CoraRuntimeFailureCode } from "../db/finops-cora-runtime-attempt-repository.ts";
import { CORA_EXPORT_MATERIALIZATION_JOB_KIND, deriveCoraExportRequestKey, runCoraExportMaterializationJob,
  type CoraExportRuntimeContext } from "./finops-cora-export-orchestration.ts";
import { createCoraSignedBroker, CORA_REQUIRED_PERMISSION_PACK,
  type CoraSignedBrokerConfiguration } from "./finops-cora-signed-broker.ts";

export const CORA_PRODUCTION_COMPOSITION_SCHEMA = "sutra.cora-production-composition.v1" as const;
export const CORA_SCHEDULE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const CORA_PRODUCTION_COMPOSITION_STATUS = Object.freeze({
  schemaVersion: CORA_PRODUCTION_COMPOSITION_SCHEMA,
  pinnedOfficialContract: "v0.0.11", exactSheets: 5, exactVisuals: 28, exactControlPlacements: 52,
  credentialOwningProviderAdapterImplemented: true, signedBrokerImplemented: true,
  defaultSdkParquetFactoryImplemented: false,
  immutableExportReplayImplemented: true, durableProviderLeaseImplemented: true,
  immutableDashboardHistoryImplemented: true,
  deterministicDailySchedulerImplemented: true, identityOnlyQueuePayload: true,
  commitmentOptionMatricesImplemented: true, requiredPermissionPack: CORA_REQUIRED_PERMISSION_PACK,
  sharedWorkerRegistered: false, sqliteMigrationRegistered: false, postgresMigrationRegistered: false,
  activationState: "AWAITING_SHARED_MIGRATION_AND_REGISTRY_HOOKS" as const,
});
export type CoraEligibleScope = CoraExportObjectScope;
export interface CoraProductionOptions {
  readonly database?: D1Database; readonly now?: () => number; readonly broker: CoraSignedBrokerConfiguration;
  readonly fetcher?: typeof fetch;
  readonly listEligibleScopes: (limit: number) => Promise<readonly CoraEligibleScope[]>;
  readonly loadRuntimeContext: (scope: CoraExportObjectScope) => Promise<CoraExportRuntimeContext>;
}
export function coraScheduledWindow(scheduledAtMs: number): string { if (!Number.isSafeInteger(scheduledAtMs) || scheduledAtMs < 0) throw new Error("CORA_SCHEDULE_INVALID"); return new Date(Math.floor(scheduledAtMs / CORA_SCHEDULE_INTERVAL_MS) * CORA_SCHEDULE_INTERVAL_MS).toISOString(); }
export async function scheduleCoraCollections(input: { readonly scheduledAtMs: number; readonly listEligibleScopes: CoraProductionOptions["listEligibleScopes"]; readonly queue: Pick<JobQueueRepository, "enqueue"> }) {
  const scheduledWindow = coraScheduledWindow(input.scheduledAtMs); const scopes = await input.listEligibleScopes(10_001); if (scopes.length > 10_000) throw new Error("CORA_ELIGIBLE_SCOPE_BOUND_REACHED");
  const identities = new Set<string>(); let enqueued = 0; for (const scope of [...scopes].sort((a, b) => a.connectionId.localeCompare(b.connectionId))) { const identity = `${scope.organizationId}:${scope.customerId}:${scope.connectionId}`; if (identities.has(identity)) throw new Error("CORA_DUPLICATE_ELIGIBLE_SCOPE"); identities.add(identity); await input.queue.enqueue({ orgId: scope.organizationId, customerId: scope.customerId, connectionId: scope.connectionId, kind: CORA_EXPORT_MATERIALIZATION_JOB_KIND, payload: { scheduledWindow }, maxAttempts: 5, idempotencyKey: `cora:${scope.connectionId}:${scheduledWindow}` }); enqueued += 1; }
  return { scheduledWindow, enqueued };
}
export function createCoraProductionComposition(options: CoraProductionOptions) {
  const now = options.now ?? Date.now; const exports = new CoraExportObjectRepository(options.database); const snapshots = new CoraRepository(options.database); const queue = new JobQueueRepository(options.database);
  const attempts = new CoraRuntimeAttemptRepository(options.database, now);
  const adapter = createCoraSignedBroker({ configuration: options.broker, ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }), now, boundaryForRequest: async (request) => {
    const context = await options.loadRuntimeContext({ organizationId: request.scope.orgId, customerId: request.scope.customerId, connectionId: request.scope.connectionId });
    if (JSON.stringify(context.boundary.scope) !== JSON.stringify(request.scope) || JSON.stringify(context.boundary.exportTarget) !== JSON.stringify(request.target)) throw new Error("CORA_RUNTIME_BOUNDARY_CHANGED"); return context.boundary;
  } });
  const handler = async (job: RunnableJob): Promise<void> => {
    if (job.customerId === null || job.connectionId === null || typeof job.payload !== "object" || job.payload === null || Array.isArray(job.payload)) throw new Error("CORA_RUNTIME_JOB_INVALID");
    const payload = job.payload as Record<string, unknown>; if (Object.keys(payload).length !== 1 || typeof payload.scheduledWindow !== "string") throw new Error("CORA_RUNTIME_JOB_INVALID");
    const scope = { organizationId: job.orgId, customerId: job.customerId, connectionId: job.connectionId }; const context = await options.loadRuntimeContext(scope); const requestKey = await deriveCoraExportRequestKey(context.boundary, payload.scheduledWindow); const identity = { ...scope, requestKey, jobId: job.id, scheduledWindow: payload.scheduledWindow, jobAttempt: job.attempt, maxAttempts: job.maxAttempts };
    const lease = await attempts.prepare(identity); if (lease.state === "replayed") return; if (await attempts.recoverPersistedGeneration(identity) !== null) return;
    try {
      const result = await runCoraExportMaterializationJob(job, { loadRuntimeContext: options.loadRuntimeContext, adapter, recordExport: exports.recordMaterialization.bind(exports), listAcceptedExports: exports.listAcceptedHistory.bind(exports), recordCoraCapture: snapshots.recordCapture.bind(snapshots), now });
      await attempts.commitSuccess({ ...identity, generationId: result.exportGenerationId, completedAtMs: now() });
    } catch (error) {
      const named = error instanceof Error ? error.name : ""; const code: CoraRuntimeFailureCode = named.includes("SignedBroker") && "code" in (error as object) && (error as { code?: unknown }).code === "BROKER_TIMEOUT" ? "ADAPTER_TIMEOUT"
        : named.includes("Materialization") || named.includes("Boundary") ? "CAPTURE_REJECTED"
          : named.includes("Repository") ? "PERSISTENCE_REJECTED" : "ADAPTER_UNAVAILABLE";
      await attempts.recordFailure({ ...identity, code, terminal: job.attempt >= job.maxAttempts, completedAtMs: now() }); throw new Error(`CORA_RUNTIME_${code}`);
    }
  };
  return Object.freeze({ schemaVersion: CORA_PRODUCTION_COMPOSITION_SCHEMA, handler,
    scheduleTick: (scheduledAtMs: number) => scheduleCoraCollections({ scheduledAtMs, listEligibleScopes: options.listEligibleScopes, queue }), exportRepository: exports, snapshotRepository: snapshots, attemptRepository: attempts });
}

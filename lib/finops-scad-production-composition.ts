/** Unique production composition for ADD-07; shared handler registration is intentionally external. */
import { ScadAllocationRepository, type ScadPersistenceScope } from "../db/finops-scad-allocation-repository.ts";
import { ScadCur2RuntimeAttemptRepository } from "../db/finops-scad-runtime-attempt-repository.ts";
import { ScadCur2RuntimeAdapter, type ScadCur2RuntimeBoundary } from "./finops-scad-cur2-runtime-adapter.ts";
import { createScadCur2RuntimeJobHandler, scheduleScadCur2Collections,
  type ScadCur2RuntimeDependencies, type ScadCur2RuntimeQueue } from "./finops-scad-durable-runtime-binding.ts";
import { createScadCur2SignedProvider, type ScadCur2SignedProviderTransport } from "./finops-scad-signed-provider.ts";

export interface ScadCur2ProductionCompositionInput {
  readonly jobId: string; readonly scheduledWindow: string;
  readonly transport: ScadCur2SignedProviderTransport;
  readonly loadBoundary: (scope: ScadPersistenceScope) => Promise<ScadCur2RuntimeBoundary>;
  readonly snapshotRepository?: ScadAllocationRepository;
  readonly replayRepository?: ScadCur2RuntimeAttemptRepository;
  readonly now?: () => number;
}
export function createScadCur2ProductionComposition(input: ScadCur2ProductionCompositionInput) {
  const snapshotRepository = input.snapshotRepository ?? new ScadAllocationRepository();
  const replayRepository = input.replayRepository ?? new ScadCur2RuntimeAttemptRepository();
  const provider = createScadCur2SignedProvider({ jobId: input.jobId,
    scheduledWindow: input.scheduledWindow, transport: input.transport });
  const record: ScadCur2RuntimeDependencies["record"] = (scope, trusted, capture, nowMs) =>
    snapshotRepository.recordCapture(scope, trusted, capture, nowMs);
  const dependencies: ScadCur2RuntimeDependencies = Object.freeze({ loadBoundary: input.loadBoundary,
    adapter: new ScadCur2RuntimeAdapter(provider, input.now),
    record,
    replayStore: replayRepository, ...(input.now === undefined ? {} : { now: input.now }) });
  return Object.freeze({ dependencies, handler: createScadCur2RuntimeJobHandler(dependencies),
    schedule: (scheduledWindow: string, loadEligibleScopes: () => Promise<readonly ScadPersistenceScope[]>,
      queue: ScadCur2RuntimeQueue) => scheduleScadCur2Collections({ scheduledWindow, loadEligibleScopes, queue }),
    providerRoute: "/v1/finops/scad/cur2-provider" as const,
    permissionContract: "foundational-cur2-export-v1" as const,
    registeredInSharedRuntime: false as const });
}

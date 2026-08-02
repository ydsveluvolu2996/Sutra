/** Production-grade ADD-08 composition, intentionally separate from shared registries. */
import { SustainabilityRuntimeRepository } from "../db/finops-sustainability-runtime-repository.ts";
import {
  createSustainabilityCarbonRuntimeJobHandler,
  scheduleSustainabilityCarbonCollections,
  type SustainabilityCarbonEvidenceArchive,
  type SustainabilityCarbonEvidenceSealer,
  type SustainabilityCarbonRuntimeMaterializer,
  type SustainabilityCarbonRuntimeQueue,
  type SustainabilityCarbonServerBoundary,
} from "./finops-sustainability-carbon-runtime-binding.ts";
import type { SustainabilityPersistenceScope } from "../db/finops-sustainability-carbon-repository.ts";

export interface SustainabilityCarbonProductionPorts {
  readonly loadBoundary: (scope: SustainabilityPersistenceScope) => Promise<SustainabilityCarbonServerBoundary | null>;
  readonly loadEligibleScopes: () => Promise<readonly SustainabilityPersistenceScope[]>;
  readonly materializer: SustainabilityCarbonRuntimeMaterializer;
  readonly evidence: SustainabilityCarbonEvidenceArchive;
  readonly sealer: SustainabilityCarbonEvidenceSealer;
  readonly queue: SustainabilityCarbonRuntimeQueue;
  readonly now?: () => number;
}

export function createSustainabilityCarbonProductionComposition(ports: SustainabilityCarbonProductionPorts) {
  const dependencies = {
    loadBoundary: ports.loadBoundary,
    materializer: ports.materializer,
    evidence: ports.evidence,
    sealer: ports.sealer,
    handoff: new SustainabilityRuntimeRepository(),
    ...(ports.now === undefined ? {} : { now: ports.now }),
  };
  return Object.freeze({
    schemaVersion: "sutra.sustainability-carbon-production-composition.v1" as const,
    handler: createSustainabilityCarbonRuntimeJobHandler(dependencies),
    schedule: (scheduledWindow: string) => scheduleSustainabilityCarbonCollections({
      loadEligibleScopes: ports.loadEligibleScopes, queue: ports.queue, scheduledWindow,
    }),
    durability: Object.freeze({ acceptedAttemptReplay: true, immutableFailureAudit: true,
      immutableSnapshotHistory: true, currentEmptyOnlyHeadAdvancement: true }),
    separation: Object.freeze({ proxyToCarbonConversion: false,
      providerCarbonWorkloadAllocation: false, directApiComparatorAsExportHistory: false }),
  });
}

/** Credential-free materialization contract for cross-service Graviton evidence. */
import {
  GRAVITON_SAVINGS_BOUNDS,
  GRAVITON_SAVINGS_READ_OPERATIONS,
  type GravitonSavingsCapture,
  type GravitonTenantBoundary,
} from "./finops-graviton-savings.ts";

export interface GravitonMaterializationRequest {
  readonly schemaVersion: "sutra.graviton-materialization-request.v1";
  readonly requestKey: `gvrq_${string}`;
  readonly scheduledWindow: string;
  readonly boundary: GravitonTenantBoundary;
  readonly operations: typeof GRAVITON_SAVINGS_READ_OPERATIONS;
  readonly services: readonly ["EC2_AND_AUTO_SCALING", "RDS_AND_AURORA", "OPENSEARCH", "ELASTICACHE"];
  readonly recommendationPolicy: {
    readonly computeOptimizerAccepted: true;
    readonly managedServiceInventoryPricingAcceptedOnlyWithAllCompatibilityDimensions: true;
    readonly inferCompatibilityFromFamilyName: false;
    readonly inferSavingsWithoutPeriodMatchedCur2AndPricing: false;
  };
  readonly bounds: typeof GRAVITON_SAVINGS_BOUNDS;
  readonly deadlineAtIso: string;
}
export interface GravitonSignedCollector {
  collect(request: GravitonMaterializationRequest, signal: AbortSignal): Promise<GravitonSavingsCapture>;
}
export interface GravitonSnapshotStore {
  recordCapture(boundary: GravitonTenantBoundary, capture: GravitonSavingsCapture, nowMs: number): Promise<{
    readonly generation: { readonly generationId: string; readonly snapshot: { readonly collectionId: string; readonly state: string } };
    readonly becameActive: boolean;
  }>;
}
export class GravitonMaterializationJobError extends Error {
  public constructor() { super("Graviton materialization failed"); this.name = "GravitonMaterializationJobError"; }
}
function sameBoundary(capture: GravitonSavingsCapture, boundary: GravitonTenantBoundary): boolean {
  return capture.scope.orgId === boundary.scope.orgId && capture.scope.customerId === boundary.scope.customerId
    && capture.scope.connectionId === boundary.scope.connectionId && capture.managementAccountId === boundary.managementAccountId
    && capture.partition === boundary.partition && JSON.stringify(capture.accountIds) === JSON.stringify(boundary.accountIds)
    && JSON.stringify(capture.regions) === JSON.stringify(boundary.regions);
}
export async function runGravitonMaterializationJob(input: {
  readonly requestKey: `gvrq_${string}`; readonly scheduledWindow: string; readonly boundary: GravitonTenantBoundary;
  readonly collector: GravitonSignedCollector; readonly store: GravitonSnapshotStore; readonly nowMs?: number;
}) {
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !/^gvrq_[a-f0-9]{64}$/u.test(input.requestKey)
    || !/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u.test(input.scheduledWindow)) throw new GravitonMaterializationJobError();
  const request: GravitonMaterializationRequest = Object.freeze({
    schemaVersion: "sutra.graviton-materialization-request.v1", requestKey: input.requestKey,
    scheduledWindow: input.scheduledWindow,
    boundary: Object.freeze({ ...input.boundary, scope: Object.freeze({ ...input.boundary.scope }),
      accountIds: Object.freeze([...input.boundary.accountIds]), regions: Object.freeze([...input.boundary.regions]) }),
    operations: GRAVITON_SAVINGS_READ_OPERATIONS,
    services: ["EC2_AND_AUTO_SCALING", "RDS_AND_AURORA", "OPENSEARCH", "ELASTICACHE"] as const,
    recommendationPolicy: Object.freeze({ computeOptimizerAccepted: true,
      managedServiceInventoryPricingAcceptedOnlyWithAllCompatibilityDimensions: true,
      inferCompatibilityFromFamilyName: false, inferSavingsWithoutPeriodMatchedCur2AndPricing: false }),
    bounds: GRAVITON_SAVINGS_BOUNDS,
    deadlineAtIso: new Date(nowMs + GRAVITON_SAVINGS_BOUNDS.maximumDurationMs).toISOString(),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAVITON_SAVINGS_BOUNDS.maximumDurationMs);
  const timeout = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new GravitonMaterializationJobError()), { once: true }));
  try {
    const capture = await Promise.race([input.collector.collect(request, controller.signal), timeout]);
    if (!sameBoundary(capture, input.boundary)) throw new GravitonMaterializationJobError();
    const stored = await input.store.recordCapture(input.boundary, capture, nowMs);
    return { generationId: stored.generation.generationId, sourceCollectionId: stored.generation.snapshot.collectionId,
      state: stored.generation.snapshot.state, becameActive: stored.becameActive };
  } catch { throw new GravitonMaterializationJobError(); }
  finally { clearTimeout(timer); controller.abort(); }
}

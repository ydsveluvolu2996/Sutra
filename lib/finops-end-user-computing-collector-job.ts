/** Credential-free permanent-job contract for the privacy-safe EUC collector. */
import {
  END_USER_COMPUTING_COLLECTION_BOUNDS,
  END_USER_COMPUTING_READ_OPERATIONS,
  type EndUserComputingBoundary,
  type EndUserComputingCapture,
} from "./finops-end-user-computing.ts";

export interface EndUserComputingCollectorRequest {
  readonly schemaVersion: "sutra.end-user-computing-collector-request.v1";
  readonly boundary: EndUserComputingBoundary;
  readonly operations: typeof END_USER_COMPUTING_READ_OPERATIONS;
  readonly bounds: typeof END_USER_COMPUTING_COLLECTION_BOUNDS;
  readonly canonicalBillingSource: "ACTIVE_RECONCILED_CUR2_GENERATION";
  readonly privacy: {
    readonly includeUserIdentifiers: false;
    readonly includeSessionIdentifiers: false;
    readonly includeInstanceIdentifiers: false;
    readonly includeNetworkAddresses: false;
    readonly includeRawProviderMessages: false;
  };
  readonly deadlineAtIso: string;
}

export interface EndUserComputingSignedBroker {
  collect(request: EndUserComputingCollectorRequest): Promise<EndUserComputingCapture>;
}

export interface EndUserComputingCaptureStore {
  recordCapture(boundary: EndUserComputingBoundary, capture: EndUserComputingCapture, nowMs: number): Promise<{
    readonly generation: { readonly generationId: string; readonly snapshot: { readonly captureId: string; readonly state: string } };
    readonly becameActive: boolean;
  }>;
}

export class EndUserComputingCollectorJobError extends Error {
  public constructor() {
    super("End User Computing collection job failed");
    this.name = "EndUserComputingCollectorJobError";
  }
}

function sameBoundary(left: EndUserComputingBoundary, right: EndUserComputingBoundary): boolean {
  return left.scope.orgId === right.scope.orgId && left.scope.customerId === right.scope.customerId
    && left.scope.connectionId === right.scope.connectionId && left.partition === right.partition
    && JSON.stringify(left.accountIds) === JSON.stringify(right.accountIds)
    && JSON.stringify(left.regions) === JSON.stringify(right.regions);
}

export async function runEndUserComputingCollectionJob(input: {
  readonly boundary: EndUserComputingBoundary;
  readonly broker: EndUserComputingSignedBroker;
  readonly store: EndUserComputingCaptureStore;
  readonly nowMs?: number;
}): Promise<{ readonly generationId: string; readonly sourceCaptureId: string; readonly state: string; readonly becameActive: boolean }> {
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new EndUserComputingCollectorJobError();
  const request: EndUserComputingCollectorRequest = Object.freeze({
    schemaVersion: "sutra.end-user-computing-collector-request.v1",
    boundary: Object.freeze({ ...input.boundary, scope: Object.freeze({ ...input.boundary.scope }), accountIds: Object.freeze([...input.boundary.accountIds]), regions: Object.freeze([...input.boundary.regions]) }),
    operations: END_USER_COMPUTING_READ_OPERATIONS,
    bounds: END_USER_COMPUTING_COLLECTION_BOUNDS,
    canonicalBillingSource: "ACTIVE_RECONCILED_CUR2_GENERATION",
    privacy: Object.freeze({ includeUserIdentifiers: false, includeSessionIdentifiers: false, includeInstanceIdentifiers: false, includeNetworkAddresses: false, includeRawProviderMessages: false }),
    deadlineAtIso: new Date(nowMs + END_USER_COMPUTING_COLLECTION_BOUNDS.maximumDurationMs).toISOString(),
  });
  try {
    const capture = await input.broker.collect(request);
    const supplied: EndUserComputingBoundary = { scope: capture.scope, partition: capture.partition, accountIds: capture.accountIds, regions: capture.regions };
    if (!sameBoundary(supplied, input.boundary)) throw new EndUserComputingCollectorJobError();
    const stored = await input.store.recordCapture(input.boundary, capture, nowMs);
    return { generationId: stored.generation.generationId, sourceCaptureId: stored.generation.snapshot.captureId, state: stored.generation.snapshot.state, becameActive: stored.becameActive };
  } catch {
    throw new EndUserComputingCollectorJobError();
  }
}

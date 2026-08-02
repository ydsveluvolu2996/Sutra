/** Server-owned multi-account/Region materialization contract for Extended Support. */
import {
  EXTENDED_SUPPORT_PROJECTION_BOUNDS,
  EXTENDED_SUPPORT_READ_OPERATIONS,
  type ExtendedSupportProjectionCapture,
  type ExtendedSupportTenantBoundary,
} from "./finops-extended-support-projection.ts";

const JOB_ID = /^job_[a-f0-9]{32}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;

export interface ExtendedSupportCollectorRequest {
  readonly schemaVersion: "sutra.extended-support-collector-request.v1";
  readonly jobId: string;
  readonly scheduledWindow: string;
  readonly boundary: ExtendedSupportTenantBoundary;
  readonly operations: typeof EXTENDED_SUPPORT_READ_OPERATIONS;
  readonly bounds: typeof EXTENDED_SUPPORT_PROJECTION_BOUNDS;
  readonly inventoryScope: "SERVER_PINNED_ACCOUNT_REGION_FANOUT";
  readonly lifecycleSource: "AUTHORITATIVE_AWS_API_OR_DOCUMENTATION";
  readonly pricingSource: "AWS_PRICE_LIST_OR_PUBLIC_PRICING";
  readonly actualCostSource: "ACTIVE_RECONCILED_CUR2_GENERATION";
  readonly deadlineAtIso: string;
}

export interface ExtendedSupportSignedBroker {
  collect(request: ExtendedSupportCollectorRequest): Promise<ExtendedSupportProjectionCapture>;
}

export interface ExtendedSupportCaptureStore {
  recordCapture(
    boundary: ExtendedSupportTenantBoundary,
    capture: ExtendedSupportProjectionCapture,
    nowMs: number,
  ): Promise<{
    readonly snapshot: {
      readonly generationId: string;
      readonly snapshot: { readonly collectionId: string; readonly state: string };
    };
    readonly becameActive: boolean;
  }>;
}

export class ExtendedSupportCollectorJobError extends Error {
  public constructor() {
    super("Extended Support collection job failed");
    this.name = "ExtendedSupportCollectorJobError";
  }
}

function same(
  capture: ExtendedSupportProjectionCapture,
  boundary: ExtendedSupportTenantBoundary,
): boolean {
  return capture.scope.orgId === boundary.scope.orgId
    && capture.scope.customerId === boundary.scope.customerId
    && capture.scope.connectionId === boundary.scope.connectionId
    && capture.managementAccountId === boundary.managementAccountId
    && capture.partition === boundary.partition
    && JSON.stringify(capture.accountIds) === JSON.stringify(boundary.accountIds)
    && JSON.stringify(capture.regions) === JSON.stringify(boundary.regions);
}

export async function runExtendedSupportCollectionJob(input: {
  readonly jobId: string;
  readonly scheduledWindow: string;
  readonly boundary: ExtendedSupportTenantBoundary;
  readonly broker: ExtendedSupportSignedBroker;
  readonly store: ExtendedSupportCaptureStore;
  readonly nowMs?: number;
}) {
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !JOB_ID.test(input.jobId)
    || !WINDOW.test(input.scheduledWindow)
    || new Date(Date.parse(input.scheduledWindow)).toISOString() !== input.scheduledWindow) {
    throw new ExtendedSupportCollectorJobError();
  }
  const request: ExtendedSupportCollectorRequest = Object.freeze({
    schemaVersion: "sutra.extended-support-collector-request.v1",
    jobId: input.jobId,
    scheduledWindow: input.scheduledWindow,
    boundary: Object.freeze({
      ...input.boundary,
      scope: Object.freeze({ ...input.boundary.scope }),
      accountIds: Object.freeze([...input.boundary.accountIds]),
      regions: Object.freeze([...input.boundary.regions]),
    }),
    operations: EXTENDED_SUPPORT_READ_OPERATIONS,
    bounds: EXTENDED_SUPPORT_PROJECTION_BOUNDS,
    inventoryScope: "SERVER_PINNED_ACCOUNT_REGION_FANOUT",
    lifecycleSource: "AUTHORITATIVE_AWS_API_OR_DOCUMENTATION",
    pricingSource: "AWS_PRICE_LIST_OR_PUBLIC_PRICING",
    actualCostSource: "ACTIVE_RECONCILED_CUR2_GENERATION",
    deadlineAtIso: new Date(nowMs + EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumDurationMs)
      .toISOString(),
  });
  try {
    const capture = await input.broker.collect(request);
    if (!same(capture, input.boundary)) throw new ExtendedSupportCollectorJobError();
    const stored = await input.store.recordCapture(input.boundary, capture, nowMs);
    return {
      generationId: stored.snapshot.generationId,
      collectionId: stored.snapshot.snapshot.collectionId,
      state: stored.snapshot.snapshot.state,
      becameActive: stored.becameActive,
    };
  } catch {
    throw new ExtendedSupportCollectorJobError();
  }
}

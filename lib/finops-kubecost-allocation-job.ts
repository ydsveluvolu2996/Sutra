/** Credential-free materialization job for a versioned Kubecost/OpenCost export. */
import {
  KUBECOST_ALLOCATION_BOUNDS,
  KUBECOST_EXPORT_CONTRACT,
  KUBECOST_RUNTIME_S3_READ_IAM_ACTIONS,
  KUBECOST_SSE_KMS_READ_IAM_ACTIONS,
  KUBECOST_VERSIONED_OBJECT_READ_IAM_ACTIONS,
  type KubecostAllocationCapture,
  type KubecostAllocationScope,
} from "./finops-kubecost-allocation.ts";

export interface KubecostMaterializationRequest {
  readonly schemaVersion: "sutra.kubecost-materialization-request.v1";
  readonly scope: KubecostAllocationScope;
  readonly destination: { readonly bucket: string; readonly prefix: string; readonly expectedBucketOwner: string };
  readonly exportContract: typeof KUBECOST_EXPORT_CONTRACT;
  readonly runtimeReadActions: typeof KUBECOST_RUNTIME_S3_READ_IAM_ACTIONS;
  readonly versionedReadActions: typeof KUBECOST_VERSIONED_OBJECT_READ_IAM_ACTIONS;
  readonly conditionalKmsActions: typeof KUBECOST_SSE_KMS_READ_IAM_ACTIONS;
  readonly authoritativeSpendSource: "AWS_CUR2_ACTIVE_GENERATION";
  readonly bounds: typeof KUBECOST_ALLOCATION_BOUNDS;
  readonly deadlineAtIso: string;
}

export interface KubecostSignedExporterIngest { collect(request: KubecostMaterializationRequest): Promise<KubecostAllocationCapture> }
export interface KubecostSnapshotStore { recordCapture(scope: KubecostAllocationScope, capture: KubecostAllocationCapture, nowMs: number): Promise<{ readonly generation: { readonly generationId: string; readonly snapshot: { readonly captureId: string; readonly state: string } }; readonly becameActive: boolean }> }
export class KubecostMaterializationJobError extends Error { public constructor() { super("Kubecost allocation materialization failed"); this.name = "KubecostMaterializationJobError"; } }

function sameScope(left: KubecostAllocationScope, right: KubecostAllocationScope): boolean {
  return left.orgId === right.orgId && left.customerId === right.customerId && left.connectionId === right.connectionId
    && left.partition === right.partition && left.billingPeriod === right.billingPeriod
    && left.activeCur2GenerationId === right.activeCur2GenerationId
    && JSON.stringify(left.awsAccountIds) === JSON.stringify(right.awsAccountIds)
    && JSON.stringify(left.clusterIds) === JSON.stringify(right.clusterIds);
}

export async function runKubecostMaterializationJob(input: {
  readonly scope: KubecostAllocationScope;
  readonly destination: KubecostMaterializationRequest["destination"];
  readonly ingest: KubecostSignedExporterIngest;
  readonly store: KubecostSnapshotStore;
  readonly nowMs?: number;
}): Promise<{ readonly generationId: string; readonly sourceCaptureId: string; readonly state: string; readonly becameActive: boolean }> {
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !/^\d{12}$/u.test(input.destination.expectedBucketOwner)
    || !input.destination.prefix.endsWith("/") || input.destination.prefix.includes("..")) throw new KubecostMaterializationJobError();
  const request: KubecostMaterializationRequest = Object.freeze({
    schemaVersion: "sutra.kubecost-materialization-request.v1",
    scope: Object.freeze({ ...input.scope, awsAccountIds: Object.freeze([...input.scope.awsAccountIds]), clusterIds: Object.freeze([...input.scope.clusterIds]) }),
    destination: Object.freeze({ ...input.destination }), exportContract: KUBECOST_EXPORT_CONTRACT,
    runtimeReadActions: KUBECOST_RUNTIME_S3_READ_IAM_ACTIONS, versionedReadActions: KUBECOST_VERSIONED_OBJECT_READ_IAM_ACTIONS,
    conditionalKmsActions: KUBECOST_SSE_KMS_READ_IAM_ACTIONS, authoritativeSpendSource: "AWS_CUR2_ACTIVE_GENERATION",
    bounds: KUBECOST_ALLOCATION_BOUNDS, deadlineAtIso: new Date(nowMs + KUBECOST_ALLOCATION_BOUNDS.maximumCaptureDurationMs).toISOString(),
  });
  try {
    const capture = await input.ingest.collect(request);
    if (!sameScope(capture.scope, input.scope) || capture.destination.bucket !== input.destination.bucket
      || capture.destination.prefix !== input.destination.prefix) throw new KubecostMaterializationJobError();
    const stored = await input.store.recordCapture(input.scope, capture, nowMs);
    return { generationId: stored.generation.generationId, sourceCaptureId: stored.generation.snapshot.captureId, state: stored.generation.snapshot.state, becameActive: stored.becameActive };
  } catch { throw new KubecostMaterializationJobError(); }
}

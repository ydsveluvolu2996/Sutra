/**
 * Credential-free orchestration contract for the permanent AWS Budgets job.
 * The signed broker owns temporary credentials and must return the bounded
 * capture; this module cannot call AWS, mutate budgets, or read Sutra budgets.
 */
import {
  AWS_BUDGETS_COLLECTION_BOUNDS,
  AWS_BUDGETS_ORGANIZATION_READ_IAM_ACTIONS,
  AWS_BUDGETS_READ_API_OPERATIONS,
  type AwsBudgetsCapture,
  type AwsBudgetsScope,
  type AwsOrganizationHierarchyEvidence,
} from "./finops-aws-budgets-organization.ts";

export interface AwsBudgetsBrokerRequest {
  readonly schemaVersion: "sutra.aws-budgets-broker-request.v1";
  readonly scope: AwsBudgetsScope;
  readonly budgetOperations: typeof AWS_BUDGETS_READ_API_OPERATIONS;
  readonly organizationOperations: typeof AWS_BUDGETS_ORGANIZATION_READ_IAM_ACTIONS;
  readonly budgetHierarchyTagKey: "cid:budget-level";
  readonly bounds: typeof AWS_BUDGETS_COLLECTION_BOUNDS;
  readonly deadlineAtIso: string;
}

export interface AwsBudgetsBrokerResponse {
  readonly capture: AwsBudgetsCapture;
  readonly hierarchy: AwsOrganizationHierarchyEvidence | null;
}

export interface AwsBudgetsSignedBroker {
  collect(request: AwsBudgetsBrokerRequest): Promise<AwsBudgetsBrokerResponse>;
}

export interface AwsBudgetsCaptureStore {
  recordCapture(
    scope: AwsBudgetsScope,
    capture: AwsBudgetsCapture,
    hierarchy: AwsOrganizationHierarchyEvidence | null,
    nowMs: number,
  ): Promise<{
    readonly generation: { readonly generationId: string; readonly snapshot: { readonly captureId: string; readonly collectionState: string } };
    readonly becameActive: boolean;
  }>;
}

export interface AwsBudgetsCollectionJobResult {
  readonly source: "AWS_BUDGETS";
  readonly generationId: string;
  readonly sourceCaptureId: string;
  readonly state: string;
  readonly becameActive: boolean;
}

export class AwsBudgetsCollectorJobError extends Error {
  public constructor() {
    super("AWS Budgets collection job failed");
    this.name = "AwsBudgetsCollectorJobError";
  }
}

function sameScope(left: AwsBudgetsScope, right: AwsBudgetsScope): boolean {
  return left.orgId === right.orgId && left.customerId === right.customerId
    && left.connectionId === right.connectionId && left.accountId === right.accountId
    && left.partition === right.partition;
}

export async function runAwsBudgetsCollectionJob(input: {
  readonly scope: AwsBudgetsScope;
  readonly broker: AwsBudgetsSignedBroker;
  readonly store: AwsBudgetsCaptureStore;
  readonly nowMs?: number;
}): Promise<AwsBudgetsCollectionJobResult> {
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new AwsBudgetsCollectorJobError();
  const request: AwsBudgetsBrokerRequest = Object.freeze({
    schemaVersion: "sutra.aws-budgets-broker-request.v1",
    scope: Object.freeze({ ...input.scope }),
    budgetOperations: AWS_BUDGETS_READ_API_OPERATIONS,
    organizationOperations: AWS_BUDGETS_ORGANIZATION_READ_IAM_ACTIONS,
    budgetHierarchyTagKey: "cid:budget-level",
    bounds: AWS_BUDGETS_COLLECTION_BOUNDS,
    deadlineAtIso: new Date(nowMs + 30 * 60 * 1_000).toISOString(),
  });
  try {
    const response = await input.broker.collect(request);
    if (!sameScope(response.capture.scope, input.scope)
      || (response.hierarchy !== null && !sameScope({
        ...input.scope,
        ...response.hierarchy.scope,
      }, input.scope))) throw new AwsBudgetsCollectorJobError();
    const stored = await input.store.recordCapture(
      input.scope, response.capture, response.hierarchy, nowMs,
    );
    return {
      source: "AWS_BUDGETS",
      generationId: stored.generation.generationId,
      sourceCaptureId: stored.generation.snapshot.captureId,
      state: stored.generation.snapshot.collectionState,
      becameActive: stored.becameActive,
    };
  } catch {
    // Broker/provider diagnostics must be translated to bounded evidence by
    // the adapter; raw provider messages never cross this job boundary.
    throw new AwsBudgetsCollectorJobError();
  }
}

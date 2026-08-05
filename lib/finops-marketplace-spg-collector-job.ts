/** Credential-free server-owned collection contract for Marketplace buyer evidence. */
import {
  AWS_MARKETPLACE_ACCOUNT_COVERAGE_IAM_ACTIONS,
  AWS_MARKETPLACE_BUYER_API_OPERATIONS,
  AWS_MARKETPLACE_LICENSE_MANAGER_API_OPERATIONS,
  AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS,
  type AwsMarketplaceSpgCapture,
  type AwsMarketplaceSpgScope,
} from "./finops-marketplace-spg.ts";

export interface AwsMarketplaceSpgCollectorRequest {
  readonly schemaVersion: "sutra.aws-marketplace-spg-collector-request.v1";
  readonly scope: AwsMarketplaceSpgScope;
  readonly buyerOperations: typeof AWS_MARKETPLACE_BUYER_API_OPERATIONS;
  readonly licenseOperations: typeof AWS_MARKETPLACE_LICENSE_MANAGER_API_OPERATIONS;
  readonly accountCoverageActions: typeof AWS_MARKETPLACE_ACCOUNT_COVERAGE_IAM_ACTIONS;
  readonly bounds: typeof AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS;
  readonly billingSource: "ACTIVE_RECONCILED_CUR2_GENERATION";
  readonly buyerParty: "Acceptor";
  readonly privacy: {
    readonly includeRegistrationTokens: false;
    readonly includePurchaseOrderReferences: false;
    readonly includeLegalDocumentsOrUrls: false;
    readonly includeContacts: false;
    readonly includeProviderErrorText: false;
    readonly includeTemporaryEmbedUrls: false;
  };
  readonly deadlineAtIso: string;
}

export interface AwsMarketplaceSpgSignedBroker {
  collect(request: AwsMarketplaceSpgCollectorRequest): Promise<AwsMarketplaceSpgCapture>;
}

export interface AwsMarketplaceSpgCaptureStore {
  recordCapture(scope: AwsMarketplaceSpgScope, capture: AwsMarketplaceSpgCapture, nowMs: number): Promise<{
    readonly snapshot: { readonly generationId: string; readonly snapshot: { readonly captureId: string; readonly state: string } };
    readonly becameActive: boolean;
  }>;
}

export class AwsMarketplaceSpgCollectorJobError extends Error {
  public constructor() {
    super("AWS Marketplace SPG collection job failed");
    this.name = "AwsMarketplaceSpgCollectorJobError";
  }
}

function sameScope(left: AwsMarketplaceSpgScope, right: AwsMarketplaceSpgScope): boolean {
  return left.orgId === right.orgId && left.customerId === right.customerId
    && left.connectionId === right.connectionId && left.accountId === right.accountId
    && left.partition === right.partition && left.awsOrganizationId === right.awsOrganizationId;
}

export async function runAwsMarketplaceSpgCollectionJob(input: {
  readonly scope: AwsMarketplaceSpgScope;
  readonly broker: AwsMarketplaceSpgSignedBroker;
  readonly store: AwsMarketplaceSpgCaptureStore;
  readonly nowMs?: number;
}): Promise<{ readonly generationId: string; readonly captureId: string; readonly state: string; readonly becameActive: boolean }> {
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || input.scope.partition !== "aws") {
    throw new AwsMarketplaceSpgCollectorJobError();
  }
  const request: AwsMarketplaceSpgCollectorRequest = Object.freeze({
    schemaVersion: "sutra.aws-marketplace-spg-collector-request.v1",
    scope: Object.freeze({ ...input.scope }),
    buyerOperations: AWS_MARKETPLACE_BUYER_API_OPERATIONS,
    licenseOperations: AWS_MARKETPLACE_LICENSE_MANAGER_API_OPERATIONS,
    accountCoverageActions: AWS_MARKETPLACE_ACCOUNT_COVERAGE_IAM_ACTIONS,
    bounds: AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS,
    billingSource: "ACTIVE_RECONCILED_CUR2_GENERATION",
    buyerParty: "Acceptor",
    privacy: Object.freeze({
      includeRegistrationTokens: false,
      includePurchaseOrderReferences: false,
      includeLegalDocumentsOrUrls: false,
      includeContacts: false,
      includeProviderErrorText: false,
      includeTemporaryEmbedUrls: false,
    }),
    deadlineAtIso: new Date(nowMs + 15 * 60 * 1_000).toISOString(),
  });
  try {
    const capture = await input.broker.collect(request);
    if (!sameScope(capture.scope, input.scope)) throw new AwsMarketplaceSpgCollectorJobError();
    const stored = await input.store.recordCapture(input.scope, capture, nowMs);
    return {
      generationId: stored.snapshot.generationId,
      captureId: stored.snapshot.snapshot.captureId,
      state: stored.snapshot.snapshot.state,
      becameActive: stored.becameActive,
    };
  } catch {
    throw new AwsMarketplaceSpgCollectorJobError();
  }
}

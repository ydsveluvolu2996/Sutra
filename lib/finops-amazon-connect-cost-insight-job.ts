/** Server-owned materialization contract for privacy-minimized Connect evidence. */
import {
  AMAZON_CONNECT_COST_INSIGHT_BOUNDS,
  AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS,
  type AmazonConnectCostInsightCapture,
  type AmazonConnectScope,
} from "./finops-amazon-connect-cost-insight.ts";

export interface AmazonConnectCostInsightMaterializationRequest {
  readonly schemaVersion: "sutra.amazon-connect-cost-insight-materialization-request.v1";
  readonly scope: AmazonConnectScope;
  readonly operations: typeof AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS;
  readonly bounds: typeof AMAZON_CONNECT_COST_INSIGHT_BOUNDS;
  readonly billingSource: "AWS_CUR2_ACTIVE_GENERATION";
  readonly privacy: {
    readonly rawContactRecordsAccepted: false; readonly rawPhoneNumbersAccepted: false;
    readonly rawCallerIdentityAccepted: false; readonly rawEndpointAddressesAccepted: false;
    readonly tokenization: "HMAC_SHA256_TENANT_SCOPED_ROTATING";
  };
  readonly deadlineAtIso: string;
}
export interface AmazonConnectCostInsightBroker { collect(request: AmazonConnectCostInsightMaterializationRequest): Promise<AmazonConnectCostInsightCapture>; }
export interface AmazonConnectCostInsightStore { recordCapture(scope: AmazonConnectScope, capture: AmazonConnectCostInsightCapture, nowMs: number): Promise<{ readonly snapshot: { readonly generationId: string; readonly snapshot: { readonly captureId: string; readonly state: string } }; readonly becameActive: boolean }>; }
export class AmazonConnectCostInsightJobError extends Error { public constructor() { super("Amazon Connect cost materialization failed"); this.name = "AmazonConnectCostInsightJobError"; } }
function sameScope(a: AmazonConnectScope, b: AmazonConnectScope): boolean { return a.orgId === b.orgId && a.customerId === b.customerId && a.connectionId === b.connectionId && a.accountId === b.accountId && a.partition === b.partition && a.region === b.region && JSON.stringify(a.instanceArns) === JSON.stringify(b.instanceArns); }
export async function runAmazonConnectCostInsightMaterialization(input: { readonly scope: AmazonConnectScope; readonly broker: AmazonConnectCostInsightBroker; readonly store: AmazonConnectCostInsightStore; readonly nowMs?: number }) {
  const nowMs = input.nowMs ?? Date.now(); if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new AmazonConnectCostInsightJobError();
  const request: AmazonConnectCostInsightMaterializationRequest = Object.freeze({ schemaVersion: "sutra.amazon-connect-cost-insight-materialization-request.v1",
    scope: Object.freeze({ ...input.scope, instanceArns: Object.freeze([...input.scope.instanceArns]) }), operations: AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS,
    bounds: AMAZON_CONNECT_COST_INSIGHT_BOUNDS, billingSource: "AWS_CUR2_ACTIVE_GENERATION", privacy: Object.freeze({ rawContactRecordsAccepted: false,
      rawPhoneNumbersAccepted: false, rawCallerIdentityAccepted: false, rawEndpointAddressesAccepted: false, tokenization: "HMAC_SHA256_TENANT_SCOPED_ROTATING" }),
    deadlineAtIso: new Date(nowMs + AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumDurationMs).toISOString() });
  try { const capture = await input.broker.collect(request); if (!sameScope(capture.scope, input.scope)) throw new AmazonConnectCostInsightJobError();
    const stored = await input.store.recordCapture(input.scope, capture, nowMs); return { generationId: stored.snapshot.generationId, captureId: stored.snapshot.snapshot.captureId,
      state: stored.snapshot.snapshot.state, becameActive: stored.becameActive };
  } catch { throw new AmazonConnectCostInsightJobError(); }
}

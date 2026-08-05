/** Credential-free materialization boundary for GCP Cloud Billing exports. */
import { GCP_BILLING_EXPORT_READ_PERMISSIONS, normalizeGcpBillingExportCapture, type GcpBillingExportCapture, type GcpBillingScope, type GcpBillingSnapshot } from "./finops-gcp-cloud-intelligence.ts";

export interface GcpBillingCollectorRequest {
  readonly scope: GcpBillingScope;
  readonly identityBindingId: string;
  readonly permissions: typeof GCP_BILLING_EXPORT_READ_PERMISSIONS;
  readonly billingTable: string;
  readonly pricingTable: string;
  readonly maximumRows: 1_000_000;
  readonly requireParameterizedQuery: true;
  readonly requireReadOnlyJob: true;
  readonly acceptServiceAccountKey: false;
}
export interface GcpBillingCollector { collect(request: GcpBillingCollectorRequest): Promise<GcpBillingExportCapture>; }
export interface GcpBillingSnapshotStore { recordCapture(scope: GcpBillingScope, capture: GcpBillingExportCapture, nowMs?: number): Promise<{ readonly snapshot: { readonly snapshot: GcpBillingSnapshot }; readonly becameActive: boolean }>; }
export interface GcpBillingJobBoundary { readonly scope: GcpBillingScope; readonly identityBindingId: string; }
export class GcpBillingJobError extends Error { public constructor(){super("GCP billing materialization rejected");this.name="GcpBillingJobError";} }
function reject():never{throw new GcpBillingJobError();}
export async function runGcpBillingMaterializationJob(input:{readonly boundary:GcpBillingJobBoundary;readonly collector:GcpBillingCollector;readonly store:GcpBillingSnapshotStore;readonly nowMs?:number}){
  if(!/^gcpwif_[a-f0-9]{64}$/u.test(input.boundary.identityBindingId))reject();
  const scope=input.boundary.scope, capture=await input.collector.collect({scope,identityBindingId:input.boundary.identityBindingId,permissions:GCP_BILLING_EXPORT_READ_PERMISSIONS,billingTable:`${scope.exportProjectId}.${scope.datasetId}.${scope.billingTableId}`,pricingTable:`${scope.pricingProjectId}.${scope.pricingDatasetId}.${scope.pricingTableId}`,maximumRows:1_000_000,requireParameterizedQuery:true,requireReadOnlyJob:true,acceptServiceAccountKey:false});
  normalizeGcpBillingExportCapture(capture,scope,input.nowMs??Date.now());
  return input.store.recordCapture(scope,capture,input.nowMs);
}

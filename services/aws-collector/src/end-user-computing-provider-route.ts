/** Exact signed credential-owning route boundary for ADV-11. */
import { createHash } from "node:crypto";
import type { AwsTemporaryCredentials } from "./types.js";
import {
  END_USER_COMPUTING_PROVIDER_ACTIONS,
  END_USER_COMPUTING_PROVIDER_BOUNDS,
  EndUserComputingProviderError,
  collectEndUserComputingProviderEvidence,
  type EndUserComputingCanonicalCostProjection,
  type EndUserComputingProviderReader,
  type EndUserComputingProviderRequest,
} from "./end-user-computing-provider-adapter.js";

export const END_USER_COMPUTING_PROVIDER_ROUTE = "/v1/finops/end-user-computing/collect";
const ID=/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u,CONNECTION=/^conn_[a-f0-9]{32}$/u;
const ACCOUNT=/^\d{12}$/u,REGION=/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const REQUEST=/^eur_[a-f0-9]{64}$/u,JOB=/^job_[a-f0-9]{32}$/u,SHA=/^[a-f0-9]{64}$/u;
const WINDOW=/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/u;
const MAX_BODY_BYTES=256*1_024;

export interface EndUserComputingProviderRouteHeaders {
  readonly tenantId:string;readonly customerId:string;readonly connectionId:string;
  readonly jobId:string;
}
export interface EndUserComputingProviderRouteDependencies {
  readonly assumeReadOnlySession:(input:{readonly tenantId:string;readonly customerId:string;
    readonly connectionId:string;readonly jobId:string;readonly expectedAccountId:string;
    readonly partition:"aws"|"aws-cn"|"aws-us-gov";readonly region:string;
    readonly sessionActions:typeof END_USER_COMPUTING_PROVIDER_ACTIONS;readonly signal:AbortSignal})=>Promise<{
      readonly accountId:string;readonly partition:"aws"|"aws-cn"|"aws-us-gov";
      readonly credentials:AwsTemporaryCredentials}>;
  readonly readerFactory:(input:{readonly credentials:AwsTemporaryCredentials;readonly accountId:string;
    readonly partition:"aws"|"aws-cn"|"aws-us-gov";readonly region:string})=>EndUserComputingProviderReader;
  readonly loadCanonicalCostProjection:(input:{readonly tenantId:string;readonly customerId:string;
    readonly connectionId:string;readonly requestId:string;readonly cur2:Readonly<Record<string,unknown>>;
    readonly accountIds:readonly string[];readonly regions:readonly string[]})=>Promise<EndUserComputingCanonicalCostProjection>;
  readonly now?:()=>number;
}
function fail(code:EndUserComputingProviderError["code"]="INVALID_REQUEST"):never{throw new EndUserComputingProviderError(code)}
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{if(typeof value!=="object"||value===null||Array.isArray(value))fail();const record=value as Record<string,unknown>;if(JSON.stringify(Object.keys(record).sort())!==JSON.stringify([...keys].sort()))fail();return record}
function same(left:unknown,right:unknown):boolean{return JSON.stringify(left)===JSON.stringify(right)}
function sorted(values:unknown,pattern:RegExp,maximum:number):values is readonly string[]{return Array.isArray(values)&&values.length>0&&values.length<=maximum&&values.every(value=>typeof value==="string"&&pattern.test(value))&&new Set(values).size===values.length&&same(values,[...values].sort())}
function canonicalIso(value:unknown):value is string{return typeof value==="string"&&Number.isFinite(Date.parse(value))&&new Date(Date.parse(value)).toISOString()===value}
function validateCostProjection(projection:EndUserComputingCanonicalCostProjection):void{
  if(!Array.isArray(projection.costs)||projection.costs.length>250_000)fail("PROVIDER_RESPONSE_INVALID");
  const costKeys=["lineItemId","service","accountId","region","resourceId","usageStartAt","usageEndAt","currency","amountsMicros","usageAmountMicros","usageUnit","commitmentClass"];
  for(const raw of projection.costs){const value=exact(raw,costKeys);exact(value.amountsMicros,["unblended","net","amortized","list","contracted","public"]);
    if(!["WORKSPACES","APPSTREAM"].includes(String(value.service))||typeof value.accountId!=="string"||!ACCOUNT.test(value.accountId)
      ||typeof value.region!=="string"||!REGION.test(value.region)||!canonicalIso(value.usageStartAt)
      ||(value.usageEndAt!==null&&!canonicalIso(value.usageEndAt)))fail("PROVIDER_RESPONSE_INVALID");}
  if(projection.billingEvidence!==null)exact(projection.billingEvidence,["generationId","billingPeriod","sourceEvidenceId","manifestSha256","sourceUpdatedAt","committedAt","sourceFormat","sourceVersion","reconciled","activeGenerationRowCount","matchedLineItemCount"]);
}

export function parseEndUserComputingProviderRouteRequest(body:string):EndUserComputingProviderRequest{
  if(Buffer.byteLength(body,"utf8")<2||Buffer.byteLength(body,"utf8")>MAX_BODY_BYTES)fail("BOUND_REACHED");
  let parsed:unknown;try{parsed=JSON.parse(body)}catch{fail()}
  const request=exact(parsed,["schemaVersion","requestId","jobId","scheduledWindow","boundary","operations","bounds","maximumDurationMs","cur2","privacy"]);
  const boundary=exact(request.boundary,["scope","partition","accountIds","regions"]),scope=exact(boundary.scope,["orgId","customerId","connectionId"]);
  const privacy=exact(request.privacy,["includeUserIdentifiers","includeSessionIdentifiers","includeInstanceIdentifiers","includeNetworkAddresses","includeRawProviderMessages"]);
  const cur2=exact(request.cur2,["availability","generationId","billingPeriod","sourceEvidenceId","manifestSha256","sourceUpdatedAt","committedAt","activeGenerationRowCount","matchedLineItemCount","projectedCostLinesSha256"]);
  const unavailable=cur2.availability==="UNAVAILABLE"&&Object.entries(cur2).filter(([key])=>key!=="availability").every(([,value])=>value===null);
  const active=cur2.availability==="ACTIVE_RECONCILED"&&typeof cur2.generationId==="string"&&/^fbg_[a-f0-9]{64}$/u.test(cur2.generationId)
    &&typeof cur2.billingPeriod==="string"&&/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(cur2.billingPeriod)
    &&typeof cur2.sourceEvidenceId==="string"&&ID.test(cur2.sourceEvidenceId)
    &&typeof cur2.manifestSha256==="string"&&SHA.test(cur2.manifestSha256)
    &&canonicalIso(cur2.sourceUpdatedAt)&&canonicalIso(cur2.committedAt)
    &&Date.parse(cur2.sourceUpdatedAt)<=Date.parse(cur2.committedAt)
    &&Number.isSafeInteger(cur2.activeGenerationRowCount)&&Number(cur2.activeGenerationRowCount)>=0
    &&Number.isSafeInteger(cur2.matchedLineItemCount)&&Number(cur2.matchedLineItemCount)>=0
    &&Number(cur2.matchedLineItemCount)<=Number(cur2.activeGenerationRowCount)
    &&typeof cur2.projectedCostLinesSha256==="string"&&SHA.test(cur2.projectedCostLinesSha256);
  if(request.schemaVersion!=="sutra.end-user-computing-runtime-request.v1"||typeof request.requestId!=="string"||!REQUEST.test(request.requestId)
    ||typeof request.jobId!=="string"||!JOB.test(request.jobId)||typeof request.scheduledWindow!=="string"||!WINDOW.test(request.scheduledWindow)
    ||typeof scope.orgId!=="string"||!ID.test(scope.orgId)||typeof scope.customerId!=="string"||!ID.test(scope.customerId)
    ||typeof scope.connectionId!=="string"||!CONNECTION.test(scope.connectionId)||!["aws","aws-cn","aws-us-gov"].includes(String(boundary.partition))
    ||!sorted(boundary.accountIds,ACCOUNT,200)||!sorted(boundary.regions,REGION,50)
    ||!same(request.operations,END_USER_COMPUTING_PROVIDER_ACTIONS)||!same(request.bounds,END_USER_COMPUTING_PROVIDER_BOUNDS)
    ||request.maximumDurationMs!==300_000||Object.values(privacy).some(value=>value!==false)||(!unavailable&&!active))fail();
  return {...request,boundary:{...boundary,scope},cur2,privacy} as unknown as EndUserComputingProviderRequest;
}

export async function runEndUserComputingProviderRoute(input:{readonly body:string;
  readonly headers:EndUserComputingProviderRouteHeaders;readonly signal:AbortSignal},dependencies:EndUserComputingProviderRouteDependencies):Promise<{
    readonly schemaVersion:"sutra.end-user-computing-runtime-response.v1";readonly requestId:string;
    readonly requestBodySha256:string;readonly capture:unknown}>{
  const request=parseEndUserComputingProviderRouteRequest(input.body),scope=request.boundary.scope;
  if(!(input.signal instanceof AbortSignal)||input.signal.aborted||input.headers.tenantId!==scope.orgId
    ||input.headers.customerId!==scope.customerId||input.headers.connectionId!==scope.connectionId
    ||input.headers.jobId!==request.jobId)fail();
  const current=dependencies.now?.()??Date.now();
  if(!Number.isSafeInteger(current)||current<0)fail();
  const deadline=AbortSignal.any([input.signal,AbortSignal.timeout(request.maximumDurationMs)]);
  const projection=await dependencies.loadCanonicalCostProjection({tenantId:scope.orgId,customerId:scope.customerId,
    connectionId:scope.connectionId,requestId:request.requestId,cur2:request.cur2,
    accountIds:request.boundary.accountIds,regions:request.boundary.regions});
  validateCostProjection(projection);
  const expectedDigest=request.cur2.projectedCostLinesSha256;
  if((request.cur2.availability==="UNAVAILABLE"&&(projection.billingEvidence!==null||projection.costs.length!==0))
    ||(request.cur2.availability==="ACTIVE_RECONCILED"&&(projection.billingEvidence===null
      ||createHash("sha256").update(JSON.stringify(projection.costs),"utf8").digest("hex")!==expectedDigest)))fail("PROVIDER_RESPONSE_INVALID");
  const sessions=new Map<string,Promise<{accountId:string;partition:"aws"|"aws-cn"|"aws-us-gov";credentials:AwsTemporaryCredentials}>>();
  const capture=await collectEndUserComputingProviderEvidence({request,costProjection:projection,signal:deadline,
    ...(dependencies.now===undefined?{}:{now:dependencies.now}),readerFactory:async({accountId,region,partition})=>{
      const key=`${accountId}|${region}`;let session=sessions.get(key);if(session===undefined){session=dependencies.assumeReadOnlySession({tenantId:scope.orgId,customerId:scope.customerId,connectionId:scope.connectionId,jobId:request.jobId,expectedAccountId:accountId,partition,region,sessionActions:END_USER_COMPUTING_PROVIDER_ACTIONS,signal:deadline});sessions.set(key,session)}
      const assumed=await session;if(assumed.accountId!==accountId||assumed.partition!==partition)fail();
      return dependencies.readerFactory({credentials:assumed.credentials,accountId,partition,region});
    }});
  return Object.freeze({schemaVersion:"sutra.end-user-computing-runtime-response.v1",requestId:request.requestId,
    requestBodySha256:createHash("sha256").update(input.body,"utf8").digest("hex"),capture});
}

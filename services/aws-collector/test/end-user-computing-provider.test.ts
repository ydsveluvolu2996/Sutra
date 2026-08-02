import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  END_USER_COMPUTING_PROVIDER_ACTIONS,
  END_USER_COMPUTING_PROVIDER_BOUNDS,
  END_USER_COMPUTING_REQUIRED_PERMISSION_PACK,
  EndUserComputingProviderError,
} from "../src/end-user-computing-provider-adapter.js";
import {
  parseEndUserComputingProviderRouteRequest,
  runEndUserComputingProviderRoute,
} from "../src/end-user-computing-provider-route.js";

const now=Date.parse("2026-08-02T12:00:00.000Z"),connectionId=`conn_${"a".repeat(32)}`;
const request={schemaVersion:"sutra.end-user-computing-runtime-request.v1",requestId:`eur_${"b".repeat(64)}`,
  jobId:`job_${"c".repeat(32)}`,scheduledWindow:"2026-08-02T12:00:00.000Z",
  boundary:{scope:{orgId:"org_euc",customerId:"customer_euc",connectionId},partition:"aws",accountIds:["111122223333"],regions:["us-east-1"]},
  operations:END_USER_COMPUTING_PROVIDER_ACTIONS,bounds:END_USER_COMPUTING_PROVIDER_BOUNDS,maximumDurationMs:300_000,
  cur2:{availability:"UNAVAILABLE",generationId:null,billingPeriod:null,sourceEvidenceId:null,manifestSha256:null,sourceUpdatedAt:null,committedAt:null,activeGenerationRowCount:null,matchedLineItemCount:null,projectedCostLinesSha256:null},
  privacy:{includeUserIdentifiers:false,includeSessionIdentifiers:false,includeInstanceIdentifiers:false,includeNetworkAddresses:false,includeRawProviderMessages:false}} as const;
function body(value:unknown=request){return JSON.stringify(value)}
function code(expected:EndUserComputingProviderError["code"]){return(error:unknown)=>error instanceof EndUserComputingProviderError&&error.code===expected&&!error.message.includes("secret")}
const page=(values:Record<string,unknown>)=>values;
function reader(){return{
  describeWorkspaces:async()=>page({Workspaces:[{WorkspaceId:"ws-12345678",BundleId:"wsb-12345678",State:"AVAILABLE",UserName:"must-not-cross",IpAddress:"10.0.0.1",WorkspaceProperties:{RunningMode:"AUTO_STOP",ComputeTypeName:"VALUE",RootVolumeSizeGib:80,UserVolumeSizeGib:50}}]}),
  describeWorkspaceBundles:async()=>page({WorkspaceBundles:[{BundleId:"wsb-12345678",Name:"Standard",Owner:"AMAZON",ComputeType:{Name:"VALUE"},RootStorage:{Capacity:80},UserStorage:{Capacity:50}}]}),
  describeWorkspacesConnectionStatus:async()=>page({WorkspacesConnectionStatus:[{WorkspaceId:"ws-12345678",ConnectionState:"CONNECTED",LastKnownUserConnectionTimestamp:new Date(now)}]}),
  describeFleets:async()=>page({Fleets:[{Arn:"arn:aws:appstream:us-east-1:111122223333:fleet/fleet-a",Name:"fleet-a",State:"RUNNING",FleetType:"ON_DEMAND",InstanceType:"stream.standard.small",ComputeCapacityStatus:{Desired:1,Running:1,InUse:1,Available:0},MaxConcurrentSessions:1}]}),
  describeStacks:async()=>page({Stacks:[{Arn:"arn:aws:appstream:us-east-1:111122223333:stack/stack-a",Name:"stack-a"}]}),
  listAssociatedFleets:async()=>page({Names:["fleet-a"]}),
  describeSessions:async()=>page({Sessions:[{Id:"session-secret",UserId:"user@example.com",InstanceId:"i-secret",NetworkAccessConfiguration:{EniPrivateIpAddress:"10.0.0.2"},State:"ACTIVE",ConnectionState:"CONNECTED"}]}),
  getPrivacySafeMetricObservations:async()=>({observations:[],pages:[{requestTokenSha256:null,responseNextTokenSha256:null,pageSize:500,recordCount:0}]})};}

test("ADV-11 route accepts only the exact frozen privacy and runtime contract",()=>{
  assert.deepEqual(parseEndUserComputingProviderRouteRequest(body()),request);
  for(const mutation of [
    {...request,operations:[...request.operations,"workspaces:TerminateWorkspaces"]},
    {...request,privacy:{...request.privacy,includeUserIdentifiers:true}},
    {...request,boundary:{...request.boundary,accountIds:["111122223333","000000000000"]}},
    {...request,maximumDurationMs:300_001},{...request,extra:true},
  ])assert.throws(()=>parseEndUserComputingProviderRouteRequest(body(mutation)),code("INVALID_REQUEST"));
  assert.equal(END_USER_COMPUTING_REQUIRED_PERMISSION_PACK,"standard-2026-08.11");
});

test("ADV-11 route binds temporary scope, strips identities, and returns reconciled pagination evidence",async()=>{
  const sessions:unknown[]=[];
  const result=await runEndUserComputingProviderRoute({body:body(),headers:{tenantId:"org_euc",customerId:"customer_euc",connectionId,jobId:request.jobId},signal:new AbortController().signal},{
    now:()=>now,assumeReadOnlySession:async(input)=>{sessions.push(input);return{accountId:"111122223333",partition:"aws" as const,credentials:{accessKeyId:"AKIAEXAMPLE",secretAccessKey:"secret",sessionToken:"token",expiration:new Date(now+3_600_000)}}},
    readerFactory:()=>reader(),loadCanonicalCostProjection:async()=>({billingEvidence:null,costs:[]})});
  assert.equal(result.requestBodySha256,createHash("sha256").update(body()).digest("hex"));
  const capture=result.capture as Record<string,unknown>,serialized=JSON.stringify(capture);
  for(const secret of ["must-not-cross","10.0.0.1","session-secret","user@example.com","i-secret","10.0.0.2","LastKnownUserConnectionTimestamp"])assert.doesNotMatch(serialized,new RegExp(secret.replaceAll(".","\\."),"u"));
  assert.equal((capture.workspaces as unknown[]).length,1);assert.equal((capture.appStreamSessions as unknown[]).length,1);
  assert.equal((capture.pagination as unknown[]).length,9);assert.equal((capture.coverage as unknown[]).length,2);
  assert.deepEqual((sessions[0] as {sessionActions:unknown}).sessionActions,END_USER_COMPUTING_PROVIDER_ACTIONS);
});

test("ADV-11 route rejects tenant, STS identity, and CUR2 projection substitution",async()=>{
  const common={body:body(),headers:{tenantId:"org_attacker",customerId:"customer_euc",connectionId,jobId:request.jobId},signal:new AbortController().signal};
  await assert.rejects(runEndUserComputingProviderRoute(common,{now:()=>now,assumeReadOnlySession:async()=>{throw new Error("must-not-run")},readerFactory:()=>reader(),loadCanonicalCostProjection:async()=>({billingEvidence:null,costs:[]})}),code("INVALID_REQUEST"));
  await assert.rejects(runEndUserComputingProviderRoute({...common,headers:{...common.headers,tenantId:"org_euc"}},{now:()=>now,assumeReadOnlySession:async()=>({accountId:"000000000000",partition:"aws" as const,credentials:{accessKeyId:"x",secretAccessKey:"y",sessionToken:"z",expiration:new Date(now+1)}}),readerFactory:()=>reader(),loadCanonicalCostProjection:async()=>({billingEvidence:null,costs:[]})}),code("INVALID_REQUEST"));
  const active={...request,cur2:{availability:"ACTIVE_RECONCILED",generationId:`fbg_${"d".repeat(64)}`,billingPeriod:"2026-08",sourceEvidenceId:"cur2_euc",manifestSha256:"e".repeat(64),sourceUpdatedAt:"2026-08-02T10:00:00.000Z",committedAt:"2026-08-02T10:01:00.000Z",activeGenerationRowCount:1,matchedLineItemCount:0,projectedCostLinesSha256:"f".repeat(64)}} as const;
  await assert.rejects(runEndUserComputingProviderRoute({body:body(active),headers:{tenantId:"org_euc",customerId:"customer_euc",connectionId,jobId:request.jobId},signal:new AbortController().signal},{now:()=>now,assumeReadOnlySession:async()=>{throw new Error("must-not-run")},readerFactory:()=>reader(),loadCanonicalCostProjection:async()=>({billingEvidence:{generationId:active.cur2.generationId,billingPeriod:"2026-08",sourceEvidenceId:"cur2_euc",manifestSha256:"e".repeat(64),sourceUpdatedAt:"2026-08-02T10:00:00.000Z",committedAt:"2026-08-02T10:01:00.000Z",sourceFormat:"aws-cur",sourceVersion:"2.0",reconciled:true,activeGenerationRowCount:1,matchedLineItemCount:0},costs:[]})}),code("PROVIDER_RESPONSE_INVALID"));
});

test("ADV-11 removes identity-bearing metric observations before broker response",async()=>{
  const unsafe={...reader(),getPrivacySafeMetricObservations:async()=>({observations:[{service:"WORKSPACES",accountId:"111122223333",region:"us-east-1",resourceScope:"SERVICE",resourceId:null,metricName:"WORKSPACES_AVAILABLE",statistic:"SUM",unit:"COUNT",valueMicros:"1000000",sampleCount:1,windowStartAt:"2026-08-02T06:00:00.000Z",windowEndAt:"2026-08-02T12:00:00.000Z",dataThroughAt:"2026-08-02T12:00:00.000Z",completeWindow:true,source:"CLOUDWATCH_GET_METRIC_DATA",privacyScope:"NO_USER_DIMENSION",UserId:"must-not-cross"}],pages:[{requestTokenSha256:null,responseNextTokenSha256:null,pageSize:500,recordCount:1}]})};
  const result=await runEndUserComputingProviderRoute({body:body(),headers:{tenantId:"org_euc",customerId:"customer_euc",connectionId,jobId:request.jobId},signal:new AbortController().signal},{now:()=>now,assumeReadOnlySession:async()=>({accountId:"111122223333",partition:"aws" as const,credentials:{accessKeyId:"x",secretAccessKey:"y",sessionToken:"z",expiration:new Date(now+1)}}),readerFactory:()=>unsafe,loadCanonicalCostProjection:async()=>({billingEvidence:null,costs:[]})});
  assert.doesNotMatch(JSON.stringify(result),/must-not-cross|UserId/u);
  assert.deepEqual((result.capture as {metrics:unknown[]}).metrics,[]);
});

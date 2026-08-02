/** Concrete AWS SDK v3 reader for the privacy-minimized ADV-11 provider adapter. */
import { createHash } from "node:crypto";
import {
  AppStreamClient, DescribeFleetsCommand, DescribeSessionsCommand,
  DescribeStacksCommand, ListAssociatedFleetsCommand,
  type DescribeSessionsCommandInput, type ListAssociatedFleetsCommandInput,
} from "@aws-sdk/client-appstream";
import { CloudWatchClient, GetMetricDataCommand, type MetricDataQuery } from "@aws-sdk/client-cloudwatch";
import {
  WorkSpacesClient, DescribeWorkspaceBundlesCommand,
  DescribeWorkspacesCommand, DescribeWorkspacesConnectionStatusCommand,
} from "@aws-sdk/client-workspaces";
import type { AwsTemporaryCredentials } from "./types.js";
import type { EndUserComputingProviderReader } from "./end-user-computing-provider-adapter.js";

type Service="WORKSPACES"|"APPSTREAM";
interface QueryBinding { readonly id:string;readonly service:Service;readonly resourceScope:"SERVICE"|"RESOURCE"|"FLEET";
  readonly resourceId:string|null;readonly metricName:string;readonly statistic:"SUM"|"AVERAGE"|"MAXIMUM";
  readonly unit:"COUNT"|"PERCENT"|"SECONDS"|"MILLISECONDS" }
const WORKSPACES_METRICS=Object.freeze([
  ["Available","WORKSPACES_AVAILABLE","AVERAGE","COUNT"],
  ["Unhealthy","WORKSPACES_UNHEALTHY","AVERAGE","COUNT"],
  ["ConnectionAttempt","WORKSPACES_CONNECTION_ATTEMPT","SUM","COUNT"],
  ["ConnectionSuccess","WORKSPACES_CONNECTION_SUCCESS","SUM","COUNT"],
  ["ConnectionFailure","WORKSPACES_CONNECTION_FAILURE","SUM","COUNT"],
  ["SessionLaunchTime","WORKSPACES_SESSION_LAUNCH_TIME","AVERAGE","SECONDS"],
  ["InSessionLatency","WORKSPACES_IN_SESSION_LATENCY","AVERAGE","MILLISECONDS"],
  ["SessionDisconnect","WORKSPACES_SESSION_DISCONNECT","SUM","COUNT"],
] as const);
const APPSTREAM_METRICS=Object.freeze([
  ["InUseCapacity","APPSTREAM_IN_USE_CAPACITY","AVERAGE","COUNT"],
  ["AvailableCapacity","APPSTREAM_AVAILABLE_CAPACITY","AVERAGE","COUNT"],
  ["DesiredCapacity","APPSTREAM_DESIRED_CAPACITY","AVERAGE","COUNT"],
  ["ActualCapacity","APPSTREAM_ACTUAL_CAPACITY","AVERAGE","COUNT"],
  ["CapacityUtilization","APPSTREAM_CAPACITY_UTILIZATION","AVERAGE","PERCENT"],
  ["InsufficientCapacityError","APPSTREAM_INSUFFICIENT_CAPACITY_ERROR","SUM","COUNT"],
] as const);
function digest(value:string){return createHash("sha256").update(value,"utf8").digest("hex")}
function query(id:string,namespace:string,name:string,dimensions:readonly {Name:string;Value:string}[],statistic:string):MetricDataQuery{
  return{Id:id,MetricStat:{Metric:{Namespace:namespace,MetricName:name,Dimensions:[...dimensions]},Period:300,Stat:statistic},ReturnData:true};
}
function plan(input:{readonly workspaces:readonly string[];readonly fleetNames:readonly string[];readonly maximumObservations:number}){
  const service:Service=input.workspaces.length>0||input.fleetNames.length===0?"WORKSPACES":"APPSTREAM";
  const specs=service==="WORKSPACES"?WORKSPACES_METRICS:APPSTREAM_METRICS,resources=service==="WORKSPACES"?input.workspaces:input.fleetNames;
  const bindings:QueryBinding[]=[],queries:MetricDataQuery[]=[];
  const append=(resource:string|null,spec:typeof specs[number])=>{if(queries.length>=500||bindings.length>=input.maximumObservations)return;
    const id=`q${queries.length}`,dimensions=resource===null?[]:[{Name:service==="WORKSPACES"?"WorkspaceId":"FleetName",Value:resource}];
    queries.push(query(id,service==="WORKSPACES"?"AWS/WorkSpaces":"AWS/AppStream",spec[0],dimensions,spec[2]));
    bindings.push({id,service,resourceScope:resource===null?"SERVICE":service==="WORKSPACES"?"RESOURCE":"FLEET",resourceId:resource,metricName:spec[1],statistic:spec[2],unit:spec[3]});};
  // A dimensionless query proves CloudWatch permission even for an empty fleet.
  append(null,specs[0]);for(const resource of [...resources].sort())for(const spec of specs)append(resource,spec);
  return{bindings,queries};
}
function aggregate(values:readonly number[],statistic:QueryBinding["statistic"]):number{
  if(statistic==="SUM")return values.reduce((sum,value)=>sum+value,0);
  if(statistic==="MAXIMUM")return Math.max(...values);
  return values.reduce((sum,value)=>sum+value,0)/values.length;
}

export function createEndUserComputingSdkReader(input:{readonly credentials:AwsTemporaryCredentials;
  readonly accountId:string;readonly partition:"aws"|"aws-cn"|"aws-us-gov";readonly region:string}):EndUserComputingProviderReader{
  const config={region:input.region,credentials:input.credentials},workspaces=new WorkSpacesClient(config),
    appstream=new AppStreamClient(config),cloudwatch=new CloudWatchClient(config);
  return{
    describeWorkspaces:(request,signal)=>workspaces.send(new DescribeWorkspacesCommand(request),{abortSignal:signal}),
    describeWorkspaceBundles:(request,signal)=>workspaces.send(new DescribeWorkspaceBundlesCommand(request),{abortSignal:signal}),
    describeWorkspacesConnectionStatus:(request,signal)=>workspaces.send(new DescribeWorkspacesConnectionStatusCommand(request),{abortSignal:signal}),
    describeFleets:(request,signal)=>appstream.send(new DescribeFleetsCommand(request),{abortSignal:signal}),
    describeStacks:(request,signal)=>appstream.send(new DescribeStacksCommand(request),{abortSignal:signal}),
    listAssociatedFleets:(request,signal)=>appstream.send(new ListAssociatedFleetsCommand(request as unknown as ListAssociatedFleetsCommandInput),{abortSignal:signal}),
    describeSessions:(request,signal)=>appstream.send(new DescribeSessionsCommand(request as unknown as DescribeSessionsCommandInput),{abortSignal:signal}),
    async getPrivacySafeMetricObservations(request,signal){
      const {bindings,queries}=plan(request),byId=new Map(bindings.map(binding=>[binding.id,binding]));
      const observations:unknown[]=[],pages:unknown[]=[];let token:string|undefined;const seen=new Set<string>();
      do{const requestDigest=token===undefined?null:digest(token),output=await cloudwatch.send(new GetMetricDataCommand({
        MetricDataQueries:queries,StartTime:new Date(request.windowStartAt),EndTime:new Date(request.windowEndAt),
        ScanBy:"TimestampAscending",MaxDatapoints:100_800,...(token===undefined?{}:{NextToken:token})}),{abortSignal:signal});
        const results=output.MetricDataResults??[],next=output.NextToken,responseDigest=next===undefined?null:digest(next);
        if(next!==undefined&&(next===token||seen.has(responseDigest!)))throw Object.assign(new Error("pagination"),{name:"InvalidPaginationToken"});
        if(responseDigest!==null)seen.add(responseDigest);pages.push({requestTokenSha256:requestDigest,responseNextTokenSha256:responseDigest,pageSize:500,recordCount:results.length});
        for(const result of results){const binding=result.Id===undefined?undefined:byId.get(result.Id),values=(result.Values??[]).filter(Number.isFinite),timestamps=(result.Timestamps??[]).filter(value=>value instanceof Date&&!Number.isNaN(value.getTime()));
          if(binding===undefined||values.length===0||timestamps.length===0)continue;const value=aggregate(values,binding.statistic);
          if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER/1_000_000)continue;
          const through=new Date(Math.max(...timestamps.map(item=>item.getTime()))).toISOString();observations.push({service:binding.service,accountId:input.accountId,region:input.region,resourceScope:binding.resourceScope,resourceId:binding.resourceId,metricName:binding.metricName,statistic:binding.statistic,unit:binding.unit,valueMicros:BigInt(Math.round(value*1_000_000)).toString(),sampleCount:values.length,windowStartAt:request.windowStartAt,windowEndAt:request.windowEndAt,dataThroughAt:through,completeWindow:result.StatusCode==="Complete",source:"CLOUDWATCH_GET_METRIC_DATA",privacyScope:binding.service==="WORKSPACES"?"NO_USER_DIMENSION":"NO_USER_SESSION_OR_INSTANCE_DIMENSION"});}
        token=next;
      }while(token!==undefined);
      return{observations,pages};
    },
  };
}

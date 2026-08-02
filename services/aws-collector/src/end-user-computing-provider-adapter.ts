/** Credential-scoped, privacy-minimizing provider adapter for ADV-11. */
import { createHash } from "node:crypto";

export const END_USER_COMPUTING_PROVIDER_ACTIONS = Object.freeze([
  "appstream:DescribeFleets",
  "appstream:DescribeSessions",
  "appstream:DescribeStacks",
  "appstream:ListAssociatedFleets",
  "cloudwatch:GetMetricData",
  "workspaces:DescribeWorkspaceBundles",
  "workspaces:DescribeWorkspaces",
  "workspaces:DescribeWorkspacesConnectionStatus",
] as const);

export const END_USER_COMPUTING_REQUIRED_PERMISSION_PACK = "standard-2026-08.11" as const;

export const END_USER_COMPUTING_PROVIDER_BOUNDS = Object.freeze({
  workspacePageSize: 25, appStreamSessionPageSize: 50, generalPageSize: 25,
  cloudWatchResultPageSize: 500, maximumConcurrency: 4, maximumDurationMs: 900_000,
  maximumPages: 20_000, maximumAccounts: 200, maximumRegions: 50,
  maximumCoverageRows: 20_000, maximumWorkspaces: 50_000, maximumBundles: 10_000,
  maximumFleets: 10_000, maximumStacks: 10_000, maximumSessionAggregates: 50_000,
  maximumSessions: 1_000_000, maximumMetricObservations: 100_000,
  maximumCostRows: 250_000, maximumHistoryDays: 93,
  maximumCaptureBytes: 64 * 1_024 * 1_024, maximumDashboardBytes: 8 * 1_024 * 1_024,
  maximumResourcesInResponse: 5_000, maximumTextCharacters: 256,
  inventoryFreshnessHours: 24, activityFreshnessHours: 6,
  metricFreshnessHours: 6, costFreshnessHours: 48,
} as const);

type Partition = "aws" | "aws-cn" | "aws-us-gov";
type Service = "APPSTREAM" | "WORKSPACES";
type Failure = "ACCESS_DENIED" | "THROTTLED" | "TIMEOUT" | "BOUND_REACHED"
  | "PROVIDER_UNAVAILABLE" | "INVALID_PAGINATION" | "CANONICAL_COST_UNAVAILABLE" | "UNKNOWN";

export interface EndUserComputingProviderRequest {
  readonly schemaVersion: "sutra.end-user-computing-runtime-request.v1";
  readonly requestId: string;
  readonly jobId: string;
  readonly scheduledWindow: string;
  readonly boundary: { readonly scope: { readonly orgId: string; readonly customerId: string; readonly connectionId: string };
    readonly partition: Partition; readonly accountIds: readonly string[]; readonly regions: readonly string[] };
  readonly operations: typeof END_USER_COMPUTING_PROVIDER_ACTIONS;
  readonly bounds: typeof END_USER_COMPUTING_PROVIDER_BOUNDS;
  readonly maximumDurationMs: 300_000;
  readonly cur2: Readonly<Record<string, unknown>>;
  readonly privacy: { readonly includeUserIdentifiers: false; readonly includeSessionIdentifiers: false;
    readonly includeInstanceIdentifiers: false; readonly includeNetworkAddresses: false;
    readonly includeRawProviderMessages: false };
}

export interface EndUserComputingProviderReader {
  describeWorkspaces(input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown>;
  describeWorkspaceBundles(input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown>;
  describeWorkspacesConnectionStatus(input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown>;
  describeFleets(input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown>;
  describeStacks(input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown>;
  listAssociatedFleets(input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown>;
  describeSessions(input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown>;
  /** Returns only aggregate, identity-free observations produced from GetMetricData. */
  getPrivacySafeMetricObservations(input: {
    readonly accountId: string; readonly region: string;
    readonly workspaces: readonly string[]; readonly fleetNames: readonly string[];
    readonly windowStartAt: string; readonly windowEndAt: string;
    readonly maximumObservations: number;
  }, signal: AbortSignal): Promise<{ readonly observations: readonly unknown[]; readonly pages: readonly unknown[] }>;
}

export interface EndUserComputingCanonicalCostProjection {
  readonly billingEvidence: unknown | null;
  readonly costs: readonly unknown[];
}

export type EndUserComputingReaderFactory = (input: {
  readonly accountId: string; readonly region: string; readonly partition: Partition;
}) => Promise<EndUserComputingProviderReader> | EndUserComputingProviderReader;

export class EndUserComputingProviderError extends Error {
  public constructor(public readonly code: "INVALID_REQUEST" | "PROVIDER_RESPONSE_INVALID" | "BOUND_REACHED" | "ABORTED") {
    super("AWS End User Computing provider collection did not complete");
    this.name = "EndUserComputingProviderError";
  }
}

function reject(code: EndUserComputingProviderError["code"]): never { throw new EndUserComputingProviderError(code); }
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject("PROVIDER_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}
function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) reject("PROVIDER_RESPONSE_INVALID");
  return value;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) reject("PROVIDER_RESPONSE_INVALID");
  return value;
}
function nullableText(value: unknown, maximum: number): string | null { return value === undefined || value === null ? null : text(value, maximum); }
function integer(value: unknown, maximum = 1_000_000): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) reject("PROVIDER_RESPONSE_INVALID");
  return Number(value);
}
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function nextToken(value: unknown): string | null {
  return value === undefined || value === null ? null : text(value, 8_192);
}
function failure(error: unknown, signal: AbortSignal): Failure {
  if (signal.aborted) return "TIMEOUT";
  if (error instanceof EndUserComputingProviderError && error.code === "BOUND_REACHED") return "BOUND_REACHED";
  const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  if (/accessdenied|unauthorized|notauthorized/iu.test(name)) return "ACCESS_DENIED";
  if (/throttl|toomanyrequest|requestlimit/iu.test(name)) return "THROTTLED";
  if (/timeout|abort/iu.test(name)) return "TIMEOUT";
  return "PROVIDER_UNAVAILABLE";
}
function enumValue(value: unknown, allowed: readonly string[], fallback?: string): string {
  if (typeof value === "string" && allowed.includes(value)) return value;
  if (fallback !== undefined) return fallback;
  reject("PROVIDER_RESPONSE_INVALID");
}
function privacyMetric(raw: unknown, service: Service, accountId: string, region: string): unknown {
  const value=record(raw),keys=["service","accountId","region","resourceScope","resourceId","metricName","statistic","unit","valueMicros","sampleCount","windowStartAt","windowEndAt","dataThroughAt","completeWindow","source","privacyScope"];
  if(JSON.stringify(Object.keys(value).sort())!==JSON.stringify(keys.sort())||value.service!==service
    ||value.accountId!==accountId||value.region!==region||value.source!=="CLOUDWATCH_GET_METRIC_DATA"
    ||(service==="WORKSPACES"&&value.privacyScope!=="NO_USER_DIMENSION")
    ||(service==="APPSTREAM"&&value.privacyScope!=="NO_USER_SESSION_OR_INSTANCE_DIMENSION"))reject("PROVIDER_RESPONSE_INVALID");
  return value;
}
function metricPages(raw: readonly unknown[]): PageSequence["pages"] {
  if(raw.length<1)reject("PROVIDER_RESPONSE_INVALID");let expected:string|null=null;const seen=new Set<string>();
  const pages=raw.map((item)=>{const value=record(item),keys=["requestTokenSha256","responseNextTokenSha256","pageSize","recordCount"];
    const request=value.requestTokenSha256,next=value.responseNextTokenSha256;
    if(JSON.stringify(Object.keys(value).sort())!==JSON.stringify(keys.sort())||request!==expected
      ||(request!==null&&(typeof request!=="string"||!`${request}`.match(/^[a-f0-9]{64}$/u)))
      ||(next!==null&&(typeof next!=="string"||!`${next}`.match(/^[a-f0-9]{64}$/u)||seen.has(`${next}`)))
      ||value.pageSize!==500||!Number.isSafeInteger(value.recordCount)
      ||Number(value.recordCount)<0||Number(value.recordCount)>500)reject("PROVIDER_RESPONSE_INVALID");
    if(next!==null)seen.add(`${next}`);expected=next as string|null;return value as unknown as PageSequence["pages"][number];});
  if(expected!==null)reject("PROVIDER_RESPONSE_INVALID");return pages;
}

interface PageSequence { service: Service; accountId: string; region: string; operation: string;
  queryKeySha256: string | null; pages: { requestTokenSha256: string | null; responseNextTokenSha256: string | null;
    pageSize: number; recordCount: number }[]; exhausted: boolean }

async function paginate(input: {
  readonly service: Service; readonly accountId: string; readonly region: string; readonly operation: string;
  readonly pageSize: number; readonly queryKeySha256?: string | null; readonly maximumPages: number;
  readonly signal: AbortSignal; readonly read: (token: string | null) => Promise<unknown>;
  readonly extract: (page: Record<string, unknown>) => readonly unknown[];
}): Promise<{ readonly values: readonly unknown[]; readonly sequence: PageSequence }> {
  const values: unknown[] = [], pages: PageSequence["pages"] = [], seen = new Set<string>();
  let token: string | null = null;
  do {
    if (pages.length >= input.maximumPages) reject("BOUND_REACHED");
    if (input.signal.aborted) reject("ABORTED");
    const page = record(await input.read(token));
    const records = input.extract(page);
    if (records.length > input.pageSize) reject("PROVIDER_RESPONSE_INVALID");
    const emitted = nextToken(page.NextToken ?? page.nextToken);
    const requestDigest = token === null ? null : hash(token);
    const responseDigest = emitted === null ? null : hash(emitted);
    if (emitted !== null && (emitted === token || seen.has(responseDigest!))) reject("PROVIDER_RESPONSE_INVALID");
    if (responseDigest !== null) seen.add(responseDigest);
    pages.push({ requestTokenSha256: requestDigest, responseNextTokenSha256: responseDigest,
      pageSize: input.pageSize, recordCount: records.length });
    values.push(...records); token = emitted;
  } while (token !== null);
  return { values, sequence: { service: input.service, accountId: input.accountId, region: input.region,
    operation: input.operation, queryKeySha256: input.queryKeySha256 ?? null, pages, exhausted: true } };
}

function workspace(raw: unknown, accountId: string, region: string, observedAt: string) {
  const value = record(raw), properties = value.WorkspaceProperties === undefined ? {} : record(value.WorkspaceProperties);
  const workspaceId = text(value.WorkspaceId, 66), bundleId = text(value.BundleId, 67);
  if (!/^ws-[0-9a-z]{8,63}$/u.test(workspaceId) || !/^wsb-[0-9a-z]{8,63}$/u.test(bundleId)) reject("PROVIDER_RESPONSE_INVALID");
  return { accountId, region, workspaceId, bundleId,
    state: enumValue(value.State, ["PENDING","AVAILABLE","IMPAIRED","UNHEALTHY","REBOOTING","STARTING","REBUILDING","RESTORING","MAINTENANCE","ADMIN_MAINTENANCE","TERMINATING","TERMINATED","SUSPENDED","UPDATING","STOPPING","STOPPED","ERROR"]),
    runningMode: enumValue(properties.RunningMode, ["ALWAYS_ON","AUTO_STOP","MANUAL"], "UNKNOWN"),
    computeType: nullableText(properties.ComputeTypeName, 128),
    rootVolumeGib: integer(properties.RootVolumeSizeGib, 65_536), userVolumeGib: integer(properties.UserVolumeSizeGib, 65_536),
    observedAt, connection: null as null | { state: string; observedAt: string } };
}
function bundle(raw: unknown, accountId: string, region: string, observedAt: string) {
  const value = record(raw), compute = value.ComputeType === undefined ? {} : record(value.ComputeType),
    root = value.RootStorage === undefined ? {} : record(value.RootStorage), user = value.UserStorage === undefined ? {} : record(value.UserStorage);
  const bundleId = text(value.BundleId, 67); if (!/^wsb-[0-9a-z]{8,63}$/u.test(bundleId)) reject("PROVIDER_RESPONSE_INVALID");
  return { accountId, region, bundleId, owner: value.Owner === "AMAZON" ? "AMAZON" : "ACCOUNT",
    name: text(value.Name, 256), computeType: nullableText(compute.Name, 128),
    rootVolumeGib: integer(root.Capacity, 65_536), userVolumeGib: integer(user.Capacity, 65_536), observedAt };
}
function fleet(raw: unknown, accountId: string, region: string, observedAt: string) {
  const value = record(raw), capacity = value.ComputeCapacityStatus === undefined ? {} : record(value.ComputeCapacityStatus);
  const arn = text(value.Arn, 512), name = text(value.Name, 101);
  if (!arn.startsWith(`arn:`) || !arn.includes(`:appstream:${region}:${accountId}:fleet/`)
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/u.test(name)) reject("PROVIDER_RESPONSE_INVALID");
  return { accountId, region, fleetArn: arn, fleetName: name,
    state: enumValue(value.State, ["STARTING","RUNNING","STOPPING","STOPPED"]),
    fleetType: enumValue(value.FleetType, ["ALWAYS_ON","ON_DEMAND","ELASTIC"]),
    instanceType: nullableText(value.InstanceType, 128), desiredCapacity: integer(capacity.Desired),
    runningCapacity: integer(capacity.Running), inUseCapacity: integer(capacity.InUse),
    availableCapacity: integer(capacity.Available), maxSessionsPerInstance: integer(value.MaxConcurrentSessions, 1_000), observedAt };
}
function stack(raw: unknown, accountId: string, region: string, observedAt: string) {
  const value = record(raw), arn = text(value.Arn, 512), name = text(value.Name, 101);
  if (!arn.includes(`:appstream:${region}:${accountId}:stack/`) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/u.test(name)) reject("PROVIDER_RESPONSE_INVALID");
  return { accountId, region, stackArn: arn, stackName: name, associatedFleetNames: [] as string[], observedAt };
}

async function collectTarget(input: { readonly request: EndUserComputingProviderRequest; readonly accountId: string;
  readonly region: string; readonly reader: EndUserComputingProviderReader; readonly signal: AbortSignal;
  readonly observedAt: string; readonly remainingPages: () => number }) {
  const { accountId, region, reader, signal, observedAt } = input;
  const pagination: PageSequence[] = [], workspaces: ReturnType<typeof workspace>[] = [], bundles: ReturnType<typeof bundle>[] = [],
    fleets: ReturnType<typeof fleet>[] = [], stacks: ReturnType<typeof stack>[] = [], sessions: unknown[] = [], metrics: unknown[] = [];
  const status: Record<Service, { inventory: "COMPLETE"|"UNAVAILABLE"; activity: "COMPLETE"|"UNAVAILABLE";
    metric: "COMPLETE"|"UNAVAILABLE"; failure: Failure | null }> = {
      WORKSPACES: { inventory: "COMPLETE", activity: "COMPLETE", metric: "COMPLETE", failure: null },
      APPSTREAM: { inventory: "COMPLETE", activity: "COMPLETE", metric: "COMPLETE", failure: null },
    };
  try {
    const [ws, wb] = await Promise.all([
      paginate({ service:"WORKSPACES", accountId, region, operation:"workspaces:DescribeWorkspaces", pageSize:25,
        maximumPages:input.remainingPages(), signal, read:(token)=>reader.describeWorkspaces({ Limit:25, NextToken:token },signal),
        extract:(page)=>list(page.Workspaces ?? [],25) }),
      paginate({ service:"WORKSPACES", accountId, region, operation:"workspaces:DescribeWorkspaceBundles", pageSize:25,
        maximumPages:input.remainingPages(), signal, read:(token)=>reader.describeWorkspaceBundles({ Owner:"ALL", NextToken:token },signal),
        extract:(page)=>list(page.WorkspaceBundles ?? [],25) }),
    ]);
    pagination.push(ws.sequence, wb.sequence); workspaces.push(...ws.values.map((item)=>workspace(item,accountId,region,observedAt)));
    bundles.push(...wb.values.map((item)=>bundle(item,accountId,region,observedAt)));
  } catch (error) { status.WORKSPACES.inventory="UNAVAILABLE"; status.WORKSPACES.activity="UNAVAILABLE"; status.WORKSPACES.metric="UNAVAILABLE"; status.WORKSPACES.failure=failure(error,signal); workspaces.length=0; bundles.length=0; }
  if (status.WORKSPACES.inventory === "COMPLETE") try {
    const connections = await paginate({ service:"WORKSPACES", accountId, region, operation:"workspaces:DescribeWorkspacesConnectionStatus", pageSize:25,
      maximumPages:input.remainingPages(), signal, read:(token)=>reader.describeWorkspacesConnectionStatus({ NextToken:token },signal),
      extract:(page)=>list(page.WorkspacesConnectionStatus ?? [],25) }); pagination.push(connections.sequence);
    const byId = new Map(connections.values.map((raw) => { const value=record(raw), id=text(value.WorkspaceId,66);
      return [id,{ state:enumValue(value.ConnectionState,["CONNECTED","DISCONNECTED","UNKNOWN"],"UNKNOWN"), observedAt }] as const; }));
    for (const item of workspaces) item.connection=byId.get(item.workspaceId) ?? null;
  } catch (error) { status.WORKSPACES.activity="UNAVAILABLE"; status.WORKSPACES.failure=failure(error,signal); }
  try {
    const [fl, st] = await Promise.all([
      paginate({ service:"APPSTREAM", accountId, region, operation:"appstream:DescribeFleets", pageSize:25,
        maximumPages:input.remainingPages(), signal, read:(token)=>reader.describeFleets({ MaxResults:25, NextToken:token },signal), extract:(page)=>list(page.Fleets ?? [],25) }),
      paginate({ service:"APPSTREAM", accountId, region, operation:"appstream:DescribeStacks", pageSize:25,
        maximumPages:input.remainingPages(), signal, read:(token)=>reader.describeStacks({ MaxResults:25, NextToken:token },signal), extract:(page)=>list(page.Stacks ?? [],25) }),
    ]); pagination.push(fl.sequence,st.sequence); fleets.push(...fl.values.map((item)=>fleet(item,accountId,region,observedAt)));
    stacks.push(...st.values.map((item)=>stack(item,accountId,region,observedAt)));
    for (const item of stacks) {
      const queryKeySha256=hash(JSON.stringify({stackName:item.stackName}));
      const associated=await paginate({ service:"APPSTREAM",accountId,region,operation:"appstream:ListAssociatedFleets",queryKeySha256,pageSize:25,
        maximumPages:input.remainingPages(),signal,read:(token)=>reader.listAssociatedFleets({StackName:item.stackName,MaxResults:25,NextToken:token},signal),extract:(page)=>list(page.Names??[],25) });
      item.associatedFleetNames=[...new Set(associated.values.map((name)=>text(name,101)))].sort(); pagination.push(associated.sequence);
    }
  } catch(error){ status.APPSTREAM.inventory="UNAVAILABLE";status.APPSTREAM.activity="UNAVAILABLE";status.APPSTREAM.metric="UNAVAILABLE";status.APPSTREAM.failure=failure(error,signal);fleets.length=0;stacks.length=0; }
  if(status.APPSTREAM.inventory==="COMPLETE") try {
    for(const item of stacks) for(const fleetName of item.associatedFleetNames){
      const queryKeySha256=hash(JSON.stringify({fleetName,stackName:item.stackName}));
      const result=await paginate({service:"APPSTREAM",accountId,region,operation:"appstream:DescribeSessions",queryKeySha256,pageSize:50,
        maximumPages:input.remainingPages(),signal,read:(token)=>reader.describeSessions({FleetName:fleetName,StackName:item.stackName,Limit:50,NextToken:token},signal),extract:(page)=>list(page.Sessions??[],50)});
      let active=0,pending=0,expired=0,connected=0,notConnected=0;
      for(const raw of result.values){const value=record(raw),state=enumValue(value.State,["ACTIVE","PENDING","EXPIRED"]),connection=enumValue(value.ConnectionState,["CONNECTED","NOT_CONNECTED"],"NOT_CONNECTED");
        if(state==="ACTIVE")active++;else if(state==="PENDING")pending++;else expired++;if(connection==="CONNECTED")connected++;else notConnected++;}
      sessions.push({accountId,region,fleetName,stackName:item.stackName,queryKeySha256,observedAt,active,pending,expired,connected,notConnected});pagination.push(result.sequence);
    }
  }catch(error){status.APPSTREAM.activity="UNAVAILABLE";status.APPSTREAM.failure=failure(error,signal);sessions.length=0;}
  const metricStart=new Date(Date.parse(observedAt)-6*60*60*1_000).toISOString();
  for(const service of ["WORKSPACES","APPSTREAM"] as const) if(status[service].inventory==="COMPLETE") try{
    const output=await reader.getPrivacySafeMetricObservations({accountId,region,workspaces:service==="WORKSPACES"?workspaces.map(item=>item.workspaceId):[],fleetNames:service==="APPSTREAM"?fleets.map(item=>item.fleetName):[],windowStartAt:metricStart,windowEndAt:observedAt,maximumObservations:END_USER_COMPUTING_PROVIDER_BOUNDS.maximumMetricObservations-metrics.length},signal);
    if(!Array.isArray(output.observations)||!Array.isArray(output.pages)||output.pages.length<1)reject("PROVIDER_RESPONSE_INVALID");
    metrics.push(...output.observations.map(item=>privacyMetric(item,service,accountId,region)));pagination.push({service,accountId,region,operation:"cloudwatch:GetMetricData",queryKeySha256:null,pages:metricPages(output.pages),exhausted:true});
  }catch(error){status[service].metric="UNAVAILABLE";status[service].failure=failure(error,signal);}
  return {accountId,region,pagination,workspaces,bundles,fleets,stacks,sessions,metrics,status};
}

/** Collects every account/Region independently; no raw identity-bearing provider object is returned. */
export async function collectEndUserComputingProviderEvidence(input:{readonly request:EndUserComputingProviderRequest;
  readonly readerFactory:EndUserComputingReaderFactory;readonly costProjection:EndUserComputingCanonicalCostProjection;
  readonly signal:AbortSignal;readonly now?:()=>number}):Promise<unknown>{
  if(!(input.signal instanceof AbortSignal)||input.signal.aborted)reject("ABORTED");
  const now=input.now??Date.now,started=now(),deadline=started+input.request.maximumDurationMs;
  if(!Number.isSafeInteger(started)||started<0)reject("INVALID_REQUEST");
  const signal=AbortSignal.any([input.signal,AbortSignal.timeout(Math.max(1,deadline-started))]);
  const targets=input.request.boundary.accountIds.flatMap(accountId=>input.request.boundary.regions.map(region=>({accountId,region})));
  const results:Awaited<ReturnType<typeof collectTarget>>[]=[];let cursor=0,pageCount=0;
  await Promise.all(Array.from({length:Math.min(4,targets.length)},async()=>{while(cursor<targets.length){const target=targets[cursor++]!;
    const reader=await input.readerFactory({...target,partition:input.request.boundary.partition});
    const result=await collectTarget({request:input.request,...target,reader,signal,observedAt:new Date(now()).toISOString(),remainingPages:()=>END_USER_COMPUTING_PROVIDER_BOUNDS.maximumPages-pageCount});
    pageCount+=result.pagination.reduce((sum,item)=>sum+item.pages.length,0);if(pageCount>END_USER_COMPUTING_PROVIDER_BOUNDS.maximumPages)reject("BOUND_REACHED");results.push(result);}}));
  results.sort((a,b)=>`${a.accountId}|${a.region}`.localeCompare(`${b.accountId}|${b.region}`));
  const costs=[...input.costProjection.costs],billingEvidence=input.costProjection.billingEvidence;
  const completedAt=new Date(now()).toISOString(),costAvailable=billingEvidence!==null;
  const coverage=results.flatMap(result=>(["APPSTREAM","WORKSPACES"] as const).map(service=>{const state=result.status[service],costCount=costs.filter((item)=>{const value=record(item);return value.service===service&&value.accountId===result.accountId&&value.region===result.region}).length;
    const sessionCount=result.sessions.reduce<number>((sum,item)=>sum+Number(record(item).active)+Number(record(item).pending)+Number(record(item).expired),0);
    const failed=state.failure??(costAvailable?null:"CANONICAL_COST_UNAVAILABLE");return{service,accountId:result.accountId,region:result.region,inventoryStatus:state.inventory,activityStatus:state.activity,metricStatus:state.metric,costStatus:costAvailable?"COMPLETE":"UNAVAILABLE",inventoryObservedAt:state.inventory==="COMPLETE"?completedAt:null,activityObservedAt:state.activity==="COMPLETE"?completedAt:null,metricDataThroughAt:state.metric==="COMPLETE"?completedAt:null,costDataThroughAt:costAvailable?completedAt:null,inventoryRecordCount:service==="WORKSPACES"?result.workspaces.length:result.fleets.length+result.stacks.length,activityRecordCount:service==="WORKSPACES"?result.workspaces.filter(item=>item.connection!==null).length:sessionCount,metricRecordCount:result.metrics.filter(item=>record(item).service===service).length,costRecordCount:costCount,inventoryPermissionValidated:state.inventory==="COMPLETE",activityPermissionValidated:state.activity==="COMPLETE",metricPermissionValidated:state.metric==="COMPLETE",costGenerationActivated:costAvailable,failureCode:failed};}));
  const capture={schemaVersion:"sutra.end-user-computing.v1",scope:input.request.boundary.scope,partition:input.request.boundary.partition,accountIds:input.request.boundary.accountIds,regions:input.request.boundary.regions,captureId:`euc_${input.request.requestId.slice(4)}`,startedAt:new Date(started).toISOString(),completedAt,execution:{concurrencyLimit:4,observedPeakConcurrency:Math.min(4,targets.length),pageCount},coverage,pagination:results.flatMap(item=>item.pagination),workspaces:results.flatMap(item=>item.workspaces),workspaceBundles:results.flatMap(item=>item.bundles),appStreamFleets:results.flatMap(item=>item.fleets),appStreamStacks:results.flatMap(item=>item.stacks),appStreamSessions:results.flatMap(item=>item.sessions),metrics:results.flatMap(item=>item.metrics),billingEvidence,costs};
  if(Buffer.byteLength(JSON.stringify(capture),"utf8")>END_USER_COMPUTING_PROVIDER_BOUNDS.maximumCaptureBytes)reject("BOUND_REACHED");return Object.freeze(capture);
}

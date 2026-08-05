/** Lazy AWS SDK v3 reader that exhausts the exact ADD-12 operation graph. */
import type { AwsTemporaryCredentials } from "./types.js";
import type {
  AwsConfigComplianceCentralProjection,
  AwsConfigComplianceFanoutProjection,
  AwsConfigComplianceProviderReader,
  AwsConfigComplianceProviderRequest,
  AwsConfigComplianceProviderTarget,
} from "./aws-config-compliance-provider-adapter.js";

type Command = object;
type Client = { send(command: Command, options?: { readonly abortSignal?: AbortSignal }): Promise<unknown>; destroy(): void };
type Constructor = new (input: Record<string, unknown>) => Command;
interface ConfigSdk { readonly ConfigServiceClient: new (input: Record<string, unknown>) => Client;
  readonly DescribeConfigurationAggregatorsCommand:Constructor;readonly DescribeConfigurationAggregatorSourcesStatusCommand:Constructor;
  readonly DescribeAggregateComplianceByConfigRulesCommand:Constructor;readonly GetAggregateComplianceDetailsByConfigRuleCommand:Constructor;
  readonly DescribeAggregateComplianceByConformancePacksCommand:Constructor;readonly GetAggregateDiscoveredResourceCountsCommand:Constructor;
  readonly SelectAggregateResourceConfigCommand:Constructor;readonly DescribeConfigRulesCommand:Constructor;
  readonly DescribeConfigRuleEvaluationStatusCommand:Constructor;readonly DescribeConfigurationRecordersCommand:Constructor;
  readonly DescribeConfigurationRecorderStatusCommand:Constructor }
interface OrganizationsSdk { readonly OrganizationsClient:new(input:Record<string,unknown>)=>Client;
  readonly DescribeOrganizationCommand:Constructor;readonly ListAccountsCommand:Constructor }
interface Page { readonly request:Readonly<Record<string,unknown>>;readonly response:unknown }
export interface AwsConfigComplianceCentralRawEvidence { readonly organization:unknown;
  readonly accounts:readonly Page[];readonly aggregators:readonly Page[];readonly sourceStatuses:readonly Page[];
  readonly ruleCompliance:readonly Page[];readonly complianceDetails:readonly Page[];
  readonly conformancePacks:readonly Page[];readonly resourceCounts:readonly Page[];readonly inventory:readonly Page[] }
export interface AwsConfigComplianceFanoutRawEvidence { readonly rules:readonly Page[];
  readonly evaluationStatuses:readonly Page[];readonly recorders:unknown;readonly recorderStatuses:unknown }
export interface AwsConfigComplianceProjectionBuilder {
  central(input:{readonly request:AwsConfigComplianceProviderRequest;readonly evidence:AwsConfigComplianceCentralRawEvidence}):AwsConfigComplianceCentralProjection;
  fanout(input:{readonly request:AwsConfigComplianceProviderRequest;readonly target:AwsConfigComplianceProviderTarget;
    readonly evidence:AwsConfigComplianceFanoutRawEvidence}):AwsConfigComplianceFanoutProjection;
}
function record(value:unknown):Readonly<Record<string,unknown>>{if(typeof value!=="object"||value===null||Array.isArray(value))throw new Error("AWS_CONFIG_PROVIDER_RESPONSE_INVALID");return value as Readonly<Record<string,unknown>>}
function token(output:unknown):string|null{const value=record(output).NextToken;if(value===undefined||value===null||value==="")return null;if(typeof value!=="string"||value.length>10_000)throw new Error("AWS_CONFIG_PROVIDER_PAGINATION_INVALID");return value}
async function pages(input:{readonly client:Client;readonly Command:Constructor;readonly base:Readonly<Record<string,unknown>>;
  readonly signal:AbortSignal;readonly maximum?:number}):Promise<readonly Page[]>{const result:Page[]=[];const seen=new Set<string>();let next:string|null=null;do{if(result.length>=(input.maximum??20_000))throw new Error("AWS_CONFIG_PROVIDER_PAGE_BOUND_REACHED");const request=Object.freeze({...input.base,...(next===null?{}:{NextToken:next})});const response=await input.client.send(new input.Command(request),{abortSignal:input.signal});result.push(Object.freeze({request,response}));const received=token(response);if(received!==null&&(received===next||seen.has(received)))throw new Error("AWS_CONFIG_PROVIDER_PAGINATION_INVALID");if(received!==null)seen.add(received);next=received}while(next!==null);return Object.freeze(result)}
function complianceKeys(input:readonly Page[]):readonly {ConfigRuleName:string;AccountId:string;AwsRegion:string}[]{const values=new Map<string,{ConfigRuleName:string;AccountId:string;AwsRegion:string}>();for(const page of input){const rows=record(page.response).AggregateComplianceByConfigRules;if(!Array.isArray(rows))throw new Error("AWS_CONFIG_PROVIDER_RESPONSE_INVALID");for(const raw of rows){const item=record(raw);if(typeof item.ConfigRuleName!=="string"||typeof item.AccountId!=="string"||typeof item.AwsRegion!=="string")throw new Error("AWS_CONFIG_PROVIDER_RESPONSE_INVALID");const value={ConfigRuleName:item.ConfigRuleName,AccountId:item.AccountId,AwsRegion:item.AwsRegion};values.set(`${value.AccountId}|${value.AwsRegion}|${value.ConfigRuleName}`,value)}}return Object.freeze([...values.values()].sort((a,b)=>`${a.AccountId}|${a.AwsRegion}|${a.ConfigRuleName}`.localeCompare(`${b.AccountId}|${b.AwsRegion}|${b.ConfigRuleName}`)))}

export function createAwsConfigComplianceProviderReader(input:{
  readonly request:AwsConfigComplianceProviderRequest;
  readonly sessionForTarget:(target:AwsConfigComplianceProviderTarget,signal:AbortSignal)=>Promise<AwsTemporaryCredentials>;
  readonly projection:AwsConfigComplianceProjectionBuilder;
}):AwsConfigComplianceProviderReader{
  const configModule="@aws-sdk/client-config-service",organizationsModule="@aws-sdk/client-organizations";
  const loadConfig=()=>import(configModule).then((value)=>value as unknown as ConfigSdk);
  const loadOrganizations=()=>import(organizationsModule).then((value)=>value as unknown as OrganizationsSdk);
  const configClient=async(target:AwsConfigComplianceProviderTarget,signal:AbortSignal)=>{const[sdk,credentials]=await Promise.all([loadConfig(),input.sessionForTarget(target,signal)]);return{sdk,client:new sdk.ConfigServiceClient({region:target.region,credentials,maxAttempts:3})}};
  const readCentral: AwsConfigComplianceProviderReader["readCentral"] = async({target,aggregatorName,inventoryQuery},signal)=>{const[{sdk,client},organizations]=await Promise.all([configClient(target,signal),loadOrganizations()]);const credentials=await input.sessionForTarget(target,signal);const organizationsClient=new organizations.OrganizationsClient({region:input.request.scope.partition==="aws-cn"?"cn-northwest-1":input.request.scope.partition==="aws-us-gov"?"us-gov-west-1":"us-east-1",credentials,maxAttempts:3});try{const organization=await organizationsClient.send(new organizations.DescribeOrganizationCommand({}),{abortSignal:signal});const[accounts,aggregators,sourceStatuses,ruleCompliance,conformancePacks,resourceCounts,inventory]=await Promise.all([
      pages({client:organizationsClient,Command:organizations.ListAccountsCommand,base:{MaxResults:20},signal,maximum:1_000}),
      pages({client,Command:sdk.DescribeConfigurationAggregatorsCommand,base:{ConfigurationAggregatorNames:[aggregatorName],Limit:100},signal}),
      pages({client,Command:sdk.DescribeConfigurationAggregatorSourcesStatusCommand,base:{ConfigurationAggregatorName:aggregatorName,Limit:100},signal}),
      pages({client,Command:sdk.DescribeAggregateComplianceByConfigRulesCommand,base:{ConfigurationAggregatorName:aggregatorName,Limit:100},signal}),
      pages({client,Command:sdk.DescribeAggregateComplianceByConformancePacksCommand,base:{ConfigurationAggregatorName:aggregatorName,Limit:100},signal}),
      Promise.resolve(Object.freeze([] as Page[])),
      pages({client,Command:sdk.SelectAggregateResourceConfigCommand,base:{ConfigurationAggregatorName:aggregatorName,Expression:inventoryQuery,Limit:100},signal}),
    ]);const complianceDetails:Page[]=[];for(const key of complianceKeys(ruleCompliance))complianceDetails.push(...await pages({client,Command:sdk.GetAggregateComplianceDetailsByConfigRuleCommand,base:{ConfigurationAggregatorName:aggregatorName,...key,Limit:100},signal}));const countPages=[...resourceCounts];for(const scoped of input.request.targets)countPages.push(...await pages({client,Command:sdk.GetAggregateDiscoveredResourceCountsCommand,base:{ConfigurationAggregatorName:aggregatorName,Filters:{AccountId:scoped.accountId,Region:scoped.region},Limit:100},signal}));return input.projection.central({request:input.request,evidence:{organization,accounts,aggregators,sourceStatuses,ruleCompliance,complianceDetails:Object.freeze(complianceDetails),conformancePacks,resourceCounts:Object.freeze(countPages),inventory}})}finally{client.destroy();organizationsClient.destroy()}};
  const readAccountRegion: AwsConfigComplianceProviderReader["readAccountRegion"] = async({target},signal)=>{const{sdk,client}=await configClient(target,signal);try{const[rules,evaluationStatuses,recorders,recorderStatuses]=await Promise.all([
      pages({client,Command:sdk.DescribeConfigRulesCommand,base:{},signal}),
      pages({client,Command:sdk.DescribeConfigRuleEvaluationStatusCommand,base:{Limit:100},signal}),
      client.send(new sdk.DescribeConfigurationRecordersCommand({}),{abortSignal:signal}),
      client.send(new sdk.DescribeConfigurationRecorderStatusCommand({}),{abortSignal:signal}),
    ]);return input.projection.fanout({request:input.request,target,evidence:{rules,evaluationStatuses,recorders,recorderStatuses}})}finally{client.destroy()}};
  return Object.freeze({ readCentral, readAccountRegion });
}

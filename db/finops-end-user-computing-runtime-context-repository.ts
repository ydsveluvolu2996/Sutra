/** Trusted ADV-11 boundary and active reconciled CUR2 projection reader. */
import { getRawDb } from "./index";
import type { EndUserComputingBoundary } from "../lib/finops-end-user-computing.ts";
import type { EndUserComputingRuntimeContext } from "../lib/finops-end-user-computing-runtime-binding.ts";

const PACK = "standard-2026-08.11";
const ACCOUNT = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const MAX_BOUNDARIES = 10_000;
const MAX_COSTS = 250_000;

interface ConnectionRow { org_id:string;customer_id:string;connection_id:string;account_id:string;
  partition:"aws"|"aws-cn"|"aws-us-gov";enabled_regions_json:string }
interface PartitionRow { id:string;billing_period:string;active_generation_id:string;
  active_manifest_sha256:string;active_source_updated_at:string;active_committed_at:string;
  active_accepted_rows:number|string }
interface CostRow { line_item_id:string;usage_account_id:string;service:string;product_code:string|null;
  product_name:string|null;resource_id:string|null;region:string|null;usage_start:string;usage_end:string|null;
  amount_micros:number|string;net_unblended_cost_micros:number|string|null;amortized_micros:number|string|null;
  list_cost_micros:number|string|null;contracted_cost_micros:number|string|null;
  public_on_demand_cost_micros:number|string|null;currency:string;commitment_type:string|null;
  charge_category:string }

function parseRegions(value:string):readonly string[]{let parsed:unknown;try{parsed=JSON.parse(value)}catch{throw new Error("END_USER_COMPUTING_STORED_SCOPE_INVALID")}
  if(!Array.isArray(parsed)||parsed.length<1||parsed.length>50||parsed.some(item=>typeof item!=="string"||!REGION.test(item))
    ||new Set(parsed).size!==parsed.length)throw new Error("END_USER_COMPUTING_STORED_SCOPE_INVALID");return Object.freeze((parsed as string[]).sort())}
function boundary(row:ConnectionRow):EndUserComputingBoundary{if(!CONNECTION.test(row.connection_id)||!ACCOUNT.test(row.account_id)
  ||!["aws","aws-cn","aws-us-gov"].includes(row.partition))throw new Error("END_USER_COMPUTING_STORED_SCOPE_INVALID");
  return Object.freeze({scope:Object.freeze({orgId:row.org_id,customerId:row.customer_id,connectionId:row.connection_id}),
    partition:row.partition,accountIds:Object.freeze([row.account_id]),regions:parseRegions(row.enabled_regions_json)})}
function micros(value:number|string|null):string|null{if(value===null)return null;const text=String(value);if(!/^-?\d+$/u.test(text))throw new Error("END_USER_COMPUTING_STORED_COST_INVALID");return text}
function service(row:CostRow):"WORKSPACES"|"APPSTREAM"|null{const value=`${row.service} ${row.product_code??""} ${row.product_name??""}`.toLowerCase();
  if(value.includes("appstream")||value.includes("workspaces applications"))return "APPSTREAM";
  if(value.includes("workspace"))return "WORKSPACES";return null}
function cost(row:CostRow){const classified=service(row);if(classified===null)return null;
  const commitment=/saving/iu.test(row.commitment_type??"")?"SAVINGS_PLAN":/reserved/iu.test(row.commitment_type??"")?"RESERVED":
    /on.?demand/iu.test(`${row.commitment_type??""} ${row.charge_category}`)?"ON_DEMAND":"UNCLASSIFIED";
  return Object.freeze({lineItemId:row.line_item_id,service:classified,accountId:row.usage_account_id,
    region:row.region,resourceId:classified==="WORKSPACES"&&row.resource_id!==null&&/^ws-[0-9a-z]{8,63}$/u.test(row.resource_id)?row.resource_id:null,
    usageStartAt:row.usage_start,usageEndAt:row.usage_end,currency:row.currency,
    amountsMicros:Object.freeze({unblended:micros(row.amount_micros),net:micros(row.net_unblended_cost_micros),
      amortized:micros(row.amortized_micros),list:micros(row.list_cost_micros),contracted:micros(row.contracted_cost_micros),
      public:micros(row.public_on_demand_cost_micros)}),usageAmountMicros:null,usageUnit:null,commitmentClass:commitment})}
async function sha256(value:string):Promise<string>{const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,"0")).join("")}

export class EndUserComputingRuntimeContextRepository {
  public constructor(private readonly database:D1Database=getRawDb()){}
  private live=`FROM aws_connections c JOIN organizations o ON o.id=c.org_id AND o.status='active'
    JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status IN ('active','trial')
    WHERE c.source_kind='aws_trust_role' AND c.status='active' AND c.permission_pack_version='${PACK}'`;
  public async listEligibleBoundaries():Promise<readonly EndUserComputingBoundary[]>{const result=await this.database.prepare(
    `SELECT c.org_id,c.customer_id,c.id AS connection_id,c.aws_account_id AS account_id,c.partition,c.enabled_regions_json ${this.live} ORDER BY c.id ASC LIMIT ?`)
    .bind(MAX_BOUNDARIES+1).all<ConnectionRow>();const rows=result.results??[];if(rows.length>MAX_BOUNDARIES)throw new Error("END_USER_COMPUTING_BOUND_REACHED");
    return Object.freeze(rows.map(boundary))}
  public async loadRuntimeContext(scope:{readonly orgId:string;readonly customerId:string;readonly connectionId:string}):Promise<EndUserComputingRuntimeContext>{
    const row=await this.database.prepare(`SELECT c.org_id,c.customer_id,c.id AS connection_id,c.aws_account_id AS account_id,c.partition,c.enabled_regions_json ${this.live}
      AND c.org_id=? AND c.customer_id=? AND c.id=? LIMIT 1`).bind(scope.orgId,scope.customerId,scope.connectionId).first<ConnectionRow>();
    if(row===null)throw new Error("END_USER_COMPUTING_SCOPE_NOT_FOUND");const trusted=boundary(row);
    const partition=await this.database.prepare(`SELECT id,billing_period,active_generation_id,active_manifest_sha256,
      active_source_updated_at,active_committed_at,active_accepted_rows FROM finops_export_partitions
      WHERE org_id=? AND customer_id=? AND connection_id=? AND active_generation_id IS NOT NULL
        AND active_manifest_sha256 IS NOT NULL AND active_source_format='aws-cur' AND active_source_version='2.0'
      ORDER BY active_committed_at DESC,billing_period DESC,id ASC LIMIT 1`).bind(scope.orgId,scope.customerId,scope.connectionId).first<PartitionRow>();
    if(partition===null)return Object.freeze({boundary:trusted,cur2:Object.freeze({availability:"UNAVAILABLE",generationId:null,billingPeriod:null,
      sourceEvidenceId:null,manifestSha256:null,sourceUpdatedAt:null,committedAt:null,activeGenerationRowCount:null,matchedLineItemCount:null,projectedCostLinesSha256:null})});
    const rows=await this.database.prepare(`SELECT line_item_id,usage_account_id,service,product_code,product_name,resource_id,region,
      usage_start,usage_end,amount_micros,net_unblended_cost_micros,amortized_micros,list_cost_micros,contracted_cost_micros,
      public_on_demand_cost_micros,currency,commitment_type,charge_category FROM finops_billing_lines_v2
      WHERE org_id=? AND customer_id=? AND connection_id=? AND billing_period=? AND generation_id=?
        AND usage_account_id=? AND region IN (${trusted.regions.map(()=>"?").join(",")})
      ORDER BY line_item_id ASC LIMIT ?`).bind(scope.orgId,scope.customerId,scope.connectionId,partition.billing_period,
      partition.active_generation_id,trusted.accountIds[0],...trusted.regions,MAX_COSTS+1).all<CostRow>();
    const projected=(rows.results??[]).map(cost).filter((value):value is NonNullable<ReturnType<typeof cost>>=>value!==null);
    if(projected.length>MAX_COSTS)throw new Error("END_USER_COMPUTING_BOUND_REACHED");
    return Object.freeze({boundary:trusted,cur2:Object.freeze({availability:"ACTIVE_RECONCILED",generationId:partition.active_generation_id,
      billingPeriod:partition.billing_period,sourceEvidenceId:partition.id,manifestSha256:partition.active_manifest_sha256,
      sourceUpdatedAt:partition.active_source_updated_at,committedAt:partition.active_committed_at,
      activeGenerationRowCount:Number(partition.active_accepted_rows),matchedLineItemCount:projected.length,
      projectedCostLinesSha256:await sha256(JSON.stringify(projected))})})}
}

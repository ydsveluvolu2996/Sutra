import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { Miniflare } from "miniflare";
import { createServer } from "vite";

const root=path.resolve(import.meta.dirname,".."); const connection=`conn_${"a".repeat(32)}`;
const exact=(numerator,denominator="1")=>({numerator,denominator});
function efficiency(metric,used,requested){return {metric,unit:metric==="CPU"?"core-hours":"byte-hours",requestedOrProvisioned:exact(requested),used:exact(used),ratio:exact(used,requested),state:"COMPLETE",evidenceBasis:"EXPLICIT_SOURCE_FIELDS"};}
function group(overrides={}){return {usageAccountId:"111122223333",region:"us-east-1",clusterId:"eks-prod",namespace:"payments",controllerKind:"Deployment",controller:"payments-api",workload:"payments-api",pod:"payments-api-1",container:"api",allocationKind:"WORKLOAD",currency:"USD",rowCount:1,totalCost:exact("10"),efficiencies:[efficiency("CPU","1","2"),efficiency("RAM","50","100")],sourceRowIds:["row-1"],sourceRowsTruncated:false,...overrides};}
function snapshot(){return {schemaVersion:"sutra.kubecost-allocation.snapshot.v1",scope:{orgId:"org_a",customerId:"customer_a",connectionId:connection,partition:"aws",billingPeriod:"2026-08",activeCur2GenerationId:`fbg_${"b".repeat(64)}`,awsAccountIds:["111122223333"],clusterIds:["eks-prod","eks-dev"]},captureId:`kubecost_${"c".repeat(64)}`,state:"READY",complete:true,generatedAtIso:"2026-08-01T01:00:00.000Z",dataThroughAtIso:"2026-08-01T00:00:00.000Z",ageHours:1,exportLineage:{provider:"KUBECOST",exporterName:"exporter",exporterVersion:"1",schemaName:"sutra.kubecost-opencost-allocation",schemaVersion:"1.0.0",schemaSha256:"1".repeat(64),manifestSha256:"2".repeat(64),querySha256:"3".repeat(64),costModelSha256:"4".repeat(64),objectCount:1,versionPinnedObjectCount:1},coverage:{expectedObjects:1,processedObjects:1,failedObjects:0,expectedClusters:2,capturedClusters:2,rowsExhausted:true},rowCount:2,groupCount:2,categoryTotals:[{category:"WORKLOAD_ALLOCATION",currency:"USD",exact:exact("14"),rowCount:2}],groups:[group(),group({usageAccountId:"444455556666",clusterId:"eks-dev",namespace:"analytics",workload:"worker",pod:"worker-1",container:"worker",totalCost:exact("4"),sourceRowIds:["row-2"]})],reconciliation:{state:"MATCHED",authoritativeSpendSource:"AWS_CUR2_ACTIVE_GENERATION",presentationPolicy:"ATTRIBUTION_VIEW_ONLY_DO_NOT_ADD_TO_CUR2",toleranceMicros:"0",currencies:[{currency:"USD",kubecostTotal:exact("14"),cur2TotalMicros:"14000000",delta:exact("0"),withinTolerance:true}]},limitations:["Allocation only."]};}

test("Kubecost dashboard uses exact aggregation, filters, pivots and usage-vs-request efficiency",async()=>{
  const {buildKubecostDashboard}=await import("../lib/finops-kubecost-dashboard.ts"); const report=buildKubecostDashboard(snapshot());
  assert.deepEqual(report.executiveSummary.totals,[{currency:"USD",totalCost:exact("14")}]);
  assert.deepEqual(report.executiveSummary.efficiencies.find((item)=>item.metric==="CPU").ratio,exact("1","2"));
  assert.equal(report.byAccount[0].accountId,"111122223333"); assert.equal(report.topClusters[0].clusterId,"eks-prod");
  assert.deepEqual(report.pivots.namespaces.map((item)=>item.identity),["payments","analytics"]);
  const filtered=buildKubecostDashboard(snapshot(),{clusterId:"eks-dev",limit:1}); assert.equal(filtered.resultCount,1); assert.equal(filtered.rows[0].namespace,"analytics");
  assert.match(filtered.unsupported.eksCapacityInstanceType,/instance type/u);
});

test("Kubecost migrations enforce immutable complete-only monotonic heads",async()=>{
  const [sqlite,postgres]=await Promise.all([readFile(path.join(root,"drizzle/0097_finops_kubecost_allocation.sql"),"utf8"),readFile(path.join(root,"postgres/migrations/0092_finops_kubecost_allocation.sql"),"utf8")]);
  for(const sql of [sqlite,postgres]){assert.match(sql,/FINOPS_KUBECOST_SNAPSHOT_IMMUTABLE/u);assert.match(sql,/candidate\.?`?complete`?/u);assert.match(sql,/candidate\.?`?data_through_at`?>active\.?`?data_through_at`?/u);}
  const mf=new Miniflare({modules:true,script:"export default { fetch(){return new Response('ok')} }",compatibilityDate:"2026-05-22",d1Databases:{DB:`kubecost-${crypto.randomUUID()}`},d1Persist:false});
  try{const db=await mf.getD1Database("DB"); await db.prepare("CREATE TABLE organizations(id text PRIMARY KEY)").run();await db.prepare("CREATE TABLE customers(id text PRIMARY KEY)").run();await db.prepare("CREATE TABLE aws_connections(id text PRIMARY KEY)").run();for(const statement of sqlite.split("--> statement-breakpoint").map((value)=>value.trim()).filter(Boolean))await db.prepare(statement).run();await db.batch([db.prepare("INSERT INTO organizations VALUES('org_a')"),db.prepare("INSERT INTO customers VALUES('customer_a')"),db.prepare("INSERT INTO aws_connections VALUES(?)").bind(connection)]);
    const insert=(id,state,complete,through)=>db.prepare("INSERT INTO finops_kubecost_snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(`kcg_${id.repeat(64)}`,"org_a","customer_a",connection,"aws","2026-08",`fbg_${"b".repeat(64)}`,`kubecost_${id.repeat(64)}`,state,complete,through,id.repeat(64),"{}",0,0,1);
    await insert("a","READY",1,"2026-08-01T00:00:00.000Z").run();await db.prepare("INSERT INTO finops_kubecost_snapshot_heads VALUES(?,?,?,?,1)").bind("org_a","customer_a",connection,`kcg_${"a".repeat(64)}`).run();await insert("b","PARTIAL",0,"2026-08-01T01:00:00.000Z").run();
    await assert.rejects(db.prepare("UPDATE finops_kubecost_snapshot_heads SET active_generation_id=?").bind(`kcg_${"b".repeat(64)}`).run(),/FINOPS_KUBECOST_HEAD_REJECTED/u);await assert.rejects(db.prepare("UPDATE finops_kubecost_snapshots SET source_state='PARTIAL'").run(),/FINOPS_KUBECOST_SNAPSHOT_IMMUTABLE/u);
  }finally{await mf.dispose();}
});

test("materialization job pins exporter destination, read-only actions, bounds and exact scope",async()=>{
  const {runKubecostMaterializationJob,KubecostMaterializationJobError}=await import("../lib/finops-kubecost-allocation-job.ts"); const scope=snapshot().scope; const destination={bucket:"sutra-kubecost-evidence",prefix:"tenants/org_a/kubecost/",expectedBucketOwner:"111122223333"}; let request;
  const capture={scope,destination:{bucket:destination.bucket,prefix:destination.prefix},captureId:`kubecost_${"c".repeat(64)}`};
  const result=await runKubecostMaterializationJob({scope,destination,nowMs:1_785_552_000_000,ingest:{collect:async(value)=>{request=value;return capture;}},store:{recordCapture:async()=>({generation:{generationId:`kcg_${"d".repeat(64)}`,snapshot:{captureId:capture.captureId,state:"READY"}},becameActive:true})}});
  assert.deepEqual(request.runtimeReadActions,["s3:GetBucketLocation","s3:ListBucket","s3:GetObject"]);assert.equal(request.runtimeReadActions.includes("s3:PutObject"),false);assert.equal(request.authoritativeSpendSource,"AWS_CUR2_ACTIVE_GENERATION");assert.equal(request.destination.expectedBucketOwner,"111122223333");assert.equal(result.becameActive,true);
  await assert.rejects(runKubecostMaterializationJob({scope,destination,ingest:{collect:async()=>({...capture,scope:{...scope,orgId:"org_b"}})},store:{recordCapture:async()=>{throw new Error("must not persist");}}}),(error)=>error instanceof KubecostMaterializationJobError&&!/must not persist/u.test(error.message));
});

test("repository and API enforce normalized immutable persistence and same-tenant reads",async()=>{
  const [repository,route]=await Promise.all([readFile(path.join(root,"db/finops-kubecost-allocation-repository.ts"),"utf8"),readFile(path.join(root,"app/api/v1/finops/kubecost-allocation/route.ts"),"utf8")]);
  assert.match(repository,/buildKubecostAllocationSnapshot\(capture, expectedScope/u);assert.match(repository,/snapshot\.scope\.orgId !== row\.org_id/u);assert.match(repository,/snapshot\.complete &&/u);
  assert.match(route,/requireApiSession\(request\)/u);assert.match(route,/getConnectionForOrg\(authenticated\.subject\.orgId/u);assert.match(route,/assertSessionCapability\(authenticated, "connection:read", connection\.customerId\)/u);assert.match(route,/KUBECOST_SIGNED_VERSIONED_EXPORT_RUNTIME_NOT_REGISTERED/u);assert.match(route,/do not add it to authoritative CUR2 spend/u);
});

test("native Kubecost UI renders official sections, reconciliation and honest unavailable states",async()=>{
  const vite=await createServer({root,configFile:false,logLevel:"silent",plugins:[react()],server:{middlewareMode:true}});try{const dashboardModule=await vite.ssrLoadModule("/app/costs/finops-kubecost-allocation-dashboard.tsx");const projection=(await import("../lib/finops-kubecost-dashboard.ts")).buildKubecostDashboard(snapshot());
    const report={...projection,connectionId:connection,sourceState:"partial",history:[],freshness:{ageHours:1},evidence:{activeCur2GenerationId:snapshot().scope.activeCur2GenerationId},collection:{jobContractAvailable:true,providerAdapterAvailable:false,reason:"KUBECOST_SIGNED_VERSIONED_EXPORT_RUNTIME_NOT_REGISTERED"},disclosures:["Allocation only."]};
    const html=renderToStaticMarkup(createElement(dashboardModule.FinopsKubecostAllocationReportView,{report,filters:{},onFiltersChange:()=>undefined}));for(const text of ["Allocation, not additional spend","Executive Summary","Total cost by account","Workloads Explorer","EKS Breakdown","Showback / chargeback evidence","usage vs requests","Trend view unavailable","instance-type breakdown unavailable","Reconciliation, provenance"] )assert.match(html,new RegExp(text,"iu"));assert.doesNotMatch(html,/sample|fixture|placeholder/iu);
  }finally{await vite.close();}
});

import assert from "node:assert/strict";import{createHash}from"node:crypto";import{readFile}from"node:fs/promises";import test from"node:test";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");
const ACTIONS=["compute-optimizer:GetEC2InstanceRecommendations","compute-optimizer:GetAutoScalingGroupRecommendations",
  "compute-optimizer:GetRDSDatabaseRecommendations","ec2:DescribeInstances","ec2:DescribeImages","ec2:DescribeInstanceTypes",
  "autoscaling:DescribeAutoScalingGroups","rds:DescribeDBInstances","rds:DescribeDBClusters","es:ListDomainNames",
  "es:DescribeDomain","elasticache:DescribeCacheClusters","elasticache:DescribeReplicationGroups","pricing:ListPriceLists","pricing:GetPriceListFileUrl"];
test(".8.12 exactly preserves immutable .8.11 and adds only frozen Graviton reads",async()=>{const[prior,next]=await Promise.all([
  read("infrastructure/customer-onboarding-role-standard-2026-08.11.yaml"),read("infrastructure/customer-onboarding-role-standard-2026-08.12.yaml")]);
  assert.equal(createHash("sha256").update(prior).digest("hex"),"300b317f394763140c31867ef4f2938083cd3cdda7af7bc3a62ab56fe5b3ad08");
  assert.match(next,/preserves every standard-2026-08\.11 capability/u);const start=next.indexOf("PolicyName: SutraFinopsGravitonSavingsReadV1"),
    policy=next.slice(start,next.indexOf("      Tags:",start)),granted=[...policy.matchAll(/^\s+- ([a-z0-9-]+:[A-Za-z0-9]+)$/gmu)].map(match=>match[1]);
  assert.deepEqual(granted,ACTIONS);assert.doesNotMatch(policy,/Effect: Deny/u);});
test(".8.12 runtime has concrete SDK, migrations, broker, authority, worker and daily tick",async()=>{const sources=await Promise.all([
  "services/aws-collector/package.json","services/aws-collector/src/graviton-savings-sdk-reader.ts","services/aws-collector/src/role-broker.ts",
  "services/aws-collector/src/local-server.ts","db/runtime-migrations.ts","scripts/postgres-migrate.mjs",
  "db/finops-graviton-runtime-repository.ts","db/background-job-handlers.ts","app/api/internal/jobs/run/route.ts",
  "lib/finops-graviton-production-composition.ts","lib/finops-permission-pack-successors.ts"].map(read));const all=sources.join("\n");
  for(const token of ["@aws-sdk/client-auto-scaling\": \"3.1087.0","createGravitonSavingsSdkReader","assumeValidatedGravitonSavingsSession",
    "GRAVITON_PROVIDER_ROUTE","0122_finops_graviton_runtime","0118_finops_graviton_runtime","bindProductionAuthorities",
    "GRAVITON_MATERIALIZATION_JOB_KIND","scheduleGravitonSavingsTick","REGISTERED_LOCAL_RUNTIME","standard-2026-08.12"])
    assert.ok(all.includes(token),token);});

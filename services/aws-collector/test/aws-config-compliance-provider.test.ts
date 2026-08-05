import assert from "node:assert/strict";
import test from "node:test";
import {
  AWS_CONFIG_COMPLIANCE_PROVIDER_BOUNDS,
  AwsConfigComplianceProviderError,
  collectAwsConfigComplianceProviderEvidence,
  type AwsConfigComplianceProviderRequest,
} from "../src/aws-config-compliance-provider-adapter.js";
import { parseAwsConfigComplianceProviderRouteRequest,
  runAwsConfigComplianceProviderRoute } from "../src/aws-config-compliance-provider-route.js";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const REQUEST: AwsConfigComplianceProviderRequest = {
  schemaVersion: "sutra.aws-config-compliance-provider-request.v1",
  requestId: `acr_${"a".repeat(64)}`, scheduledWindow: "2026-08-02T00:00:00.000Z",
  scope: { orgId: "org_config", customerId: "customer_config",
    connectionId: `conn_${"b".repeat(32)}`, partition: "aws",
    aggregatorAccountId: "111122223333", aggregatorRegion: "us-east-1",
    aggregatorName: "organization-aggregator",
    aggregatorArn: "arn:aws:config:us-east-1:111122223333:config-aggregator/config-aggregator-abc" },
  expectedCoverage: { awsOrganizationId: "o-1234567890", accountsEvidenceId: "ledger-1",
    accountsObservedAt: "2026-08-02T11:00:00.000Z",
    activeAccountIds: ["111122223333", "222233334444"], expectedRegions: ["us-east-1"] },
  targets: [{ accountId: "111122223333", region: "us-east-1", connectionId: `conn_${"b".repeat(32)}` },
    { accountId: "222233334444", region: "us-east-1", connectionId: `conn_${"c".repeat(32)}` }],
  operations: { central: ["config:DescribeConfigurationAggregators",
    "config:DescribeConfigurationAggregatorSourcesStatus", "config:DescribeAggregateComplianceByConfigRules",
    "config:GetAggregateComplianceDetailsByConfigRule", "config:DescribeAggregateComplianceByConformancePacks",
    "config:GetAggregateDiscoveredResourceCounts", "config:SelectAggregateResourceConfig",
    "organizations:DescribeOrganization", "organizations:ListAccounts"],
    fanout: ["config:DescribeConfigRules", "config:DescribeConfigRuleEvaluationStatus",
      "config:DescribeConfigurationRecorders", "config:DescribeConfigurationRecorderStatus"] },
  inventoryQuery: "SELECT accountId, awsRegion, resourceType, resourceId, configurationItemCaptureTime, resourceCreationTime, configurationItemStatus",
  activity: null, cur2: null, credentials: "SERVER_OWNED_TRUST_ROLE_SESSIONS",
  deadlineAtIso: "2026-08-02T12:20:00.000Z", bounds: AWS_CONFIG_COMPLIANCE_PROVIDER_BOUNDS,
};
function reader() { const targets: string[] = []; return { targets, value: {
  readCentral: async ({ target }: { target: { accountId:string } }) => { targets.push(`central:${target.accountId}`); return {
    prerequisites: { serviceConfigured:true,aggregatorValidated:true,readPermissionsValidated:true,organizationsAllFeaturesEnabled:true },
    aggregator:null,operationCoverage:[],sourceStatuses:[],ruleCompliance:[],evaluations:[],conformancePacks:[],resourceCounts:[],resourceInventory:[] }; },
  readAccountRegion: async ({ target }: { target:{accountId:string} }) => { targets.push(`fanout:${target.accountId}`); return { operationCoverage:[],recorders:[],rules:[] }; },
} }; }

test("collector binds exact central and account/Region fanout without synthetic channels", async () => {
  const fixture=reader();let tick=0;
  const capture=await collectAwsConfigComplianceProviderEvidence({request:REQUEST,reader:fixture.value,
    signal:new AbortController().signal,now:()=>NOW+(tick++*1_000)});
  assert.deepEqual(fixture.targets,["central:111122223333","fanout:111122223333","fanout:222233334444"]);
  assert.equal(capture.captureId,`config_${"a".repeat(64)}`);
  assert.equal(capture.activity,null);assert.equal(capture.cur2,null);
});

test("reordered, missing, or extra target scope is rejected before provider reads", async () => {
  const fixture=reader();
  for(const request of [{...REQUEST,targets:[...REQUEST.targets].reverse()},
    {...REQUEST,targets:REQUEST.targets.slice(0,1)}]){
    await assert.rejects(collectAwsConfigComplianceProviderEvidence({request,reader:fixture.value,
      signal:new AbortController().signal,now:()=>NOW}),
      (error)=>error instanceof AwsConfigComplianceProviderError&&error.code==="INVALID_REQUEST");
  }
  assert.deepEqual(fixture.targets,[]);
  const body=JSON.stringify({...REQUEST,clientRoleArn:"arn:aws:iam::999999999999:role/forged"});
  assert.throws(()=>parseAwsConfigComplianceProviderRouteRequest(body),AwsConfigComplianceProviderError);
});

test("route verifies signed-header identity and every assumed session account", async () => {
  const body=JSON.stringify(REQUEST);const fixture=reader();
  await assert.rejects(runAwsConfigComplianceProviderRoute({body,headers:{tenantId:REQUEST.scope.orgId,
    customerId:REQUEST.scope.customerId,connectionId:REQUEST.scope.connectionId,requestId:REQUEST.requestId},
    signal:new AbortController().signal},{now:()=>NOW,readerFactory:({sessionForTarget})=>({
      ...fixture.value,
      readCentral:async(input,signal)=>{await sessionForTarget(input.target,signal);return fixture.value.readCentral(input)},
      readAccountRegion:async(input,signal)=>{await sessionForTarget(input.target,signal);return fixture.value.readAccountRegion(input)},
    }),
    assumeReadOnlySession:async(input)=>({accountId:input.expectedAccountId==="111122223333"?"999900001111":input.expectedAccountId,
      partition:input.partition,credentials:{accessKeyId:"AKIAEXAMPLE",secretAccessKey:"secret",sessionToken:"token",expiration:new Date(NOW+3_600_000)}})}),
    AwsConfigComplianceProviderError);
});

import assert from "node:assert/strict";
import test from "node:test";
import { collectMarketplaceSpgProviderEvidence, MARKETPLACE_SPG_PROVIDER_BOUNDS, MarketplaceSpgProviderError, type MarketplaceSpgProviderRequest } from "../src/marketplace-spg-provider-adapter.js";
import { parseMarketplaceSpgProviderRouteRequest } from "../src/marketplace-spg-provider-route.js";

const ACCOUNT="111122223333", NOW=1_785_628_800_000;
const REQUEST:MarketplaceSpgProviderRequest={schemaVersion:"sutra.marketplace-spg-provider-request.v1",requestId:`mpr_${"a".repeat(64)}`,expectedCaptureId:`marketplace_${"b".repeat(64)}`,scheduledWindow:"2026-08-02T00:00:00.000Z",scope:{orgId:"org_add05",customerId:"customer_add05",connectionId:`conn_${"c".repeat(32)}`,accountId:ACCOUNT,partition:"aws",awsOrganizationId:"o-abcdefghij12"},expectedAccountIds:[ACCOUNT],accountCoverageEvidenceId:`fss_${"d".repeat(64)}`,accountCoverageObservedAt:"2026-08-02T00:00:00.000Z",licenseManagerRegion:"us-east-1",approvedProductTypes:[{productId:"prod-1",type:"SOFTWARE",evidenceId:`fss_${"e".repeat(64)}`}],deadlineAtIso:"2026-08-02T00:15:00.000Z"};
const FULL={...REQUEST,buyerOperations:["SearchAgreements","DescribeAgreement","GetAgreementTerms","GetAgreementEntitlements","ListAgreementCharges","GetProduct"],licenseOperations:["GetServiceSettings","ListReceivedLicenses","ListReceivedGrants","ListReceivedLicensesForOrganization","ListReceivedGrantsForOrganization"],accountCoverageActions:["organizations:DescribeOrganization","organizations:ListAccounts"],buyerParty:"Acceptor",credentials:"SERVER_OWNED_TRUST_ROLE_SESSIONS",privacy:{includeRegistrationTokens:false,includePurchaseOrderReferences:false,includeLegalDocumentsOrUrls:false,includeContacts:false,includeProviderErrorText:false,includeTemporaryEmbedUrls:false},bounds:MARKETPLACE_SPG_PROVIDER_BOUNDS};

test("strict route parser pins tenant, buyer operations, privacy and approved taxonomy",()=>{
  assert.deepEqual(parseMarketplaceSpgProviderRouteRequest(JSON.stringify(FULL)),REQUEST);
  assert.throws(()=>parseMarketplaceSpgProviderRouteRequest(JSON.stringify({...FULL,buyerParty:"Proposer"})),MarketplaceSpgProviderError);
  assert.throws(()=>parseMarketplaceSpgProviderRouteRequest(JSON.stringify({...FULL,temporaryEmbedUrl:"secret"})),MarketplaceSpgProviderError);
});

test("provider collector produces buyer-only empty evidence and exhausts pagination",async()=>{
  let searches=0;
  const result=await collectMarketplaceSpgProviderEvidence({request:REQUEST,signal:new AbortController().signal,now:()=>NOW,cur2:{scope:REQUEST.scope,generationId:`fbg_${"f".repeat(64)}`,sourceEvidenceId:`fss_${"1".repeat(64)}`,dataThroughAt:"2026-08-02T00:00:00.000Z",reconciliationState:"reconciled",predicate:"CUR2_BILLING_ENTITY_AWS_MARKETPLACE",rows:[]},clients:{
    searchAgreements:async()=>{searches+=1;return{items:[],nextToken:null}},describeAgreement:async()=>{throw new Error("not called")},getAgreementTerms:async()=>({items:[],nextToken:null}),getAgreementEntitlements:async()=>({items:[],nextToken:null}),listAgreementCharges:async()=>({items:[],nextToken:null}),getProduct:async()=>{throw new Error("not called")},getServiceSettings:async()=>({organizationIntegrationEnabled:true,crossAccountDiscoveryEnabled:true}),listReceivedLicensesForOrganization:async()=>({items:[],nextToken:null}),listReceivedGrantsForOrganization:async()=>({items:[],nextToken:null})}});
  assert.equal(searches,1);assert.equal(result.capture.captureId,REQUEST.expectedCaptureId);assert.deepEqual(result.capture.agreementAccountCoverage.capturedAgreementAccountIds,[ACCOUNT]);assert.equal(result.capture.agreements.length,0);assert.equal(result.capture.cur2?.generationId,`fbg_${"f".repeat(64)}`);
});

test("provider collector converts replayed pagination tokens to generic partial evidence",async()=>{
  const result=await collectMarketplaceSpgProviderEvidence({request:REQUEST,signal:new AbortController().signal,now:()=>NOW,cur2:{scope:REQUEST.scope,generationId:`fbg_${"f".repeat(64)}`,sourceEvidenceId:`fss_${"1".repeat(64)}`,dataThroughAt:"2026-08-02T00:00:00.000Z",reconciliationState:"reconciled",predicate:"CUR2_BILLING_ENTITY_AWS_MARKETPLACE",rows:[]},clients:{searchAgreements:async(input)=>({items:[],nextToken:input.nextToken??"same"}),describeAgreement:async()=>({}),getAgreementTerms:async()=>({items:[],nextToken:null}),getAgreementEntitlements:async()=>({items:[],nextToken:null}),listAgreementCharges:async()=>({items:[],nextToken:null}),getProduct:async()=>({}),getServiceSettings:async()=>({organizationIntegrationEnabled:true,crossAccountDiscoveryEnabled:true}),listReceivedLicensesForOrganization:async()=>({items:[],nextToken:null}),listReceivedGrantsForOrganization:async()=>({items:[],nextToken:null})}});
  assert.equal(result.capture.operationCoverage[0]?.state,"UNAVAILABLE");
  assert.equal(result.capture.operationCoverage[0]?.failureCode,"PROVIDER_UNAVAILABLE");
});

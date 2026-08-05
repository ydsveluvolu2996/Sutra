import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";

const root=path.resolve(import.meta.dirname,"..");
register(new URL("./cloudflare-loader.mjs",import.meta.url));
const production=await import("../lib/finops-end-user-computing-production-composition.ts");
const runtime=await import("../lib/finops-end-user-computing-runtime-binding.ts");

test("ADV-11 production composition pins the six-hour window, SDKs, and immutable permission successor",()=>{
  assert.equal(production.endUserComputingScheduledWindow(Date.parse("2026-08-02T17:59:59.999Z")),"2026-08-02T12:00:00.000Z");
  assert.equal(production.END_USER_COMPUTING_REQUIRED_PERMISSION_PACK,"standard-2026-08.11");
  assert.deepEqual(production.END_USER_COMPUTING_PRODUCTION_COMPOSITION_STATUS.requiredSdks,[
    "@aws-sdk/client-appstream@3.1087.0","@aws-sdk/client-cloudwatch@3.1087.0","@aws-sdk/client-workspaces@3.1087.0"]);
  assert.equal(production.END_USER_COMPUTING_PRODUCTION_COMPOSITION_STATUS.credentialOwningProviderRouteImplemented,true);
  assert.equal(production.END_USER_COMPUTING_PRODUCTION_COMPOSITION_STATUS.explicitUnavailableCollectingFailedReadyStatesImplemented,true);
  assert.equal(runtime.END_USER_COMPUTING_RUNTIME_BINDING.providerAdapterAvailable,true);
  assert.equal(runtime.END_USER_COMPUTING_RUNTIME_BINDING.registeredInSharedRuntime,true);
});

test("ADV-11 composition refuses an unsigned or ambiguous production broker",()=>{
  const base={loadEligibleBoundaries:async()=>[],loadRuntimeContext:async()=>{throw new Error("must-not-load")}};
  assert.throws(()=>production.createEndUserComputingProductionComposition(base),/EXACTLY_ONE_BROKER/u);
  assert.throws(()=>production.createEndUserComputingProductionComposition({...base,broker:{collect:async()=>{throw new Error("unused")}},brokerConfiguration:{brokerOrigin:"https://broker.invalid",signing:{}}}),/EXACTLY_ONE_BROKER/u);
});

test("ADV-11 unique production files expose no raw identity or mutating AWS operation",async()=>{
  const files=["services/aws-collector/src/end-user-computing-provider-adapter.ts","services/aws-collector/src/end-user-computing-provider-route.ts","lib/finops-end-user-computing-production-composition.ts"];
  const source=(await Promise.all(files.map(file=>readFile(path.join(root,file),"utf8")))).join("\n");
  for(const action of ["TerminateWorkspaces","StartWorkspaces","StopWorkspaces","ExpireSession","CreateFleet","UpdateFleet"])assert.doesNotMatch(source,new RegExp(`\\b${action}\\b`,"u"));
  assert.match(source,/includeUserIdentifiers:\s*false/u);assert.match(source,/includeSessionIdentifiers:\s*false/u);
  assert.match(source,/standard-2026-08\.11/u);
});

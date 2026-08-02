import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("ADD-05 production composition declares local closure and honest Bedrock gap",async()=>{
  const production=await readFile(new URL("../lib/finops-marketplace-spg-production-composition.ts",import.meta.url),"utf8");
  for(const token of ["credentialOwningProviderRouteImplemented:true","durableReplayRepositoryImplemented:true","approvedProductTypingImplemented:true","bedrockClassificationImplemented:false","standard-2026-08.13","runMarketplaceSpgRuntimeHandler","scheduleMarketplaceSpgCollections"])assert.match(production,new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu,"\\$&"),"u"));
});

test("ADD-05 reserved migrations provide durable boundaries, leases and immutable success",async()=>{
  const [sqlite,postgres]=await Promise.all([readFile(new URL("../drizzle/0123_finops_marketplace_spg_runtime.sql",import.meta.url),"utf8"),readFile(new URL("../postgres/migrations/0119_finops_marketplace_spg_runtime.sql",import.meta.url),"utf8")]);
  for(const source of [sqlite,postgres])for(const token of ["finops_marketplace_spg_runtime_boundaries","finops_marketplace_spg_runtime_attempts","lease_expires_at","SUCCEEDED","evidence_object_id"])assert.match(source,new RegExp(token,"u"));
});

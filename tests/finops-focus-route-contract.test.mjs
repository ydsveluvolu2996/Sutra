import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const route = await readFile(
  path.join(root, "app/api/v1/finops/focus/route.ts"),
  "utf8",
);

test("FOCUS GET is authenticated, same-tenant, and read-only", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(
    route,
    /getConnectionForOrg\(\s*authenticated\.subject\.orgId,\s*query\.connectionId,\s*\)/u,
  );
  assert.match(route, /connection\.sourceKind !== "aws_trust_role"/u);
  assert.match(route, /connection\.status !== "active"/u);
  assert.match(
    route,
    /assertSessionCapability\(\s*authenticated,\s*"connection:read",\s*connection\.customerId,\s*\)/u,
  );
  assert.match(route, /repository\.listActivePartitions\(owner\)/u);
  assert.match(route, /repository\.loadActivePartition\(owner, partition\)/u);
  assert.doesNotMatch(route, /export async function (?:POST|PUT|PATCH|DELETE)/u);
  assert.doesNotMatch(
    route,
    /\.get\("(?:orgId|organizationId|customerId|tenantId|accountId|exportName|generationId)"\)/u,
  );
});

test("FOCUS GET has an exact query allowlist and fixed history bounds", () => {
  assert.match(
    route,
    /const ALLOWED_QUERY_PARAMETERS = new Set\(\[\s*"connectionId",\s*"providerSourceId",\s*"fromPeriod",\s*"toPeriod",\s*"billingAccount",\s*"subAccount",\s*"provider",\s*"publisher",\s*"chargeCategory",\s*\]\)/u,
  );
  assert.match(route, /parameters\.keys\(\)/u);
  assert.match(route, /!ALLOWED_QUERY_PARAMETERS\.has\(key\)/u);
  assert.match(route, /parameters\.getAll\(key\)\.length > 1/u);
  assert.match(route, /FINOPS_FOCUS_DASHBOARD_BOUNDS\.maximumPeriods/u);
  assert.match(route, /FINOPS_FOCUS_DASHBOARD_BOUNDS\.maximumTotalRows/u);
  assert.match(route, /const FRESHNESS_SLA_HOURS = 48/u);
  assert.match(route, /ageHours > FRESHNESS_SLA_HOURS/u);
  assert.match(route, /freshness\.state/u);
  assert.match(route, /const FILTER_VALUE/u);
  assert.match(route, /filters: \{ billingAccount: query\.billingAccount/u);
  assert.match(route, /report\.quality\.selectedLineCount === 0/u);
});

test("FOCUS GET cannot substitute CUR or FOCUS 1.0", () => {
  assert.match(
    route,
    /activeSourceFormat === "focus"[\s\S]*activeSourceVersion === "1\.2"/u,
  );
  assert.match(route, /substitutionAllowed: false/u);
  assert.match(route, /sourceState: allActivePartitions\.length === 0[\s\S]*"configuration_required"/u);
  assert.doesNotMatch(route, /activeSourceFormat === "aws-cur"/u);
  assert.doesNotMatch(route, /activeSourceVersion === "1\.0"/u);
  assert.doesNotMatch(route, /CostExplorer|fixture|simulated|sample/iu);
  assert.doesNotMatch(route, /sourceState: "ready"|source_incomplete/u);
});

test("FOCUS GET discovers only authorized provider sources and fails closed on unbound schemas", () => {
  assert.match(route, /AzureCidRepository/u);
  assert.match(route, /GcpCloudIntelligenceRepository/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:read", source\.scope\.customerId\)/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:read", source\.customerId\)/u);
  assert.match(route, /source\.scope\.customerId !== connection\.customerId/u);
  assert.match(route, /source\.customerId !== connection\.customerId/u);
  assert.doesNotMatch(route, /parameters\.get\("(?:orgId|organizationId|customerId)"\)/u);
  assert.match(route, /AZURE_FOCUS_1_0_NORMALIZED_BINDING_NOT_DEPLOYED/u);
  assert.match(route, /AZURE_SOURCE_IS_NOT_FOCUS/u);
  assert.match(route, /GCP_FOCUS_EXPORT_ADAPTER_NOT_DEPLOYED/u);
  assert.match(route, /FOCUS_PROVIDER_SOURCE_NOT_FOUND/u);
  assert.match(route, /substitutionAllowed: false/u);
  assert.match(route, /tagTaxonomy: GOVERNED_TAG_TAXONOMY/u);
});

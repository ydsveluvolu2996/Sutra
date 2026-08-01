import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/v1/finops/cudos/route.ts", import.meta.url),
  "utf8",
);
const repository = await readFile(
  new URL("../db/finops-active-billing-query-repository.ts", import.meta.url),
  "utf8",
);

test("CUDOS GET has an exact query allowlist and server-resolved tenant authorization", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(
    route,
    /const ALLOWED_QUERY_PARAMETERS = new Set\(\[\s*"connectionId",\s*"period",\s*"costBasis",\s*"rankingLimit",\s*\]\)/u,
  );
  assert.match(route, /parameters\.keys\(\)/u);
  assert.match(route, /parameters\.getAll\(key\)\.length > 1/u);
  assert.doesNotMatch(route, /\.get\("(?:orgId|customerId|tenantId)"\)/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(
    route,
    /getConnectionForOrg\(\s*authenticated\.subject\.orgId,\s*query\.connectionId,\s*\)/u,
  );
  assert.match(
    route,
    /assertSessionCapability\(\s*authenticated,\s*"connection:read",\s*connection\.customerId,\s*\)/u,
  );
  assert.match(route, /connection\.sourceKind !== "aws_trust_role"/u);
  assert.match(route, /connection\.status !== "active"/u);
  assert.doesNotMatch(route, /export async function (?:POST|PUT|PATCH|DELETE)/u);
});

test("CUDOS route invokes only the canonical active-generation engine and has an explicit waiting state", () => {
  assert.match(
    route,
    /repository\.listActivePartitions\(owner\)/u,
  );
  assert.match(
    route,
    /repository\.loadActivePartition\(owner, selected\)/u,
  );
  assert.match(
    route,
    /buildFinopsCudosDashboard\(\{\s*scope: active\.scope,\s*rows: active\.rows,\s*options: query\.options,\s*\}\)/u,
  );
  assert.match(route, /report: null,\s*sourceState: "waiting"/u);
  assert.match(route, /report,\s*sourceState: "complete"/u);
  assert.match(
    route,
    /sourceEvidence: \{\s*activeGeneration: \{/u,
  );
  assert.match(route, /sourceUpdatedAtIso: active\.evidence\.activeSourceUpdatedAtIso/u);
  assert.match(route, /observedAtIso: active\.evidence\.activeObservedAtIso/u);
  assert.doesNotMatch(route, /partitionFreshness|matchesActiveManifest/u);
  assert.doesNotMatch(route, /fixture|demo|sample/iu);
  assert.doesNotMatch(route, /finops_cur_lines|FinopsWorkspaceRepository/u);
});

test("active billing repository is bounded, paginated, and live-owned in every read", () => {
  assert.match(repository, /await ensureRuntimeSchema\(this\.database\)/u);
  assert.match(repository, /const MAX_PARTITIONS = 36/u);
  assert.match(repository, /const MAX_PAGE_ROWS = 1_000/u);
  assert.match(repository, /const MAX_PARTITION_ROWS = 250_000/u);
  assert.match(repository, /const MAX_TOTAL_ROWS = 250_000/u);
  assert.match(
    repository,
    /p\.active_generation_id = l\.generation_id/u,
  );
  assert.match(repository, /l\.id > \?/u);
  assert.match(repository, /ORDER BY l\.id ASC/u);
  assert.match(repository, /nextAfterId/u);
  assert.ok(
    repository.match(/c\.source_kind = 'aws_trust_role'/gu)?.length >= 3,
    "list, page, and scope guard must each require a real AWS role",
  );
  assert.ok(
    repository.match(/c\.status = 'active'/gu)?.length >= 3,
    "list, page, and scope guard must each require live ownership",
  );
  assert.match(
    repository,
    /p\.active_source_updated_at, p\.active_observed_at/u,
  );
  assert.match(
    repository,
    /p\.active_committed_at, p\.active_accepted_rows,\s*p\.active_rejected_rows/u,
  );
  assert.doesNotMatch(repository, /SELECT COUNT\(\*\)/u);
  assert.doesNotMatch(repository, /p\.manifest_sha256/u);
  assert.doesNotMatch(repository, /finops_cur_lines/u);
});

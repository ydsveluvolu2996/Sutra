import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("case optimistic mutation requires both row update and activity append", async () => {
  const source = await readFile(new URL("../db/case-repository.ts", import.meta.url), "utf8");
  assert.match(source, /commitAuditedStatements\(\{[\s\S]+mutationGuard:/u);
  assert.match(source, /INSERT INTO finding_case_activities[\s\S]+WHERE EXISTS \([\s\S]+updated_at = \?/u);
  assert.match(source, /JOIN finding_case_activities a ON a\.case_id = c\.id[\s\S]+c\.updated_at = \?[\s\S]+a\.id = \?[\s\S]+a\.event_hash = \?/u);
});

test("D1 migration recovery treats pre-existing triggers as idempotent objects", async () => {
  const source = await readFile(new URL("../db/runtime-migrations.ts", import.meta.url), "utf8");
  assert.match(source, /\(\?:TABLE\|INDEX\|TRIGGER\)/u);
  assert.match(source, /CREATE_OBJECT\.test\(statement\) && \/already exists\/iu/u);
});

test("compliance reviewer selection requires effective customer-admin scope", async () => {
  const [repository, route] = await Promise.all([
    readFile(new URL("../db/compliance-exception-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v1/compliance/exceptions/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(repository, /m\.role IN \('org_owner', 'org_admin', 'customer_admin'\)/u);
  assert.match(repository, /ca\.role = 'customer_admin'/u);
  assert.match(route, /current\.requestedBy === authenticated\.subject\.userId && otherEligibleReviewerExists/u);
  assert.match(route, /A different eligible administrator must review this exception/u);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sqlite = await readFile(new URL("../drizzle/0088_finops_pricing_change_materializations.sql", import.meta.url), "utf8");
const postgres = await readFile(new URL("../postgres/migrations/0083_finops_pricing_change_materializations.sql", import.meta.url), "utf8");

test("Pricing Change migrations retain sealed metadata, immutable rows, and complete-only heads", () => {
  for (const sql of [sqlite, postgres]) {
    assert.match(sql, /finops_pricing_change_materializations/u);
    assert.match(sql, /finops_pricing_change_heads/u);
    assert.match(sql, /evidence_reference_ciphertext/u);
    assert.match(sql, /evidence_generation_id/u);
    assert.match(sql, /FINOPS_PRICING_CHANGE_IMMUTABLE/u);
    assert.match(sql, /FINOPS_PRICING_CHANGE_HEAD_REJECTED/u);
    assert.match(sql, /'ready'[\s\S]*'no_usage'/u);
    assert.match(sql, /fbg_/u);
    assert.doesNotMatch(sql, /\^gen_|'gen_'/u);
    assert.doesNotMatch(sql, /capture_json|usage_json|catalog_terms_json|price_per_unit/u);
  }
  assert.match(postgres, /REVOKE ALL ON finops_pricing_change_materializations FROM PUBLIC/u);
  assert.match(postgres, /REVOKE ALL ON finops_pricing_change_heads FROM PUBLIC/u);
});

test("parent integration registered both reserved migrations exactly once", async () => {
  const runtime = await readFile(new URL("../db/runtime-migrations.ts", import.meta.url), "utf8");
  const postgresRuntime = await readFile(new URL("../db/postgres-runtime-migrations.ts", import.meta.url), "utf8");
  assert.equal(runtime.match(/0088_finops_pricing_change_materializations/gu)?.length, 2);
  assert.equal(postgresRuntime.match(/0083_finops_pricing_change_materializations/gu)?.length, 2);
});

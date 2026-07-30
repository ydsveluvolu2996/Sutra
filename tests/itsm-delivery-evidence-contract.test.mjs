import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sources = await Promise.all([
  "../drizzle/0076_itsm_delivery_evidence.sql",
  "../postgres/migrations/0071_itsm_delivery_evidence.sql",
  "../db/runtime-migrations.ts",
  "../db/postgres-runtime-migrations.ts",
  "../scripts/postgres-migrate.mjs",
  "../app/api/v1/itsm/dispatch/route.ts",
  "../app/api/v1/itsm/inbound/[connectorId]/route.ts",
  "../db/background-job-handlers.ts",
].map((path) => readFile(new URL(path, import.meta.url), "utf8")));

const [
  d1,
  postgres,
  d1Runtime,
  postgresRuntime,
  postgresMigrator,
  dispatch,
  inbound,
  handlers,
] = sources;

test("D1 and PostgreSQL register durable connector-specific delivery evidence", () => {
  for (const migration of [d1, postgres]) {
    assert.match(migration, /last_outbound_success_at/u);
    assert.match(migration, /last_authenticated_inbound_at/u);
  }
  assert.match(d1Runtime, /0076_itsm_delivery_evidence/u);
  assert.match(postgresRuntime, /0071_itsm_delivery_evidence/u);
  assert.match(postgresMigrator, /0071_itsm_delivery_evidence\.sql/u);
});

test("only observed provider success and authenticated inbound processing record evidence", () => {
  assert.match(dispatch, /if \(delivered\)[\s\S]*recordOutboundSuccess\(scope, connector\.id, connector\.updatedAt\)/u);
  assert.match(handlers, /if \(result\.delivered\)[\s\S]*recordOutboundSuccess\([\s\S]*connector\.updatedAt/u);
  const signatureCheck = inbound.indexOf("verifyInboundSignature");
  const inboundRecord = inbound.indexOf("recordAuthenticatedInboundSuccess");
  assert.ok(signatureCheck >= 0 && inboundRecord > signatureCheck);
  assert.match(inbound, /recordAuthenticatedInboundSuccess\([\s\S]*connector\.updatedAt/u);
  assert.ok(inboundRecord < inbound.indexOf('return jsonResponse({ decision: "applied"'));
});

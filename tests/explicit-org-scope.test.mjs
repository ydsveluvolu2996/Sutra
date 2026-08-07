import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// `db/pilot-repository.ts` used to expose eleven exported functions whose
// `orgId` parameter defaulted to `LOCAL_ORG_ID`, plus three wrappers that
// resolved a connection or its secret in the local org from an id alone. The
// defaults made the persisted tenant invisible at the call site, and one of
// them hid a real defect: `setFindingWorkflowStatus` resolved the connection
// and bound both of its SQL statements to `LOCAL_ORG_ID`, so the finding
// workflow route resolved a connection in the caller's org, authorized against
// it, and then looked the same connection up again in the local org — returning
// 404 for every hosted tenant, and writing `org_id = LOCAL_ORG_ID` had that
// lookup ever succeeded.
//
// These tests keep the tenant explicit at every exported boundary.

const repository = await readFile(
  new URL("../db/pilot-repository.ts", import.meta.url),
  "utf8",
);
const workflowRoute = await readFile(
  new URL("../app/api/pilot/findings/workflow/route.ts", import.meta.url),
  "utf8",
);

test("no exported repository function defaults orgId to the local organization", () => {
  const defaulted = [...repository.matchAll(/^\s*orgId(?::\s*string)?\s*=\s*LOCAL_ORG_ID,\s*$/gmu)];
  // The only permitted default is on the private `findAuditRequest` helper,
  // whose two callers both forward an optional `AuditInput.orgId`.
  assert.equal(defaulted.length, 1);
  const index = repository.indexOf(defaulted[0][0]);
  const enclosing = repository.slice(0, index).lastIndexOf("function ");
  assert.match(
    repository.slice(enclosing, index),
    /^function findAuditRequest\(/u,
    "only findAuditRequest may still default orgId",
  );
});

test("the unscoped local-org convenience wrappers are gone", () => {
  for (const wrapper of [
    "export function getConnection(",
    "export function getLatestConnection(",
    "export function getStoredConnectionSecret(",
  ]) {
    assert.ok(
      !repository.includes(wrapper),
      `${wrapper}) resolves in LOCAL_ORG_ID from an id alone and must not exist`,
    );
  }
  // The org-scoped forms remain and are the only way in.
  for (const scoped of [
    "export async function getConnectionForOrg(",
    "export async function getLatestConnectionForOrg(",
    "export async function getStoredConnectionSecretForOrg(",
  ]) {
    assert.ok(repository.includes(scoped), `${scoped}) must remain`);
  }
});

test("setFindingWorkflowStatus is scoped to the caller's organization", () => {
  const start = repository.indexOf("export async function setFindingWorkflowStatus(");
  assert.ok(start > 0);
  const body = repository.slice(start, repository.indexOf("\nexport ", start + 1));

  assert.match(body, /setFindingWorkflowStatus\(\s*\n\s*orgId: string,/u);
  assert.match(body, /getConnectionForOrg\(orgId, connectionId\)/u);
  // Neither the read nor the write may pin the local organization.
  assert.doesNotMatch(
    body,
    /LOCAL_ORG_ID/u,
    "the finding workflow read and write must bind the caller's org, never LOCAL_ORG_ID",
  );
  assert.match(body, /\.bind\(orgId, connection\.customerId, connectionId, fingerprint\)/u);
});

test("the finding workflow route passes its authenticated org through", () => {
  assert.match(
    workflowRoute,
    /getConnectionForOrg\(actor\.orgId, body\.connectionId\)/u,
  );
  assert.match(
    workflowRoute,
    /setFindingWorkflowStatus\(\s*actor\.orgId,\s*body\.connectionId,/u,
    "the org written must be the authenticated org, never one derived from the body",
  );
  assert.doesNotMatch(workflowRoute, /\bLOCAL_ORG_ID\b/u);
});

test("local fixture routes name the local organization explicitly", async () => {
  for (const path of [
    "../app/api/local/fixtures/route.ts",
    "../app/api/local/jobs/publish/route.ts",
    "../app/api/local/jobs/simulated-sync/route.ts",
    "../lib/local-schedule-api.ts",
  ]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(
      source,
      /getConnectionForOrg\(LOCAL_ORG_ID, fixture\.connectionId\)/u,
      `${path} must name the tenant it resolves in`,
    );
  }
});

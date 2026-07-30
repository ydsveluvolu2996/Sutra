import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/v1/compliance/signoffs/route.ts", import.meta.url),
  "utf8",
);

test("compliance sign-off is bound to the current canonical report hash", () => {
  assert.match(route, /getPilotStateForOrg\(authenticated\.subject\.orgId, connectionId\)/u);
  assert.match(route, /listComplianceExceptions\(\{/u);
  assert.match(route, /buildComplianceReport\(state, exceptions\)/u);
  assert.match(route, /reportSha256 !== currentReport\.reportSha256/u);
  assert.ok(
    route.indexOf("reportSha256 !== currentReport.reportSha256")
      < route.indexOf("repository.recordSignoff"),
  );
});

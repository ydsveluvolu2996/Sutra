import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeSource = await readFile(
  new URL("../app/api/pilot/findings/workflow/route.ts", import.meta.url),
  "utf8",
);

test("finding workflow authorizes with connection metadata, never AWS trust ciphertext", () => {
  assert.match(routeSource, /getConnection\(body\.connectionId\)/u);
  assert.doesNotMatch(routeSource, /getStoredConnectionSecret/u);
  assert.match(
    routeSource,
    /assertSessionCapability\(actor\.authenticated, "finding:manage", connection\.customerId\)/u,
  );
});

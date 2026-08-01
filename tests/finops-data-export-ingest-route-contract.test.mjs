import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL(
    "../app/api/v1/finops/data-export/ingest/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const job = await readFile(
  new URL("../lib/finops-data-export-ingest-job.ts", import.meta.url),
  "utf8",
);

test("billing ingest emitter derives tenant scope and authorizes before enqueue", () => {
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /readBoundedJson\(request, BODY_BYTES\)/u);
  assert.ok(
    route.indexOf("requireApiSession(request)")
      < route.indexOf("readBoundedJson(request, BODY_BYTES)"),
  );
  assert.match(
    route,
    /Object\.keys\(body\)\.length !== 2/u,
  );
  assert.match(
    route,
    /getConnectionForOrg\(\s*authenticated\.subject\.orgId,\s*body\.connectionId/u,
  );
  assert.match(
    route,
    /assertSessionCapability\(\s*authenticated,\s*"sync:run",\s*connection\.customerId/u,
  );
  assert.match(
    route,
    /connection\.permissionPackVersion !== FOUNDATIONAL_FINOPS_PERMISSION_PACK/u,
  );
  assert.match(
    route,
    /orgId: authenticated\.subject\.orgId,[\s\S]*customerId: connection\.customerId/u,
  );
  assert.match(route, /FinopsDataExportObservationRepository/u);
  assert.match(route, /\.getExact\(/u);
  assert.match(route, /payload: observation\.payload/u);
  assert.doesNotMatch(
    route,
    /body\.(?:manifestKey|manifestSha256|rowCount|currencies|bucket|prefix|contractId)/u,
  );
});

test("billing ingest contract pins independent evidence and both exact AWS tables", () => {
  assert.match(job, /manifestSha256: evidence\.manifestSha256/u);
  assert.match(
    job,
    /contractId === "foundational-cur2-export-v1"[\s\S]*table: "cur-2\.0"[\s\S]*sourceTableName: "COST_AND_USAGE_REPORT"/u,
  );
  assert.match(
    job,
    /table: "focus-1\.2-aws"[\s\S]*sourceTableName: "FOCUS_1_2_AWS"/u,
  );
  assert.match(
    job,
    /evidence\.manifestSha256 !== manifest\.manifestSha256/u,
  );
  assert.match(job, /idempotencyKey: await ingestionIdempotencyKey/u);
});

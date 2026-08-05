import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const collectorChunk = await readFile(
  new URL(
    "../services/aws-collector/src/finops-export-chunk.ts",
    import.meta.url,
  ),
  "utf8",
);
const collectorServer = await readFile(
  new URL("../services/aws-collector/src/local-server.ts", import.meta.url),
  "utf8",
);
const appReader = await readFile(
  new URL("../lib/finops-broker-object-reader.ts", import.meta.url),
  "utf8",
);
const pilotServer = await readFile(
  new URL("../lib/pilot-server.ts", import.meta.url),
  "utf8",
);
const job = await readFile(
  new URL("../lib/finops-data-export-ingest-job.ts", import.meta.url),
  "utf8",
);
const handlers = await readFile(
  new URL("../db/background-job-handlers.ts", import.meta.url),
  "utf8",
);
const emitterRoute = await readFile(
  new URL(
    "../app/api/v1/finops/data-export/ingest/route.ts",
    import.meta.url,
  ),
  "utf8",
);

test("the durable job is composed through the authenticated broker and canonical repository", () => {
  assert.match(
    handlers,
    /\[FINOPS_DATA_EXPORT_INGEST_JOB_KIND\][\s\S]*runFinopsDataExportIngestJob/u,
  );
  assert.match(
    handlers,
    /repository: new FinopsBillingEngineRepository\(\)/u,
  );
  assert.match(
    handlers,
    /createFinopsBrokerObjectReader[\s\S]*runFinopsExportChunkRead/u,
  );
  assert.doesNotMatch(job, /new S3Client|AssumeRoleCommand|AWS_ACCESS_KEY/u);
  assert.doesNotMatch(appReader, /new S3Client|AssumeRoleCommand|AWS_ACCESS_KEY/u);
});

test("the broker endpoint owns S3 and both sides pin the same four-MiB range cap", () => {
  assert.match(
    collectorServer,
    /finops-export-chunk[\s\S]*collectFinopsExportChunk/u,
  );
  assert.match(
    collectorChunk,
    /FINOPS_EXPORT_CHUNK_MAX_BYTES = 4 \* 1_024 \* 1_024/u,
  );
  assert.match(
    appReader,
    /FINOPS_EXPORT_CHUNK_MAX_BYTES = 4 \* 1_024 \* 1_024/u,
  );
  assert.match(
    collectorChunk,
    /Range: `bytes=\$\{reparsed\.offset\}-\$\{end\}`/u,
  );
  assert.match(
    collectorChunk,
    /createAwsFinopsExportChunkClient[\s\S]*new S3Client/u,
  );
  assert.match(
    pilotServer,
    /runFinopsExportChunkRead[\s\S]{0,1000}contractId: input\.contractId[\s\S]{0,200}exportName: input\.exportName/u,
  );
});

test("activation stays fail-closed and only emits server-owned observations", () => {
  assert.match(
    job,
    /FOUNDATIONAL_FINOPS_PERMISSION_PACK =\s*\n\s*"standard-2026-08\.1"/u,
  );
  assert.match(
    job,
    /connection\.permissionPackVersion !== FOUNDATIONAL_FINOPS_PERMISSION_PACK/u,
  );
  assert.match(
    collectorServer,
    /connection\.permissionPackVersion !== FOUNDATIONAL_FINOPS_PERMISSION_PACK_VERSION[\s\S]*foundationalFinopsContracts === undefined/u,
  );
  assert.match(
    collectorServer,
    /broker\.assumeValidatedFinopsSession/u,
  );
  assert.doesNotMatch(
    handlers,
    /ensureDueFinopsDataExport|enqueueFinopsDataExportIngestJob/u,
    "the system must not auto-enqueue a path whose successor role is not active",
  );
  assert.match(emitterRoute, /FinopsDataExportObservationRepository/u);
  assert.match(emitterRoute, /payload: observation\.payload/u);
  assert.doesNotMatch(
    emitterRoute,
    /body\.(?:manifestKey|manifestSha256|rowCount|currencies|bucket|prefix|contractId)/u,
  );
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const template = readFileSync(
  new URL("../infrastructure/production-ha.yaml", import.meta.url),
  "utf8",
);
const entrypoint = readFileSync(
  new URL("../deploy/production/entrypoint.sh", import.meta.url),
  "utf8",
);
const download = readFileSync(
  new URL("../app/api/v1/evidence/download/route.ts", import.meta.url),
  "utf8",
);
const repository = readFileSync(
  new URL("../db/evidence-repository.ts", import.meta.url),
  "utf8",
);
const inventory = readFileSync(
  new URL("../app/cmdb/inventory-browser.tsx", import.meta.url),
  "utf8",
);
const legacyExport = readFileSync(
  new URL("../app/api/pilot/export/route.ts", import.meta.url),
  "utf8",
);

test("production evidence storage is private, KMS-bound, retained, and least privilege", () => {
  assert.match(template, /BlockPublicAcls:\s+true/u);
  assert.match(template, /RestrictPublicBuckets:\s+true/u);
  assert.match(template, /SSEAlgorithm:\s+aws:kms/u);
  assert.match(template, /DenyEvidenceEncryptedWithUnexpectedKey/u);
  assert.match(template, /ExpirationInDays:\s+!Ref EvidenceRetentionDays/u);
  assert.match(template, /NoncurrentVersionExpiration: \{ NoncurrentDays: 1 \}/u);
  assert.doesNotMatch(template, /NoncurrentDays: 2555/u);
  assert.match(template, /\$\{EvidenceBucket\.Arn\}\/evidence\/v1\/\*/u);
  assert.match(template, /s3:GetObject/u);
  assert.match(template, /s3:PutObject/u);
  assert.doesNotMatch(template, /s3:DeleteObject/u);
  assert.doesNotMatch(template, /s3:ListBucket/u);
  assert.doesNotMatch(template, /s3:GetObject.+s3:\*/u);
  assert.match(entrypoint, /SUTRA_EVIDENCE_BACKEND/u);
  assert.match(entrypoint, /SUTRA_EVIDENCE_BUCKET/u);
  assert.match(entrypoint, /SUTRA_EVIDENCE_KMS_KEY_ARN/u);
  assert.match(entrypoint, /SUTRA_EVIDENCE_RETENTION_DAYS/u);
});

test("download is application-streamed with one-time opaque tokens and no caller key", () => {
  assert.match(download, /new Response\(responseBody\.buffer/u);
  assert.match(download, /cache-control": "no-store, private"/u);
  assert.match(download, /consumeGrant/u);
  assert.match(repository, /SET consumed_at = \?/u);
  assert.match(repository, /token_sha256/u);
  assert.doesNotMatch(download, /presign|Presign|objectKey|object_key/u);
  assert.doesNotMatch(repository, /input\.objectKey|input\.object_key/u);
  assert.match(inventory, /downloadManagedEvidenceExport/u);
  assert.doesNotMatch(inventory, /href=\{`\/api\/pilot\/export/u);
  assert.match(legacyExport, /SUTRA_DEPLOYMENT_ENV === "production"/u);
});

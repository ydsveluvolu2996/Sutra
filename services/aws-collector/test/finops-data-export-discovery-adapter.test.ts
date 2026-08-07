import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverNewestManifest,
  evidenceFromManifest,
  ManifestDiscoveryError,
  type ManifestObjectListing,
} from "../src/finops-data-export-discovery-adapter.js";
import type { DiscoveredDataExport } from "../src/finops-data-export-discovery-reader.js";

const EXPORT: DiscoveredDataExport = {
  exportArn: "arn:aws:bcm-data-exports:ap-south-1:373665157695:export/sutra_cur2",
  exportName: "sutra_cur2",
  table: "COST_AND_USAGE_REPORT",
  contractId: "foundational-cur2-export-v1",
  bucket: "customer-billing-export",
  prefix: "sutra/cur2/sutra_cur2/",
  region: "ap-south-1",
};

function object(key: string, iso = "2026-08-01T00:00:00.000Z"): ManifestObjectListing {
  return { key, eTag: '"abc"', versionId: null, sizeBytes: 2048, lastModifiedIso: iso };
}

function readerFor(objects: readonly ManifestObjectListing[], pages = 1) {
  let call = 0;
  return {
    listPrefix: async () => {
      call += 1;
      return { objects, nextToken: call < pages ? `t${call}` : null };
    },
  };
}

test("the newest billing period wins, chosen by period rather than upload time", async () => {
  // A correction republished for an older period must not displace a later
  // period's delivery, so LastModified is deliberately not the tie-break.
  const outcome = await discoverNewestManifest({
    export: EXPORT,
    reader: readerFor([
      object(`${EXPORT.prefix}metadata/BILLING_PERIOD=2026-06/manifest.json`, "2026-09-01T00:00:00.000Z"),
      object(`${EXPORT.prefix}metadata/BILLING_PERIOD=2026-08/manifest.json`, "2026-08-02T00:00:00.000Z"),
      object(`${EXPORT.prefix}metadata/BILLING_PERIOD=2026-07/manifest.json`),
    ]),
  }, new AbortController().signal);

  assert.equal(outcome.kind, "delivered");
  assert.equal(outcome.kind === "delivered" ? outcome.manifest.billingPeriod : null, "2026-08");
});

test("no manifest is 'awaiting first delivery', a denial is 'unavailable'", async () => {
  // These are different facts needing different operator actions: nothing has
  // been delivered yet, versus this session cannot see the prefix at all
  // (typically the CUR 2.0 add-on is not deployed).
  const empty = await discoverNewestManifest(
    { export: EXPORT, reader: readerFor([]) },
    new AbortController().signal,
  );
  assert.equal(empty.kind, "awaiting-first-delivery");

  for (const [name, reason] of [
    ["AccessDenied", "ACCESS_DENIED"],
    ["InternalError", "PROVIDER_ERROR"],
  ] as const) {
    const outcome = await discoverNewestManifest({
      export: EXPORT,
      reader: {
        listPrefix: async () => { throw Object.assign(new Error(name), { name }); },
      },
    }, new AbortController().signal);
    assert.equal(outcome.kind, "unavailable", name);
    assert.equal(outcome.kind === "unavailable" ? outcome.reason : null, reason);
  }
});

test("only the exact AWS-owned manifest path is treated as a manifest", async () => {
  const outcome = await discoverNewestManifest({
    export: EXPORT,
    reader: readerFor([
      object(`${EXPORT.prefix}metadata/BILLING_PERIOD=2026-08/manifest.json.bak`),
      object(`${EXPORT.prefix}metadata/manifest.json`),
      object(`${EXPORT.prefix}data/BILLING_PERIOD=2026-08/part-0.parquet`),
      object(`${EXPORT.prefix}metadata/BILLING_PERIOD=26-08/manifest.json`),
    ]),
  }, new AbortController().signal);
  assert.equal(outcome.kind, "awaiting-first-delivery");
});

test("a key outside the granted prefix is refused rather than read", async () => {
  // The add-on's S3 grant is bounded to this prefix. A provider response
  // pointing elsewhere is a boundary violation, not a row to skip.
  await assert.rejects(
    () => discoverNewestManifest({
      export: EXPORT,
      reader: readerFor([object("someone-else/metadata/BILLING_PERIOD=2026-08/manifest.json")]),
    }, new AbortController().signal),
    ManifestDiscoveryError,
  );
});

test("a malformed prefix is refused before any listing happens", async () => {
  let listed = false;
  for (const prefix of ["sutra/cur2/no-trailing-slash", "/absolute/", "sutra/../escape/"]) {
    await assert.rejects(
      () => discoverNewestManifest({
        export: { ...EXPORT, prefix },
        reader: { listPrefix: async () => { listed = true; return { objects: [], nextToken: null }; } },
      }, new AbortController().signal),
      ManifestDiscoveryError,
      prefix,
    );
  }
  assert.equal(listed, false);
});

test("evidence uses the manifest's declared totals and stays deterministic", async () => {
  const evidence = evidenceFromManifest({
    manifestSha256: "a".repeat(64),
    dataFiles: [{ rowCount: 10 }, { rowCount: 5 }],
    declaredRowCount: 15,
    declaredCurrencies: [
      { currency: "USD", rowCount: 10 },
      { currency: "EUR", rowCount: 5 },
    ],
  });
  assert.equal(evidence.rowCount, 15);
  // Sorted, because the outbox dedupes on a payload hash: two discoveries of the
  // same delivery must serialize identically or every sweep writes a new row.
  assert.deepEqual(evidence.currencies.map((c) => c.currency), ["EUR", "USD"]);
});

test("per-file counts are summed only when every file declares one", () => {
  const summed = evidenceFromManifest({
    manifestSha256: "b".repeat(64),
    dataFiles: [{ rowCount: 7 }, { rowCount: 3 }],
  });
  assert.equal(summed.rowCount, 10);

  // A partial sum would understate the delivery and the ingest job's independent
  // comparison would then reject it for the wrong reason. Refuse instead.
  assert.throws(
    () => evidenceFromManifest({
      manifestSha256: "c".repeat(64),
      dataFiles: [{ rowCount: 7 }, { rowCount: null }],
    }),
    ManifestDiscoveryError,
  );
});

test("a manifest with no usable count is refused rather than given a guess", () => {
  assert.throws(
    () => evidenceFromManifest({ manifestSha256: "d".repeat(64), dataFiles: [] }),
    ManifestDiscoveryError,
  );
  assert.throws(
    () => evidenceFromManifest({ manifestSha256: "not-a-hash", dataFiles: [{ rowCount: 1 }] }),
    ManifestDiscoveryError,
  );
});

test("malformed currency entries are dropped, never coerced", () => {
  const evidence = evidenceFromManifest({
    manifestSha256: "e".repeat(64),
    dataFiles: [{ rowCount: 1 }],
    declaredRowCount: 1,
    declaredCurrencies: [
      { currency: "usd", rowCount: 1 },
      { currency: "US", rowCount: 1 },
      { currency: "USD", rowCount: -1 },
      { currency: "GBP", rowCount: 1 },
    ],
  });
  assert.deepEqual(evidence.currencies, [{ currency: "GBP", rowCount: 1 }]);
});

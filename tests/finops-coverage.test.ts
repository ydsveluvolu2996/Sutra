import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";
import { buildTagCoverage, DEFAULT_ALLOCATION_TAG_KEYS } from "../lib/finops-coverage.ts";

function line(
  overrides: Partial<NormalizedCurLine> & { amountMicros: string },
): NormalizedCurLine {
  return {
    lineItemId: overrides.lineItemId ?? "li",
    usageAccountId: overrides.usageAccountId ?? "111111111111",
    service: overrides.service ?? "AmazonEC2",
    chargeCategory: overrides.chargeCategory ?? "Usage",
    usageStartIso: overrides.usageStartIso ?? "2026-07-01T00:00:00.000Z",
    amountMicros: overrides.amountMicros,
    currency: overrides.currency ?? "USD",
    region: overrides.region ?? null,
    amortizedMicros: overrides.amortizedMicros ?? null,
    commitmentType: overrides.commitmentType ?? null,
    commitmentId: overrides.commitmentId ?? null,
    commitmentExpiry: overrides.commitmentExpiry ?? null,
    usageType: overrides.usageType ?? null,
    usageAmountMicros: overrides.usageAmountMicros ?? null,
    usageUnit: overrides.usageUnit ?? null,
    tags: overrides.tags ?? {},
  };
}

describe("buildTagCoverage", () => {
  it("computes taggedPercent and per-key coverage over mixed lines", () => {
    const report = buildTagCoverage([
      // fully tagged: env + team
      line({ amountMicros: "10000000", tags: { env: "prod", team: "payments" } }),
      // partially tagged: env only (still counts as "tagged" overall)
      line({ amountMicros: "6000000", service: "AmazonS3", tags: { env: "dev" } }),
      // untagged: no tags at all
      line({ amountMicros: "4000000", service: "AmazonRDS", tags: {} }),
    ]);

    assert.equal(report.currency, "USD");
    assert.deepEqual(report.currenciesPresent, ["USD"]);
    assert.deepEqual(report.allocationTagKeys, DEFAULT_ALLOCATION_TAG_KEYS);

    // Total = 20, tagged = 16 (10 + 6), untagged = 4.
    assert.equal(report.overall.totalMicros, "20000000");
    assert.equal(report.overall.totalUnits, 20);
    assert.equal(report.overall.taggedMicros, "16000000");
    assert.equal(report.overall.taggedUnits, 16);
    assert.equal(report.overall.untaggedMicros, "4000000");
    assert.equal(report.overall.taggedPercent, 80);
    assert.equal(report.overall.lineCount, 3);
    assert.equal(report.overall.taggedLineCount, 2);
    assert.equal(report.overall.untaggedLineCount, 1);

    const byKey = new Map(report.perTagKey.map((entry) => [entry.key, entry]));
    // env is present on the two tagged lines (10 + 6 = 16 of 20 = 80%).
    const env = byKey.get("env");
    assert.ok(env);
    assert.equal(env.coveredMicros, "16000000");
    assert.equal(env.coveragePercent, 80);
    assert.equal(env.coveredLineCount, 2);
    assert.equal(env.missingLineCount, 1);
    // team is only on the first line (10 of 20 = 50%).
    const team = byKey.get("team");
    assert.ok(team);
    assert.equal(team.coveredMicros, "10000000");
    assert.equal(team.coveragePercent, 50);
    // owner is on no line (0%).
    const owner = byKey.get("owner");
    assert.ok(owner);
    assert.equal(owner.coveredMicros, "0");
    assert.equal(owner.coveragePercent, 0);
  });

  it("treats a tag key match as case-insensitive and requires a non-empty value", () => {
    const report = buildTagCoverage(
      [
        line({ amountMicros: "5000000", tags: { ENV: "prod" } }), // uppercase key
        line({ amountMicros: "5000000", tags: { env: "" } }), // empty value -> missing + untagged
      ],
      ["env"],
    );
    const env = report.perTagKey[0];
    assert.equal(env.key, "env");
    // Only the first line has a non-empty env value.
    assert.equal(env.coveredMicros, "5000000");
    assert.equal(env.coveragePercent, 50);
    // The empty-valued line carries no non-empty tag => it is untagged overall.
    assert.equal(report.overall.taggedMicros, "5000000");
    assert.equal(report.overall.untaggedMicros, "5000000");
  });

  it("reports 0% tagged when every line is untagged", () => {
    const report = buildTagCoverage([
      line({ amountMicros: "3000000", service: "AmazonEC2", tags: {} }),
      line({ amountMicros: "7000000", service: "AmazonS3", tags: {} }),
    ]);
    assert.equal(report.overall.taggedMicros, "0");
    assert.equal(report.overall.taggedPercent, 0);
    assert.equal(report.overall.untaggedMicros, "10000000");
    for (const entry of report.perTagKey) {
      assert.equal(entry.coveredMicros, "0");
      assert.equal(entry.coveragePercent, 0);
    }
  });

  it("is honest and empty with no lines", () => {
    const report = buildTagCoverage([]);
    assert.equal(report.currency, null);
    assert.deepEqual(report.currenciesPresent, []);
    assert.equal(report.overall.totalMicros, "0");
    assert.equal(report.overall.taggedPercent, null);
    assert.equal(report.overall.lineCount, 0);
    assert.deepEqual(report.biggestUnallocated.services, []);
    assert.deepEqual(report.biggestUnallocated.accounts, []);
    // Per-key rows still exist for every configured key, all null coverage.
    assert.equal(report.perTagKey.length, DEFAULT_ALLOCATION_TAG_KEYS.length);
    for (const entry of report.perTagKey) assert.equal(entry.coveragePercent, null);
  });

  it("ranks the biggest unallocated services and accounts by untagged spend", () => {
    const report = buildTagCoverage(
      [
        // untagged spend concentrations across services + accounts
        line({ amountMicros: "9000000", service: "AmazonRDS", usageAccountId: "acct-A", tags: {} }),
        line({ amountMicros: "1000000", service: "AmazonRDS", usageAccountId: "acct-B", tags: {} }),
        line({ amountMicros: "5000000", service: "AmazonEC2", usageAccountId: "acct-A", tags: {} }),
        line({ amountMicros: "2000000", service: "AmazonS3", usageAccountId: "acct-C", tags: {} }),
        // tagged line MUST NOT appear in the unallocated ranking
        line({ amountMicros: "50000000", service: "AmazonEC2", usageAccountId: "acct-A", tags: { env: "prod" } }),
      ],
      undefined,
      2, // top-N = 2
    );

    // Services by untagged spend: RDS 10, EC2 5, S3 2 -> top 2 are RDS, EC2.
    assert.deepEqual(
      report.biggestUnallocated.services.map((group) => [group.key, group.untaggedMicros, group.lineCount]),
      [
        ["AmazonRDS", "10000000", 2],
        ["AmazonEC2", "5000000", 1],
      ],
    );
    // Accounts by untagged spend: acct-A 14 (9+5), acct-C 2, acct-B 1 -> top 2.
    assert.deepEqual(
      report.biggestUnallocated.accounts.map((group) => [group.key, group.untaggedMicros]),
      [
        ["acct-A", "14000000"],
        ["acct-C", "2000000"],
      ],
    );
  });

  it("analyses a single dominant currency and never mixes currencies", () => {
    const report = buildTagCoverage([
      line({ amountMicros: "100000000", currency: "USD", tags: {} }),
      line({ amountMicros: "1000000", currency: "EUR", tags: { env: "prod" } }),
    ]);
    // USD dominates -> only USD lines aggregated.
    assert.equal(report.currency, "USD");
    assert.deepEqual(report.currenciesPresent, ["EUR", "USD"]);
    assert.equal(report.overall.totalMicros, "100000000");
    assert.equal(report.overall.lineCount, 1);
    // The EUR (tagged) line is excluded entirely from the USD aggregate.
    assert.equal(report.overall.taggedMicros, "0");
  });
});

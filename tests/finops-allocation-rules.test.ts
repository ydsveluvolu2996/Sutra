import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAllocationRules,
  type AllocationRule,
} from "../lib/finops-allocation-rules.ts";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";

const units = (whole: number): string => String(whole * 1_000_000);

function line(
  overrides: Partial<NormalizedCurLine> & { amountMicros: string },
): NormalizedCurLine {
  return {
    lineItemId: overrides.lineItemId ?? "li-1",
    usageAccountId: overrides.usageAccountId ?? "111111111111",
    service: overrides.service ?? "AmazonEC2",
    chargeCategory: overrides.chargeCategory ?? "Usage",
    usageStartIso: overrides.usageStartIso ?? "2026-07-01T00:00:00.000Z",
    amountMicros: overrides.amountMicros,
    currency: overrides.currency ?? "USD",
    region: overrides.region ?? "us-east-1",
    amortizedMicros: overrides.amortizedMicros ?? null,
    commitmentType: overrides.commitmentType ?? null,
    commitmentId: overrides.commitmentId ?? null,
    commitmentExpiry: overrides.commitmentExpiry ?? null,
    tags: overrides.tags ?? {},
  };
}

function rule(overrides: Partial<AllocationRule> & { id: string }): AllocationRule {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    priority: overrides.priority ?? 100,
    match: overrides.match ?? {},
    targetKind: overrides.targetKind ?? "customer",
    targetValue: overrides.targetValue ?? "acme",
    enabled: overrides.enabled ?? true,
  };
}

test("assigns lines to the first matching enabled rule by priority", () => {
  const lines = [
    line({ lineItemId: "a", service: "AmazonEC2", amountMicros: units(10) }),
    line({ lineItemId: "b", service: "AmazonEC2", amountMicros: units(5) }),
  ];
  const rules = [
    rule({ id: "ar_2", priority: 200, match: { service: "AmazonEC2" }, targetValue: "loser" }),
    rule({ id: "ar_1", priority: 10, match: { service: "AmazonEC2" }, targetValue: "winner" }),
  ];
  const result = applyAllocationRules(lines, rules);
  assert.equal(result.allocated.length, 1);
  assert.equal(result.allocated[0]?.targetValue, "winner");
  assert.equal(result.allocated[0]?.amountMicros, units(15));
  assert.equal(result.allocated[0]?.amountUnits, 15);
  assert.equal(result.allocated[0]?.lineCount, 2);
  assert.equal(result.unallocated.amountMicros, "0");
});

test("requires ALL specified criteria to match", () => {
  const lines = [
    line({ lineItemId: "a", usageAccountId: "222", service: "AmazonS3", amountMicros: units(7) }),
    line({ lineItemId: "b", usageAccountId: "222", service: "AmazonEC2", amountMicros: units(3) }),
  ];
  const rules = [rule({ id: "ar_1", match: { account: "222", service: "AmazonS3" }, targetValue: "s3-team" })];
  const result = applyAllocationRules(lines, rules);
  assert.equal(result.allocated.length, 1);
  assert.equal(result.allocated[0]?.amountMicros, units(7));
  assert.equal(result.unallocated.amountMicros, units(3));
  assert.equal(result.unallocated.lineCount, 1);
});

test("matches on tag key and optional tag value", () => {
  const lines = [
    line({ lineItemId: "a", tags: { Team: "payments" }, amountMicros: units(4) }),
    line({ lineItemId: "b", tags: { Team: "search" }, amountMicros: units(6) }),
    line({ lineItemId: "c", tags: {}, amountMicros: units(2) }),
  ];
  const keyOnly = applyAllocationRules(lines, [rule({ id: "ar_1", match: { tagKey: "Team" }, targetValue: "tagged" })]);
  assert.equal(keyOnly.allocated[0]?.amountMicros, units(10));
  assert.equal(keyOnly.unallocated.amountMicros, units(2));
  const valueScoped = applyAllocationRules(lines, [rule({ id: "ar_1", match: { tagKey: "Team", tagValue: "payments" }, targetValue: "payments" })]);
  assert.equal(valueScoped.allocated[0]?.amountMicros, units(4));
  assert.equal(valueScoped.unallocated.amountMicros, units(8));
});

test("everything unmatched lands in the unallocated bucket; empty match matches nothing", () => {
  const lines = [line({ amountMicros: units(9) })];
  const emptyRule = applyAllocationRules(lines, [rule({ id: "ar_1", match: {}, targetValue: "catch-all" })]);
  assert.equal(emptyRule.allocated.length, 0);
  assert.equal(emptyRule.unallocated.amountMicros, units(9));
  assert.equal(emptyRule.unallocated.lineCount, 1);
});

test("disabled rules are skipped", () => {
  const lines = [line({ amountMicros: units(8) })];
  const rules = [rule({ id: "ar_1", match: { service: "AmazonEC2" }, enabled: false, targetValue: "off" })];
  const result = applyAllocationRules(lines, rules);
  assert.equal(result.allocated.length, 0);
  assert.equal(result.unallocated.amountMicros, units(8));
  assert.equal(result.ruleCount, 0);
});

test("total equals allocated plus unallocated and is deterministic", () => {
  const lines = [
    line({ lineItemId: "a", service: "AmazonEC2", amountMicros: units(10) }),
    line({ lineItemId: "b", service: "AmazonS3", amountMicros: units(20) }),
  ];
  const rules = [
    rule({ id: "ar_ec2", priority: 10, match: { service: "AmazonEC2" }, targetKind: "product", targetValue: "compute" }),
    rule({ id: "ar_s3", priority: 20, match: { service: "AmazonS3" }, targetKind: "product", targetValue: "storage" }),
  ];
  const first = applyAllocationRules(lines, rules);
  const second = applyAllocationRules(lines, rules);
  assert.deepEqual(first, second);
  assert.equal(first.totalMicros, units(30));
  const allocatedSum = first.allocated.reduce((sum, bucket) => sum + BigInt(bucket.amountMicros), BigInt(0));
  assert.equal((allocatedSum + BigInt(first.unallocated.amountMicros)).toString(), first.totalMicros);
  // Emitted in rule (priority) order.
  assert.deepEqual(first.allocated.map((b) => b.targetValue), ["compute", "storage"]);
});

test("malformed micros are ignored, not counted", () => {
  const lines = [
    line({ lineItemId: "a", service: "AmazonEC2", amountMicros: "not-a-number" }),
    line({ lineItemId: "b", service: "AmazonEC2", amountMicros: units(5) }),
  ];
  const result = applyAllocationRules(lines, [rule({ id: "ar_1", match: { service: "AmazonEC2" }, targetValue: "acme" })]);
  assert.equal(result.allocated[0]?.amountMicros, units(5));
  assert.equal(result.allocated[0]?.lineCount, 1);
  assert.equal(result.totalMicros, units(5));
});

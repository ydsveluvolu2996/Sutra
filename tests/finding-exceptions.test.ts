import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFindingExceptions,
  type Finding,
  type FindingException,
} from "../lib/finding-exceptions.ts";

function finding(over: Partial<Finding> = {}): Finding {
  return { id: "f1", ruleId: "rule.a", resourceRef: "res-1", severity: "high", ...over };
}

function exception(over: Partial<FindingException> = {}): FindingException {
  return {
    id: "e1",
    scope: { ruleId: "rule.a" },
    justification: "accepted risk during migration",
    approvedBy: "usr_owner",
    createdAtDays: 100,
    expiresAtDays: 30,
    ...over,
  };
}

test("a valid unexpired scoped exception suppresses only the matching findings", () => {
  const findings = [
    finding({ id: "f1", ruleId: "rule.a", resourceRef: "res-1" }),
    finding({ id: "f2", ruleId: "rule.b", resourceRef: "res-2" }),
    finding({ id: "f3", ruleId: "rule.a", resourceRef: "res-3" }),
  ];
  const report = applyFindingExceptions(findings, [exception({ scope: { ruleId: "rule.a" } })], 110);

  assert.deepEqual(report.suppressed.map((s) => s.finding.id), ["f1", "f3"]);
  assert.deepEqual(report.active.map((f) => f.id), ["f2"]);
  assert.equal(report.suppressed[0]?.exceptionId, "e1");
  assert.equal(report.suppressed[0]?.justification, "accepted risk during migration");
  assert.equal(report.suppressed[0]?.expiresInDays, 20); // 100 + 30 - 110
  assert.equal(report.invalidExceptions.length, 0);
  assert.equal(report.summary.appliedExceptions, 1);
});

test("a more specific scope (ruleId + resourceRef) suppresses only the exact resource", () => {
  const findings = [
    finding({ id: "f1", ruleId: "rule.a", resourceRef: "res-1" }),
    finding({ id: "f2", ruleId: "rule.a", resourceRef: "res-2" }),
  ];
  const report = applyFindingExceptions(findings, [exception({ scope: { ruleId: "rule.a", resourceRef: "res-1" } })], 110);
  assert.deepEqual(report.suppressed.map((s) => s.finding.id), ["f1"]);
  assert.deepEqual(report.active.map((f) => f.id), ["f2"]);
});

test("an expired exception suppresses nothing and its finding stays active (not invalid)", () => {
  const report = applyFindingExceptions(
    [finding({ id: "f1", ruleId: "rule.a" })],
    [exception({ scope: { ruleId: "rule.a" }, createdAtDays: 100, expiresAtDays: 30 })],
    130, // 100 + 30 <= 130 -> expired
  );
  assert.equal(report.suppressed.length, 0);
  assert.deepEqual(report.active.map((f) => f.id), ["f1"]);
  assert.equal(report.invalidExceptions.length, 0);
  assert.equal(report.summary.expiredExceptions, 1);
  assert.equal(report.summary.activeExceptions, 0);
});

test("nowDays drives expiry deterministically at the created + expires boundary", () => {
  const exc = exception({ scope: { ruleId: "rule.a" }, createdAtDays: 100, expiresAtDays: 30 });
  const findings = [finding({ ruleId: "rule.a" })];

  const before = applyFindingExceptions(findings, [exc], 129);
  assert.equal(before.suppressed.length, 1);
  assert.equal(before.suppressed[0]?.expiresInDays, 1);

  const at = applyFindingExceptions(findings, [exc], 130); // <= boundary -> expired
  assert.equal(at.suppressed.length, 0);
  assert.equal(at.active.length, 1);

  const after = applyFindingExceptions(findings, [exc], 200);
  assert.equal(after.suppressed.length, 0);
});

test("a null expiry never expires: it always suppresses and reports expiresInDays null", () => {
  const report = applyFindingExceptions(
    [finding({ ruleId: "rule.a" })],
    [exception({ scope: { ruleId: "rule.a" }, expiresAtDays: null })],
    1_000_000,
  );
  assert.equal(report.suppressed.length, 1);
  assert.equal(report.suppressed[0]?.expiresInDays, null);
});

test("an omitted expiry (undefined) also never expires", () => {
  const exc: FindingException = { id: "e2", scope: { ruleId: "rule.a" }, justification: "x", approvedBy: "y", createdAtDays: 0 };
  const report = applyFindingExceptions([finding({ ruleId: "rule.a" })], [exc], 5_000);
  assert.equal(report.suppressed.length, 1);
  assert.equal(report.suppressed[0]?.expiresInDays, null);
});

test("a missing justification makes the exception invalid and suppresses nothing", () => {
  const report = applyFindingExceptions(
    [finding({ ruleId: "rule.a" })],
    [exception({ scope: { ruleId: "rule.a" }, justification: "   " })],
    110,
  );
  assert.deepEqual(report.invalidExceptions, [{ id: "e1", reason: "missing-justification" }]);
  assert.equal(report.suppressed.length, 0);
  assert.equal(report.active.length, 1); // finding remains active, never silently dropped
});

test("a missing approver makes the exception invalid", () => {
  const report = applyFindingExceptions(
    [finding({ ruleId: "rule.a" })],
    [exception({ scope: { ruleId: "rule.a" }, approvedBy: "" })],
    110,
  );
  assert.deepEqual(report.invalidExceptions, [{ id: "e1", reason: "missing-approver" }]);
  assert.equal(report.suppressed.length, 0);
});

test("an empty scope is invalid ('empty-scope') and cannot blanket-suppress everything", () => {
  const findings = [finding({ id: "f1", ruleId: "rule.a" }), finding({ id: "f2", ruleId: "rule.x" })];
  const report = applyFindingExceptions(findings, [exception({ scope: {} })], 110);
  assert.deepEqual(report.invalidExceptions, [{ id: "e1", reason: "empty-scope" }]);
  assert.equal(report.suppressed.length, 0);
  assert.equal(report.active.length, 2);
});

test("a non-finite created/expires day is invalid ('invalid-expiry'), never a default suppress", () => {
  const nanExpiry = applyFindingExceptions(
    [finding({ ruleId: "rule.a" })],
    [exception({ scope: { ruleId: "rule.a" }, expiresAtDays: Number.NaN })],
    110,
  );
  assert.deepEqual(nanExpiry.invalidExceptions, [{ id: "e1", reason: "invalid-expiry" }]);
  assert.equal(nanExpiry.suppressed.length, 0);

  const infCreated = applyFindingExceptions(
    [finding({ ruleId: "rule.a" })],
    [exception({ id: "e2", scope: { ruleId: "rule.a" }, createdAtDays: Number.POSITIVE_INFINITY })],
    110,
  );
  assert.equal(infCreated.invalidExceptions[0]?.reason, "invalid-expiry");
  assert.equal(infCreated.suppressed.length, 0);
});

test("tenant scope suppresses only the matching tenant; an absent scope field is a wildcard", () => {
  const acme = finding({ id: "fa", ruleId: "rule.a", tenant: "acme" });
  const globex = finding({ id: "fg", ruleId: "rule.a", tenant: "globex" });
  const untenanted = finding({ id: "fn", ruleId: "rule.a" });

  const scoped = applyFindingExceptions([acme, globex, untenanted], [exception({ scope: { tenant: "acme" } })], 110);
  assert.deepEqual(scoped.suppressed.map((s) => s.finding.id), ["fa"]);
  assert.deepEqual(scoped.active.map((f) => f.id), ["fg", "fn"]);

  // No tenant field in scope -> tenant is a wildcard, matching every tenant incl. untenanted.
  const wildcard = applyFindingExceptions([acme, globex, untenanted], [exception({ scope: { ruleId: "rule.a" } })], 110);
  assert.equal(wildcard.suppressed.length, 3);
});

test("the finding object is passed through unchanged into the suppressed entry", () => {
  const f = finding({ id: "f1", ruleId: "rule.a", resourceRef: "res-1", severity: "critical", tenant: "acme" });
  const report = applyFindingExceptions([f], [exception({ scope: { ruleId: "rule.a" } })], 110);
  assert.deepEqual(report.suppressed[0]?.finding, f);
});

test("an invalid exception never suppresses even when its scope would match", () => {
  const report = applyFindingExceptions(
    [finding({ ruleId: "rule.a" })],
    [exception({ scope: { ruleId: "rule.a" }, justification: "" })],
    110,
  );
  assert.equal(report.suppressed.length, 0);
  assert.equal(report.active.length, 1);
  assert.equal(report.invalidExceptions.length, 1);
});

test("when several active exceptions match, the first in input order is cited", () => {
  const e1 = exception({ id: "e1", scope: { ruleId: "rule.a" }, justification: "first" });
  const e2 = exception({ id: "e2", scope: { resourceRef: "res-1" }, justification: "second" });
  const report = applyFindingExceptions([finding({ ruleId: "rule.a", resourceRef: "res-1" })], [e1, e2], 110);
  assert.equal(report.suppressed[0]?.exceptionId, "e1");
  assert.equal(report.suppressed[0]?.justification, "first");
  assert.equal(report.summary.appliedExceptions, 1);
  assert.equal(report.summary.unusedExceptions, 1); // e2 matched no remaining finding
});

test("summary partitions and classification counts are internally consistent", () => {
  const findings = [
    finding({ id: "f1", ruleId: "rule.a" }), // suppressed by active e-active
    finding({ id: "f2", ruleId: "rule.b" }), // only an expired exception targets it -> active
    finding({ id: "f3", ruleId: "rule.c" }), // no exception -> active
  ];
  const exceptions = [
    exception({ id: "e-active", scope: { ruleId: "rule.a" }, createdAtDays: 100, expiresAtDays: 30 }),
    exception({ id: "e-expired", scope: { ruleId: "rule.b" }, createdAtDays: 1, expiresAtDays: 1 }),
    exception({ id: "e-invalid", scope: {} }),
  ];
  const report = applyFindingExceptions(findings, exceptions, 110);

  assert.equal(report.summary.findings, 3);
  assert.equal(report.summary.active + report.summary.suppressed, report.summary.findings);
  assert.equal(
    report.summary.activeExceptions + report.summary.expiredExceptions + report.summary.invalidExceptions,
    report.summary.exceptions,
  );
  assert.equal(report.summary.appliedExceptions + report.summary.unusedExceptions, report.summary.activeExceptions);
  assert.equal(report.summary.suppressed, 1);
  assert.equal(report.summary.expiredExceptions, 1);
  assert.equal(report.summary.invalidExceptions, 1);
});

test("no exceptions leaves every finding active; no findings yields an empty partition", () => {
  const noExceptions = applyFindingExceptions([finding({ id: "f1" }), finding({ id: "f2" })], [], 0);
  assert.equal(noExceptions.active.length, 2);
  assert.equal(noExceptions.suppressed.length, 0);

  const empty = applyFindingExceptions([], [], 0);
  assert.deepEqual(empty.active, []);
  assert.deepEqual(empty.suppressed, []);
  assert.deepEqual(empty.invalidExceptions, []);
  assert.equal(empty.summary.findings, 0);
  assert.equal(empty.schema, "sutra.finding-exceptions.v1");
  assert.match(empty.disclaimer, /not evidence the underlying finding was fixed/u);
});

test("output is deterministic for identical input", () => {
  const findings = [finding({ id: "z", ruleId: "rule.a" }), finding({ id: "a", ruleId: "rule.b", tenant: "t1" })];
  const exceptions = [
    exception({ id: "e1", scope: { ruleId: "rule.a" } }),
    exception({ id: "e2", scope: { tenant: "t1" }, expiresAtDays: null }),
  ];
  const build = () => applyFindingExceptions(findings, exceptions, 110);
  assert.deepEqual(build(), build());
});

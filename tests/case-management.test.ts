import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCaseTransition,
  assertCaseOperationalMutationAllowed,
  caseSlaState,
  defaultCaseDueAt,
  parseCaseDueAt,
  parseCaseNote,
  parseCasePriority,
} from "../lib/case-management.ts";

test("priority defaults produce deterministic SLA deadlines", () => {
  const createdAt = Date.parse("2026-07-16T00:00:00.000Z");
  assert.equal(new Date(defaultCaseDueAt("critical", createdAt)).toISOString(), "2026-07-16T04:00:00.000Z");
  assert.equal(new Date(defaultCaseDueAt("high", createdAt)).toISOString(), "2026-07-17T00:00:00.000Z");
  assert.equal(new Date(defaultCaseDueAt("medium", createdAt)).toISOString(), "2026-07-19T00:00:00.000Z");
  assert.equal(new Date(defaultCaseDueAt("low", createdAt)).toISOString(), "2026-07-23T00:00:00.000Z");
});

test("SLA state is calculated from durable dates and lifecycle", () => {
  const dueAt = Date.parse("2026-07-17T00:00:00.000Z");
  assert.equal(caseSlaState({ dueAt, status: "open", resolvedAt: null, closedAt: null, now: dueAt - 25 * 60 * 60 * 1_000 }), "on_track");
  assert.equal(caseSlaState({ dueAt, status: "investigating", resolvedAt: null, closedAt: null, now: dueAt - 1_000 }), "due_soon");
  assert.equal(caseSlaState({ dueAt, status: "open", resolvedAt: null, closedAt: null, now: dueAt + 1 }), "overdue");
  assert.equal(caseSlaState({ dueAt, status: "resolved", resolvedAt: dueAt - 1, closedAt: null, now: dueAt + 99_000 }), "met");
  assert.equal(caseSlaState({ dueAt, status: "closed", resolvedAt: dueAt - 1, closedAt: dueAt + 1, now: dueAt + 99_000 }), "met");
  assert.equal(caseSlaState({ dueAt, status: "closed", resolvedAt: null, closedAt: dueAt + 1, now: dueAt + 99_000 }), "missed");
});

test("case lifecycle allows investigation, resolution, closure, and reopening only", () => {
  assert.doesNotThrow(() => assertCaseTransition("open", "investigating"));
  assert.doesNotThrow(() => assertCaseTransition("investigating", "resolved"));
  assert.doesNotThrow(() => assertCaseTransition("resolved", "closed"));
  assert.doesNotThrow(() => assertCaseTransition("closed", "open"));
  assert.throws(() => assertCaseTransition("closed", "resolved"), /cannot move/u);
  assert.throws(() => assertCaseTransition("open", "open"), /cannot move/u);
});

test("completed cases must reopen before mutable SLA fields can change", () => {
  assert.doesNotThrow(() => assertCaseOperationalMutationAllowed("open"));
  assert.doesNotThrow(() => assertCaseOperationalMutationAllowed("investigating"));
  assert.throws(() => assertCaseOperationalMutationAllowed("resolved"), /Reopen the case/u);
  assert.throws(() => assertCaseOperationalMutationAllowed("closed"), /Reopen the case/u);
});

test("case input parsers bound notes, priority, and future dates", () => {
  assert.equal(parseCasePriority("critical"), "critical");
  assert.throws(() => parseCasePriority("urgent"), /priority/u);
  assert.equal(parseCaseNote("  Investigating approved change  "), "Investigating approved change");
  assert.throws(() => parseCaseNote("\u0000unsafe"), /notes/u);
  const now = Date.parse("2026-07-16T00:00:00.000Z");
  assert.equal(parseCaseDueAt("2026-07-17T00:00:00.000Z", now), Date.parse("2026-07-17T00:00:00.000Z"));
  assert.throws(() => parseCaseDueAt("2026-07-15T00:00:00.000Z", now), /future/u);
});
